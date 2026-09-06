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
# OpenRouter rotates without notice; if this 404s, check openrouter.ai/models
# for a current :free vision-capable listing and update this default (or set
# VLM_MODEL yourself, which always wins).
DEFAULT_MODEL = "google/gemma-4-31b-it:free"

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
    return os.environ.get(MODEL_ENV, DEFAULT_MODEL)
