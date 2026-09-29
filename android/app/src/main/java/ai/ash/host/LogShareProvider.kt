package ai.ash.host

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
 * Shares log files as files (targetSdk 28 forbids file:// URIs and this app has no AndroidX
 * FileProvider): a minimal read-only provider over cache/share/ only, one flat file name per URI.
 */
class LogShareProvider : ContentProvider() {
    override fun onCreate() = true

    private fun resolve(uri: Uri): File? {
        val name = uri.lastPathSegment ?: return null
        if (name.isEmpty() || name.contains('/') || name.contains('\\') || name.contains("..")) return null
        return File(shareDir(context ?: return null), name)
    }

    override fun getType(uri: Uri) = "text/plain"

    override fun query(uri: Uri, projection: Array<out String>?, selection: String?, selectionArgs: Array<out String>?, sortOrder: String?): Cursor? {
        val f = resolve(uri)?.takeIf { it.exists() } ?: return null
        val cols = if (projection.isNullOrEmpty()) arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE) else projection
        return MatrixCursor(cols, 1).apply {
            addRow(cols.map { c -> when (c) { OpenableColumns.DISPLAY_NAME -> f.name; OpenableColumns.SIZE -> f.length(); else -> null } }.toTypedArray())
        }
    }

    override fun openFile(uri: Uri, mode: String): ParcelFileDescriptor {
        val f = resolve(uri)?.takeIf { it.exists() } ?: throw FileNotFoundException(uri.toString())
        return ParcelFileDescriptor.open(f, ParcelFileDescriptor.MODE_READ_ONLY)
    }

    override fun insert(uri: Uri, values: ContentValues?): Uri? = null
    override fun delete(uri: Uri, selection: String?, selectionArgs: Array<out String>?) = 0
    override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<out String>?) = 0

    companion object {
        fun shareDir(ctx: Context) = File(ctx.cacheDir, "share").apply { mkdirs() }
        fun uriFor(ctx: Context, name: String): Uri = Uri.parse("content://${ctx.packageName}.logshare/$name")
    }
}
