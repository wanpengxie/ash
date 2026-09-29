package ai.ash.host.system

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.pm.ApplicationInfo
import java.util.Locale

/** Launchable apps (those with a launcher icon) and resolution of "an app" from a package or a label. */
object Apps {
    class App(val label: String, val pkg: String, val activity: String, val system: Boolean) {
        val component get() = ComponentName(pkg, activity)
    }

    fun launchable(ctx: Context): List<App> {
        val pm = ctx.packageManager
        val main = Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER)
        val seen = HashSet<String>()
        val out = ArrayList<App>()
        for (ri in pm.queryIntentActivities(main, 0)) {
            val ai = ri.activityInfo ?: continue
            if (!seen.add(ai.packageName)) continue
            val label = try { ri.loadLabel(pm).toString() } catch (e: Throwable) { ai.packageName }
            val sys = (ai.applicationInfo.flags and (ApplicationInfo.FLAG_SYSTEM or ApplicationInfo.FLAG_UPDATED_SYSTEM_APP)) != 0
            out.add(App(label.trim(), ai.packageName, ai.name, sys))
        }
        out.sortWith(compareBy<App>({ it.label.lowercase(Locale.ROOT) }, { it.pkg }))
        return out
    }

    fun isInstalled(ctx: Context, pkg: String): Boolean = try {
        ctx.packageManager.getApplicationInfo(pkg, 0); true
    } catch (e: Throwable) { false }

    /** Label of any installed package (not only launchable ones), or null. */
    fun labelOf(ctx: Context, pkg: String): String? = try {
        val pm = ctx.packageManager
        pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0)).toString()
    } catch (e: Throwable) { null }

    /**
     * Finds one launchable app from a package name or a (case-insensitive, space-insensitive) label:
     * exact package → exact label → label prefix → label substring → package substring.
     * Throws with the candidates when nothing or several equally good apps match.
     */
    fun resolve(ctx: Context, query: String): App {
        val q = query.trim()
        require(q.isNotEmpty()) { "app is required (a package name or an app label)" }
        val all = launchable(ctx)
        all.firstOrNull { it.pkg == q }?.let { return it }
        if (isInstalled(ctx, q)) throw IllegalArgumentException("$q is installed but has no launcher activity")
        val nq = norm(q)
        val tiers = listOf<(App) -> Boolean>(
            { norm(it.label) == nq },
            { norm(it.label).startsWith(nq) },
            { norm(it.label).contains(nq) },
            { it.pkg.lowercase(Locale.ROOT).contains(nq) },
        )
        for ((i, t) in tiers.withIndex()) {
            val hits = all.filter(t)
            if (hits.size == 1 || (hits.size > 1 && i == 0)) return hits.first()
            if (hits.size > 1) {
                val list = hits.take(10).joinToString("; ") { "${it.label} (${it.pkg})" }
                throw IllegalArgumentException("\"$q\" matches several apps: $list${if (hits.size > 10) "; …" else ""}. Use the package name.")
            }
        }
        throw IllegalArgumentException("no launchable app matches \"$q\" (apps.list shows what is installed)")
    }

    private fun norm(s: String) = s.lowercase(Locale.ROOT).replace(Regex("\\s+"), "")
}
