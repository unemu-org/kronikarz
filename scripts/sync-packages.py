#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Sync data/MJC-400/<pkg>/package.yaml `components` from referenced
gates in pages/<*>.sch.yaml. Strips `ic` field from gates if AI left it
in the sch.yaml (it belongs in package.yaml, not page).

Usage: uv run scripts/sync-packages.py [<pkg>...]
"""
from __future__ import annotations
import sys
from pathlib import Path
import yaml

REPO = Path(__file__).resolve().parent.parent
ROOT = REPO / "data/MJC-400"


def sync_package(pkg_dir: Path) -> None:
    pkg_path = pkg_dir / "package.yaml"
    pages_dir = pkg_dir / "pages"
    if not pkg_path.exists() or not pages_dir.exists():
        return

    pkg_doc = yaml.safe_load(pkg_path.read_text())
    components = pkg_doc.setdefault("components", {}) or {}
    if components is None:
        components = {}

    ref_to_ic: dict[str, str | None] = {}
    ref_to_pages: dict[str, dict[str | None, set[str]]] = {}

    for sch_path in sorted(pages_dir.glob("*.sch.yaml")):
        sch = yaml.safe_load(sch_path.read_text())
        if not isinstance(sch, dict):
            continue
        page_id = sch.get("page")
        gates = sch.get("gates") or []
        dirty = False
        for g in gates:
            if not isinstance(g, dict):
                continue
            ref = g.get("ref")
            if not ref:
                continue
            ic = g.pop("ic", None)
            if ic is not None:
                dirty = True
            if ref not in ref_to_ic or (ic and not ref_to_ic[ref]):
                ref_to_ic[ref] = ic
            letter = g.get("gate")
            ref_to_pages.setdefault(ref, {}).setdefault(letter, set()).add(page_id)
        if dirty:
            # rewrite sch.yaml without `ic` in gates
            text = "kronikarz: \"1\"\n" + yaml.safe_dump(
                {k: v for k, v in sch.items() if k != "kronikarz"},
                sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
            )
            sch_path.write_text(text)
            print(f"  stripped ic from {sch_path.relative_to(REPO)}")

    added = 0
    for ref, ic in ref_to_ic.items():
        if ref in components and components[ref]:
            continue
        gates_by_letter = ref_to_pages.get(ref, {})
        if ic:
            comp = {
                "ic": ic,
                "gates": {
                    letter: {"page": next(iter(pages))}
                    for letter, pages in sorted(gates_by_letter.items())
                    if letter is not None
                    for _ in [pages]
                },
            }
        else:
            all_pages = sorted({p for pages in gates_by_letter.values() for p in pages})
            comp = {"ic": None, "type": "unknown", "pages": all_pages}
        components[ref] = comp
        added += 1

    if added or any(ref_to_ic.values()):
        pkg_doc["components"] = components
        text = "kronikarz: \"1\"\n" + yaml.safe_dump(
            {k: v for k, v in pkg_doc.items() if k != "kronikarz"},
            sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
        )
        pkg_path.write_text(text)
        print(f"{pkg_dir.name}: +{added} components ({len(components)} total)")
    else:
        print(f"{pkg_dir.name}: already in sync")


def main() -> None:
    targets = sys.argv[1:] if len(sys.argv) > 1 else [p.name for p in ROOT.iterdir() if p.is_dir()]
    for name in sorted(targets):
        pkg_dir = ROOT / name
        if pkg_dir.is_dir():
            sync_package(pkg_dir)


if __name__ == "__main__":
    main()
