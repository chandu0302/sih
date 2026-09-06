"""
Covers the real bug found in the field: .env.example ships VLM_MODEL= as a
present-but-empty line so it's visible/fillable, and python-dotenv loads
that as an actual empty string — os.environ.get(key, default) does not
fall back to `default` for a present-but-empty value, only for an absent
key. get_model() must, or every capture silently sends "model": "" to
OpenRouter.
"""

from app.config import DEFAULT_MODEL, get_model


def test_get_model_falls_back_to_default_when_env_var_absent(monkeypatch):
    monkeypatch.delenv("VLM_MODEL", raising=False)
    assert get_model() == DEFAULT_MODEL


def test_get_model_falls_back_to_default_when_env_var_present_but_empty(monkeypatch):
    # This is the exact shape .env.example produces via python-dotenv.
    monkeypatch.setenv("VLM_MODEL", "")
    assert get_model() == DEFAULT_MODEL


def test_get_model_uses_the_env_var_when_actually_set(monkeypatch):
    monkeypatch.setenv("VLM_MODEL", "qwen/qwen3-vl-30b-a3b-instruct")
    assert get_model() == "qwen/qwen3-vl-30b-a3b-instruct"
