"""
SIH 26171 — Phase 4 FastAPI app.

Errors are values, not exceptions, at this boundary too — mirrors the
extension's own CaptureResponse convention (types.ts): a VLM call can fail
in ordinary, expected ways (missing key, rate limit, malformed JSON from a
free-tier model), and the client needs a structured reason, not a raw 500.
"""

from __future__ import annotations

from fastapi import FastAPI

from .schemas import PlanActionRequest
from . import vlm_client

app = FastAPI(title="PrivacyLens action planner", version="0.1.0")


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
