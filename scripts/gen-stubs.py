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

UWAGA: data/MJC-400 to ręcznie kurowane dane. Skrypt domyślnie NIE nadpisuje
niczego: najpierw zbiera wszystkie pliki docelowe i jeśli którykolwiek z
project.yaml / ic_map.yaml / <pkg>/package.yaml już istnieje, wypisuje listę i
kończy się kodem 1, nie zapisując nic (wszystko albo nic). Istniejące strony
*.sch.yaml są zawsze pomijane (nigdy nie nadpisywane, także z --force).

Konsekwencja: dodanie stuba dla NOWEGO skanu w istniejącym module wymaga
--force (bo package.yaml / project.yaml już istnieją), a --force przepisuje
package.yaml od zera — `components: {}` (rejestr IC zostaje wyczyszczony),
project.yaml dostaje `backplane: []`, ic_map.yaml wraca do minimalnego zestawu.
W praktyce: NIE używaj --force na kurowanych danych; nową stronę dopisz ręcznie
(albo wygeneruj do pustego katalogu przez --root i przenieś sam *.sch.yaml).

  --force     nadpisz istniejące pliki; przed nadpisaniem każdy jest kopiowany do
              `<plik>.<ISO-UTC>.bak` obok (np. project.yaml.2026-11-27T10-15-30-123Z.bak,
              ten sam wzór co backupy serwera; *.bak jest w .gitignore).
              Zapis atomowy (plik tymczasowy w tym samym katalogu + os.replace).
  --root DIR  katalog modułu (domyślnie data/MJC-400) — do testów / prób.
  --dry-run   tylko wypisz, co zostałoby utworzone / nadpisane.

Run: uv run scripts/gen-stubs.py [--root DIR] [--force] [--dry-run]
"""
from __future__ import annotations
import argparse
import sys
from pathlib import Path
import yaml
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _safe_write import write_all  # noqa: E402

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


def build_writes(root: Path) -> tuple[dict[Path, str], list[str]]:
    """Wylicza (ścieżka → treść) wszystkich plików do zapisu, bez zapisywania."""
    writes: dict[Path, str] = {}
    log: list[str] = []
    packages = sorted(p for p in root.iterdir() if p.is_dir())

    # ic_map.yaml
    writes[root / "ic_map.yaml"] = yaml.safe_dump(IC_MAP, sort_keys=False, allow_unicode=True)

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
    writes[root / "project.yaml"] = (
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
            writes[sch_path] = (
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
        writes[pkg_dir / "package.yaml"] = (
            "kronikarz: \"1\"\n" + yaml.safe_dump(
                {k: v for k, v in pkg_doc.items() if k != "kronikarz"},
                sort_keys=False, allow_unicode=True,
            )
        )
        log.append(f"  {pkg_dir.name}: {len(scans)} stron")

    log.append(f"\nTotal: {len(packages)} pakietow, {total_pages} stron sch.yaml")
    return writes, log


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Generuje stuby YAML (nie nadpisuje bez --force).")
    ap.add_argument("--root", type=Path, default=ROOT, help=f"katalog modułu (domyślnie {ROOT})")
    ap.add_argument("--force", action="store_true", help="nadpisz istniejące pliki (z kopią .bak)")
    ap.add_argument("--dry-run", action="store_true", help="tylko pokaż plan zapisu")
    args = ap.parse_args(argv)
    if not args.root.is_dir():
        sys.stderr.write(f"błąd: brak katalogu {args.root}\n")
        return 1

    writes, log = build_writes(args.root)
    rc = write_all(writes, force=args.force, dry_run=args.dry_run)
    if rc == 0 and not args.dry_run:
        print("\n".join(log))
    return rc


if __name__ == "__main__":
    sys.exit(main())
