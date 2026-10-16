package ai.ash.caps.perception

import java.io.File

/**
 * The PP-OCRv6 small models (Apache-2.0, PaddlePaddle on Hugging Face, the ONNX exports) pinned to a commit, so the bytes
 * never change under the checksum. The second address of each is a public mirror of the same repository for networks that
 * cannot reach Hugging Face; the checksum makes the mirror no more trusted than the first.
 */
object OcrModels {
    private fun urls(repo: String, revision: String) = listOf("https://huggingface.co", "https://hf-mirror.com").map { "$it/PaddlePaddle/$repo/resolve/$revision/inference.onnx" }

    val DET = ModelFile("ppocrv6-small-det", urls("PP-OCRv6_small_det_onnx", "28fe5895c24fd108c19eb3e8479f4ab385fbfc62"), 9_880_512L,
        "d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e")
    val REC = ModelFile("ppocrv6-small-rec", urls("PP-OCRv6_small_rec_onnx", "b8f84f0b80c529de40b4fbb3544b84fa7233a513"), 21_159_378L,
        "5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634")
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
