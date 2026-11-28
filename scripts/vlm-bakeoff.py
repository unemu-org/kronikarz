# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml", "pillow", "python-dotenv", "anthropic", "openai"]
# ///
"""Bake-off modeli VLM czytających tekst z małych wycinków schematu (spike kr-9p8.4).

Pytanie: który model najlepiej czyta tekst schematu MERA-400 z małych wycinków —
lokalnie (MLX, `mlx-vlm`) albo online (Claude, GPT)? Pola:

- bramka: symbol funkcji (`&`, `1`, `R`), typ układu (`04`, `H11`, `170`…), ref (`M54`)
  i numery pinów przy bokach (lewy/prawy góra→dół, górny lewo→prawo);
- port: złącze+pin w szewronie (`A50`, `B03`) i etykieta sygnału (`-BLR`) albo jej brak;
- cross-ref: etykieta (`+RPA`) i lista arkuszy (`2,3,4,5`).

Wycinki powstają z geometrii WZORCA (`data/gold`), nie z detekcji — mierzymy samo czytanie.

Geometria wycinków (px skanu 200 dpi; stałe `GATE_*`, `PORT_*`, `XREF_*`):

- bramka: prostokąt bramki poszerzony o `GATE_MX` w poziomie (numery pinów leżą nad drutem
  tuż przy ścianie, wyjście ma kółko negacji), `GATE_MT` u góry (cyfra pierwszego pinu
  wystaje ponad ścianę), `GATE_MB` u dołu; dodatkowo pionowo obejmuje każdy pin wzorca
  (`py - GATE_PIN_ABOVE … py + GATE_MB`). Bez osobnego marginesu na piny górne: jedyna
  bramka z pinami „top” we wzorcu (2-63 M19) ma je w rzeczywistości z lewej, a margines
  wciągał ref sąsiada (M8);
- port: wiersz `y-PORT_UP … y+PORT_DOWN`; w poziomie od szewronu w głąb arkusza
  (`PORT_OUT` na zewnątrz, `PORT_IN` do środka);
- cross-ref: wiersz `y-XREF_UP … y+XREF_DOWN`; `XREF_BACK` w stronę etykiety,
  `XREF_FWD` w stronę listy arkuszy;
- port i cross-ref dostają biały margines `MARK_PAD` po bokach z czerwonymi trójkątami na
  wysokości drutu celu (piksele skanu nie są zasłaniane). Sąsiednie wiersze są w kadrze;
  trójkąty mówią, który wiersz czytać;
- skala 1 (natywnie) albo 2 (LANCZOS ×2) — `--scale`.

Prawda (truth) pochodzi ze wzorca; `TRUTH_OVERRIDES` to jawna, krótka lista miejsc, gdzie
wzorzec nie opisuje tego, co jest NADRUKOWANE na skanie (port, przy którym etykieta nie jest
wypisana, bo wspólny drut opisano raz; pin bramki obecny we wzorcu jako `disconnected`, ale
nienarysowany). Każda pozycja ma powód i powinna zostać obejrzana przez opiekuna.

Normalizacja przed porównaniem (dokładne dopasowanie po normalizacji):
usunięcie białych znaków; minusy `−–—‐‑` → `-`; `Ø`/`ø` → `0` (rysownik pisał zero
z kreską; wzorzec raz ma `Ø`, raz `0`); litera `O` i cyfra `0` NIE są utożsamiane
(pomyłki raportowane osobno); polskie litery bez zmian; wielkość liter bez zmian.
W etykietach znak „∤” w środku (`W∤R`) zapisany jako `/`, `#`, `+`, `|`, `↑` → `/`
(wzorzec sam zapisuje go niejednolicie).
Złącze portu: litera + liczba bez zer wiodących (`B03` = `B3`). Arkusze: posortowana lista int.
Piny bramki: pole zaliczone, gdy listy lewa/prawa/góra są identyczne (kolejność ważna).

Flagi (sygnał do kolejki przeglądu):
(a) niezgodność dwóch odczytów (dwa modele albo dwa prompty) dla pola;
(b) odpowiedź spoza słownika: ref nie `M\\d+`, typ spoza kluczy `ic_map.yaml` (prefiks `H`
zdejmowany jak w `resolveIcKey`: `H11` → `11`), numer pinu
spoza `gate_pins` (i zasilania) odczytanego typu, złącze nie `[A-D]\\d{1,2}` (pin 1..96),
etykieta nie zaczyna się od `+`/`-`, arkusz spoza 1..liczba arkuszy pakietu.

Prompty: `v1` (główny), `v2` (inne sformułowanie, bez przykładów — drugi głos do flagi (a)),
`v3` (= v1 + wskazówki o piśmie, wyprowadzone tylko z błędów na 2-58/2-59).

Adaptery: `mlx` (lokalnie, `mlx-vlm`; tryb myślenia wyłączony, temperatura 0), `anthropic`
(oficjalne SDK, structured outputs, `effort`), `openai` (Responses API, json_schema),
`ocr` (PaddleOCR-VL przez mlx-vlm: wolny tekst + parsowanie regułami). Klucze API z
`.env` głównego checkoutu, nigdy nie są wypisywane. Odpowiedzi są cache'owane po
(model, hash wycinka, hash promptu, parametry) w `--cache` (domyślnie
`/Volumes/Dane/llm/kronikarz-cache/vlm-bakeoff`); dla MLX model = nazwa + hash pełnej ścieżki,
wpisy spod dawnych nazw (sam katalog) są czytane i kopiowane pod nowy klucz. Błędy (wyjątki,
odmowy) nie trafiają do cache. `run --cache-only --rescore` przelicza run bez wywołań modelu;
modele MLX ładują się dopiero przy pierwszym braku w cache.

Cały arkusz (`sheet`): elementy odpowiedzi dopasowywane do wycinków wzorca po położeniu i
po odczycie wycinkowym `--ref-run` (nigdy po prawdzie). `score --no-overrides` liczy na samym
wzorcu.

Uruchomienie (mlx-vlm dociągane osobno, poza projektem):

    uv run scripts/vlm-bakeoff.py crops --out $OUT --scale 2
    uv run --with mlx-vlm scripts/vlm-bakeoff.py run --out $OUT --scale 2 \\
        --model mlx:/Volumes/Dane/llm/models/lmstudio-community/Qwen3.8-27B-MLX-4bit
    uv run scripts/vlm-bakeoff.py run --out $OUT --scale 2 --model anthropic:claude-opus-5-5 \\
        --effort low --limit 20
    uv run scripts/vlm-bakeoff.py sheet --out $OUT --page 2-60 --model anthropic:claude-opus-5-5 \\
        --ref-run anthropic_claude-opus-5-5_low__v3__s2
    uv run scripts/vlm-bakeoff.py score --out $OUT

Strony strojenia: 2-58, 2-59. Held-out: 2-60, 2-61, 2-63 (raportowane osobno).
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import re
import subprocess
import sys
import time
from collections import Counter, defaultdict
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass, field
from pathlib import Path

import yaml
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))
_old_dwb, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # bez scripts/__pycache__
# Wspólne z krokiem ② (scripts/auto.py): geometria i render wycinków, prompty, parsowanie,
# normalizacja, adapter MLX — scripts/_vlm.py.
from _vlm import (  # noqa: E402,F401
    FIELDS, GATE_MB, GATE_MT, GATE_MX, GATE_PIN_ABOVE, JSON_ONLY, LETTERING_HINTS, MARK_PAD, MINUS_RE,
    PORT_DOWN, PORT_IN, PORT_OUT, PORT_UP, PROMPTS, SCHEMAS, SLASH_GLYPHS, SYMBOL_BY_TYPE, XREF_BACK,
    XREF_DOWN, XREF_FWD, XREF_LEFT_BACK, XREF_LEFT_FWD, XREF_UP, Adapter, MlxAdapter, OcrAdapter,
    gate_crop_box, model_label, norm_conn, norm_label, norm_pages, norm_pins, norm_text, norm_type,
    ocr_to_obj, parse_json_text, path_hash, png_bytes, port_crop_box, render_box, to_pred,
    xref_crop_box,
)
sys.dont_write_bytecode = _old_dwb

ROOT = Path(__file__).resolve().parent.parent
GOLD = ROOT / "data" / "gold"
IC_MAP = ROOT / "data" / "MJC-400" / "ic_map.yaml"


def _main_checkout() -> Path:
    """Główny checkout (skany i .env nie są w worktree): katalog nad wspólnym .git."""
    try:
        out = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "--path-format=absolute", "--git-common-dir"],
            capture_output=True, text=True, check=True,
        ).stdout.strip()
        return Path(out).parent
    except (OSError, subprocess.CalledProcessError):
        return ROOT


MAIN_CHECKOUT = Path(os.environ.get("KRONIKARZ_MAIN_CHECKOUT") or _main_checkout())
SCANS = MAIN_CHECKOUT / "data" / "MJC-400" / "P-R3-2" / "scans"
ENV_FILE = MAIN_CHECKOUT / ".env"
CACHE = Path("/Volumes/Dane/llm/kronikarz-cache/vlm-bakeoff")
PACKAGE = "P-R3-2"
TUNE_PAGES = ["2-58", "2-59"]
HELDOUT_PAGES = ["2-60", "2-61", "2-63"]
ALL_PAGES = TUNE_PAGES + HELDOUT_PAGES

# Jawne poprawki prawdy względem wzorca (co NADRUKOWANO na skanie). Klucz = id wycinka.
# Wszystkie pozycje potwierdzone przez opiekuna na pełnych arkuszach (2026-11-26), poza listą
# narysowanych wyjść M8 (2-63), o którą nie pytano wprost.
TRUTH_OVERRIDES: dict[str, dict] = {
    # porty, przy których etykieta nie jest wypisana (wzorzec ma nazwę netu)
    "2-58_P_C41": {"label": "", "why": "wspólny drut z A50; '-BLR' wypisane tylko przy A50"},
    "2-58_P_C48": {"label": "", "why": "wspólny drut z B48; '-RA' wypisane tylko przy B48"},
    "2-58_P_C46": {"label": "", "why": "wspólny drut z B49; '-RB' wypisane tylko przy B49"},
    "2-58_P_C43": {"label": "", "why": "wspólny drut z B47; '-W/R' wypisane tylko przy B47"},
    "2-58_P_C47": {"label": "", "why": "wspólny drut z A49; '-RC' wypisane tylko przy A49"},
    "2-63_P_D40": {"label": "", "why": "wspólny drut z A86; '-DNB0' wypisane tylko przy A86"},
    "2-63_P_D43": {"label": "", "why": "wspólny drut z B84; '-DNB3' wypisane tylko przy B84"},
    # piny bramki: wzorzec ma piny nienarysowane (disconnected)
    "2-63_G_M30A": {"pins": {"left": [5, 12, 13, 9, 1], "right": [2, 3, 7, 6, 10, 11, 15, 14], "top": []},
                    "why": "pin 4 (A1) nienarysowany (we wzorcu disconnected)"},
    "2-63_G_M8A": {"pins": {"left": [4, 5, 12, 13, 9, 1], "right": [2, 7, 10, 15], "top": []},
                   "why": "wyjścia 3/6/11/14 nienarysowane (niepotwierdzone, piny M8 nieruszone w danych)"},
}

# ---------------------------------------------------------------------------
# prawda i wycinki
# ---------------------------------------------------------------------------

@dataclass
class Item:
    id: str
    page: str
    kind: str  # gate | port | xref
    bbox: tuple[int, int, int, int]  # x0,y0,x1,y1 w px skanu (przed paddingiem)
    mark_y: int | None  # wiersz celu (port/xref), px skanu
    truth: dict
    overrides: dict = field(default_factory=dict)


def load_yaml(p: Path):
    return yaml.safe_load(p.read_text(encoding="utf-8"))


def safe_id(s: str) -> str:
    return re.sub(r"[^A-Za-z0-9+\-]", "_", s)


def gate_bbox(g: dict) -> tuple[int, int, int, int]:
    x, y, w, h = float(g["x"]), float(g["y"]), float(g.get("w") or 56), float(g.get("h") or 80)
    pys = [float(p["py"]) for p in g.get("pins", []) if p.get("side") in ("left", "right") and "py" in p]
    return gate_crop_box((x - w / 2, y - h / 2, x + w / 2, y + h / 2), pys)


def gate_truth(g: dict, components: dict) -> dict:
    comp = components.get(g["ref"], {})
    typ = norm_type(comp.get("ic"))
    pins = g.get("pins", [])

    def side(s, key):
        return [int(p["num"]) for p in sorted((p for p in pins if p.get("side") == s), key=lambda p: float(p[key]))]

    return {
        "symbol": SYMBOL_BY_TYPE.get(typ),
        "type": typ,
        "ref": norm_text(g["ref"]),
        "pins": {"left": side("left", "py"), "right": side("right", "py"), "top": side("top", "px")},
    }


def port_bbox(p: dict) -> tuple[int, int, int, int]:
    return port_crop_box(p["x"], p["y"], p.get("side"))


def xref_bbox(c: dict) -> tuple[int, int, int, int]:
    return xref_crop_box(c["x"], c["y"], c.get("side"))


def build_items(gold_dir: Path = GOLD, pages=ALL_PAGES, overrides: bool = True) -> list[Item]:
    pkg = load_yaml(gold_dir / PACKAGE / "package.yaml")
    components = pkg.get("components") or {}
    items: list[Item] = []
    for page in pages:
        d = load_yaml(gold_dir / PACKAGE / f"{page}.sch.yaml")
        for g in d.get("gates") or []:
            iid = f"{page}_G_{g['ref']}{g.get('gate') or ''}"
            items.append(Item(iid, page, "gate", gate_bbox(g), None, gate_truth(g, components)))
        for p in d.get("ports") or []:
            iid = f"{page}_P_{p.get('connector')}{p.get('pin')}"
            truth = {"conn": norm_conn((p.get("connector"), p.get("pin"))), "label": norm_label(p.get("label"))}
            items.append(Item(iid, page, "port", port_bbox(p), round(float(p["y"])), truth))
        for i, c in enumerate(d.get("cross_refs") or []):
            iid = f"{page}_X_{i:02d}_{safe_id(str(c.get('label')))}"
            truth = {"label": norm_label(c.get("label")), "pages": norm_pages(c.get("pages"))}
            items.append(Item(iid, page, "xref", xref_bbox(c), round(float(c["y"])), truth))
    seen = Counter(it.id for it in items)
    dup = [k for k, v in seen.items() if v > 1]
    if dup:
        raise ValueError(f"duplikaty id wycinków: {dup}")
    for it in items:
        ov = TRUTH_OVERRIDES.get(it.id) if overrides else None
        if ov:
            it.overrides = {k: v for k, v in ov.items() if k != "why"}
            for k, v in it.overrides.items():
                it.truth[k] = v if isinstance(v, dict) else (norm_label(v) if k == "label" else norm_text(v))
            if it.kind == "gate" and "type" in it.overrides:
                it.truth["symbol"] = SYMBOL_BY_TYPE.get(it.truth["type"])
    return items


def package_sheet_count(gold_dir: Path = GOLD) -> int:
    """Liczba arkuszy pakietu z package.yaml (największy `sheet`, inaczej liczba stron)."""
    pages = (load_yaml(gold_dir / PACKAGE / "package.yaml").get("package") or {}).get("pages") or []
    sheets = [int(p["sheet"]) for p in pages if p.get("sheet") is not None]
    return max(sheets) if sheets else len(pages)


def render_crop(scan: Image.Image, it: Item, scale: int) -> Image.Image:
    """Wycina bbox (z białym dopełnieniem poza skanem), skaluje, dorysowuje znaczniki wiersza."""
    return render_box(scan, it.bbox, it.mark_y, scale)


# ---------------------------------------------------------------------------
# adaptery
# ---------------------------------------------------------------------------

def load_env_keys() -> dict:
    from dotenv import dotenv_values

    return dotenv_values(ENV_FILE)


class AnthropicAdapter(Adapter):
    online = True
    PRICES = {"claude-opus-5-5": (4.0, 20.0), "claude-fable-5-2": (8.0, 40.0)}

    def __init__(self, model: str, effort: str = "low", max_tokens: int = 8000):
        import anthropic

        key = load_env_keys().get("ANTHROPIC_API_KEY")
        if not key:
            raise SystemExit("brak ANTHROPIC_API_KEY w .env")
        self.client = anthropic.Anthropic(api_key=key, max_retries=4)
        self.model, self.effort, self.max_tokens = model, effort, max_tokens
        self.name = f"anthropic:{model}@{effort}"

    def params(self):
        return {"effort": self.effort, "max_tokens": self.max_tokens}

    def call(self, content: list, schema: dict) -> dict:
        t0 = time.perf_counter()
        r = self.client.messages.create(
            model=self.model, max_tokens=self.max_tokens,
            messages=[{"role": "user", "content": content}],
            output_config={"effort": self.effort, "format": {"type": "json_schema", "schema": schema}},
        )
        dt = time.perf_counter() - t0
        err = None if r.stop_reason in ("end_turn", "stop_sequence") else f"stop_reason={r.stop_reason}"
        text = "".join(b.text for b in r.content if b.type == "text") if err is None else ""
        return {"text": text, "in_tok": r.usage.input_tokens, "out_tok": r.usage.output_tokens, "latency": dt,
                "peak_gb": None, "error": err}

    def ask(self, png, kind, prompt):
        content = [
            {"type": "image", "source": {"type": "base64", "media_type": "image/png",
                                         "data": base64.b64encode(png).decode()}},
            {"type": "text", "text": prompt},
        ]
        return self.call(content, SCHEMAS[kind])

    def cost(self, in_tok, out_tok) -> float:
        pi, po = self.PRICES.get(self.model, (0, 0))
        return (in_tok * pi + out_tok * po) / 1e6


class OpenAIAdapter(Adapter):
    online = True
    # developers.openai.com/api/docs/pricing (standard, ≤272K), sprawdzone 2026-11-26
    PRICES = {"gpt-5.6-sol": (4.0, 20.0), "gpt-5.6-terra": (2.0, 12.0), "gpt-5.5": (5.0, 30.0)}

    def __init__(self, model: str, effort: str = "low", max_tokens: int = 8000):
        import openai

        key = load_env_keys().get("OPENAI_API_KEY")
        if not key:
            raise SystemExit("brak OPENAI_API_KEY w .env")
        self.client = openai.OpenAI(api_key=key, max_retries=4)
        self.model, self.effort, self.max_tokens = model, effort, max_tokens
        self.name = f"openai:{model}@{effort}"

    def params(self):
        return {"effort": self.effort, "max_tokens": self.max_tokens}

    def call(self, content: list, schema: dict) -> dict:
        t0 = time.perf_counter()
        r = self.client.responses.create(
            model=self.model, max_output_tokens=self.max_tokens, reasoning={"effort": self.effort},
            input=[{"role": "user", "content": content}],
            text={"format": {"type": "json_schema", "name": "answer", "schema": schema, "strict": True}},
        )
        dt = time.perf_counter() - t0
        err = None if r.status == "completed" else f"status={r.status}"
        return {"text": r.output_text if err is None else "", "in_tok": r.usage.input_tokens,
                "out_tok": r.usage.output_tokens, "latency": dt, "peak_gb": None, "error": err}

    def ask(self, png, kind, prompt):
        content = [
            {"type": "input_text", "text": prompt},
            {"type": "input_image", "image_url": "data:image/png;base64," + base64.b64encode(png).decode(),
             "detail": "high"},
        ]
        return self.call(content, SCHEMAS[kind])

    def cost(self, in_tok, out_tok) -> float:
        pi, po = self.PRICES.get(self.model, (0, 0))
        return (in_tok * pi + out_tok * po) / 1e6


def make_adapter(spec: str, effort: str) -> Adapter:
    kind, _, rest = spec.partition(":")
    if kind == "mlx":
        return MlxAdapter(rest)
    if kind == "ocr":
        return OcrAdapter(rest)
    if kind == "anthropic":
        return AnthropicAdapter(rest, effort)
    if kind == "openai":
        return OpenAIAdapter(rest, effort)
    raise SystemExit(f"nieznany adapter: {spec}")


def run_tag(model_name: str, prompt: str, scale: int) -> str:
    return safe_id(f"{model_name}__{prompt}__s{scale}")


def cache_key(model_name: str, params: dict, png: bytes, prompt_text: str) -> str:
    h = hashlib.sha256()
    h.update(model_name.encode())
    h.update(json.dumps(params, sort_keys=True).encode())
    h.update(hashlib.sha256(png).digest())
    h.update(hashlib.sha256(prompt_text.encode()).digest())
    return h.hexdigest()


def cache_keys(adapter: Adapter, params: dict, payload: bytes, prompt_text: str, suffix: str = "") -> list[str]:
    """Klucz bieżący + klucze dawne (do odczytu wpisów sprzed zmiany `cache_id`)."""
    ids = [adapter.cache_id] + [i for i in adapter.legacy_cache_ids() if i != adapter.cache_id]
    return [cache_key(i + suffix, params, payload, prompt_text) for i in ids]


def cache_get(cache_dir: Path, keys: list[str]) -> dict | None:
    """Pierwszy istniejący wpis; wpis spod dawnego klucza kopiowany pod klucz bieżący."""
    for k in keys:
        p = cache_dir / f"{k}.json"
        if p.exists():
            raw = json.loads(p.read_text())
            if k != keys[0]:
                (cache_dir / f"{keys[0]}.json").write_text(p.read_text())
            return raw
    return None


def raw_to_obj(adapter_name: str, kind: str, raw: dict) -> dict | None:
    """Surowa odpowiedź → obiekt pól. OCR: zawsze parser regułowy na `text` (nie zapisany `obj`)."""
    if adapter_name.startswith("ocr:"):
        return ocr_to_obj(kind, raw.get("text", ""))
    return parse_json_text(raw.get("text", ""))


# ---------------------------------------------------------------------------
# komendy
# ---------------------------------------------------------------------------

def crops_dir(out: Path, scale: int) -> Path:
    return out / "crops" / f"s{scale}"


def cmd_crops(a):
    items = build_items()
    for scale in a.scale:
        cdir = crops_dir(a.out, scale)
        scans = {}
        for it in items:
            if it.page not in scans:
                scans[it.page] = Image.open(SCANS / f"{it.page}.jpg").convert("L")
            p = cdir / it.page / f"{it.id}.png"
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_bytes(png_bytes(render_crop(scans[it.page], it, scale)))
        print(f"s{scale}: {len(items)} wycinków → {cdir}")
    man = [{"id": it.id, "page": it.page, "kind": it.kind, "bbox": it.bbox, "mark_y": it.mark_y, "truth": it.truth,
            "overrides": it.overrides} for it in items]
    (a.out / "items.json").write_text(json.dumps(man, ensure_ascii=False, indent=1))
    by = Counter((it.page, it.kind) for it in items)
    for page in ALL_PAGES:
        print(page, {k: by[(page, k)] for k in ("gate", "port", "xref")})


def select_items(items: list[Item], a) -> list[Item]:
    sel = [it for it in items if it.page in a.pages and (not a.kinds or it.kind in a.kinds)]
    if a.ids:
        want = set(a.ids.split(","))
        sel = [it for it in sel if it.id in want]
    if a.limit:
        # próbka zrównoważona: co n-ty wycinek, żeby objąć strony i rodzaje
        step = max(1, len(sel) // a.limit)
        sel = sel[::step][: a.limit]
    return sel


def cmd_run(a):
    items = select_items(build_items(), a)
    adapter = make_adapter(a.model, a.effort)
    tag = run_tag(adapter.name, a.prompt, a.scale)
    out_path = a.out / "runs" / f"{tag}.jsonl"
    out_path.parent.mkdir(parents=True, exist_ok=True)
    a.cache.mkdir(parents=True, exist_ok=True)
    done = {}
    if out_path.exists():
        for line in out_path.read_text().splitlines():
            r = json.loads(line)
            done[r["id"]] = r

    def work(it: Item):
        png = (crops_dir(a.out, a.scale) / it.page / f"{it.id}.png").read_bytes()
        prompt = PROMPTS[a.prompt][it.kind]
        keys = cache_keys(adapter, adapter.params(), png, prompt)
        raw = cache_get(a.cache, keys)
        if raw is not None and raw.get("error") and a.retry_errors:
            raw = None  # stary wpis z błędem (sprzed zmiany: lokalne wyjątki trafiały do cache)
        cached = raw is not None
        if raw is None and a.cache_only:
            raw = {"text": "", "error": "cache miss (--cache-only)", "latency": None, "in_tok": 0, "out_tok": 0}
        elif raw is None:
            try:
                raw = adapter.ask(png, it.kind, prompt)
            except Exception as e:  # noqa: BLE001 — błąd zapisujemy jako wynik, ale nie do cache
                raw = {"text": "", "error": f"{type(e).__name__}: {e}", "latency": None, "in_tok": 0, "out_tok": 0}
            if not raw.get("error"):
                (a.cache / f"{keys[0]}.json").write_text(json.dumps(raw, ensure_ascii=False))
        obj = raw_to_obj(adapter.name, it.kind, raw)
        rec = {"id": it.id, "page": it.page, "kind": it.kind, "model": adapter.name, "prompt": a.prompt,
               "scale": a.scale, "cached": cached, "raw": raw.get("text"), "obj": obj, "pred": to_pred(it.kind, obj),
               "latency": raw.get("latency"), "in_tok": raw.get("in_tok"), "out_tok": raw.get("out_tok"),
               "peak_gb": raw.get("peak_gb"), "error": raw.get("error")}
        return rec

    todo = [it for it in items if it.id not in done or a.rescore or (a.retry_errors and done[it.id].get("error"))]
    print(f"{adapter.name} prompt={a.prompt} s{a.scale}: {len(items)} wycinków, do zrobienia {len(todo)}", flush=True)
    workers = a.workers if adapter.online else 1
    t0 = time.perf_counter()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        for n, rec in enumerate(ex.map(work, todo), 1):
            done[rec["id"]] = rec
            if n % 10 == 0 or n == len(todo):
                print(f"  {n}/{len(todo)}  {time.perf_counter() - t0:.0f}s", flush=True)
    wall = time.perf_counter() - t0
    with out_path.open("w") as f:
        for it in items:
            if it.id in done:
                f.write(json.dumps(done[it.id], ensure_ascii=False) + "\n")
    recs = [done[it.id] for it in items if it.id in done]
    fresh = [r for r in recs if not r["cached"] and r["id"] in {t.id for t in todo}]
    in_tok = sum(r.get("in_tok") or 0 for r in recs)
    out_tok = sum(r.get("out_tok") or 0 for r in recs)
    msg = f"zapisano {out_path} ({len(recs)}); nowe wywołania {len(fresh)}, wall {wall:.1f}s; tokeny in {in_tok} out {out_tok}"
    if hasattr(adapter, "cost"):
        c = adapter.cost(in_tok, out_tok)
        msg += f"; koszt ${c:.3f} (${c / max(1, len(recs)):.4f}/wycinek)"
    errs = [r for r in recs if r.get("error")]
    if errs:
        msg += f"; błędy {len(errs)}: {errs[0]['error'][:200]}"
    print(msg)


# --- cały arkusz (linia bazowa) ---

SHEET_SCHEMA = {
    "type": "object",
    "properties": {
        "gates": {"type": "array", "items": {
            "type": "object",
            "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}, **SCHEMAS["gate"]["properties"]},
            "required": ["x", "y"] + SCHEMAS["gate"]["required"], "additionalProperties": False}},
        "ports": {"type": "array", "items": {
            "type": "object",
            "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}, **SCHEMAS["port"]["properties"]},
            "required": ["x", "y"] + SCHEMAS["port"]["required"], "additionalProperties": False}},
        "cross_refs": {"type": "array", "items": {
            "type": "object",
            "properties": {"x": {"type": "integer"}, "y": {"type": "integer"}, **SCHEMAS["xref"]["properties"]},
            "required": ["x", "y"] + SCHEMAS["xref"]["required"], "additionalProperties": False}},
    },
    "required": ["gates", "ports", "cross_refs"],
    "additionalProperties": False,
}

SHEET_PROMPT = (
    "This is a full scanned sheet ({w}x{h} px) of a hand-lettered 1970s Polish logic schematic (TTL 74xx). "
    "Transcribe all text of these elements and give each one's approximate pixel position (x, y) in this image:\n"
    "1. gates: every logic gate / IC block rectangle. Each one is a separate entry, also when several are stacked. "
    "Inside: function symbol in the top-left corner (\"&\", \"1\" or \"R\"), IC type number (e.g. 04, 10, H11, 170), "
    "and the underlined reference (M + number) at the bottom. Pin numbers are written outside the box above the "
    "wires: pins_left and pins_right top to bottom, pins_top left to right. x,y = box centre. Ignore signal names "
    "inside large blocks.\n"
    "2. ports: chevron-shaped edge connectors (< or >) with connector letter+number inside (e.g. A50, B03) and "
    "the signal name written on the wire next to it (\"\" if that connector has none). x,y = chevron centre.\n"
    "3. cross_refs: wires ending in a signal name (starts with + or -) plus a comma-separated list of sheet "
    "numbers (e.g. 2,3,4,5). x,y = wire end next to the sheet numbers.\n"
    "Ignore the title block. A slashed zero (Ø) is the digit 0. Keep Polish letters."
)


def cmd_sheet(a):
    adapter = make_adapter(a.model, a.effort)
    scan_path = SCANS / f"{a.page}.jpg"
    data = scan_path.read_bytes()
    with Image.open(scan_path) as im:
        w, h = im.size
    prompt = SHEET_PROMPT.format(w=w, h=h)
    keys = cache_keys(adapter, adapter.params(), data, prompt, suffix="|sheet")
    a.cache.mkdir(parents=True, exist_ok=True)
    raw = cache_get(a.cache, keys)
    if raw is None and a.cache_only:
        raise SystemExit(f"brak w cache: {adapter.name} cały arkusz {a.page} (--cache-only)")
    if raw is None:
        if isinstance(adapter, AnthropicAdapter):
            content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                                    "data": base64.b64encode(data).decode()}},
                       {"type": "text", "text": prompt}]
            raw = adapter.call(content, SHEET_SCHEMA)
        elif isinstance(adapter, OpenAIAdapter):
            content = [{"type": "input_text", "text": prompt},
                       {"type": "input_image", "image_url": "data:image/jpeg;base64," + base64.b64encode(data).decode(),
                        "detail": "high"}]
            raw = adapter.call(content, SHEET_SCHEMA)
        else:
            raise SystemExit("cały arkusz tylko dla modeli online")
        if not raw.get("error"):
            (a.cache / f"{keys[0]}.json").write_text(json.dumps(raw, ensure_ascii=False))
    obj = parse_json_text(raw.get("text", "")) or {}
    ref_preds = None
    if a.ref_run:
        ref_path = a.out / "runs" / f"{a.ref_run}.jsonl"
        ref_preds = {r["id"]: r["pred"] for r in map(json.loads, ref_path.read_text().splitlines()) if r.get("pred")}
    recs = match_sheet(a.page, obj, adapter.name, ref_preds)
    path = a.out / "runs" / f"{run_tag(adapter.name, 'sheet', 0)}__{a.page}.jsonl"
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w") as f:
        for i, r in enumerate(recs):
            # czas rozłożony równo na elementy; tokeny całego calla przy pierwszym rekordzie strony
            r.update({"latency": raw.get("latency") / len(recs) if raw.get("latency") else None,
                      "in_tok": (raw.get("in_tok") or 0) if i == 0 else 0,
                      "out_tok": (raw.get("out_tok") or 0) if i == 0 else 0})
            f.write(json.dumps(r, ensure_ascii=False) + "\n")
    cost = adapter.cost(raw.get("in_tok") or 0, raw.get("out_tok") or 0) if hasattr(adapter, "cost") else 0
    print(f"{adapter.name} cały arkusz {a.page}: gates {len(obj.get('gates', []))} ports {len(obj.get('ports', []))} "
          f"xrefs {len(obj.get('cross_refs', []))}; {raw.get('latency', 0):.1f}s; in {raw.get('in_tok')} "
          f"out {raw.get('out_tok')}; ${cost:.3f}; err {raw.get('error')} → {path}")


SHEET_MATCH_MAX = 6.0


def match_sheet(page: str, obj: dict, model: str, ref_preds: dict | None = None) -> list[dict]:
    """Dopasowanie odpowiedzi całoarkuszowej do wycinków wzorca, zachłannie po koszcie:
    odległość od położenia elementu wzorca / 100 px + liczba pól niezgodnych z ODCZYTEM
    WYCINKOWYM `ref_preds` (id → pred z runu wycinkowego). Prawda nie jest używana; pola
    nieoceniane (symbol bramki 51) nie liczą się. Bez `ref_preds` — samo położenie (zgrubne:
    stosy bramek i porty co 25–55 px). Koszt > SHEET_MATCH_MAX = niedopasowany (pusta predykcja)."""
    items = [it for it in build_items(pages=[page])]
    lists = {"gate": obj.get("gates") or [], "port": obj.get("ports") or [], "xref": obj.get("cross_refs") or []}
    recs = []
    for kind in ("gate", "port", "xref"):
        golds = [it for it in items if it.kind == kind]
        preds = [(i, p, to_pred(kind, p)) for i, p in enumerate(lists[kind])]
        pairs = []
        for gi, it in enumerate(golds):
            x0, y0, x1, y1 = it.bbox
            cx, cy = (x0 + x1) / 2, (it.mark_y if it.mark_y is not None else (y0 + y1) / 2)
            for pi, p, pr in preds:
                try:
                    dist = ((float(p.get("x", 0)) - cx) ** 2 + (float(p.get("y", 0)) - cy) ** 2) ** 0.5
                except (TypeError, ValueError):
                    dist = 1e4
                ref = (ref_preds or {}).get(it.id) or {}
                mism = sum(1 for f in FIELDS[kind]
                           if it.truth.get(f) is not None and ref.get(f) is not None and pr.get(f) != ref.get(f))
                pairs.append((dist / 100 + mism, gi, pi))
        pairs.sort()
        used_g, used_p, best = set(), set(), {}
        for c, gi, pi in pairs:
            if gi in used_g or pi in used_p or c > SHEET_MATCH_MAX:
                continue
            used_g.add(gi)
            used_p.add(pi)
            best[gi] = pi
        for gi, it in enumerate(golds):
            pi = best.get(gi)
            obj_i = lists[kind][pi] if pi is not None else None
            recs.append({"id": it.id, "page": page, "kind": kind, "model": model + "|sheet", "prompt": "sheet",
                         "scale": 0, "obj": obj_i, "pred": to_pred(kind, obj_i), "error": None if obj_i else "unmatched"})
    return recs


# --- ocena ---

def load_ic_vocab() -> dict[str, set[int]]:
    ic = load_yaml(IC_MAP)
    vocab = {}
    for k, v in ic.items():
        pins = set()
        for gp in (v.get("gate_pins") or {}).values():
            for lst in gp.values():
                pins.update(int(x) for x in (lst if isinstance(lst, list) else [lst]))
        vocab[str(k)] = pins
    return vocab


def resolve_type(typ: str, vocab: dict) -> str | None:
    """Typ odczytany → klucz ic_map (prefiks H jak w resolveIcKey: H11 → 11) albo None."""
    if typ in vocab:
        return typ
    if typ.startswith("H") and typ[1:] in vocab:
        return typ[1:]
    return None


def field_ok(kind: str, f: str, pred: dict, truth: dict) -> bool | None:
    t = truth.get(f)
    if t is None:  # pole nieoceniane (np. symbol nieznanego typu)
        return None
    return pred.get(f) == t


def oov_flags(kind: str, pred: dict, vocab: dict, n_sheets: int) -> dict[str, bool]:
    """Flaga (b): odczyt spoza słownika, per pole. True = podejrzany."""
    fl = {}
    if kind == "gate":
        typ = resolve_type(pred.get("type") or "", vocab)
        fl["type"] = typ is None
        fl["ref"] = not re.fullmatch(r"M\d+", pred.get("ref") or "")
        fl["symbol"] = (pred.get("symbol") or "") not in ("&", "1", "R")
        pins = pred.get("pins") or {}
        allp = [p for s in ("left", "right", "top") for p in pins.get(s, [])]
        ok_pins = vocab.get(typ)
        fl["pins"] = (not allp) or (ok_pins is not None and any(p not in ok_pins for p in allp)) or len(allp) != len(set(allp))
    elif kind == "port":
        m = re.fullmatch(r"([A-D])(\d+)", pred.get("conn") or "")
        fl["conn"] = not (m and 1 <= int(m.group(2)) <= 96)
        lab = pred.get("label") or ""
        fl["label"] = bool(lab) and lab[0] not in "+-"
    else:
        lab = pred.get("label") or ""
        fl["label"] = not lab or lab[0] not in "+-"
        pg = pred.get("pages") or []
        fl["pages"] = not pg or any(not (1 <= p <= n_sheets) for p in pg)
    return fl


CONFUSION_FAMILIES = {
    "0/O": {("0", "O")},
    "H/M": {("H", "M")},
    "+/-": {("+", "-")},
    "R/Q,A,D": {("R", "Q"), ("R", "A"), ("R", "D")},
    "L/Ł": {("L", "Ł")},
    "B/8": {("B", "8")},
    "5/S": {("5", "S")},
    "11/H": {("1", "H")},
}


def char_confusions(t: str, p: str) -> list[tuple[str, str]]:
    """Pary (prawda→odczyt) znak po znaku dla ciągów równej długości; inaczej cały ciąg."""
    if len(t) == len(p):
        return [(a, b) for a, b in zip(t, p) if a != b]
    return [(t, p)]


def load_runs(out: Path) -> dict[str, list[dict]]:
    runs = {}
    for p in sorted((out / "runs").glob("*.jsonl")):
        recs = [json.loads(l) for l in p.read_text().splitlines() if l.strip()]
        runs[p.stem] = recs
    return runs


def score_run(recs: list[dict], items: dict[str, Item]) -> dict:
    """Zwraca liczniki per (grupa stron, rodzaj, pole) → [ok, n]."""
    acc = defaultdict(lambda: [0, 0])
    for r in recs:
        it = items.get(r["id"])
        if not it:
            continue
        grp = "tune" if it.page in TUNE_PAGES else "held"
        for f in FIELDS[it.kind]:
            ok = field_ok(it.kind, f, r["pred"], it.truth)
            if ok is None:
                continue
            for g in (grp, "all"):
                acc[(g, it.kind, f)][0] += int(ok)
                acc[(g, it.kind, f)][1] += 1
    return acc


def pct(ok_n) -> str:
    ok, n = ok_n
    return f"{100 * ok / n:.1f}% ({ok}/{n})" if n else "-"


def known_records(tag: str, recs: list[dict], items: dict[str, Item]) -> list[dict]:
    """Rekordy, których id jest wśród wycinków wzorca; reszta pomijana z ostrzeżeniem."""
    unknown = sorted({r.get("id") for r in recs if items.get(r.get("id")) is None})
    if unknown:
        print(f"UWAGA: {tag}: {len(unknown)} rekordów spoza wzorca pominięto (np. {unknown[0]})", file=sys.stderr)
    return [r for r in recs if items.get(r.get("id")) is not None]


def page_group(page: str) -> str:
    return "tune" if page in TUNE_PAGES else "held"


def run_cost(r: dict) -> float:
    """Koszt rekordu z tokenów i cennika modelu (0 dla lokalnych i całoarkuszowych bez tokenów)."""
    model = r.get("model") or ""
    mname = model.split(":", 1)[-1].split("@")[0].split("|")[0]
    prices = AnthropicAdapter.PRICES if model.startswith("anthropic:") else (
        OpenAIAdapter.PRICES if model.startswith("openai:") else {})
    pi, po = prices.get(mname, (0, 0))
    return ((r.get("in_tok") or 0) * pi + (r.get("out_tok") or 0) * po) / 1e6


def group_timing(recs: list[dict], grp: str) -> dict:
    """Czas (suma latencji wycinków, sekwencyjnie) i koszt na arkusz dla grupy stron:
    średnia i maksimum po stronach. Bez ładowania modelu, renderu wycinków i detekcji."""
    sel = [r for r in recs if grp == "all" or page_group(r["page"]) == grp]
    per_page, cost_page = defaultdict(float), defaultdict(float)
    for r in sel:
        per_page[r["page"]] += r.get("latency") or 0
        cost_page[r["page"]] += run_cost(r)
    n = len(per_page) or 1
    lat = [r["latency"] for r in sel if r.get("latency")]
    return {"n": len(sel), "s_crop": sum(lat) / len(lat) if lat else None,
            "s_sheet": sum(per_page.values()) / n if lat else None,
            "s_sheet_max": max(per_page.values()) if lat else None,
            "usd_sheet": sum(cost_page.values()) / n}


def cmd_score(a):
    all_items = build_items(overrides=not a.no_overrides)
    items = {it.id: it for it in all_items}
    man = [{"id": it.id, "page": it.page, "kind": it.kind, "bbox": it.bbox, "mark_y": it.mark_y, "truth": it.truth,
            "overrides": it.overrides} for it in all_items]
    a.out.mkdir(parents=True, exist_ok=True)
    (a.out / "items.json").write_text(json.dumps(man, ensure_ascii=False, indent=1))
    vocab = load_ic_vocab()
    n_sheets = package_sheet_count()
    runs = {k: known_records(k, v, items) for k, v in load_runs(a.out).items()}
    if a.runs:
        runs = {k: v for k, v in runs.items() if any(s in k for s in a.runs.split(","))}
    lines = []
    cols = [(k, f) for k in ("gate", "port", "xref") for f in FIELDS[k]]
    lines.append("| run | n | " + " | ".join(f"{k}.{f}" for k, f in cols)
                 + " | s/wycinek | s/arkusz (śr.) | s/arkusz (max) | peak GB | $/arkusz |")
    lines.append("|" + "---|" * (len(cols) + 7))
    summary = {}
    for tag, recs in runs.items():
        acc = score_run(recs, items)
        peak = max((r.get("peak_gb") or 0 for r in recs), default=0)
        online = any((r.get("model") or "").startswith(("anthropic:", "openai:")) for r in recs)
        for grp in ("tune", "held", "all"):
            if not any(acc[(grp, k, f)][1] for k, f in cols):
                continue
            t = group_timing(recs, grp)
            row = [f"{tag} [{grp}]", str(t["n"])]
            row += [pct(acc[(grp, k, f)]) for k, f in cols]
            row += [f"{t['s_crop']:.2f}" if t["s_crop"] else "-",
                    f"{t['s_sheet']:.0f}" if t["s_sheet"] else "-",
                    f"{t['s_sheet_max']:.0f}" if t["s_sheet_max"] else "-",
                    f"{peak:.1f}" if peak else "-", f"{t['usd_sheet']:.3f}" if online else "-"]
            lines.append("| " + " | ".join(row) + " |")
        summary[tag] = {f"{g}|{k}|{f}": acc[(g, k, f)] for g in ("tune", "held", "all") for k, f in cols}
    # pomyłki
    lines.append("")
    lines.append("## Pomyłki (prawda → odczyt), top 12 per run")
    errs_by_run = {}
    for tag, recs in runs.items():
        conf = Counter()
        examples = []
        for r in recs:
            it = items.get(r["id"])
            if not it:
                continue
            for f in FIELDS[it.kind]:
                ok = field_ok(it.kind, f, r["pred"], it.truth)
                if ok is False:
                    t, p = it.truth.get(f), r["pred"].get(f)
                    if isinstance(t, str) and isinstance(p, str):
                        for c in char_confusions(t, p):
                            conf[(f, *c)] += 1
                    else:
                        conf[(f, json.dumps(t), json.dumps(p))] += 1
                    examples.append((r["id"], f, t, p))
        errs_by_run[tag] = examples
        top = ", ".join(f"{f}: {t!r}→{p!r} ×{n}" for (f, t, p), n in conf.most_common(12))
        lines.append(f"- **{tag}** ({len(examples)} błędnych pól): {top}")
        fam = Counter()
        for (f, t, p), n in conf.items():
            for name, pair in CONFUSION_FAMILIES.items():
                if (t, p) in pair or (p, t) in pair:
                    fam[name] += n
        if fam:
            lines.append("  - rodziny: " + ", ".join(f"{k} ×{v}" for k, v in fam.most_common()))
    # flagi
    lines.append("")
    lines.append("## Flagi → błąd (precision / recall)")
    pairs = [x.split("|") for x in (a.pairs or "").split(",") if "|" in x]
    for tag, recs in runs.items():
        tp = fp = fn = tn = 0
        for r in recs:
            it = items.get(r["id"])
            if not it:
                continue
            fl = oov_flags(it.kind, r["pred"], vocab, n_sheets)
            for f in FIELDS[it.kind]:
                ok = field_ok(it.kind, f, r["pred"], it.truth)
                if ok is None:
                    continue
                flag = fl.get(f, False)
                tp += flag and not ok
                fp += flag and ok
                fn += (not flag) and not ok
                tn += (not flag) and ok
        P = tp / (tp + fp) if tp + fp else float("nan")
        R = tp / (tp + fn) if tp + fn else float("nan")
        lines.append(f"- (b) słownik, {tag}: flagged {tp + fp}, P={P:.2f} R={R:.2f} (tp {tp}, fp {fp}, fn {fn})")
    for a_tag, b_tag in pairs:
        if a_tag not in runs or b_tag not in runs:
            lines.append(f"- (a) brak runów {a_tag} / {b_tag}")
            continue
        bmap = {r["id"]: r for r in runs[b_tag]}
        tp = fp = fn = 0
        tpu = fpu = fnu = 0
        for r in runs[a_tag]:
            it = items.get(r["id"])
            o = bmap.get(r["id"])
            if not it or not o:
                continue
            fl = oov_flags(it.kind, r["pred"], vocab, n_sheets)
            for f in FIELDS[it.kind]:
                ok = field_ok(it.kind, f, r["pred"], it.truth)
                if ok is None:
                    continue
                dis = r["pred"].get(f) != o["pred"].get(f)
                tp += dis and not ok
                fp += dis and ok
                fn += (not dis) and not ok
                u = dis or fl.get(f, False)
                tpu += u and not ok
                fpu += u and ok
                fnu += (not u) and not ok
        P = tp / (tp + fp) if tp + fp else float("nan")
        R = tp / (tp + fn) if tp + fn else float("nan")
        Pu = tpu / (tpu + fpu) if tpu + fpu else float("nan")
        Ru = tpu / (tpu + fnu) if tpu + fnu else float("nan")
        lines.append(f"- (a) niezgodność {a_tag} vs {b_tag}: flagged {tp + fp}, P={P:.2f} R={R:.2f}; "
                     f"(a)∪(b): flagged {tpu + fpu}, P={Pu:.2f} R={Ru:.2f}")
    txt = "\n".join(lines)
    print(txt)
    (a.out / "score.md").write_text(txt)
    (a.out / "score.json").write_text(json.dumps({"summary": summary, "errors": errs_by_run}, ensure_ascii=False,
                                                 indent=1, default=str))


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = ap.add_subparsers(dest="cmd", required=True)

    def common(p):
        p.add_argument("--out", type=Path, required=True)
        p.add_argument("--cache", type=Path, default=CACHE)

    p = sub.add_parser("crops")
    common(p)
    p.add_argument("--scale", type=int, nargs="+", default=[1, 2])
    p.set_defaults(fn=cmd_crops)

    p = sub.add_parser("run")
    common(p)
    p.add_argument("--model", required=True, help="mlx:<ścieżka> | ocr:<ścieżka> | anthropic:<id> | openai:<id>")
    p.add_argument("--effort", default="low")
    p.add_argument("--prompt", default="v1", choices=sorted(PROMPTS))
    p.add_argument("--scale", type=int, default=2)
    p.add_argument("--pages", nargs="+", default=ALL_PAGES)
    p.add_argument("--kinds", nargs="*", default=[])
    p.add_argument("--ids", default="")
    p.add_argument("--limit", type=int, default=0)
    p.add_argument("--workers", type=int, default=6)
    p.add_argument("--retry-errors", action="store_true", help="ponów wycinki z błędem (także błędy w cache)")
    p.add_argument("--cache-only", action="store_true", help="bez wywołań modelu; brak w cache = błąd w rekordzie")
    p.add_argument("--rescore", action="store_true", help="przelicz wszystkie rekordy runu (z cache), nie tylko brakujące")
    p.set_defaults(fn=cmd_run)

    p = sub.add_parser("sheet")
    common(p)
    p.add_argument("--model", required=True)
    p.add_argument("--effort", default="low")
    p.add_argument("--page", default="2-60")
    p.add_argument("--ref-run", default="", help="run wycinkowy (nazwa pliku w runs/ bez .jsonl) do dopasowania")
    p.add_argument("--cache-only", action="store_true")
    p.set_defaults(fn=cmd_sheet)

    p = sub.add_parser("score")
    common(p)
    p.add_argument("--runs", default="", help="podciągi nazw runów, po przecinku")
    p.add_argument("--pairs", default="", help="pary runów do flagi (a): 'A|B,C|D'")
    p.add_argument("--no-overrides", action="store_true", help="prawda = sam wzorzec, bez TRUTH_OVERRIDES")
    p.set_defaults(fn=cmd_score)

    a = ap.parse_args(argv)
    a.fn(a)


if __name__ == "__main__":
    main()
