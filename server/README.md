# PrivacyLens — action-planner server (Phase 4)

FastAPI service that takes an **already-sanitized** screenshot (text masked
by 3a, faces blurred by 3b) plus its redaction manifest (3c) and a task
description, and returns one next browser action from a vision-language
model. This is `fixture-first`: built and tested against a synthetic fixture
so far, not yet wired to the real extension (that's Phase 5).

## Setup

```bash
cd server
pip install -r requirements.txt
cp .env.example .env
```

Get a free API key at [openrouter.ai/keys](https://openrouter.ai/keys)
(email or GitHub, no card required) and paste it into `.env` as
`OPENROUTER_API_KEY`. Never commit `.env` — it's gitignored.

The default model (`app/config.py`'s `DEFAULT_MODEL`) is a free,
vision-capable OpenRouter listing, so you can run everything below without
spending anything. Free-tier models rotate and rate-limit hard — if it
404s, check [openrouter.ai/models](https://openrouter.ai/models) for a
current `:free` vision listing, or set `VLM_MODEL` in `.env` to a paid model
(e.g. `qwen/qwen3-vl-30b-a3b-instruct`, the recommended choice once you're
ready to spend a little for better GUI-grounding accuracy).

## Running

```bash
uvicorn app.main:app --reload
```

## Testing

```bash
pytest
```

All 16 tests run offline — `vlm_client.plan_action`'s actual HTTP call is
never exercised by the unit tests (same philosophy as the extension's
face-detector.ts: pure logic is tested, the real model call is verified
manually against the live API, not mocked into false confidence).

## Manual smoke test (needs a real API key)

Regenerate the fixture if you've changed it, then hit the running server:

```bash
python fixtures/generate_fixture.py
curl -X POST http://localhost:8000/plan-action \
  -H "Content-Type: application/json" \
  -d @fixtures/sample_capture.json
```

Expect `{"ok": true, "action": {...}}` with one of `click`/`type`/`scroll`/
`done`. A `{"ok": false, "error": ...}` response is not a bug — it's the
same error-as-value convention the extension uses (`CaptureResponse` in
`types.ts`); read the `error` string (missing key, rate limit, malformed
model output after `response_format: json_object`, etc).

## What's NOT here yet

- **Phase 5**: no WebSocket, no wiring to the real extension — the client
  sends nothing to this server yet. `/plan-action` is a plain HTTP POST for
  now, matching the roadmap's "fixture-first" scope.
- **Constrained decoding** is prompt + post-hoc Pydantic validation
  (`response_format: {"type": "json_object"}`), not true grammar-constrained
  decoding — OpenRouter's underlying providers don't uniformly support
  `json_schema` mode, so this is the honest, broadly-compatible middle
  ground. If you pin to a single provider later that supports `json_schema`
  natively, tightening this is a `vlm_client.py`-only change.
