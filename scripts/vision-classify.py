#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic>=0.92.0", "pillow", "python-dotenv"]
# ///
"""Classify scanned pages by package using Claude vision.

Each page in data/scans-raw/ has a title block in the bottom-right with
"Schemat ideowy pakietu <PACKAGE>" and a page id "2-NN". This script crops
that region, sends it to claude-opus-4-7, and writes the response to a
per-page cache JSON. After classification, files are copied to
data/MJC-400/<PACKAGE>/scans/<page_id>.jpg.

Run: uv run scripts/vision-classify.py
"""
from __future__ import annotations
import base64
import io
import json
import os
import shutil
import sys
from pathlib import Path

import anthropic
from dotenv import load_dotenv
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
SRC = REPO / "data/scans-raw"
CACHE = REPO / "data/.vision-cache"
DST = REPO / "data/MJC-400"

MODEL = "claude-opus-4-7"

SYSTEM = """You read scanned title blocks from a Polish 1970s computer DTR (MERA-400 MJC-400 schematics).

The title block typically contains:
- Two-line title: "Schemat ideowy / pakietu <PACKAGE_CODE>"
- A page id like "2-1", "2-32", "2-101" (NOT the document number "12-006368-...")
- The document number "12-006368-..."

Package codes look like: P-X3-2, P-M3-2, P-D3-2, P-P3-2, P-R3-2, P-A3-2, P-O3-2,
I-SK1-1, SM-POSET-1, SM-PKT-1, JPP-16/18, SPP-32/16, PPS-32.

Some pages may be cover sheets, BOM tables, or otherwise have no clear package
title — return null for those fields.

ALWAYS respond with ONLY a JSON object, no prose, no markdown fences:
{"package": "...", "page_id": "...", "confidence": "high|medium|low"}

If unreadable: {"package": null, "page_id": null, "confidence": "low"}.
Normalize package codes: collapse OCR variants to canonical form. Strip leading "P-" only if absent."""


def crop_titleblock(src: Path) -> bytes:
    """Crop bottom-right titleblock and re-encode as JPEG."""
    img = Image.open(src)
    w, h = img.size
    # bottom-right ~40% wide x 30% tall
    left = int(w * 0.55)
    top = int(h * 0.68)
    crop = img.crop((left, top, w, h))
    buf = io.BytesIO()
    crop.convert("L").save(buf, format="JPEG", quality=85)
    return buf.getvalue()


def classify(client: anthropic.Anthropic, image_bytes: bytes) -> dict:
    b64 = base64.standard_b64encode(image_bytes).decode()
    response = client.messages.create(
        model=MODEL,
        max_tokens=300,
        system=[{
            "type": "text",
            "text": SYSTEM,
            "cache_control": {"type": "ephemeral"},
        }],
        messages=[{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": "image/jpeg",
                        "data": b64,
                    },
                },
                {"type": "text", "text": "Classify this title block."},
            ],
        }],
    )
    text = "".join(b.text for b in response.content if b.type == "text").strip()
    # strip code fences if present
    if text.startswith("```"):
        text = text.split("\n", 1)[1].rsplit("```", 1)[0].strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError as e:
        return {"package": None, "page_id": None, "confidence": "low", "_error": str(e), "_raw": text}


def main() -> None:
    load_dotenv(REPO / ".env")
    if not os.environ.get("ANTHROPIC_API_KEY"):
        sys.exit("ANTHROPIC_API_KEY not set")

    CACHE.mkdir(parents=True, exist_ok=True)
    if DST.exists():
        shutil.rmtree(DST)
    DST.mkdir(parents=True)

    client = anthropic.Anthropic()
    pages = sorted(SRC.glob("page-*.png"))
    print(f"Classifying {len(pages)} pages with {MODEL}...")

    results: list[tuple[Path, dict]] = []
    for i, src in enumerate(pages):
        cache_path = CACHE / f"{src.stem}.json"
        if cache_path.exists():
            data = json.loads(cache_path.read_text())
        else:
            crop = crop_titleblock(src)
            data = classify(client, crop)
            cache_path.write_text(json.dumps(data, ensure_ascii=False, indent=2))
            print(f"  [{i+1:3d}/{len(pages)}] {src.stem} → {data.get('package')} / {data.get('page_id')} ({data.get('confidence')})")
        results.append((src, data))

    # Enforce sequential runs:
    # 1. fill nulls with prev label if neighbors agree
    # 2. absorb isolated singletons into the surrounding run
    labels = [r[1].get("package") for r in results]
    for i in range(len(labels)):
        if labels[i] is not None:
            continue
        prev = next((labels[j] for j in range(i - 1, -1, -1) if labels[j]), None)
        nxt = next((labels[j] for j in range(i + 1, len(labels)) if labels[j]), None)
        if prev and prev == nxt:
            labels[i] = prev

    # Absorb singletons / doubles surrounded by a different package on both sides
    from collections import Counter
    counts = Counter(l for l in labels if l)
    # Absorb singletons (1 page) into prev run, regardless of confidence.
    # 2-page runs absorbed only when low/medium confidence.
    singletons = {pkg for pkg, n in counts.items() if n == 1}
    doubles = {pkg for pkg, n in counts.items() if n == 2}
    for i, lbl in enumerate(labels):
        if lbl not in singletons and lbl not in doubles:
            continue
        prev = next((labels[j] for j in range(i - 1, -1, -1) if labels[j] and labels[j] not in singletons and labels[j] not in doubles), None)
        nxt = next((labels[j] for j in range(i + 1, len(labels)) if labels[j] and labels[j] not in singletons and labels[j] not in doubles), None)
        conf = results[i][1].get("confidence", "low")
        if lbl in singletons:
            labels[i] = prev or nxt or lbl
        elif conf != "high" and prev:
            labels[i] = prev
        elif conf != "high" and nxt:
            labels[i] = nxt

    # Copy files
    stats: dict[str, int] = {}
    unmatched = 0
    for (src, data), label in zip(results, labels):
        if not label:
            unmatched += 1
            continue
        page_id = data.get("page_id") or src.stem
        # sanitize: '/' in page_id or package would create subdirs
        label_s = label.replace("/", "-")
        page_id_s = str(page_id).replace("/", "-")
        scans = DST / label_s / "scans"
        scans.mkdir(parents=True, exist_ok=True)
        # convert PNG → JPEG q90
        out = scans / f"{page_id_s}.jpg"
        if out.exists():
            out = scans / f"{page_id_s}-from-{src.stem}.jpg"
        img = Image.open(src).convert("L")
        img.save(out, format="JPEG", quality=90)
        stats[label_s] = stats.get(label_s, 0) + 1

    print("\n=== Pakiety ===")
    for pkg, n in sorted(stats.items()):
        print(f"  {pkg:14s} {n:3d} stron")
    print(f"  UNMATCHED      {unmatched:3d} stron")
    print(f"  TOTAL          {sum(stats.values()) + unmatched:3d}")


if __name__ == "__main__":
    main()
