#!/usr/bin/env bash
set -euo pipefail
# No floating revisions; the cache lives outside the checkout.
cache=${1:-/tmp/ash-ocr-fast-models}
fetch() {
  local tier=$1 kind=$2 repo=$3 rev=$4 bytes=$5 sha=$6
  local dir="$cache/$tier/$kind"
  mkdir -p "$dir"
  if ! test -f "$dir/inference.onnx"; then
    curl -fL --retry 3 "https://huggingface.co/PaddlePaddle/$repo/resolve/$rev/inference.onnx" -o "$dir/inference.onnx.part"
    test "$(wc -c < "$dir/inference.onnx.part")" -eq "$bytes"
    printf '%s  %s\n' "$sha" "$dir/inference.onnx.part" | sha256sum -c -
    mv "$dir/inference.onnx.part" "$dir/inference.onnx"
  fi
  printf '%s  %s\n' "$sha" "$dir/inference.onnx" | sha256sum -c -
  curl -fsSL --retry 3 "https://huggingface.co/PaddlePaddle/$repo/resolve/$rev/inference.yml" -o "$dir/inference.yml"
}
fetch medium det PP-OCRv6_medium_det_onnx 61323801669c338b7891481ec7bac61ce31b576a 62032837 eb13b44b25bb36f89528b68720af8a61d9cf381176107f465db1757b65d086e1
fetch medium rec PP-OCRv6_medium_rec_onnx 50c7eacafc52fa7bcf4194e8cd08e46f8558504b 76554979 9c09abf0957f7968c7586464b7397b84ad2387a0497a351af40e9acc71b673ba
fetch small det PP-OCRv6_small_det_onnx 28fe5895c24fd108c19eb3e8479f4ab385fbfc62 9880512 d73e0058b7a8086bbd57f3d10b8bcd4ff95363f67e06e2762b5e814fe9c9410e
fetch small rec PP-OCRv6_small_rec_onnx b8f84f0b80c529de40b4fbb3544b84fa7233a513 21159378 5435fd747c9e0efe15a96d0b378d5bd157e9492ed8fd80edf08f30d02fa24634
fetch tiny det PP-OCRv6_tiny_det_onnx 2ba1506c0380b8f0b03dd142459aac66d4421f6c 1780590 193bab7a04fca699a6c82e6abb5b81bdb28177f0abd4062552b04908dafb19f8
fetch tiny rec PP-OCRv6_tiny_rec_onnx 2612ab37152ae0a677521bae4e1e3d4fb4cf7c30 4462639 9ef676d6ed3c88256a2d92c640c44f25b0c40947e111b14b8be8f594091563e6
fetch shared ori PP-LCNet_x0_25_textline_ori_onnx aea1f18d97338aaf84b463f90192f2820524a00a 1019454 94a6a0a0425f2b5f08b5df72086f2d72abe40f1d22f6d12d2cd83674f11f2ff3
for tier in medium small tiny; do
  if ! test -e "$cache/$tier/ori"; then ln -s ../shared/ori "$cache/$tier/ori"; fi
done
