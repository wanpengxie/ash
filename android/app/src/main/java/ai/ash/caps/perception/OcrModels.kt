package ai.ash.caps.perception

import java.io.File

/**
 * The PP-OCRv6 medium models (Apache-2.0, PaddlePaddle on Hugging Face, the ONNX exports) pinned to a commit, so the bytes
 * never change under the checksum. The second address of each is a public mirror of the same repository for networks that
 * cannot reach Hugging Face; the checksum makes the mirror no more trusted than the first.
 */
object OcrModels {
    private fun urls(repo: String, revision: String) = listOf("https://huggingface.co", "https://hf-mirror.com").map { "$it/PaddlePaddle/$repo/resolve/$revision/inference.onnx" }

    val DET = ModelFile("ppocrv6-medium-det", urls("PP-OCRv6_medium_det_onnx", "61323801669c338b7891481ec7bac61ce31b576a"), 62_032_837L,
        "eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1")
    val REC = ModelFile("ppocrv6-medium-rec", urls("PP-OCRv6_medium_rec_onnx", "50c7eacafc52fa7bcf4194e8cd08e46f8558504b"), 76_554_979L,
        "9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba")
    /** Text-line orientation (upright or upside down), 1 MB. */
    val ORI = ModelFile("pplcnet-textline-ori", urls("PP-LCNet_x0_25_textline_ori_onnx", "aea1f18d97338aaf84b463f90192f2820524a00a"), 1_019_454L,
        "94a6a0a0425f2b5f08b5df72086f2d72abe40f1d22f6d12d2cd83674f11f2ff3")

    val ALL = listOf(DET, REC, ORI)

    /** The reader's dictionary (from the recognition model's inference.yml), one character per line; shipped in the app because it is 73 KB. */
    const val DICTIONARY_ASSET = "perception/ppocrv6_dict.txt"

    fun dir(filesDir: File) = File(filesDir, "perception/ocr")

    /** Characters in dictionary order. Split on newline only: the dictionary holds characters that other line breaks would cut. */
    fun parseDictionary(text: String): List<String> = text.removeSuffix("\n").split('\n')
}
