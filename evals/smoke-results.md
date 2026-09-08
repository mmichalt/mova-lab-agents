# Local generation smoke (AG-006)

Recorded 2026-09-08 on Ubuntu 26.04 LTS / WSL2, Node 24, Docker Desktop.
Command: `npm run smoke:local` against host `npm run dev` and Compose
`local-model` Ollama. Ordinary `npm test` was not used for these figures.

The script writes wall time, HTTP status, GPU share, hardware, and property
checks to stdout. That JSON is saved as [`smoke-report.json`](smoke-report.json)
(`gpuPercent` 100, all HTTP 200, no truncation). Token and load columns are
**not** in the HTTP body; they come from matching `llm attempt completed`
log lines on the same `requestId`. Application `attemptId` values were logged;
provider request IDs were not fabricated.

## Reproducing this baseline

| Field | Value |
| --- | --- |
| Prompt | `content-drafts/v1` |
| Model tag | `qwen3:4b-instruct` |
| Digest | `0edcdef34593eac1aa2be9c7d06c432dcf81945adca5eca2f27662c18f168ba0` |
| Quantization | `Q4_K_M` |
| Ollama | `0.33.3` (`ollama/ollama:0.33.3@sha256:32931b46719f673c05fdbaa81ccb26da18ea4a1c57590a754874ab28ba269eb2`) |
| `num_ctx` / `num_predict` | 4096 / 2000 |
| Temperature | 0.3 |
| Parallel / loaded models | 1 / 1 |
| Hardware | 14th-gen i7, 32 GB RAM, NVIDIA GeForce RTX 5060 Laptop GPU **8151 MiB** (`nvidia-smi`) |

Identical wording is not expected. Compare later runs by digest, prompt version,
and these settings. The script exits non-zero on HTTP failure, truncation, or
GPU share other than 100%. Property failures are recorded and do not fail the
process.

## GPU

After the verified cold mixed request, `GET /api/ps` reported `size` =
`size_vram` = 3178149969 (~3.2 GB), **100% GPU**. `ollama ps` showed
`qwen3:4b-instruct ... 3.2 GB  100% GPU  4096`. No CPU offload. The script
unloaded the model (`keep_alive: 0`) and waited until `/api/ps` was empty
before timing the cold run.

## Latency (script) and usage (server logs)

`estimatedCostUsd` stayed `null`.

| Run | requestId | Wall (script) | Load (log) | Input | Cached | Output |
| --- | --- | --- | --- | --- | --- | --- |
| Cold mixed Р/Л (6) | `cc599193-0b8c-4353-98d9-19d6b7146293` | 14307 ms | 1.84 s | 100 | 0 | 786 |
| Warm mixed Р/Л (6) | `ac186928-222b-4a1d-9993-3689fac2dad9` | 12820 ms | 0.74 ms | 100 | 99 | 790 |
| Р only (6) | `f5b9f228-84e3-47d6-8d0d-b40070fd939d` | 10579 ms | 0.59 ms | 91 | 52 | 768 |
| Л only (6) | `75de70dd-0edb-486d-8433-4e734d8c286c` | 10898 ms | 0.59 ms | 94 | 52 | 753 |
| Max 12 mixed | `3c1709e1-69d4-4b5a-831b-d15d4a88c2b9` | 21280 ms | 1.03 ms | 108 | 52 | 1452 |

Cold load is the model-load cost after a confirmed unload. Warm load is
sub-millisecond.

## Structured output and properties

Every case returned schema-valid proposals with `requiresHumanApproval: true`.
Four of five cases passed every property. **Л only failed `literal-target-letter`**
(at least one phrase lacked the Cyrillic letter `л`). Mixed and max-12 cases
covered both requested sounds.

These properties are not phonetic, hard/soft, or therapeutic validation.
Letter presence can pass for nonsense or ungrammatical lines and can fail
on otherwise Ukrainian text.

## Context / output budget

No run returned `PROVIDER_INCOMPLETE`. Max output was 1452 tokens of a 2000
allowance; max prompt-side count was 108 of 4096. **4096 context and 2000
output sufficed** for the 12-exercise case. Defaults stay as documented; do
not raise them without a later measured miss. Truncated output was not labeled
success.
