# /// script
# requires-python = ">=3.11"
# dependencies = ["anthropic>=0.92.0", "pillow", "python-dotenv", "pyyaml"]
# ///
"""Vision per-zone: user oznacza strefy (gates / ports_left / ports_right /
cross_refs) na skanie. Skrypt crop'uje kazda i pyta Claude'a osobno
z role-specific promptem. Wynik merge'owany do jednego *.sch.yaml.

Server endpoint /vision-page-zones robi backup przed odpaleniem.

Args: package page_id zones.json
zones.json: {"zones": [{"role": "gates", "x":..., "y":..., "w":..., "h":...}, ...]}
(czytane ze stdin jako JSON dla wygody server'a)
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
MAX_TOKENS = 8000


ROLE_PROMPTS = {
    "gates": """Ten wycinek pokazuje fragment schematu z bramkami/ukladami.
Wykryj WSZYSTKIE pudelka bramek (M-numer u dolu pudla, sufiks IC i typ
bramki u gory). Dla kazdej zwroc: ref (M-numer), gate (litera A/B/C lub null),
x/y (srodek pudla), pins (lista z num/side/px/py). Pola px/py to KONCOWKI
pinow na krawedziach pudla. Pominij wszystko co nie jest pudelkiem bramki.
""",
    "ports_left": """Ten wycinek pokazuje LEWA krawedz schematu z portami
edge-connector typu `< A50 >  -BLR`. Wykryj kazdy port: connector (litera
A/B/C/D), pin (numer styku), label (sygnal np. -BLR), x/y (czubek chevronu).
side dla wszystkich = 'left'. Pominij cross_refs (te beda osobno).
""",
    "ports_right": """Ten wycinek pokazuje PRAWA krawedz schematu z portami
edge-connector. Wykryj kazdy port jak wyzej, side = 'right'.
""",
    "cross_refs_left": """Ten wycinek pokazuje LEWA krawedz z cross-page
references typu `-CZYTRW 2,3,4,5`. Wykryj kazdy: net (label sygnalu),
label, pages (lista numerow stron), x/y (koniec strzalki gdzie wchodzi wire).
side dla wszystkich = 'left'.
""",
    "cross_refs_right": """Ten wycinek pokazuje PRAWA krawedz z cross-page
references. Jak wyzej, side = 'right'.
""",
}


def role_schema(role: str) -> str:
    if role == "gates":
        return """Zwroc YAML postaci:
gates:
  - ref: M55
    gate: A
    x: 134
    y: 235
    rotation: 0
    pins:
      - { num: 9, side: left, net: "", px: 109, py: 236 }
      - { num: 8, side: right, net: "", px: 159, py: 234 }
    label_left: "9"
    label_right: "8"
    verified: false
    note: null
"""
    if role.startswith("ports_"):
        return """Zwroc YAML postaci:
ports:
  - { connector: A, pin: 50, label: "-BLR", net: "", x: 30, y: 110, side: left }
"""
    if role.startswith("cross_refs"):
        return """Zwroc YAML postaci:
cross_refs:
  - { net: "-CZYTRW", label: "-CZYTRW", pages: ["2","3","4","5"], x: 200, y: 130 }
"""
    return ""


def vision_zone(client, img_b64: str, role: str) -> list:
    prompt = ROLE_PROMPTS.get(role, "")
    schema = role_schema(role)
    system = (
        "Wykrywasz elementy schematu MERA-400 z wycinka skanu. "
        "WSZYSTKIE koordynaty zwracaj w pikselach TEGO WYCINKA (origin top-left). "
        "Zwroc TYLKO YAML, bez markdown, bez dodatkowego tekstu. "
        + prompt + "\n" + schema
    )
    resp = client.messages.create(
        model=MODEL,
        max_tokens=MAX_TOKENS,
        system=system,
        messages=[{
            "role": "user",
            "content": [
                {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": img_b64}},
                {"type": "text", "text": "Zwroc YAML zgodny ze schema. Jezeli wycinek jest pusty zwroc pusta liste."},
            ],
        }],
    )
    text = "".join(b.text for b in resp.content if b.type == "text").strip()
    if text.startswith("```"):
        first_nl = text.find("\n")
        text = text[first_nl + 1 :]
        end = text.rfind("```")
        if end >= 0:
            text = text[:end]
    try:
        doc = yaml.safe_load(text.strip()) or {}
    except Exception as e:
        print(f"  ! YAML parse fail for role={role}: {e}", file=sys.stderr)
        return []
    if role == "gates":
        return doc.get("gates") or []
    if role.startswith("ports_"):
        return doc.get("ports") or []
    if role.startswith("cross_refs"):
        return doc.get("cross_refs") or []
    return []


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("package")
    ap.add_argument("page_id")
    args = ap.parse_args()

    payload = json.loads(sys.stdin.read())
    zones = payload.get("zones") or []
    if not zones:
        sys.exit("no zones provided")

    load_dotenv(REPO / ".env")
    api_key = os.environ.get("ANTHROPIC_API_KEY")
    if not api_key:
        sys.exit("ANTHROPIC_API_KEY missing in .env")

    scan_path = REPO / f"data/MJC-400/{args.package}/scans/{args.page_id}.jpg"
    page_path = REPO / f"data/MJC-400/{args.package}/pages/{args.page_id}.sch.yaml"
    if not scan_path.exists():
        sys.exit(f"scan missing: {scan_path}")

    full_img = Image.open(scan_path).convert("RGB")
    w_orig, h_orig = full_img.size

    client = anthropic.Anthropic(api_key=api_key)

    out_gates = []
    out_ports = []
    out_xrefs = []

    for z in zones:
        role = z.get("role")
        x, y, w, h = int(z["x"]), int(z["y"]), int(z["w"]), int(z["h"])
        crop = full_img.crop((x, y, x + w, y + h))
        # Optional resize if huge
        if max(crop.size) > 2400:
            sc = 2400 / max(crop.size)
            crop = crop.resize((int(crop.size[0] * sc), int(crop.size[1] * sc)), Image.LANCZOS)
            sx = w / crop.size[0]
            sy = h / crop.size[1]
        else:
            sx = 1.0
            sy = 1.0
        buf = io.BytesIO()
        crop.save(buf, format="JPEG", quality=92)
        b64 = base64.b64encode(buf.getvalue()).decode("ascii")
        items = vision_zone(client, b64, role)
        # Scale + translate items from crop coords to full scan coords
        for it in items:
            for kx, ky in (("x", "y"), ("px", "py")):
                if kx in it and ky in it:
                    it[kx] = int(round(it[kx] * sx)) + x
                    it[ky] = int(round(it[ky] * sy)) + y
            # gates pins
            if "pins" in it:
                for pin in it["pins"]:
                    if "px" in pin and "py" in pin:
                        pin["px"] = int(round(pin["px"] * sx)) + x
                        pin["py"] = int(round(pin["py"] * sy)) + y
        if role == "gates":
            out_gates.extend(items)
        elif role.startswith("ports_"):
            for p in items:
                p["side"] = "left" if role == "ports_left" else "right"
            out_ports.extend(items)
        elif role.startswith("cross_refs"):
            for cr in items:
                cr["side"] = "left" if role == "cross_refs_left" else "right"
            out_xrefs.extend(items)

    # Read existing or start fresh
    if page_path.exists():
        doc = yaml.safe_load(page_path.read_text()) or {}
    else:
        doc = {}
    doc["kronikarz"] = "1"
    doc.setdefault("page", args.page_id)
    doc.setdefault("package", args.package)
    doc["scan_size"] = [w_orig, h_orig]
    doc["gates"] = out_gates
    doc["ports"] = out_ports
    doc["cross_refs"] = out_xrefs
    doc.setdefault("power", [])
    doc.setdefault("nets", {})
    doc.setdefault("annotations", [])

    out = 'kronikarz: "1"\n' + yaml.safe_dump(
        {k: v for k, v in doc.items() if k != "kronikarz"},
        sort_keys=False, allow_unicode=True, default_flow_style=None, width=120,
    )
    page_path.parent.mkdir(parents=True, exist_ok=True)
    page_path.write_text(out)

    summary = {
        "gates": len(out_gates),
        "ports": len(out_ports),
        "cross_refs": len(out_xrefs),
        "zones": len(zones),
        "scan_size": [w_orig, h_orig],
    }
    sys.stdout.write(json.dumps(summary, indent=2))


if __name__ == "__main__":
    main()
