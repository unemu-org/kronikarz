#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Regenerate the YOLO training dataset from existing schematic YAMLs.

Source of truth = verified gates with explicit w/h (user resized them to match
scan), plus ports / cross_refs / power on the same pages.

Writes:
  data/.yolo-dataset/classes.txt
  data/.yolo-dataset/images/<pkg>-<page>.jpg     (symlink to original scan)
  data/.yolo-dataset/labels/<pkg>-<page>.txt     (YOLO: class cx cy w h, normalized)

Usage: uv run scripts/export-yolo-from-yamls.py [--all]

Stdout: JSON summary with counts.
"""
from __future__ import annotations
import argparse
import json
import os
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data" / "MJC-400"
OUT = REPO / "data" / ".yolo-dataset"

# IC suffix → YOLO class
IC_CLASS = {
    "00": "nand2",
    "01": "nand2",  # open-collector variant
    "03": "nand2",  # open-collector
    "08": "and2",
    "09": "and2",
    "02": "nor2",
    "32": "or2",
    "04": "inv",
    "05": "inv",
    "06": "inv",
    "14": "inv",
    "07": "buf",
    "16": "inv",
    "17": "buf",
    "10": "nand3",
    "11": "and3",
    "27": "nor3",
    "20": "nand4",
    "21": "and4",
    "22": "nand4",
    "25": "nor4",
    "30": "nand8",
    "40": "nand2",
    "74": "dff",
    "174": "dff_quad",
    "175": "dff_quad",
    "273": "dff_quad",
    "374": "dff_quad",
    "86": "xor2",
    "266": "xor2",
}

# Fallback synthetic bboxes (px) when an item lacks w/h
PORT_W, PORT_H = 90, 36
CROSSREF_W, CROSSREF_H = 110, 28
POWER_W, POWER_H = 32, 32
GATE_FALLBACK_W, GATE_FALLBACK_H = 80, 110


def classify_ic(ic):
    if ic is None:
        return None
    s = str(ic).upper().lstrip("0") or "0"
    # Strip family prefixes like SN, 74, LS
    raw = str(ic)
    # Try direct, then stripped
    if raw in IC_CLASS:
        return IC_CLASS[raw]
    stripped = raw.replace("SN", "").replace("74", "", 1).lstrip("LSHCALSAF")
    if stripped in IC_CLASS:
        return IC_CLASS[stripped]
    return "unknown"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--all", action="store_true", help="include un-resized verified gates with fallback box")
    args = ap.parse_args()

    OUT.mkdir(parents=True, exist_ok=True)
    labels_dir = OUT / "labels"
    images_dir = OUT / "images"
    labels_dir.mkdir(exist_ok=True)
    images_dir.mkdir(exist_ok=True)

    classes: list[str] = []

    def class_id(name: str) -> int:
        if name not in classes:
            classes.append(name)
        return classes.index(name)

    summary = {"pages": 0, "gates": 0, "ports": 0, "cross_refs": 0, "power": 0, "skipped_gates": 0}

    for pkg_dir in sorted(DATA.glob("*/")):
        pkg_yaml = pkg_dir / "package.yaml"
        if not pkg_yaml.exists():
            continue
        pkg = yaml.safe_load(pkg_yaml.read_text()) or {}
        components = (pkg.get("components") or {})
        pkg_id = pkg_dir.name

        for page_file in sorted((pkg_dir / "pages").glob("*.sch.yaml")):
            page = yaml.safe_load(page_file.read_text()) or {}
            page_id = page.get("page")
            scan_size = page.get("scan_size") or [0, 0]
            sw, sh = scan_size
            if not (sw and sh):
                continue
            scan_path = pkg_dir / "scans" / f"{page_id}.jpg"
            if not scan_path.exists():
                continue

            lines: list[str] = []

            for g in page.get("gates", []) or []:
                if not g.get("verified"):
                    summary["skipped_gates"] += 1
                    continue
                gw = g.get("w")
                gh = g.get("h")
                if not (gw and gh):
                    if not args.all:
                        summary["skipped_gates"] += 1
                        continue
                    gw, gh = GATE_FALLBACK_W, GATE_FALLBACK_H
                ref = g.get("ref")
                comp = components.get(ref) or {}
                ic = comp.get("ic") if isinstance(comp, dict) else None
                cls = classify_ic(ic) if ic else "unknown"
                cid = class_id(cls)
                cx = g["x"] / sw
                cy = g["y"] / sh
                nw = gw / sw
                nh = gh / sh
                lines.append(f"{cid} {cx:.6f} {cy:.6f} {nw:.6f} {nh:.6f}")
                summary["gates"] += 1

            for p in page.get("ports") or []:
                cid = class_id("port")
                cx = p["x"] / sw
                cy = p["y"] / sh
                lines.append(f"{cid} {cx:.6f} {cy:.6f} {PORT_W/sw:.6f} {PORT_H/sh:.6f}")
                summary["ports"] += 1

            for cr in page.get("cross_refs") or []:
                cid = class_id("cross_ref")
                cx = cr["x"] / sw
                cy = cr["y"] / sh
                lines.append(f"{cid} {cx:.6f} {cy:.6f} {CROSSREF_W/sw:.6f} {CROSSREF_H/sh:.6f}")
                summary["cross_refs"] += 1

            for pw in page.get("power") or []:
                cls = "power_vcc" if (pw.get("type") or "").upper().startswith("V") else "power_gnd"
                cid = class_id(cls)
                cx = pw["x"] / sw
                cy = pw["y"] / sh
                lines.append(f"{cid} {cx:.6f} {cy:.6f} {POWER_W/sw:.6f} {POWER_H/sh:.6f}")
                summary["power"] += 1

            if not lines:
                continue

            stem = f"{pkg_id}-{page_id}"
            label_path = labels_dir / f"{stem}.txt"
            label_path.write_text("\n".join(lines) + "\n")
            img_link = images_dir / f"{stem}.jpg"
            if img_link.exists() or img_link.is_symlink():
                img_link.unlink()
            try:
                img_link.symlink_to(scan_path)
            except OSError:
                # Fallback: copy
                import shutil
                shutil.copy2(scan_path, img_link)
            summary["pages"] += 1

    (OUT / "classes.txt").write_text("\n".join(classes) + "\n")
    summary["classes"] = classes
    summary["total"] = summary["gates"] + summary["ports"] + summary["cross_refs"] + summary["power"]
    sys.stdout.write(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
