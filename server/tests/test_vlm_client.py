import json

import pytest

from app.schemas import PlanActionRequest
from app.vlm_client import build_payload, parse_action


@pytest.fixture()
def sample_request() -> PlanActionRequest:
    return PlanActionRequest.model_validate(
        {
            "image": "data:image/png;base64,AAAA",
            "manifest": {
                "regions": [
                    {"type": "PHONE", "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}, "confidence": 0.9},
                    {"type": "PHONE", "bbox": {"x": 5, "y": 6, "w": 3, "h": 4}, "confidence": 0.8},
                    {"type": "FACE", "bbox": {"x": 9, "y": 9, "w": 3, "h": 4}, "confidence": 0.95},
                ]
            },
            "task": "click the submit button",
        }
    )


def test_build_payload_includes_model_and_image(sample_request):
    payload = build_payload(sample_request, "some/model")

    assert payload["model"] == "some/model"
    assert payload["response_format"] == {"type": "json_object"}

    user_message = payload["messages"][1]
    assert user_message["role"] == "user"
    image_part = next(p for p in user_message["content"] if p["type"] == "image_url")
    assert image_part["image_url"]["url"] == sample_request.image


def test_build_payload_summarizes_manifest_by_type_count(sample_request):
    payload = build_payload(sample_request, "some/model")
    text_part = payload["messages"][1]["content"][0]["text"]

    assert "2 PHONE" in text_part
    assert "1 FACE" in text_part
    assert "click the submit button" in text_part


def test_build_payload_handles_empty_manifest():
    req = PlanActionRequest.model_validate(
        {"image": "data:image/png;base64,AAAA", "manifest": {}, "task": "scroll down"}
    )
    payload = build_payload(req, "some/model")
    text_part = payload["messages"][1]["content"][0]["text"]

    assert "no redacted regions" in text_part


def test_parse_action_accepts_valid_json():
    content = json.dumps({"action": "done", "reasoning": "finished"})
    action = parse_action(content)
    assert action.action == "done"


def test_parse_action_rejects_non_json():
    with pytest.raises(ValueError, match="not valid JSON"):
        parse_action("not json at all")


def test_parse_action_rejects_schema_violation():
    # click with no target — same rule ActionCommand's validator enforces.
    content = json.dumps({"action": "click", "reasoning": "clicking"})
    with pytest.raises(Exception):
        parse_action(content)
