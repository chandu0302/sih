"""
SIH 26171 — Phase 4 FastAPI app.

Errors are values, not exceptions, at this boundary too — mirrors the
extension's own CaptureResponse convention (types.ts): a VLM call can fail
in ordinary, expected ways (missing key, rate limit, malformed JSON from a
free-tier model), and the client needs a structured reason, not a raw 500.
"""

from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from .schemas import PlanActionRequest
from . import vlm_client

app = FastAPI(title="PrivacyLens action planner", version="0.1.0")

# Phase 5: the extension's side panel (chrome-extension://<id>) calls this
# server directly. <all_urls> in manifest.json's host_permissions already
# lets the extension bypass CORS on its end, but permissive CORS here too
# means this also works if that assumption is ever wrong, and costs nothing
# for a local-dev-only server with no auth of its own to leak.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
def health() -> dict:
    return {"ok": True}


@app.post("/plan-action")
async def plan_action_endpoint(req: PlanActionRequest) -> dict:
    try:
        action = await vlm_client.plan_action(req)
    except Exception as err:  # noqa: BLE001 — deliberately broad, see module doc
        return {"ok": False, "error": str(err)}

    return {"ok": True, "action": action.model_dump()}
