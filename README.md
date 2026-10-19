# rlcoach (embedded)

Subset of rlcoach bundled with RocketPrismas. It analyzes `*.prismas.json`
recordings made by `Recorder` (see `../../recorder.js`). Use it through
`python tools/analyze_match.py` from the RocketPrismas root.

- Format spec: `docs/prismas_recording_format.md`
- Adapter: `src/rlcoach/parser/prismas_adapter.py`
- Tests: `pip install pytest jsonschema && pytest` (from this folder)
- Only dependency to run: `jsonschema`
