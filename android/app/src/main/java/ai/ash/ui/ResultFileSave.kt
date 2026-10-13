package ai.ash.ui

import org.json.JSONObject
import java.security.MessageDigest

internal data class ResultFileSnapshot(val name: String, val mediaType: String, val bytes: ByteArray)
/** Metadata and bytes come only from the native authenticated fixed Core snapshot route. */
internal fun parseResultFileSnapshot(raw: ByteArray, decode: (String) -> ByteArray = { android.util.Base64.decode(it, android.util.Base64.NO_WRAP) }): ResultFileSnapshot {
    require(raw.size <= 5_600_000)
    val root = JSONObject(raw.toString(Charsets.UTF_8)); require(root.getBoolean("ok"))
    val result = root.getJSONObject("result"); val asset = result.getJSONObject("asset")
    val name = asset.getString("display_name"); val mime = asset.getString("media_type")
    require(name.isNotBlank() && name.length <= 256 && name.none { it == '/' || it == '\\' || it.isISOControl() })
    val extension = name.substringAfterLast('.', "").lowercase()
    require(when(mime) { "image/png" -> extension == "png"; "image/jpeg" -> extension in setOf("jpg", "jpeg"); "text/plain" -> extension == "txt"; "text/markdown" -> extension == "md"; else -> false })
    val length = asset.getLong("byte_length"); require(length in 0..4_194_304)
    val encoded = result.getString("bytes_base64"); require(encoded.length <= 5_592_408)
    require(Regex("(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?").matches(encoded))
    val bytes = decode(encoded)
    require(bytes.size.toLong() == length)
    val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    require(Regex("[a-f0-9]{64}").matches(asset.getString("sha256")) && hash == asset.getString("sha256"))
    return ResultFileSnapshot(name, mime, bytes)
}

/** The authenticated human stream is verified against the exact prepared asset before saving. */
internal fun parseStreamedResultFile(asset: JSONObject, bytes: ByteArray): ResultFileSnapshot {
    val name = asset.getString("display_name"); val mime = asset.getString("media_type")
    require(name.isNotBlank() && name.length <= 256 && name.none { it == '/' || it == '\\' || it.isISOControl() })
    val extension = name.substringAfterLast('.', "").lowercase()
    require(when(mime) { "image/png" -> extension == "png"; "image/jpeg" -> extension in setOf("jpg", "jpeg"); "text/plain" -> extension == "txt"; "text/markdown" -> extension == "md"; else -> false })
    val length = asset.getLong("byte_length"); require(length in 0..4_194_304 && bytes.size.toLong() == length)
    val hash = MessageDigest.getInstance("SHA-256").digest(bytes).joinToString("") { "%02x".format(it.toInt() and 255) }
    require(Regex("[a-f0-9]{64}").matches(asset.getString("sha256")) && hash == asset.getString("sha256"))
    return ResultFileSnapshot(name, mime, bytes)
}
