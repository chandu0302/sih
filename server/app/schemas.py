"""
SIH 26171 — Phase 4 request/response contracts.

Mirrors extension/src/types.ts's ImageBox / RedactionRegion / RedactionManifest
shapes deliberately, field-for-field, so the two sides of the eventual Phase 5
wire-up agree without translation. `type` on RedactionRegion is a loose str
here rather than a literal enum of the 12 PiiType values — the server has no
reason to reject a manifest over a label it doesn't recognize; that decision
belongs to the client (see ner-detector.ts's mapNerLabel: "unknown label ->
drop, don't guess"), not this boundary.
"""

from __future__ import annotations

from typing import Literal, Optional

from pydantic import BaseModel, Field, model_validator


class ImageBox(BaseModel):
    x: float
    y: float
    w: float
    h: float


class RedactionRegion(BaseModel):
    type: str
    bbox: ImageBox
    nodeId: Optional[str] = None
    confidence: float


class RedactionManifest(BaseModel):
    regions: list[RedactionRegion] = Field(default_factory=list)


class PlanActionRequest(BaseModel):
    """One planning step's input. `image` is the ALREADY-SANITIZED screenshot
    (3a text-masked, 3b face-blurred) — this server never receives raw
    pixels; that is the whole point of the client-side pipeline."""

    image: str  # data:image/png;base64,...
    manifest: RedactionManifest
    task: str


class AskRequest(BaseModel):
    """One Q&A turn's input — same sanitized-image contract as
    PlanActionRequest, `question` instead of `task` since the answer is
    free text, not a structured action."""

    image: str  # data:image/png;base64,...
    manifest: RedactionManifest
    question: str


class ClickTarget(BaseModel):
    x: int
    y: int


class ActionCommand(BaseModel):
    """One VLM-planned next step. Required fields depend on `action` —
    enforced by the validator below rather than four separate response
    models, so callers always deal with one shape."""

    action: Literal["click", "type", "scroll", "done"]
    target: Optional[ClickTarget] = None
    text: Optional[str] = None
    scroll_direction: Optional[Literal["up", "down"]] = None
    reasoning: str = ""

    @model_validator(mode="after")
    def _check_required_fields(self) -> "ActionCommand":
        if self.action == "click" and self.target is None:
            raise ValueError("action 'click' requires target {x, y}")
        if self.action == "type" and not self.text:
            raise ValueError("action 'type' requires non-empty text")
        if self.action == "scroll" and self.scroll_direction is None:
            raise ValueError("action 'scroll' requires scroll_direction")
        return self
