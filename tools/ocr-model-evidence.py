"""Inspect pinned models, verify real dynamic batches, and prepare benchmark dictionaries (not app assets)."""
import hashlib
import json
import pathlib
import sys

import numpy as np
import onnxruntime as ort
import yaml

root = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ash-ocr-fast-models")
asset = pathlib.Path("android/app/src/main/assets/perception/ppocrv6_dict.txt").read_text().removesuffix("\n").split("\n")
evidence = {"runtime": ort.__version__, "providers": ort.get_available_providers(), "models": []}
options = ort.SessionOptions()
options.intra_op_num_threads = 2
for tier in ("medium", "small", "tiny"):
    for kind in ("det", "rec"):
        model = root / tier / kind / "inference.onnx"
        config = yaml.safe_load(model.with_suffix(".yml").read_text())
        session = ort.InferenceSession(str(model), options, providers=["CPUExecutionProvider"])
        row = {"tier": tier, "kind": kind, "bytes": model.stat().st_size, "sha256": hashlib.sha256(model.read_bytes()).hexdigest(), "input": session.get_inputs()[0].shape, "output": session.get_outputs()[0].shape}
        if kind == "rec":
            chars = config["PostProcess"]["character_dict"]
            row.update(dictionary_size=len(chars), matches_app_dictionary=chars == asset, preprocess=config["PreProcess"])
            # Generated benchmark artifact only; tiny must never be decoded with the app's small/medium dictionary.
            (root / tier / "dictionary.txt").write_text("\n".join(chars) + "\n")
            row["batch_runs"] = []
            for batch, width in ((1, 17), (1, 20), (1, 21), (1, 28), (1, 29), (2, 160), (3, 328), (1, 3200)):
                output = session.run(None, {"x": np.zeros((batch, 3, 48, width), np.float32)})[0]
                row["batch_runs"].append({"input": [batch, 3, 48, width], "output": list(output.shape)})
        else:
            row["postprocess"] = config["PostProcess"]
        evidence["models"].append(row)
ori = ort.InferenceSession(str(root / "shared/ori/inference.onnx"), options)
evidence["orientation"] = {"input": ori.get_inputs()[0].shape, "batch3_output": list(ori.run(None, {"x": np.zeros((3, 3, 80, 160), np.float32)})[0].shape)}
print(json.dumps(evidence, ensure_ascii=False, indent=2))
