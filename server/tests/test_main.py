import json
from pathlib import Path

from fastapi.testclient import TestClient

from app import main
from app.schemas import ActionCommand

FIXTURE = json.loads((Path(__file__).parent.parent / "fixtures" / "sample_capture.json").read_text())

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
