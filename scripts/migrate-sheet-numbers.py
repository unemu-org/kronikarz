# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Migracja: nadaj kazdej stronie w package.yaml pole `sheet` zgodnie z kolejnoscia.
1-indexed. Idempotentne: jezeli `sheet` juz jest, pomija.
"""
from pathlib import Path
import sys
import yaml

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"


def migrate(path: Path) -> bool:
    txt = path.read_text()
    doc = yaml.safe_load(txt)
    if not doc or "package" not in doc:
        return False
    pages = doc["package"].get("pages") or []
    changed = False
    for i, p in enumerate(pages, 1):
        if "sheet" in p and isinstance(p["sheet"], int):
            continue
        p["sheet"] = i
        changed = True
    if changed:
        out = 'kronikarz: "1"\n' + yaml.safe_dump(
            {k: v for k, v in doc.items() if k != "kronikarz"},
            sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
        )
        path.write_text(out)
        print(f"  migrated {path.relative_to(REPO)}")
    return changed


def main():
    files = list(DATA.glob("**/package.yaml"))
    print(f"Scanning {len(files)} package.yaml files")
    n = sum(migrate(p) for p in files)
    print(f"Migrated {n} files.")


if __name__ == "__main__":
    main()
