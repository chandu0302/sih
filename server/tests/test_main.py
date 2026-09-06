import json
from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.schemas import ActionCommand

FIXTURE = json.loads((Path(__file__).parent.parent / "fixtures" / "sample_capture.json").read_text())
# /ask takes `question` where /plan-action takes `task` — same image+manifest.
ASK_FIXTURE = {k: v for k, v in FIXTURE.items() if k != "task"} | {
    "question": "What kind of form is this?"
}

client = TestClient(main.app)


def test_health():
    res = client.get("/health")
    assert res.status_code == 200
    assert res.json() == {"ok": True}


def test_plan_action_success(monkeypatch):
    async def fake_plan_action(req):
        return ActionCommand(action="click", target={"x": 150, "y": 67}, reasoning="clicking Name field")

    monkeypatch.setattr(main.vlm_client, "plan_action", fake_plan_action)

    res = client.post("/plan-action", json=FIXTURE)

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert body["action"]["action"] == "click"
    assert body["action"]["target"] == {"x": 150, "y": 67}


def test_plan_action_surfaces_failure_as_a_value(monkeypatch):
    async def failing_plan_action(req):
        raise RuntimeError("OPENROUTER_API_KEY is not set")

    monkeypatch.setattr(main.vlm_client, "plan_action", failing_plan_action)

    res = client.post("/plan-action", json=FIXTURE)

    # Not a 500 — the failure is a value in the body, same convention as the
    # extension's CaptureResponse.
    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "OPENROUTER_API_KEY" in body["error"]


def test_plan_action_rejects_malformed_request():
    res = client.post("/plan-action", json={"image": "x"})
    assert res.status_code == 422


def test_ask_success(monkeypatch):
    async def fake_ask_question(req):
        return "It's a contact form asking for name, phone, and state."

    monkeypatch.setattr(main.vlm_client, "ask_question", fake_ask_question)

    res = client.post("/ask", json=ASK_FIXTURE)

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is True
    assert "contact form" in body["answer"]


def test_ask_surfaces_failure_as_a_value(monkeypatch):
    async def failing_ask_question(req):
        raise RuntimeError("OPENROUTER_API_KEY is not set")

    monkeypatch.setattr(main.vlm_client, "ask_question", failing_ask_question)

    res = client.post("/ask", json=ASK_FIXTURE)

    assert res.status_code == 200
    body = res.json()
    assert body["ok"] is False
    assert "OPENROUTER_API_KEY" in body["error"]


def test_ask_rejects_malformed_request():
    res = client.post("/ask", json={"image": "x"})
    assert res.status_code == 422
