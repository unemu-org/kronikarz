# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Wyrowna x cyfry 'Ark' (numer arkusza, y~1429) do x cyfry 'A-y' (total, y~1477)
na kazdej stronie P-R3-2."""
from pathlib import Path
import yaml

REPO = Path(__file__).resolve().parent.parent
PKG_DIR = REPO / "data/MJC-400/P-R3-2"
PKG_YAML = PKG_DIR / "package.yaml"


def main():
    pkg_doc = yaml.safe_load(PKG_YAML.read_text())
    pages = pkg_doc["package"]["pages"]
    updated = 0
    for ref in pages:
        path = PKG_DIR / "pages" / f"{ref['id']}.sch.yaml"
        if not path.exists():
            continue
        doc = yaml.safe_load(path.read_text())
        anns = doc.get("annotations") or []
        sheet_ann = None
        total_ann = None
        for a in anns:
            if not isinstance(a, dict) or a.get("fontSize") != 30:
                continue
            ay = a.get("y")
            if ay is None:
                continue
            if 1420 <= ay <= 1440:
                sheet_ann = a
            elif 1465 <= ay <= 1490:
                total_ann = a
        if not sheet_ann or not total_ann:
            print(f"  ! skip {path.name} (sheet={sheet_ann is not None} total={total_ann is not None})")
            continue
        if sheet_ann["x"] == total_ann["x"]:
            continue
        sheet_ann["x"] = total_ann["x"]
        out = 'kronikarz: "1"\n' + yaml.safe_dump(
            {k: v for k, v in doc.items() if k != "kronikarz"},
            sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
        )
        path.write_text(out)
        updated += 1
        print(f"  aligned {path.name}: sheet.x -> {total_ann['x']}")
    print(f"Done. {updated} pages updated.")


if __name__ == "__main__":
    main()
