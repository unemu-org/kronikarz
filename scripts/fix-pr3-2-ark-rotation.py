# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Naprawia rotation=270 dla anotacji 'Ark.' i 'A-y' na wszystkich stronach P-R3-2."""
from pathlib import Path
import yaml

REPO = Path(__file__).resolve().parent.parent
PKG_DIR = REPO / "data/MJC-400/P-R3-2"
PKG_YAML = PKG_DIR / "package.yaml"

TARGETS = {"Ark.", "A-y"}


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
        changed = False
        for a in anns:
            if not isinstance(a, dict):
                continue
            if a.get("text") in TARGETS and a.get("rotation") != 270:
                a["rotation"] = 270
                changed = True
        if changed:
            out = 'kronikarz: "1"\n' + yaml.safe_dump(
                {k: v for k, v in doc.items() if k != "kronikarz"},
                sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
            )
            path.write_text(out)
            updated += 1
            print(f"  fixed {path.relative_to(REPO)}")
    print(f"Done. {updated} pages updated.")


if __name__ == "__main__":
    main()
