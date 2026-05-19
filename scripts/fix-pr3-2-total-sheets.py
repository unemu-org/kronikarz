# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Naprawia adnotacje 'liczba arkuszy' (np. "12") w P-R3-2 - poprzedni skrypt
nadpisał ją numerem arkusza. Anotacja jest na pozycji ~(1746, 1477) fontSize 30.
"""
from pathlib import Path
import yaml

REPO = Path(__file__).resolve().parent.parent
PKG_DIR = REPO / "data/MJC-400/P-R3-2"
PKG_YAML = PKG_DIR / "package.yaml"

TOTAL_POS = (1746, 1477)
TOTAL_FONT = 30
POS_TOL = 20


def near(a, b, tol=POS_TOL):
    return abs(a[0] - b[0]) <= tol and abs(a[1] - b[1]) <= tol


def main():
    pkg_doc = yaml.safe_load(PKG_YAML.read_text())
    pages = pkg_doc["package"]["pages"]
    total = str(len(pages))

    updated = 0
    for ref in pages:
        path = PKG_DIR / "pages" / f"{ref['id']}.sch.yaml"
        if not path.exists():
            continue
        doc = yaml.safe_load(path.read_text())
        anns = doc.get("annotations") or []
        changed = False
        for a in anns:
            if not isinstance(a, dict):
                continue
            if a.get("fontSize") != TOTAL_FONT:
                continue
            if a.get("x") is None or a.get("y") is None:
                continue
            if near((a["x"], a["y"]), TOTAL_POS):
                if a.get("text") != total:
                    a["text"] = total
                    changed = True
        if changed:
            out = 'kronikarz: "1"\n' + yaml.safe_dump(
                {k: v for k, v in doc.items() if k != "kronikarz"},
                sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
            )
            path.write_text(out)
            updated += 1
            print(f"  fixed {path.relative_to(REPO)} -> {total}")
    print(f"Done. {updated} pages updated.")


if __name__ == "__main__":
    main()
