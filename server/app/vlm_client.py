"""
SIH 26171 — Phase 4 VLM client.

Split the same way face-detector.ts splits letterbox geometry from the real
inference call: build_payload() and parse_action() are pure and unit-tested;
plan_action() is the thin, untested-by-unit-test I/O wrapper around them,
verified against the real API separately (see server/README.md's manual
smoke-test step) — a mocked HTTP response would only prove a mock behaves
like a mock.

CONSTRAINED DECODING: OpenRouter proxies many different underlying providers,
whose support for grammar-constrained / json_schema decoding is inconsistent.
`response_format: {"type": "json_object"}` is the one option broadly
supported across providers, so correctness is enforced in two layers instead
of relying on the model alone: (1) a strict system prompt spelling out the
exact schema, (2) parse_action() validating the result through ActionCommand
— a malformed or schema-violating response raises here rather than silently
producing a garbage action.
"""

from __future__ import annotations

import json

import httpx

from .config import OPENROUTER_URL, get_api_key, get_model
from .schemas import ActionCommand, AskRequest, PlanActionRequest, RedactionManifest

SYSTEM_PROMPT = """You are a browser-automation planner for PrivacyLens.

You receive a SANITIZED screenshot of a web page: some regions were masked \
(solid black boxes) or blurred by an on-device privacy layer BEFORE this \
image was ever sent anywhere. You also receive a redaction manifest \
describing WHERE those regions are and WHAT TYPE of information was there \
(never the actual content, which never left the user's device). Treat \
masked/blurred regions as opaque — do not ask about them, guess their \
content, or refuse to proceed because of them.

Given the task and the current screenshot, decide exactly ONE next action.

Respond with ONLY a JSON object, no other text, matching this schema:
{"action": "click" | "type" | "scroll" | "done",
 "target": {"x": <int>, "y": <int>} | null,
 "text": <string> | null,
 "scroll_direction": "up" | "down" | null,
 "reasoning": <string>}

Rules:
- "click": target is required (the image-pixel coordinates to click).
- "type": text is required (what to type into the currently focused field).
- "scroll": scroll_direction is required.
- "done": the task is already complete; other fields may be null.
- Never target a masked or blurred region.
"""

ASK_SYSTEM_PROMPT = """You are a helpful assistant answering questions about a web page for PrivacyLens.

You receive a SANITIZED screenshot of a web page: some regions were masked \
(solid black boxes) or blurred by an on-device privacy layer BEFORE this \
image was ever sent anywhere. You also receive a redaction manifest \
describing WHERE those regions are and WHAT TYPE of information was there \
(never the actual content, which never left the user's device).

Answer the user's question about the page using only what you can actually \
see in the screenshot. If the question asks about the CONTENT of a masked \
or blurred region specifically, say plainly that it was redacted on-device \
and you cannot see it — never guess, invent, or infer what a redacted \
region might contain, even from context. Answer in plain text, not JSON.
"""


def _summarize_manifest(manifest: RedactionManifest) -> str:
    if not manifest.regions:
        return "(no redacted regions in this capture)"

    counts: dict[str, int] = {}
    for region in manifest.regions:
        counts[region.type] = counts.get(region.type, 0) + 1

    return ", ".join(f"{count} {label}" for label, count in counts.items())


def build_payload(req: PlanActionRequest, model: str) -> dict:
    user_text = (
        f"Task: {req.task}\n\n"
        f"Redacted regions in this screenshot: {_summarize_manifest(req.manifest)}"
    )

    return {
        "model": model,
        "response_format": {"type": "json_object"},
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": req.image}},
                ],
            },
        ],
    }


def parse_action(content: str) -> ActionCommand:
    try:
        parsed = json.loads(content)
    except json.JSONDecodeError as err:
        raise ValueError(f"VLM response was not valid JSON: {err}") from err

    return ActionCommand.model_validate(parsed)


def build_ask_payload(req: AskRequest, model: str) -> dict:
    user_text = (
        f"Question: {req.question}\n\n"
        f"Redacted regions in this screenshot: {_summarize_manifest(req.manifest)}"
    )

    return {
        "model": model,
        # Deliberately NO response_format here — this is a free-text answer,
        # not a structured action; forcing json_object would just make the
        # model wrap a plain answer in JSON for no reason.
        "messages": [
            {"role": "system", "content": ASK_SYSTEM_PROMPT},
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": user_text},
                    {"type": "image_url", "image_url": {"url": req.image}},
                ],
            },
        ],
    }


def parse_answer(content: str) -> str:
    answer = content.strip()
    if not answer:
        raise ValueError("VLM returned an empty answer.")
    return answer


def check_response(response: httpx.Response) -> None:
    """response.raise_for_status() alone discards the body — and OpenRouter,
    like most APIs, puts the actually-useful reason for a 4xx/5xx there
    (e.g. {"error": {"message": "..."}}), not in the terse status-line
    summary httpx raises. Surface it instead of guessing."""
    if response.is_error:
        raise RuntimeError(
            f"OpenRouter request failed ({response.status_code}): {response.text[:1000]}"
        )


def extract_content(data: dict) -> str:
    """A 200 OK response can still have an unexpected BODY shape —
    check_response only catches HTTP-status errors, not this. Verified bug:
    when it happened live, data["choices"][0]["message"]["content"] raised a
    bare KeyError, whose str() is just the missing key's repr — the chat
    literally showed the message "'choices'" with no other context. Same
    "surface the real reason" principle as check_response, applied to the
    body shape instead of the status code."""
    try:
        return data["choices"][0]["message"]["content"]
    except (KeyError, IndexError, TypeError) as err:
        raise RuntimeError(
            f"Unexpected OpenRouter response shape (missing {err}): {json.dumps(data)[:1000]}"
        ) from err


async def _call_openrouter(payload: dict) -> str:
    """Shared by plan_action and ask_question — the HTTP call and response
    unwrapping are identical; only how the resulting content is parsed
    differs (parse_action vs. parse_answer)."""
    api_key = get_api_key()

    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.post(
            OPENROUTER_URL,
            headers={"Authorization": f"Bearer {api_key}"},
            json=payload,
        )
        check_response(response)
        data = response.json()

    return extract_content(data)


async def plan_action(req: PlanActionRequest) -> ActionCommand:
    payload = build_payload(req, get_model())
    content = await _call_openrouter(payload)
    return parse_action(content)


async def ask_question(req: AskRequest) -> str:
    payload = build_ask_payload(req, get_model())
    content = await _call_openrouter(payload)
    return parse_answer(content)
