# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Migracja schemy: split port.connector "A50" -> connector "A" + pin 50.
Aktualizuje wszystkie *.sch.yaml oraz project.yaml (backplane signals).

Backplane: stara para from/to -> nowa lista endpoints.

Idempotentne: jezeli port juz ma 'pin' jako int, pomija.
"""
import re
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent
DATA = REPO / "data"

PORT_RE = re.compile(r"^([A-Za-z]+)(\d+)$")


def split_id(s: str):
    m = PORT_RE.match(str(s).strip())
    if not m:
        return None, None
    return m.group(1).upper(), int(m.group(2))


def migrate_page(path: Path) -> bool:
    txt = path.read_text()
    doc = yaml.safe_load(txt)
    if not doc or "ports" not in doc:
        return False
    changed = False
    for port in doc.get("ports") or []:
        if isinstance(port.get("pin"), int) and isinstance(port.get("connector"), str) and len(port["connector"]) <= 3 and not any(ch.isdigit() for ch in port["connector"]):
            continue
        old = port.get("connector")
        if not isinstance(old, str):
            continue
        c, pn = split_id(old)
        if c is None:
            print(f"  ! cannot split port.connector={old!r} in {path}", file=sys.stderr)
            continue
        port["connector"] = c
        port["pin"] = pn
        changed = True
    if changed:
        out = 'kronikarz: "1"\n' + yaml.safe_dump(
            {k: v for k, v in doc.items() if k != "kronikarz"},
            sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
        )
        path.write_text(out)
        print(f"  migrated {path.relative_to(REPO)}")
    return changed


def migrate_project(path: Path) -> bool:
    txt = path.read_text()
    doc = yaml.safe_load(txt)
    if not doc:
        return False
    bp = doc.get("backplane")
    if not isinstance(bp, list):
        return False
    changed = False
    new_bp = []
    for sig in bp:
        if "endpoints" in sig:
            new_bp.append(sig)
            continue
        eps = []
        for key in ("from", "to"):
            ref = sig.get(key)
            if not isinstance(ref, dict):
                continue
            cp = ref.get("connector_pin")
            pkg = ref.get("package")
            c, pn = split_id(cp) if isinstance(cp, str) else (None, None)
            if c is None or pkg is None:
                continue
            eps.append({"package": pkg, "connector": c, "pin": pn})
        new_sig = {"signal": sig.get("signal"), "endpoints": eps}
        new_bp.append(new_sig)
        changed = True
    if changed:
        doc["backplane"] = new_bp
        out = 'kronikarz: "1"\n' + yaml.safe_dump(
            {k: v for k, v in doc.items() if k != "kronikarz"},
            sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
        )
        path.write_text(out)
        print(f"  migrated {path.relative_to(REPO)}")
    return changed


def main():
    pages = list(DATA.glob("**/pages/*.sch.yaml"))
    projects = list(DATA.glob("**/project.yaml"))
    print(f"Scanning {len(pages)} pages, {len(projects)} project.yaml files")
    n_pages = sum(migrate_page(p) for p in pages)
    n_proj = sum(migrate_project(p) for p in projects)
    print(f"Migrated {n_pages} pages, {n_proj} project files.")


if __name__ == "__main__":
    main()
