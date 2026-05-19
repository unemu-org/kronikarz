#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic>=0.92.0", "pillow", "python-dotenv", "pyyaml"]
# ///
"""Send a scan to Claude Opus 4.7 and ask for a sch.yaml describing it.

Usage: uv run scripts/vision-digitize.py <package> <page-id>
Example: uv run scripts/vision-digitize.py P-R3-2 2-58
"""
from __future__ import annotations
import argparse
import base64
import io
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

FORMAT_HINT = """\
You read a Polish 1970s schematic scan and output structured YAML
describing CONNECTIVITY ONLY. Do NOT trace wires — the human draws
segments later. Focus entirely on: which gates exist, which pins belong
to which net, and what each net is called.

Output ONLY YAML (no prose, no markdown fences). Format:

kronikarz: "1"
page: "<page-id>"
package: "<package-id>"
scan_size: [<width>, <height>]   # given below

gates:
  - ref: M54         # IC reference label visible on the schematic (M5, M22, M93).
    gate: A          # gate letter within the IC (A,B,C,D,E,F). null for passives.
    ic: "04"         # IC type suffix from ic_map (00, 04, 08, 10, 20, 74, 175...)
    x: 340           # center of the gate box on the scan, IN PIXELS
    y: 120
    rotation: 0      # 0 | 90 | 180 | 270
    pins:
      - num: 1               # pin number from the IC datasheet
        side: left           # left | right | top | bottom
        net: NET_NAME        # name of the net this pin connects to
        px: 310              # pin endpoint x in scan pixels (center of pin marker)
        py: 120              # pin endpoint y
        cross:               # OPTIONAL — only if signal exits the page
          page: "A23"        # connector designator (A23, B21, ...) or other page id
          label: "-K1"       # signal label printed in the original
    label_left: "13"         # number printed left of the box (the IC pin number)
    label_right: "12"        # number printed right of the box
    verified: false
    note: null

power:                       # VCC / GND symbols visible on the schematic
  - type: VCC
    x: 100
    y: 40
    net: VCC

ports:                       # backplane connectors — `< A50 >` symbols WITH a
                             # connector pin label inside chevron brackets
  - connector: "A50"         # connector pin label printed inside the bracket
    label: "-BLR"            # signal label printed next to the bracket
    net: "-BLR"              # net this port belongs to on this page
    x: 80                    # tip position (where the wire connects), in pixels
    y: 120
    side: left               # which edge: left | right | top | bottom

cross_refs:                  # intra-package cross-page references — printed
                             # signal name followed by a comma list of pages
                             # where the same net continues (NO chevron brackets,
                             # typically on the right edge of a page)
  - net: "-CZYTRW"
    label: "-CZYTRW"         # as printed
    pages: ["2-59", "2-60", "2-61"]   # page ids (often abbreviated like 2,3,4,5 — expand to full ids when possible, else keep as raw "2","3","4","5")
    x: 2200                  # tip position (where the wire meets the label)
    y: 380
    side: right

nets:                        # every distinct net on the page
  NET_NAME:
    pins:                    # list of "REF.GATE.NUM" or "REF.NUM" for passives
      - M54.A.1
      - M55.B.4
    segments: null           # ALWAYS null — human draws wire geometry later
    junctions: null          # ALWAYS null
  "-K1":                     # quote names that start with - or +
    pins:
      - M54.A.2
    segments: null
    junctions: null
    cross:                   # for nets exiting the page
      page: "A23"
      label: "-K1"

annotations: []

Rules:
- Coordinates: top-left origin, +x right, +y down, in pixels.
- IC refs in MJC-400 are typically M<number> (M1..M120).
- Pin numbers MUST match the standard 74xx pinout for the IC type.
  Common ICs: 7400 (quad NAND), 7404 (hex inverter), 7408 (AND),
  7410 (3-input NAND), 7420 (4-input NAND), 7430 (8-input NAND),
  7474 (D-FF), 74175 (quad D-FF), 7486 (XOR).
- The little number printed beside a pin (e.g. "13" left, "12" right)
  IS the pin number — capture it in label_left/label_right AND as pins[i].num.
- `ic` field is the suffix only ("04" not "7404", "175" not "74175").
- Cross-page exits on gate pins: schematic shows "<A23>" or similar next to a pin → fill `cross:`.
- Two distinct kinds of edge annotations on a MERA-400 page:

  1. PORTS (`ports:`) — chevron brackets `< CONN >` with a connector pin
     label INSIDE the brackets (like A50, B94, C41). These connect to the
     physical edge connector and on to the backplane. The connector label is
     CRITICAL — copy byte-for-byte. Almost always on the LEFT edge for inputs.

  2. CROSS-PAGE REFS (`cross_refs:`) — bare signal labels printed at the edge
     WITHOUT brackets, followed by a comma-list of page numbers like
     "-CZYTRW 2,3,4,5". They mean "this same net continues on pages 2-5 of
     the same package". Almost always on the RIGHT edge (outputs going to
     other pages within the package). The number list IS the list of pages.
     Capture it as `pages: ["2-59","2-60","2-61"]` when you can map the
     numbers to full page ids (page ids in this DTR look like "2-N"; bare
     digits "2,3,4,5" almost certainly mean "2-59" form continuations of
     the current page series — keep raw "2","3","4","5" if you cannot
     disambiguate).

- Do NOT confuse the two. A label WITH a chevron bracket is a port. A label
  WITHOUT chevron + with comma-page-list is a cross_ref. Some signals appear
  as both (one input port on left → one cross-ref on right with the same net
  name).
- Signal labels on either side preserve their +/- prefix verbatim.
- Resistors / capacitors: gate=null, ic=null, add `value` if printed.
- If a net has no printed label, invent NET_<descriptive> like NET_M60_OUT6.
- Preserve original signal labels verbatim (with minus/plus signs).
- ALWAYS set segments: null and junctions: null. Do not invent wire paths.
- Prefer covering every visible gate even if you cannot trace some nets.
"""


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("package")
    ap.add_argument("page_id")
    ap.add_argument("--out", help="output path (default: data/MJC-400/<pkg>/pages/<page>.sch.yaml)")
    ap.add_argument("--force", action="store_true", help="overwrite existing non-stub yaml")
    args = ap.parse_args()

    load_dotenv(REPO / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set")

    scan_path = REPO / f"data/MJC-400/{args.package}/scans/{args.page_id}.jpg"
    if not scan_path.exists():
        sys.exit(f"no such scan: {scan_path}")

    out_path = Path(args.out) if args.out else REPO / f"data/MJC-400/{args.package}/pages/{args.page_id}.sch.yaml"

    with Image.open(scan_path) as im:
        w, h = im.size
        buf = io.BytesIO()
        im.convert("L").save(buf, format="JPEG", quality=92)
        img_bytes = buf.getvalue()

    print(f"scan: {scan_path.name} ({w}x{h}, {len(img_bytes)//1024} KB)")

    client = anthropic.Anthropic()
    user_text = (
        f"Digitize this scan to YAML.\n"
        f"package: {args.package}\n"
        f"page: {args.page_id}\n"
        f"scan_size: [{w}, {h}]\n"
    )

    print(f"asking {MODEL} (this can take a minute)...")
    response = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        thinking={"type": "adaptive"},
        system=[
            {
                "type": "text",
                "text": FORMAT_HINT,
                "cache_control": {"type": "ephemeral"},
            }
        ],
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": "image/jpeg",
                            "data": base64.standard_b64encode(img_bytes).decode(),
                        },
                    },
                    {"type": "text", "text": user_text},
                ],
            }
        ],
    )

    text = "".join(b.text for b in response.content if b.type == "text").strip()
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()

    try:
        doc = yaml.safe_load(text)
        assert isinstance(doc, dict), "not a mapping"
        assert doc.get("kronikarz") == "1", f"missing kronikarz: \"1\""
    except Exception as e:
        sys.stderr.write(f"WARNING: response did not parse cleanly: {e}\n")
        sys.stderr.write(f"--- response preview ---\n{text[:500]}\n---\n")
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_text(text, encoding="utf-8")
        return

    # Pull ic suffix from each gate, strip it from sch.yaml, sync to package.yaml
    ref_to_ic: dict[str, str | None] = {}
    ref_to_gate_pages: dict[str, set[str]] = {}
    for g in doc.get("gates", []):
        ref = g.get("ref")
        if not ref:
            continue
        ic = g.pop("ic", None)
        if ref not in ref_to_ic:
            ref_to_ic[ref] = ic
        elif ic and not ref_to_ic[ref]:
            ref_to_ic[ref] = ic
        letter = g.get("gate")
        if letter is not None:
            ref_to_gate_pages.setdefault(ref, set()).add(letter)
    ic_count = sum(1 for ic in ref_to_ic.values() if ic)
    print(f"gates: {sum(len(p) for p in ref_to_gate_pages.values())} | refs: {len(ref_to_ic)} | with ic suffix: {ic_count}")

    # Write sch.yaml (with kronikarz key first)
    out_path.parent.mkdir(parents=True, exist_ok=True)
    sch_text = "kronikarz: \"1\"\n" + yaml.safe_dump(
        {k: v for k, v in doc.items() if k != "kronikarz"},
        sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
    )
    out_path.write_text(sch_text, encoding="utf-8")

    # Sync package.yaml — add components referenced by gates
    pkg_path = REPO / f"data/MJC-400/{args.package}/package.yaml"
    if pkg_path.exists():
        pkg_doc = yaml.safe_load(pkg_path.read_text())
        components = pkg_doc.setdefault("components", {}) or {}
        added = 0
        updated = 0
        for ref, ic in ref_to_ic.items():
            existing = components.get(ref)
            letters = sorted(ref_to_gate_pages.get(ref, set()))
            if not existing:
                if ic:
                    components[ref] = {
                        "ic": ic,
                        "gates": {l: {"page": args.page_id} for l in letters},
                    }
                else:
                    components[ref] = {"ic": None, "type": "unknown", "pages": [args.page_id]}
                added += 1
            else:
                # Merge: upgrade ic if previously null and now known
                changed = False
                if ic and not existing.get("ic"):
                    existing["ic"] = ic
                    existing.pop("type", None)
                    existing.setdefault("gates", {})
                    for l in letters:
                        existing["gates"].setdefault(l, {"page": args.page_id})
                    changed = True
                else:
                    # add missing gate letters
                    gates_map = existing.get("gates")
                    if isinstance(gates_map, dict):
                        for l in letters:
                            if l not in gates_map:
                                gates_map[l] = {"page": args.page_id}
                                changed = True
                if changed:
                    updated += 1
        if added or updated:
            pkg_doc["components"] = components
            pkg_text = "kronikarz: \"1\"\n" + yaml.safe_dump(
                {k: v for k, v in pkg_doc.items() if k != "kronikarz"},
                sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
            )
            pkg_path.write_text(pkg_text)
            print(f"package.yaml: +{added} new, ~{updated} updated")

    usage = response.usage
    print(f"wrote {out_path}")
    print(
        f"tokens: in={usage.input_tokens} (cache_w={usage.cache_creation_input_tokens or 0}, "
        f"cache_r={usage.cache_read_input_tokens or 0}) out={usage.output_tokens}"
    )


if __name__ == "__main__":
    main()
