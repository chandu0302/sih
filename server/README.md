# PrivacyLens — action-planner / Q&A server (Phase 4)

FastAPI service that takes an **already-sanitized** screenshot (text masked
by 3a, faces blurred by 3b) plus its redaction manifest (3c), and either:

- **`POST /plan-action`** — given a task description, returns one next
  browser action (click/type/scroll/done) from a vision-language model.
  Wired to the real extension (Phase 5, verified live) — the side panel's
  Agent mode calls this directly.
- **`POST /ask`** — given a free-text question, returns a plain-text answer
  from the same VLM. The side panel's Ask mode calls this directly.

Both share one image+manifest contract; only `task` vs. `question` differs,
matching the structured-action vs. free-text-answer difference in what each
endpoint returns.

## Setup

```bash
cd server
pip install -r requirements.txt
cp .env.example .env
```

Get a free API key at [openrouter.ai/keys](https://openrouter.ai/keys)
(email or GitHub, no card required) and paste it into `.env` as
`OPENROUTER_API_KEY`. Never commit `.env` — it's gitignored.

The default model (`app/config.py`'s `DEFAULT_MODEL`, currently
`nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free`) is free and
vision-capable, so you can run everything below without spending anything.
Free-tier models rotate and rate-limit hard under load — already observed
live (a "temporarily rate-limited" / capacity error from the provider is
expected behavior, not a bug). If it 404s or rate-limits, check
[openrouter.ai/models](https://openrouter.ai/models) for a current `:free`
vision listing, or set `VLM_MODEL` in `.env` to a paid model (e.g.
`qwen/qwen3-vl-30b-a3b-instruct`, the recommended choice once you're ready
to spend a little for better GUI-grounding accuracy — the free-tier model's
click-target grounding has been observed to miss the intended element).

## Running

```bash
uvicorn app.main:app --reload
```

## Testing

```bash
pytest
```

All tests run offline — `vlm_client`'s actual HTTP call is never exercised
by the unit tests (same philosophy as the extension's face-detector.ts:
pure logic is tested, the real model call is verified manually against the
live API, not mocked into false confidence).

## Manual smoke test (needs a real API key)

Regenerate the fixture if you've changed it, then hit the running server:

```bash
python fixtures/generate_fixture.py

curl -X POST http://localhost:8000/plan-action \
  -H "Content-Type: application/json" \
  -d @fixtures/sample_capture.json

# /ask takes `question` where /plan-action takes `task` — same image+manifest
curl -X POST http://localhost:8000/ask \
  -H "Content-Type: application/json" \
  -d '{"image": "<paste the image field from sample_capture.json>", "manifest": {"regions": []}, "question": "What is this page?"}'
```

Expect `{"ok": true, "action": {...}}` (one of `click`/`type`/`scroll`/
`done`) from `/plan-action`, or `{"ok": true, "answer": "..."}` from `/ask`.
A `{"ok": false, "error": ...}` response is not a bug — it's the same
error-as-value convention the extension uses (`CaptureResponse` in
`types.ts`); read the `error` string (missing key, rate limit/capacity,
malformed model output, an unexpected response body shape from the
provider, etc — `vlm_client.py`'s `check_response`/`extract_content` both
surface the real reason rather than a generic failure).

## Known gaps

- **Constrained decoding** is prompt + post-hoc Pydantic validation
  (`response_format: {"type": "json_object"}` for `/plan-action`; no
  `response_format` at all for `/ask`, since that's free text), not true
  grammar-constrained decoding — OpenRouter's underlying providers don't
  uniformly support `json_schema` mode, so this is the honest,
  broadly-compatible middle ground. If you pin to a single provider later
  that supports `json_schema` natively, tightening this is a
  `vlm_client.py`-only change.
- **One action per Agent turn.** `/plan-action` plans exactly one next
  step; there's no multi-step loop or session state on the server side —
  each call is independent.
- **No auth, no rate limiting of its own.** This is a local-dev-only
  server with permissive CORS (see `app/main.py`) — not something to expose
  publicly as-is.
