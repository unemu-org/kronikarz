# /// script
# requires-python = ">=3.11"
# dependencies = ["pillow==13.0.0", "pyyaml"]
# ///
"""Odtwarza skany stron MJC-400 z PDF-a DTR trzymanego w oracles/.

Skany NIE są w repozytorium: nie mamy prawa do redystrybucji dokumentacji.
Źródło to `oracles/mera400/mera400-dtr-t4-cz2-mjc400-schematy.pdf` (fetch-only,
przypięty sha256 w oracles/SHA256SUMS.fetched; pobierz przez
`cd oracles && ./fetch-oracles.sh fetch`).

Kroki (odtwarzalne bajt w bajt, sprawdzane względem <KRONIKARZ_DATA>/scans.sha256):
  1. `pdfimages -all` (poppler) -> data/scans-raw/page-NNN.png
  2. page-NNN.png -> arkusz 2-(NNN+1); pakiet z package.yaml (pages[].scan)
     -> data/MJC-400/<pkg>/scans/2-N.jpg (Pillow, JPEG quality=90, tryb L)

Usage: uv run scripts/extract-scans.py [--oracles DIR] [--force]
"""
from __future__ import annotations

import argparse
import hashlib
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import yaml
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
PDF_NAME = "mera400/mera400-dtr-t4-cz2-mjc400-schematy.pdf"
PDF_SHA256 = "f2bb99bfec681f5276a43443527949a7f59b0ad0cfbedf1549c245ff966d6882"
PROJECT = "MJC-400"


def sha256(p: Path) -> str:
    h = hashlib.sha256()
    with p.open("rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def scan_targets(data: Path) -> dict[str, Path]:
    """page id (2-N) -> docelowy plik jpg, z package.yaml każdego pakietu."""
    out: dict[str, Path] = {}
    for pkg_yaml in sorted((data / PROJECT).glob("*/package.yaml")):
        pkg = yaml.safe_load(pkg_yaml.read_text(encoding="utf-8"))
        for page in (pkg.get("package") or pkg).get("pages", []):
            if page.get("scan"):
                out[str(page["id"])] = pkg_yaml.parent / page["scan"]
    return out


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--oracles", default=os.environ.get("KRONIKARZ_ORACLES", REPO / "oracles"))
    ap.add_argument("--force", action="store_true", help="nadpisz istniejące skany")
    args = ap.parse_args()

    data = Path(os.environ.get("KRONIKARZ_DATA", REPO / "data"))
    if not data.is_absolute():
        data = REPO / data
    pdf = Path(args.oracles) / PDF_NAME
    if not pdf.is_file():
        sys.exit(f"brak {pdf} — uruchom: git submodule update --init && cd oracles && ./fetch-oracles.sh fetch")
    if sha256(pdf) != PDF_SHA256:
        sys.exit(f"{pdf}: sha256 nie zgadza się z przypiętym {PDF_SHA256}")
    if not shutil.which("pdfimages"):
        sys.exit("brak pdfimages (poppler) w PATH")

    targets = scan_targets(data)
    raw = data / "scans-raw"
    raw.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as tmp:
        subprocess.run(["pdfimages", "-all", str(pdf), f"{tmp}/page"], check=True)
        pngs = sorted(Path(tmp).glob("page-*.png"))
        for png in pngs:
            dst = raw / png.name
            if args.force or not dst.exists():
                shutil.copyfile(png, dst)
            page_id = f"2-{int(png.stem.split('-')[1]) + 1}"
            jpg = targets.get(page_id)
            if jpg is None:
                print(f"!! {png.name}: arkusz {page_id} nie występuje w żadnym package.yaml")
                continue
            if args.force or not jpg.exists():
                jpg.parent.mkdir(parents=True, exist_ok=True)
                im = Image.open(png)
                (im if im.mode in ("L", "RGB") else im.convert("L")).save(jpg, "JPEG", quality=90)
    print(f"{len(pngs)} stron z PDF, {len(targets)} arkuszy w pakietach")

    sums = data / "scans.sha256"
    bad = 0
    for line in sums.read_text().splitlines():
        h, rel = line.split(maxsplit=1)
        p = data / rel
        if not p.is_file() or sha256(p) != h:
            print(f"XX {rel}: brak albo inny sha256")
            bad += 1
    print("OK: wszystkie skany zgodne z data/scans.sha256" if not bad else f"{bad} niezgodnych plików")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
