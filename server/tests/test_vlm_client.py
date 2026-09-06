import json

import httpx
import pytest

from app.schemas import AskRequest, PlanActionRequest
from app.vlm_client import (
    build_ask_payload,
    build_payload,
    check_response,
    extract_content,
    parse_action,
    parse_answer,
)


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


@pytest.fixture()
def sample_ask_request() -> AskRequest:
    return AskRequest.model_validate(
        {
            "image": "data:image/png;base64,AAAA",
            "manifest": {
                "regions": [
                    {"type": "PHONE", "bbox": {"x": 1, "y": 2, "w": 3, "h": 4}, "confidence": 0.9},
                    {"type": "FACE", "bbox": {"x": 9, "y": 9, "w": 3, "h": 4}, "confidence": 0.95},
                ]
            },
            "question": "What kind of form is this?",
        }
    )


def test_build_ask_payload_has_no_response_format(sample_ask_request):
    # Free-text answer, not a structured action — forcing json_object would
    # just make the model wrap a plain answer in JSON for no reason.
    payload = build_ask_payload(sample_ask_request, "some/model")
    assert "response_format" not in payload


def test_build_ask_payload_includes_question_and_manifest_summary(sample_ask_request):
    payload = build_ask_payload(sample_ask_request, "some/model")
    text_part = payload["messages"][1]["content"][0]["text"]

    assert "What kind of form is this?" in text_part
    assert "1 PHONE" in text_part
    assert "1 FACE" in text_part


def test_build_ask_payload_includes_image(sample_ask_request):
    payload = build_ask_payload(sample_ask_request, "some/model")
    image_part = next(p for p in payload["messages"][1]["content"] if p["type"] == "image_url")
    assert image_part["image_url"]["url"] == sample_ask_request.image


def test_parse_answer_strips_whitespace():
    assert parse_answer("  It's a contact form.  \n") == "It's a contact form."


def test_parse_answer_rejects_empty_answer():
    with pytest.raises(ValueError, match="empty answer"):
        parse_answer("   ")


def test_extract_content_returns_the_message_content():
    data = {"choices": [{"message": {"content": "hello"}}]}
    assert extract_content(data) == "hello"


def test_extract_content_raises_a_clear_error_when_choices_is_missing():
    # The real bug found live: a 200 OK response with no "choices" key
    # raised a bare KeyError whose str() is just "'choices'" — a chat
    # message with no other context. This must include the actual body.
    data = {"error": {"message": "model temporarily unavailable"}}
    with pytest.raises(RuntimeError, match="model temporarily unavailable"):
        extract_content(data)


def test_extract_content_raises_a_clear_error_when_choices_is_empty():
    data = {"choices": []}
    with pytest.raises(RuntimeError, match="Unexpected OpenRouter response shape"):
        extract_content(data)


def _fake_response(status_code: int, body: str) -> httpx.Response:
    return httpx.Response(status_code, text=body, request=httpx.Request("POST", "https://example.test"))


def test_check_response_passes_through_on_success():
    check_response(_fake_response(200, '{"ok": true}'))  # must not raise


def test_check_response_surfaces_the_body_on_error():
    body = '{"error": {"message": "model does not support response_format"}}'
    with pytest.raises(RuntimeError, match="does not support response_format"):
        check_response(_fake_response(400, body))


def test_check_response_includes_status_code():
    with pytest.raises(RuntimeError, match="401"):
        check_response(_fake_response(401, '{"error": "invalid key"}'))
