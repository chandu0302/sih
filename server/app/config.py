"""
SIH 26171 — Phase 4 config.

The model is read from an env var, not hardcoded, on purpose: RESEARCH.md's
own note is "re-verify best-current at build time — the landscape moves
fast." DEFAULT_MODEL is a confirmed-free OpenRouter vision model for local
dev without spending anything; swap VLM_MODEL to a paid model (e.g.
qwen/qwen3-vl-30b-a3b-instruct) for real accuracy without touching code.

The API key is never hardcoded or logged — read once per call from the
environment, which itself is expected to come from a local .env (see
.env.example) that is gitignored.
"""

from __future__ import annotations

import os

from dotenv import load_dotenv

load_dotenv()

API_KEY_ENV = "OPENROUTER_API_KEY"
MODEL_ENV = "VLM_MODEL"

# Free as of this check (Sept 2026) — free-tier model availability on
# OpenRouter rotates and rate-limits without notice (google/gemma-4-31b-it:free
# hit a 429 "temporarily rate-limited upstream" during live testing, verified
# against the real API, not a hypothetical). If this one also 429s/404s,
# check openrouter.ai/models for a current :free vision-capable listing and
# update this default (or set VLM_MODEL yourself, which always wins).
DEFAULT_MODEL = "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free"

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class MissingApiKeyError(RuntimeError):
    pass


def get_api_key() -> str:
    key = os.environ.get(API_KEY_ENV)
    if not key:
        raise MissingApiKeyError(
            f"{API_KEY_ENV} is not set. Copy server/.env.example to server/.env "
            "and fill in a key from https://openrouter.ai/keys."
        )
    return key


def get_model() -> str:
    # Deliberately `or DEFAULT_MODEL`, not `.get(MODEL_ENV, DEFAULT_MODEL)`:
    # .env.example ships VLM_MODEL= (present, empty) so it's a visible,
    # fillable line rather than an absent one — python-dotenv loads that as
    # an actual empty string in the environment, which .get()'s default
    # parameter does NOT cover (that only fires when the key is missing
    # entirely). An empty model string reaches OpenRouter as "model": "",
    # which is a 400, not a fallback — verified against the real API.
    return os.environ.get(MODEL_ENV) or DEFAULT_MODEL
