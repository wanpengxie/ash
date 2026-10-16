"""Summarize raw production Kotlin results; no OCR implementation lives here."""
import json
import math
import statistics
import sys

rows = [r for filename in sys.argv[1:] for r in json.load(open(filename))["runs"]]
def quantile(values, q):
    ordered = sorted(values)
    return ordered[max(0, math.ceil(len(ordered) * q) - 1)]
metrics = ["totalMs", "detectMs", "prepareMs", "orientationMs", "inferenceMs", "decodeMs"]
print("config fixture state n total_p50 total_p95 det_p50 prepare_p50 ori_p50 rec_p50 decode_p50 CER_percent missed")
for config in sorted({r["config"] for r in rows}):
    medians = []
    for fixture in sorted({r["fixture"] for r in rows if r["config"] == config}):
        for state in ("cold", "warm"):
            group = [r for r in rows if r["config"] == config and r["fixture"] == fixture and (r["iteration"] == -2 if state == "cold" else r["iteration"] >= 0)]
            if not group:
                continue
            med = {m: statistics.median(r[m] for r in group) for m in metrics}
            cer = group[0]["editDistance"] / max(1, group[0]["expectedCharacters"])
            print(config, fixture, state, len(group), *(f"{v:.2f}" for v in (med["totalMs"], quantile([r["totalMs"] for r in group], .95), *(med[m] for m in metrics[1:]), cer * 100)), group[0]["missingLines"])
            if state == "warm" and fixture.isdigit():
                medians.append((int(fixture), med["totalMs"]))
    if len(medians) > 1:
        mx = statistics.mean(x for x, y in medians)
        my = statistics.mean(y for x, y in medians)
        slope = sum((x - mx) * (y - my) for x, y in medians) / sum((x - mx) ** 2 for x, y in medians)
        intercept = my - slope * mx
        residual = sum((y - intercept - slope * x) ** 2 for x, y in medians)
        total = sum((y - my) ** 2 for x, y in medians)
        print(f"fit {config}: {intercept:.2f} ms + {slope:.2f} ms/line; R2={1-residual/total:.4f}")
