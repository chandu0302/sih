import pytest
from pydantic import ValidationError

from app.schemas import ActionCommand, PlanActionRequest


def test_click_requires_target():
    with pytest.raises(ValidationError):
        ActionCommand(action="click", reasoning="x")

    cmd = ActionCommand(action="click", target={"x": 1, "y": 2}, reasoning="x")
    assert cmd.target.x == 1


def test_type_requires_text():
    with pytest.raises(ValidationError):
        ActionCommand(action="type", reasoning="x")

    cmd = ActionCommand(action="type", text="hello", reasoning="x")
    assert cmd.text == "hello"


def test_scroll_requires_direction():
    with pytest.raises(ValidationError):
        ActionCommand(action="scroll", reasoning="x")

    cmd = ActionCommand(action="scroll", scroll_direction="down", reasoning="x")
    assert cmd.scroll_direction == "down"


def test_done_needs_nothing_else():
    cmd = ActionCommand(action="done", reasoning="task finished")
    assert cmd.target is None
    assert cmd.text is None


def test_plan_action_request_parses_manifest():
    req = PlanActionRequest.model_validate(
        {
            "image": "data:image/png;base64,AAAA",
            "manifest": {
                "regions": [
                    {"type": "PHONE", "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}, "confidence": 0.9}
                ]
            },
            "task": "click submit",
        }
    )
    assert req.manifest.regions[0].type == "PHONE"
    assert req.manifest.regions[0].nodeId is None


def test_plan_action_request_defaults_empty_manifest():
    req = PlanActionRequest.model_validate(
        {"image": "data:image/png;base64,AAAA", "manifest": {}, "task": "x"}
    )
    assert req.manifest.regions == []
