#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml", "pillow"]
# ///
"""Generate stub YAML files for every package + page found in data/MJC-400.

Produces:
  data/MJC-400/project.yaml      — lists all packages
  data/MJC-400/ic_map.yaml       — minimal 74xx subset
  data/MJC-400/<pkg>/package.yaml — lists pages from scans/ dir
  data/MJC-400/<pkg>/pages/<page-id>.sch.yaml — empty gates/nets, real scan_size

Run: uv run scripts/gen-stubs.py
"""
from __future__ import annotations
from pathlib import Path
import yaml
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "data/MJC-400"

IC_MAP = {
    "00": {
        "name": "SN7400N",
        "desc": "Quad 2-input NAND",
        "kicad_symbol": "74xx:SN7400N",
        "kicad_footprint": "Package_DIP:DIP-14_W7.62mm",
        "pins": 14,
        "gates": 4,
        "gate_pins": {
            "A": {"in": [1, 2], "out": [3]},
            "B": {"in": [4, 5], "out": [6]},
            "C": {"in": [9, 10], "out": [8]},
            "D": {"in": [12, 13], "out": [11]},
        },
        "power": {"VCC": 14, "GND": 7},
    },
    "04": {
        "name": "SN7404N",
        "desc": "Hex Inverter",
        "kicad_symbol": "74xx:SN7404N",
        "kicad_footprint": "Package_DIP:DIP-14_W7.62mm",
        "pins": 14,
        "gates": 6,
        "gate_pins": {
            "A": {"in": [1], "out": [2]},
            "B": {"in": [3], "out": [4]},
            "C": {"in": [5], "out": [6]},
            "D": {"in": [9], "out": [8]},
            "E": {"in": [11], "out": [10]},
            "F": {"in": [13], "out": [12]},
        },
        "power": {"VCC": 14, "GND": 7},
    },
    "08": {
        "name": "SN7408N",
        "desc": "Quad 2-input AND",
        "kicad_symbol": "74xx:SN7408N",
        "pins": 14,
        "gates": 4,
        "gate_pins": {
            "A": {"in": [1, 2], "out": [3]},
            "B": {"in": [4, 5], "out": [6]},
            "C": {"in": [9, 10], "out": [8]},
            "D": {"in": [12, 13], "out": [11]},
        },
        "power": {"VCC": 14, "GND": 7},
    },
    "175": {
        "name": "SN74175N",
        "desc": "Quad D Flip-Flop",
        "kicad_symbol": "74xx:SN74175N",
        "pins": 16,
        "gates": 1,
        "gate_pins": {
            "A": {"clk": [9], "clr": [1], "d": [4, 5, 12, 13], "q": [2, 7, 10, 15], "nq": [3, 6, 11, 14]},
        },
        "power": {"VCC": 16, "GND": 8},
    },
    "R": {"kicad_symbol": "Device:R", "shape": "resistor"},
    "C": {"kicad_symbol": "Device:C", "shape": "capacitor"},
}


def page_id_sort_key(name: str) -> tuple:
    # "2-5" → (2, 5), fallback alphabetical
    parts = name.replace(".jpg", "").split("-")
    try:
        return tuple(int(p) for p in parts)
    except ValueError:
        return (999, name)


def main() -> None:
    packages = sorted(p for p in ROOT.iterdir() if p.is_dir())

    # ic_map.yaml
    (ROOT / "ic_map.yaml").write_text(yaml.safe_dump(IC_MAP, sort_keys=False, allow_unicode=True))

    # project.yaml
    project_doc = {
        "kronikarz": "1",
        "project": {
            "name": "MJC-400",
            "desc": "Modul Jednostki Centralnej",
            "doc": "12-006368-01-8A",
            "status": "raw",
        },
        "packages": [
            {"id": p.name, "name": p.name, "file": f"{p.name}/package.yaml", "status": "raw"}
            for p in packages
        ],
        "backplane": [],
    }
    (ROOT / "project.yaml").write_text(
        "kronikarz: \"1\"\n" + yaml.safe_dump(
            {k: v for k, v in project_doc.items() if k != "kronikarz"},
            sort_keys=False, allow_unicode=True,
        )
    )

    total_pages = 0
    for pkg_dir in packages:
        scans_dir = pkg_dir / "scans"
        if not scans_dir.exists():
            continue
        scans = sorted(scans_dir.glob("*.jpg"), key=lambda p: page_id_sort_key(p.name))
        pages_dir = pkg_dir / "pages"
        pages_dir.mkdir(exist_ok=True)

        page_refs = []
        for scan in scans:
            page_id = scan.stem  # "2-5"
            page_refs.append({
                "id": page_id,
                "file": f"pages/{page_id}.sch.yaml",
                "scan": f"scans/{scan.name}",
                "title": f"Schemat ideowy pakietu {pkg_dir.name}",
                "status": "raw",
            })
            sch_path = pages_dir / f"{page_id}.sch.yaml"
            if sch_path.exists():
                continue
            with Image.open(scan) as im:
                w, h = im.size
            sch_doc = {
                "kronikarz": "1",
                "page": page_id,
                "package": pkg_dir.name,
                "scan_size": [w, h],
                "gates": [],
                "power": [],
                "nets": {},
                "annotations": [],
            }
            sch_path.write_text(
                "kronikarz: \"1\"\n" + yaml.safe_dump(
                    {k: v for k, v in sch_doc.items() if k != "kronikarz"},
                    sort_keys=False, allow_unicode=True, default_flow_style=None,
                )
            )
            total_pages += 1

        pkg_doc = {
            "kronikarz": "1",
            "package": {
                "id": pkg_dir.name,
                "name": pkg_dir.name,
                "doc": "12-006368-01-8A",
                "status": "raw",
                "pages": page_refs,
            },
            "components": {},
        }
        (pkg_dir / "package.yaml").write_text(
            "kronikarz: \"1\"\n" + yaml.safe_dump(
                {k: v for k, v in pkg_doc.items() if k != "kronikarz"},
                sort_keys=False, allow_unicode=True,
            )
        )
        print(f"  {pkg_dir.name}: {len(scans)} stron")

    print(f"\nTotal: {len(packages)} pakietow, {total_pages} stron sch.yaml")


if __name__ == "__main__":
    main()
