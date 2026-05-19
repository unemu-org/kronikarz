#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic>=0.92.0", "pillow", "python-dotenv"]
# ///
"""ROI-based component detection — user selects rectangle on a page, this
script crops it and asks Claude to identify whatever logic gate / port / etc.
is inside, returning a JSON description ready for insertion into the page YAML.

Reads JSON request from stdin: {package, page, x, y, w, h} (scan pixels).
Writes JSON response to stdout: {detections: [{class, ref, gate, ic,
rotation, x, y, pins:[{num, side, net}], label_left, label_right, note}, ...],
crop_size: [w, h], tokens: {in, out}}.

Usage: echo '{"package":"P-R3-2","page":"2-58","x":340,"y":120,"w":80,"h":60}' \\
       | uv run scripts/ai-detect-roi.py
"""
from __future__ import annotations
import base64
import io
import json
import os
import sys
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
MODEL = "claude-opus-4-7"
MAX_TOKENS = 4000
MARGIN = 24  # extra px around the requested ROI so Claude sees pin numbers

SYSTEM = """You analyze a small cropped region of a Polish 1970s MERA-400
schematic and identify what electronic component(s) are inside.

The crop may contain: a logic gate (NAND, AND, OR, XOR, inverter, flip-flop),
a port (`< CONN >` chevron with connector label like A50), a cross-page
reference (bare label with comma-separated page numbers), a power symbol,
or be empty / unclear.

Output ONLY JSON (no prose, no markdown fences). Schema:

{
  "detections": [
    {
      "class": "nand2|nand3|nand4|nand8|inv|and2|or2|xor2|dff|dff_quad|port|cross_ref|power_vcc|power_gnd|unknown",
      "ref": "M54",            // IC ref, null for ports/refs/power
      "gate": "A",             // letter A/B/..., null when N/A
      "ic": "00",              // suffix (00/04/08/10/20/30/74/175/...), null for non-IC
      "rotation": 0,           // 0|90|180|270
      "x": 340,                // center, in ORIGINAL scan pixels (not crop coords)
      "y": 120,
      "pins": [
        {"num": 1, "side": "left",  "net": null, "px": 310, "py": 120, "label": "13"},
        {"num": 2, "side": "right", "net": null, "px": 370, "py": 120, "label": "12"}
      ],
      "label_left": "13",
      "label_right": "12",
      "port_connector": null,  // for class=port: e.g. "A50"
      "port_label": null,      // for class=port: e.g. "-BLR"
      "port_side": null,       // for class=port: "left"|"right"
      "cross_pages": null,     // for class=cross_ref: ["2","3","4","5"]
      "cross_label": null,     // for class=cross_ref: e.g. "-CZYTRW"
      "note": null
    }
  ]
}

Rules:
- All coordinates are in the ORIGINAL scan, NOT the crop. The user message
  tells you the crop's top-left position (crop_x, crop_y) — add those offsets.
- IC pin numbers MUST match standard 74xx pinouts.
- If the crop is empty or unclear, output {"detections": []}.
- Multiple components can be in one crop — list each one.
- Preserve signal labels verbatim (+/- prefix kept).
- Be precise with x/y — user will correct only small offsets.
"""


def main() -> None:
    load_dotenv(REPO / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set")

    req = json.loads(sys.stdin.read())
    pkg = req["package"]
    page_id = req["page"]
    rx = int(req["x"])
    ry = int(req["y"])
    rw = int(req["w"])
    rh = int(req["h"])

    scan_path = REPO / f"data/MJC-400/{pkg}/scans/{page_id}.jpg"
    if not scan_path.exists():
        sys.exit(f"scan not found: {scan_path}")

    with Image.open(scan_path) as im:
        W, H = im.size
        cx = max(0, rx - MARGIN)
        cy = max(0, ry - MARGIN)
        cx2 = min(W, rx + rw + MARGIN)
        cy2 = min(H, ry + rh + MARGIN)
        crop = im.crop((cx, cy, cx2, cy2))
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=92)
        img_bytes = buf.getvalue()

    user_text = (
        f"package: {pkg}\n"
        f"page: {page_id}\n"
        f"full_scan_size: [{W}, {H}]\n"
        f"crop_origin: [{cx}, {cy}]\n"
        f"crop_size: [{cx2 - cx}, {cy2 - cy}]\n"
        f"user_selection: x={rx} y={ry} w={rw} h={rh}\n\n"
        "Identify components in this crop. Coordinates in your output MUST be "
        "in the ORIGINAL scan frame (add crop_origin to anything you measure)."
    )

    client = anthropic.Anthropic()
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        thinking={"type": "adaptive"},
        system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                              "data": base64.standard_b64encode(img_bytes).decode()}},
                {"type": "text", "text": user_text},
            ],
        }],
    )

    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    try:
        result = json.loads(text)
    except Exception as e:
        sys.stderr.write(f"parse error: {e}\nraw: {text[:500]}\n")
        result = {"detections": [], "parse_error": str(e), "raw": text}

    result["crop_size"] = [cx2 - cx, cy2 - cy]
    result["crop_origin"] = [cx, cy]
    result["tokens"] = {
        "in": response.usage.input_tokens,
        "out": response.usage.output_tokens,
    }
    sys.stdout.write(json.dumps(result))


if __name__ == "__main__":
    main()
