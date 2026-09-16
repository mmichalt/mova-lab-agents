# Local tool-calling smoke (AG-014)

Ordinary `npm test` scripts native `tool_calls` against a fake Ollama and does
not prove that `qwen3:4b-instruct` emits argument objects. Record live results
here after `npm run smoke:tools`.

**Status:** Not yet run on this workstation. Command:
`npm run smoke:tools` (Compose `local-model` Ollama, stub search, no Mova-Lab).

Expected report fields: `nativeToolCalls`, `argumentObjects`, `searchExecuted`,
`toolMessages`, `finalVocabularyHadFormat`, `finalVocabularyHadTools`,
`vocabularyValid`. A run with `nativeToolCalls: 0` is a failed tool smoke even
if later generation quality is acceptable.
