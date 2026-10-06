package ai.ash.senses.health

import ai.ash.senses.HealthRow
import ai.ash.senses.SenseError
import android.content.Context
import android.os.Build
import androidx.health.connect.client.HealthConnectClient
import androidx.health.connect.client.permission.HealthPermission
import androidx.health.connect.client.records.ActiveCaloriesBurnedRecord
import androidx.health.connect.client.records.BodyFatRecord
import androidx.health.connect.client.records.DistanceRecord
import androidx.health.connect.client.records.ExerciseSessionRecord
import androidx.health.connect.client.records.HeartRateRecord
import androidx.health.connect.client.records.Record
import androidx.health.connect.client.records.SleepSessionRecord
import androidx.health.connect.client.records.StepsRecord
import androidx.health.connect.client.records.WeightRecord
import androidx.health.connect.client.request.ReadRecordsRequest
import androidx.health.connect.client.time.TimeRangeFilter
import kotlinx.coroutines.runBlocking
import org.json.JSONArray
import org.json.JSONObject
import java.time.Instant
import kotlin.reflect.KClass

/**
 * Health Connect, read only: the phone's shared health store (part of Android from 14; an app before that). Each
 * reading names the app that wrote it. Permissions are checked on every read: one the owner withdrew reads nothing.
 */
object HealthConnectSource {
    const val PROVIDER = "com.google.android.apps.healthdata"
    /** Reading while the helper is not in front (Android 15 / newer Health Connect). */
    const val BACKGROUND = "android.permission.health.READ_HEALTH_DATA_IN_BACKGROUND"

    val RECORDS: Map<String, KClass<out Record>> = linkedMapOf(
        "steps" to StepsRecord::class,
        "heart_rate" to HeartRateRecord::class,
        "sleep" to SleepSessionRecord::class,
        "weight" to WeightRecord::class,
        "body_fat" to BodyFatRecord::class,
        "active_calories" to ActiveCaloriesBurnedRecord::class,
        "distance" to DistanceRecord::class,
        "exercise" to ExerciseSessionRecord::class,
    )

    fun permission(metric: String): String = HealthPermission.getReadPermission(RECORDS.getValue(metric))
    val PERMISSIONS: Set<String> get() = RECORDS.keys.map { permission(it) }.toSet()
    /** What the setup page asks for. */
    fun requested(): Set<String> = PERMISSIONS + if (Build.VERSION.SDK_INT >= 34) setOf(BACKGROUND) else emptySet()

    fun state(ctx: Context): String = when (HealthConnectClient.getSdkStatus(ctx, PROVIDER)) {
        HealthConnectClient.SDK_AVAILABLE -> "available"
        HealthConnectClient.SDK_UNAVAILABLE_PROVIDER_UPDATE_REQUIRED -> "update_required"
        else -> "not_installed"
    }

    private fun client(ctx: Context): HealthConnectClient {
        when (state(ctx)) {
            "available" -> {}
            "update_required" -> throw SenseError("source_unavailable", "Health Connect needs an update before it can be read")
            else -> throw SenseError("source_unavailable", "Health Connect is not available on this phone (install it, or use Gadgetbridge)")
        }
        return HealthConnectClient.getOrCreate(ctx, PROVIDER)
    }

    fun granted(ctx: Context): Set<String> =
        if (state(ctx) != "available") emptySet() else runCatching { runBlocking { client(ctx).permissionController.getGrantedPermissions() } }.getOrDefault(emptySet())

    fun status(ctx: Context): JSONObject {
        val state = state(ctx)
        val o = JSONObject().put("id", "health_connect").put("state", state)
        if (state != "available") return o
        val granted = granted(ctx)
        o.put("granted", JSONArray(RECORDS.keys.filter { permission(it) in granted }))
            .put("missing", JSONArray(RECORDS.keys.filter { permission(it) !in granted }))
            .put("background", BACKGROUND in granted)
        return o
    }

    /** The readings of [metrics] in [range] it is allowed to read. Throws [SenseError] when it can read none of them. */
    fun read(ctx: Context, metrics: List<String>, range: LongRange, max: Int): List<HealthRow> {
        val client = client(ctx)
        val wanted = metrics.filter { it in RECORDS }
        if (wanted.isEmpty()) throw SenseError("source_unavailable", "Health Connect has none of ${metrics.joinToString()} (spo2 is read from Gadgetbridge)")
        val granted = runBlocking { client.permissionController.getGrantedPermissions() }
        val allowed = wanted.filter { permission(it) in granted }
        if (allowed.isEmpty()) throw SenseError("permission_denied", "Health Connect has not granted Ash 感知 ${wanted.joinToString()} (open its setup page)")
        val filter = TimeRangeFilter.between(Instant.ofEpochMilli(range.first), Instant.ofEpochMilli(range.last))
        val out = mutableListOf<HealthRow>()
        try {
            runBlocking {
                for (metric in allowed) {
                    var token: String? = null
                    do {
                        val page = client.readRecords(ReadRecordsRequest(RECORDS.getValue(metric), filter, pageSize = 1000, pageToken = token))
                        for (r in page.records) out += rows(metric, r)
                        token = page.pageToken
                    } while (token != null && out.size < max)
                }
            }
        } catch (e: SecurityException) {
            val background = if (BACKGROUND !in granted) " Reading while Ash 感知 is in the background needs Health Connect's background-read permission." else ""
            throw SenseError("permission_denied", "Health Connect refused the read: ${e.message}.$background")
        } catch (e: IllegalStateException) {
            throw SenseError("source_unavailable", "Health Connect could not be read: ${e.message}")
        }
        return out.filter { it.ts in range }.sortedBy { it.ts }.take(max)
    }

    private fun rows(metric: String, r: Record): List<HealthRow> {
        val source = "health_connect:${r.metadata.dataOrigin.packageName}"
        return when (r) {
            is StepsRecord -> listOf(HealthRow(r.startTime.toEpochMilli(), metric, r.count.toDouble(), source, r.endTime.toEpochMilli()))
            is HeartRateRecord -> r.samples.map { HealthRow(it.time.toEpochMilli(), metric, it.beatsPerMinute.toDouble(), source) }
            is SleepSessionRecord -> listOf(HealthRow(r.startTime.toEpochMilli(), metric, minutes(r.startTime, r.endTime), source, r.endTime.toEpochMilli()))
            is WeightRecord -> listOf(HealthRow(r.time.toEpochMilli(), metric, r.weight.inKilograms, source))
            is BodyFatRecord -> listOf(HealthRow(r.time.toEpochMilli(), metric, r.percentage.value, source))
            is ActiveCaloriesBurnedRecord -> listOf(HealthRow(r.startTime.toEpochMilli(), metric, r.energy.inKilocalories, source, r.endTime.toEpochMilli()))
            is DistanceRecord -> listOf(HealthRow(r.startTime.toEpochMilli(), metric, r.distance.inMeters, source, r.endTime.toEpochMilli()))
            is ExerciseSessionRecord -> listOf(HealthRow(r.startTime.toEpochMilli(), metric, minutes(r.startTime, r.endTime), source, r.endTime.toEpochMilli(),
                r.title?.takeIf { it.isNotBlank() } ?: "type_${r.exerciseType}"))
            else -> emptyList()
        }
    }

    private fun minutes(a: Instant, b: Instant) = (b.toEpochMilli() - a.toEpochMilli()) / 60_000.0
}
