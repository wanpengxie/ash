package ai.ash.host.media

import ai.ash.host.cap.MediaArguments
import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.ParcelFileDescriptor
import android.provider.OpenableColumns
import java.io.File
import java.io.FileNotFoundException

/**
 * Where the system camera writes a photo or video Ash asked for (targetSdk 28 forbids file:// URIs and this app has
 * no AndroidX FileProvider). Not exported: the camera app reaches a single file only through the grant on its intent.
 * Flat names under cache/capture/; the chat's web view reads the same URI back as the chosen file.
 */
class CaptureProvider : ContentProvider() {
    override fun onCreate() = true

    private fun resolve(uri: Uri): File? {
        val name = uri.lastPathSegment ?: return null
        if (uri.pathSegments.size != 1 || name.isEmpty() || name.contains('/') || name.contains('\\') || name.startsWith(".")) return null
        return File(dir(context ?: return null), name)
    }

    override fun getType(uri: Uri): String = uri.lastPathSegment?.let { MediaArguments.mimeOf(it) } ?: "application/octet-stream"

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        val f = resolve(uri)?.takeIf { it.exists() } ?: return null
        val cols = if (projection.isNullOrEmpty()) arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE) else projection
        return MatrixCursor(cols, 1).apply {
            addRow(cols.map { c -> when (c) { OpenableColumns.DISPLAY_NAME -> f.name; OpenableColumns.SIZE -> f.length(); else -> null } }.toTypedArray())
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val f = resolve(uri) ?: throw FileNotFoundException(uri.toString())
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.parseMode(mode))
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        private const val KEEP_MS = 24 * 3_600_000L

        fun dir(ctx: Context) = File(ctx.cacheDir, "capture").apply { mkdirs() }

        fun uriFor(ctx: Context, file: File): Uri = Uri.parse("content://${ctx.packageName}.capture/${Uri.encode(file.name)}")

        /** A new empty file for one capture; captures older than a day are cleared on the way. */
        fun newFile(ctx: Context, prefix: String, extension: String): File {
            val d = dir(ctx)
            val now = System.currentTimeMillis()
            d.listFiles()?.forEach { if (now - it.lastModified() > KEEP_MS) it.delete() }
            val stamp = java.text.SimpleDateFormat("yyyyMMdd-HHmmss", java.util.Locale.ROOT).format(java.util.Date(now))
            var f = File(d, "$prefix-$stamp.$extension")
            var n = 1
            while (f.exists()) f = File(d, "$prefix-$stamp-${n++}.$extension")
            f.createNewFile()
            return f
        }
    }
}
