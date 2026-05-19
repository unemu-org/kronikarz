# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Naprawia adnotacje page-id i sheet-number na kazdej stronie w P-R3-2.

Heurystyka:
- annotation pozycja w okolicy (1604, 1448) z fontSize ~40 -> text = page.id
- annotation pozycja w okolicy (1756, 1429) z fontSize ~30 -> text = sheet number
"""
from pathlib import Path
import sys
import yaml

REPO = Path(__file__).resolve().parent.parent
PKG_ID = "P-R3-2"
PKG_DIR = REPO / "data/MJC-400" / PKG_ID
PKG_YAML = PKG_DIR / "package.yaml"

PAGE_ID_POS = (1604, 1448)
PAGE_ID_FONT = 40
SHEET_POS = (1756, 1429)
SHEET_FONT = 30
POS_TOL = 80


def near(a, b, tol=POS_TOL):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


def main():
    pkg_doc = yaml.safe_load(PKG_YAML.read_text())
    pages = pkg_doc["package"]["pages"]
    sheet_by_id = {p["id"]: p.get("sheet") for p in pages}

    updated_pages = 0
    for ref in pages:
        pid = ref["id"]
        sheet = sheet_by_id.get(pid)
        page_path = PKG_DIR / "pages" / f"{pid}.sch.yaml"
        if not page_path.exists():
            print(f"  ! missing: {page_path}")
            continue
        doc = yaml.safe_load(page_path.read_text())
        anns = doc.get("annotations") or []
        changed = False
        for a in anns:
            if not isinstance(a, dict):
                continue
            ax = a.get("x")
            ay = a.get("y")
            fs = a.get("fontSize")
            if ax is None or ay is None:
                continue
            if near((ax, ay), PAGE_ID_POS) and fs == PAGE_ID_FONT:
                if a.get("text") != pid:
                    a["text"] = pid
                    changed = True
            elif near((ax, ay), SHEET_POS) and fs == SHEET_FONT:
                want = str(sheet) if sheet is not None else None
                if want and a.get("text") != want:
                    a["text"] = want
                    changed = True
        if changed:
            out = 'kronikarz: "1"\n' + yaml.safe_dump(
                {k: v for k, v in doc.items() if k != "kronikarz"},
                sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
            )
            page_path.write_text(out)
            updated_pages += 1
            print(f"  updated {page_path.relative_to(REPO)}: id={pid} sheet={sheet}")
    print(f"\nDone. Updated {updated_pages} pages.")


if __name__ == "__main__":
    main()
