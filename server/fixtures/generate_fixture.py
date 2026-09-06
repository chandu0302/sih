"""
SIH 26171 — Phase 4 fixture generator.

Builds a synthetic "already-sanitized screenshot" + matching manifest,
standing in for the real extension's 3a/3b/3c output until Phase 5 wires
this server to the live client. The image content does not need to be a
realistic web page — it only needs to exercise the request contract
(PlanActionRequest) and give the VLM something to look at that is
consistent with its manifest (a black box where PHONE says one is, a
blurred disc where FACE says one is).

Regenerate with:  python fixtures/generate_fixture.py
"""

from __future__ import annotations

import base64
import json
from pathlib import Path

from PIL import Image, ImageDraw

WIDTH, HEIGHT = 480, 320
OUT_DIR = Path(__file__).parent


def build_image() -> Image.Image:
    img = Image.new("RGB", (WIDTH, HEIGHT), "white")
    draw = ImageDraw.Draw(img)

    draw.text((20, 16), "Contact form", fill="black")

    draw.text((20, 60), "Name:", fill="black")
    draw.rectangle((90, 54, 300, 80), outline="gray")

    draw.text((20, 100), "Phone:", fill="black")
    # 3a stand-in: the phone field is already masked, matching the PHONE
    # region in the manifest below — never a real phone number.
    draw.rectangle((90, 94, 300, 120), fill="black")

    # 3b stand-in: a blurred-looking disc where a face was detected and
    # blurred, matching the FACE region below.
    draw.ellipse((340, 40, 440, 140), fill=(120, 120, 120))

    draw.rectangle((90, 160, 210, 190), fill="#2a9", outline="#2a9")
    draw.text((110, 168), "Submit", fill="white")

    return img


def main() -> None:
    img = build_image()
    png_path = OUT_DIR / "sample_capture.png"
    img.save(png_path)

    data_url = "data:image/png;base64," + base64.b64encode(png_path.read_bytes()).decode("ascii")

    fixture = {
        "image": data_url,
        "manifest": {
            "regions": [
                {
                    "type": "PHONE",
                    "bbox": {"x": 90, "y": 94, "w": 210, "h": 26},
                    "nodeId": "d0",
                    "confidence": 0.95,
                },
                {
                    "type": "FACE",
                    "bbox": {"x": 340, "y": 40, "w": 100, "h": 100},
                    "nodeId": None,
                    "confidence": 0.9,
                },
            ]
        },
        "task": "Fill in the Name field with 'Test User' and click Submit.",
    }

    (OUT_DIR / "sample_capture.json").write_text(json.dumps(fixture, indent=2) + "\n")
    print(f"Wrote {png_path.name} and sample_capture.json")


if __name__ == "__main__":
    main()
