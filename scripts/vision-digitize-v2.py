#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic>=0.92.0", "pillow", "python-dotenv", "pyyaml"]
# ///
"""Two-stage digitization: detect-rects pre-finds candidate boxes,
this script sends the annotated overlay + region list to Claude.

Prerequisite: run scripts/detect-rects.py <package> <page-id> first.

Usage: uv run scripts/vision-digitize-v2.py <package> <page-id>
"""
from __future__ import annotations
import argparse
import base64
import io
import json
import os
import sys
from pathlib import Path

import anthropic
import yaml
from dotenv import load_dotenv
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
MODEL = "claude-opus-4-7"
MAX_TOKENS = 16000

SYSTEM = """You read a Polish 1970s MERA-400 schematic and produce a YAML
describing every gate, port, cross-page reference, and net on the page.

The image is an annotated overlay: every red-numbered rectangle is a
CANDIDATE region that classical CV detected. Many candidates are false
positives (wire intersections, table cells) — discard those. Some real
gates may be MISSING from the candidate list — include those as well by
inferring their position from the original scan visible behind the overlay.

Output ONLY YAML (no prose, no markdown fences). Schema:

kronikarz: "1"
page: "<page-id>"
package: "<package-id>"
scan_size: [<w>, <h>]
gates:
  - region: 3          # the red-numbered region this gate occupies; null if not in candidate list
    ref: M54
    gate: A            # gate letter (A/B/...), null for passives
    ic: "04"           # IC suffix (00,04,08,10,20,74,175,...); null for passives
    x: 340             # center of the gate box, in scan pixels (top-left origin)
    y: 120
    rotation: 0        # 0|90|180|270
    pins:
      - {num: 1, side: left, net: NET_X, px: 310, py: 120}
      - {num: 2, side: right, net: NET_Y, px: 370, py: 120, cross: {page: "A23", label: "-K1"}}
    label_left: "13"
    label_right: "12"
    verified: false
    note: null

power: []                # VCC/GND symbols on the scan
ports:                   # `< CONN >` chevron brackets connecting to backplane
  - {connector: "A50", label: "-BLR", net: "-BLR", x: 80, y: 230, side: left}
cross_refs:              # bare labels at edge with comma-page lists (no chevron)
  - {net: "-CZYTRW", label: "-CZYTRW", pages: ["2","3","4","5"], x: 2200, y: 380, side: right}

nets:
  NET_X:
    pins: [M54.A.1, M64.A.1]
    segments: null       # always null — humans draw wires
    junctions: null
annotations: []

Rules:
- The `region` field links your gate output back to the candidate ID. If you
  find a gate that wasn't pre-detected, set region: null.
- If a candidate region is NOT a gate, OMIT IT — don't emit a placeholder.
- Coordinates are scan pixels, top-left origin. Be accurate — the user will
  drag-correct only small offsets.
- IC refs use M<n>. Pin numbers MUST match standard 74xx pinouts (7400 NAND
  quad, 7404 hex inverter, 7408 AND, 7410 3-NAND, 7420 4-NAND, 7430 8-NAND,
  7474 D-FF, 74175 quad D-FF, 7486 XOR, etc).
- ic suffix is bare ("04" not "7404"). Strip any leading "SN" / "74".
- The number printed next to a pin on the schematic IS the pin number on the
  IC. Capture as both pins[i].num and label_left/label_right.
- Ports (`< CONN >`): connector label inside the chevron is critical, copy
  exactly. Almost always on LEFT edge.
- Cross-page refs: bare label + comma list of pages (e.g. "-CZYTRW 2,3,4,5").
  Almost always on RIGHT edge. NO chevron. Keep raw "2","3","4","5" if you
  can't map to full page ids.
- segments / junctions ALWAYS null. Human draws.
- Preserve original signal labels verbatim (+/- prefix kept).
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("package")
    ap.add_argument("page_id")
    args = ap.parse_args()

    load_dotenv(REPO / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set")

    cache_dir = REPO / f"data/.cv-cache/{args.package}-{args.page_id}"
    annot_path = cache_dir / "annot.jpg"
    regions_path = cache_dir / "regions.json"
    if not annot_path.exists() or not regions_path.exists():
        sys.exit(f"missing CV cache — run scripts/detect-rects.py {args.package} {args.page_id} first")

    scan_path = REPO / f"data/MJC-400/{args.package}/scans/{args.page_id}.jpg"
    out_path = REPO / f"data/MJC-400/{args.package}/pages/{args.page_id}.sch.yaml"

    with Image.open(scan_path) as im:
        w, h = im.size

    img_bytes = annot_path.read_bytes()
    print(f"annot: {annot_path.name} ({w}x{h}, {len(img_bytes)//1024} KB)")

    regions = json.loads(regions_path.read_text())
    region_summary = "\n".join(
        f"  {r['id']}: x={r['x']} y={r['y']} w={r['w']} h={r['h']}" for r in regions
    )
    print(f"candidate regions: {len(regions)}")

    client = anthropic.Anthropic()
    user_text = (
        f"package: {args.package}\n"
        f"page: {args.page_id}\n"
        f"scan_size: [{w}, {h}]\n\n"
        f"Candidate regions ({len(regions)} total):\n{region_summary}\n\n"
        "Produce the YAML."
    )

    print(f"asking {MODEL}...")
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        thinking={"type": "adaptive"},
        system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": base64.standard_b64encode(img_bytes).decode()}},
                {"type": "text", "text": user_text},
            ],
        }],
    )

    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    try:
        doc = yaml.safe_load(text)
        assert isinstance(doc, dict)
        assert doc.get("kronikarz") == "1"
    except Exception as e:
        sys.stderr.write(f"WARNING: response did not parse: {e}\n{text[:500]}\n")
        out_path.write_text(text)
        return

    # Strip ic from gates + sync into package.yaml + clean region field
    ref_to_ic: dict[str, str | None] = {}
    ref_to_letters: dict[str, set[str]] = {}
    for g in doc.get("gates", []):
        ref = g.get("ref")
        if not ref:
            continue
        ic = g.pop("ic", None)
        g.pop("region", None)
        if ref not in ref_to_ic:
            ref_to_ic[ref] = ic
        elif ic and not ref_to_ic[ref]:
            ref_to_ic[ref] = ic
        letter = g.get("gate")
        if letter is not None:
            ref_to_letters.setdefault(ref, set()).add(letter)

    sch_text = "kronikarz: \"1\"\n" + yaml.safe_dump(
        {k: v for k, v in doc.items() if k != "kronikarz"},
        sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
    )
    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(sch_text)

    # Sync package
    pkg_path = REPO / f"data/MJC-400/{args.package}/package.yaml"
    if pkg_path.exists():
        pkg_doc = yaml.safe_load(pkg_path.read_text())
        components = pkg_doc.setdefault("components", {}) or {}
        added = updated = 0
        for ref, ic in ref_to_ic.items():
            letters = sorted(ref_to_letters.get(ref, set()))
            existing = components.get(ref)
            if not existing:
                components[ref] = (
                    {"ic": ic, "gates": {l: {"page": args.page_id} for l in letters}}
                    if ic else {"ic": None, "type": "unknown", "pages": [args.page_id]}
                )
                added += 1
            elif ic and not existing.get("ic"):
                existing["ic"] = ic
                existing.pop("type", None)
                existing.setdefault("gates", {})
                for l in letters:
                    existing["gates"].setdefault(l, {"page": args.page_id})
                updated += 1
            else:
                gmap = existing.get("gates")
                if isinstance(gmap, dict):
                    for l in letters:
                        if l not in gmap:
                            gmap[l] = {"page": args.page_id}
                            updated += 1
        if added or updated:
            pkg_doc["components"] = components
            pkg_path.write_text(
                "kronikarz: \"1\"\n" + yaml.safe_dump(
                    {k: v for k, v in pkg_doc.items() if k != "kronikarz"},
                    sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
                )
            )
            print(f"package.yaml: +{added} new, ~{updated} updated")

    n_gates = len(doc.get("gates", []))
    n_ports = len(doc.get("ports", []) or [])
    n_crefs = len(doc.get("cross_refs", []) or [])
    n_nets = len(doc.get("nets", {}) or {})
    print(f"gates: {n_gates} | ports: {n_ports} | cross_refs: {n_crefs} | nets: {n_nets}")
    usage = response.usage
    print(f"tokens: in={usage.input_tokens} out={usage.output_tokens}")
    print(f"wrote {out_path}")


if __name__ == "__main__":
    main()
