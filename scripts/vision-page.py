# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic>=0.92.0", "pillow", "python-dotenv", "pyyaml"]
# ///
"""Vision digitalizacja jednej strony: scan jpg + vision-prompt.md system
prompt -> Claude API -> YAML (zapisany do pages/<page>.sch.yaml).

Server endpoint /vision-page robi backup przed odpaleniem tego skryptu.

Usage: uv run scripts/vision-page.py <package> <page-id>
"""
from __future__ import annotations
import argparse
import base64
import io
import json
import os
import sys
from pathlib import Path

import anthropic
import yaml
from dotenv import load_dotenv
from PIL import Image

REPO = Path(__file__).resolve().parent.parent
MODEL = "claude-opus-4-7"
MAX_TOKENS = 16000


def load_system_prompt() -> str:
    p = REPO / "specyfikacje-kronikarza" / "vision-prompt.md"
    if not p.exists():
        sys.exit(f"missing prompt: {p}")
    return p.read_text()


def load_scan_b64(path: Path, max_dim: int = 2400) -> tuple[str, int, int, int, int]:
    """Returns (b64, orig_w, orig_h, sent_w, sent_h)."""
    img = Image.open(path).convert("RGB")
    w_orig, h_orig = img.size
    if max(w_orig, h_orig) > max_dim:
        scale = max_dim / max(w_orig, h_orig)
        img = img.resize((int(w_orig * scale), int(h_orig * scale)), Image.LANCZOS)
    w_sent, h_sent = img.size
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=90)
    return base64.b64encode(buf.getvalue()).decode("ascii"), w_orig, h_orig, w_sent, h_sent


def scale_doc_coords(doc: dict, sx: float, sy: float) -> None:
    """Scale all numeric coords in the YAML by (sx, sy)."""
    def s(v, sc):
        return int(round(v * sc))

    for g in doc.get("gates") or []:
        if "x" in g: g["x"] = s(g["x"], sx)
        if "y" in g: g["y"] = s(g["y"], sy)
        if "w" in g and g["w"] is not None: g["w"] = s(g["w"], sx)
        if "h" in g and g["h"] is not None: g["h"] = s(g["h"], sy)
        for pin in g.get("pins") or []:
            if "px" in pin: pin["px"] = s(pin["px"], sx)
            if "py" in pin: pin["py"] = s(pin["py"], sy)
    for port in doc.get("ports") or []:
        if "x" in port: port["x"] = s(port["x"], sx)
        if "y" in port: port["y"] = s(port["y"], sy)
    for cr in doc.get("cross_refs") or []:
        if "x" in cr: cr["x"] = s(cr["x"], sx)
        if "y" in cr: cr["y"] = s(cr["y"], sy)
    for pw in doc.get("power") or []:
        if "x" in pw: pw["x"] = s(pw["x"], sx)
        if "y" in pw: pw["y"] = s(pw["y"], sy)
    for ann in doc.get("annotations") or []:
        if "x" in ann: ann["x"] = s(ann["x"], sx)
        if "y" in ann: ann["y"] = s(ann["y"], sy)


def extract_yaml(text: str) -> str:
    s = text.strip()
    if s.startswith("```"):
        first_nl = s.find("\n")
        s = s[first_nl + 1 :]
        end = s.rfind("```")
        if end >= 0:
            s = s[:end]
    return s.strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("package")
    ap.add_argument("page_id")
    args = ap.parse_args()

    load_dotenv(REPO / ".env")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ANTHROPIC_API_KEY missing in .env")

    scan = REPO / f"data/MJC-400/{args.package}/scans/{args.page_id}.jpg"
    page_path = REPO / f"data/MJC-400/{args.package}/pages/{args.page_id}.sch.yaml"
    if not scan.exists():
        sys.exit(f"scan missing: {scan}")

    img_b64, w_orig, h_orig, w_sent, h_sent = load_scan_b64(scan)
    system = load_system_prompt()
    user_msg = (
        f"Skan strony {args.page_id} pakietu {args.package}. "
        f"WAZNE: scan_size dla TWOICH koordynat = [{w_sent}, {h_sent}] "
        f"(rozmiar zdjecia ktore widzisz). Zwróć WSZYSTKIE koordynaty (x, y, px, py) "
        f"w tym ukladzie pikseli. Pole `scan_size` w YAML ustaw na [{w_sent}, {h_sent}]. "
        f"Zwróć tylko YAML zgodny ze specyfikacją."
    )

    client = anthropic.Anthropic(api_key=api_key)
    resp = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img_b64}},
                {"type": "text", "text": user_msg},
            ],
        }],
    )

    text = "".join(b.text for b in resp.content if b.type == "text")
    yaml_text = extract_yaml(text)

    try:
        doc = yaml.safe_load(yaml_text)
    except Exception as e:
        sys.exit(f"vision returned invalid YAML: {e}\n---\n{yaml_text[:2000]}")

    if not isinstance(doc, dict) or "kronikarz" not in doc:
        sys.exit("vision YAML missing 'kronikarz' top-level field")

    # Skaluj coords z sent (vision) do oryginalu skanu
    sx = w_orig / max(1, w_sent)
    sy = h_orig / max(1, h_sent)
    scale_doc_coords(doc, sx, sy)
    doc["scan_size"] = [w_orig, h_orig]
    # Wymus required pola
    doc.setdefault("nets", {})
    doc.setdefault("annotations", [])
    doc.setdefault("power", [])

    out = 'kronikarz: "1"\n' + yaml.safe_dump(
        {k: v for k, v in doc.items() if k != "kronikarz"},
        sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
    )
    page_path.parent.mkdir(parents=True, exist_ok=True)
    page_path.write_text(out)

    summary = {
        "gates": len(doc.get("gates") or []),
        "ports": len(doc.get("ports") or []),
        "cross_refs": len(doc.get("cross_refs") or []),
        "power": len(doc.get("power") or []),
        "scan_size": [w_orig, h_orig],
        "page_path": str(page_path),
    }
    sys.stdout.write(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
