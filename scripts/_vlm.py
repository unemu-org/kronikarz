"""Wspólny kod VLM na wycinkach schematu: bake-off (kr-9p8.4, scripts/vlm-bakeoff.py) i krok ②
`text` pipeline'u (kr-9p8.27, scripts/auto.py).

Tu jest to, co musi być identyczne w obu miejscach, żeby wynik bake-offu dotyczył kroku ②:
geometria wycinka bramki (`GATE_*`, `gate_crop_box`), render wycinka (`render_box`: białe
dopełnienie poza skanem, LANCZOS ×skala, znaczniki wiersza dla portów / cross-refów), prompty
(`PROMPTS`, v1/v2/v3), parsowanie i normalizacja odpowiedzi (`parse_json_text`, `to_pred`,
`norm_*`) oraz lokalny adapter MLX (`MlxAdapter`, `mlx-vlm`, temperatura 0, myślenie wyłączone).
Adaptery płatne (Anthropic, OpenAI) zostają w vlm-bakeoff.py — krok ② ich nie używa.

Modele tylko z /Volumes/Dane/llm (`LLM_ROOT`): `llm_env()` ustawia (jeśli nie są ustawione)
HF_HOME / HUGGINGFACE_HUB_CACHE na ten dysk i tryb offline HF, zanim `mlx_vlm` zostanie
zaimportowany — lokalna ścieżka modelu nie może niczego pobierać do ~/.cache.

Bez I/O przy imporcie; Pillow potrzebny dopiero w `render_box` / `png_bytes`, `mlx-vlm` dopiero
w `MlxAdapter.load`.
"""
from __future__ import annotations

import hashlib
import io
import json
import os
import re
import signal
import threading
import time
from contextlib import contextmanager
from pathlib import Path

LLM_ROOT = Path("/Volumes/Dane/llm")
# Zwycięzca bake-offu (kr-9p8.4): Qwen3.8-27B 4-bit, prompt v3, skala 2.
DEFAULT_MLX_MODEL = LLM_ROOT / "models" / "lmstudio-community" / "Qwen3.8-27B-MLX-4bit"


def llm_env(environ=os.environ) -> None:
    """Cache HF na /Volumes/Dane/llm i bez pobierania (model to lokalny katalog)."""
    environ.setdefault("HF_HOME", str(LLM_ROOT / "hf"))
    environ.setdefault("HUGGINGFACE_HUB_CACHE", str(LLM_ROOT / "hf" / "hub"))
    environ.setdefault("HF_HUB_OFFLINE", "1")
    environ.setdefault("TRANSFORMERS_OFFLINE", "1")
    environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")

# --- geometria wycinków (px skanu) ---
GATE_MX = 36
GATE_MT = 10
GATE_MB = 4
GATE_PIN_ABOVE = 22
PORT_UP, PORT_DOWN, PORT_OUT, PORT_IN = 30, 26, 48, 215
XREF_UP, XREF_DOWN, XREF_BACK, XREF_FWD = 30, 14, 175, 125
XREF_LEFT_BACK, XREF_LEFT_FWD = 75, 200  # cross-ref przy lewej krawędzi: arkusze z lewej
MARK_PAD = 14

# Typ układu -> symbol funkcji nadrukowany w lewym górnym rogu (sprawdzone na skanach).
# 51 (AND-OR-INVERT) ma dwa symbole ('1' w rogu, '&' w kolumnie wejść) — symbol nieoceniany.
SYMBOL_BY_TYPE = {
    "00": "&", "03": "&", "08": "&", "10": "&", "11": "&", "H11": "&", "20": "&",
    "02": "1", "04": "1",
    "170": "R", "174": "R", "175": "R",
}

MINUS_RE = re.compile("[−–—‐‑]")
# Znak „∤” w środku etykiet (W∤R, BAR∤NB, W∤RBA): wzorzec zapisuje go raz jako '/', raz '#',
# raz '+'; modele piszą też '∤', '↑', '|'. Na pozycji ≥ 1 wszystkie → '/'.
SLASH_GLYPHS = "#+/∤↑ǂ‡†|"


# ---------------------------------------------------------------------------
# normalizacja
# ---------------------------------------------------------------------------

def norm_text(s) -> str:
    """Normalizacja etykiet/refów/typów: bez spacji, jeden minus, Ø→0. O≠0."""
    if s is None:
        return ""
    s = str(s)
    s = MINUS_RE.sub("-", s)
    s = s.replace("Ø", "0").replace("ø", "0")
    return re.sub(r"\s+", "", s)


def norm_type(t) -> str:
    """Typ układu: int z YAML (8) → '08'; ciąg bez spacji. 'R170' → '170' nie jest robione."""
    if t is None:
        return ""
    if isinstance(t, int):
        return f"{t:02d}"
    return norm_text(t)


def norm_label(s) -> str:
    """Etykieta sygnału: norm_text + znak ∤ w środku (poz. ≥ 1) zapisany jako '/'."""
    t = norm_text(s)
    if len(t) < 2:
        return t
    return t[0] + "".join("/" if c in SLASH_GLYPHS else c for c in t[1:])


def norm_conn(s) -> str:
    """Złącze portu: 'B03' / 'B 3' / ('B', 3) → 'B3'. Nieparsowalne → znormalizowany tekst."""
    if isinstance(s, (tuple, list)) and len(s) == 2:
        return f"{s[0]}{int(s[1])}"
    t = norm_text(s).upper() if s is not None else ""
    m = re.fullmatch(r"([A-Z])0*(\d+)", t)
    if m:
        return f"{m.group(1)}{int(m.group(2))}"
    return t


def norm_pages(v) -> list[int]:
    """Lista arkuszy → posortowana lista int (akceptuje '2,3,4,5', ['2','3'], [2,3])."""
    if v is None:
        return []
    if isinstance(v, (str, int, float)) and not isinstance(v, bool):  # model bywa zwraca skalar: "sheets": 9
        items = re.findall(r"\d+", norm_text(v))
    elif not isinstance(v, (list, tuple)):
        return []
    else:
        items = []
        for x in v:
            items += re.findall(r"\d+", norm_text(x))
    return sorted(int(x) for x in items)


def norm_pins(v) -> list[int]:
    if isinstance(v, (str, int, float)) and not isinstance(v, bool):  # skalar zamiast listy
        v = [v]
    elif not isinstance(v, (list, tuple)):
        return []
    out = []
    for x in v:
        m = re.search(r"\d+", norm_text(x))
        if m:
            out.append(int(m.group()))
    return out




def gate_crop_box(rect, pin_ys=()) -> tuple[int, int, int, int]:
    """Kadr bramki (px skanu): ramka (x0, y0, x1, y1) + `GATE_MX` w poziomie, `GATE_MT` u góry,
    `GATE_MB` u dołu; pionowo co najmniej każdy pin boczny `py - GATE_PIN_ABOVE … py + GATE_MB`
    (numer pinu stoi nad drutem)."""
    x0, y0, x1, y1 = (float(v) for v in rect)
    top = min([y0 - GATE_MT] + [float(py) - GATE_PIN_ABOVE for py in pin_ys])
    bottom = max([y1 + GATE_MB] + [float(py) + GATE_MB for py in pin_ys])
    return (round(x0 - GATE_MX), round(top), round(x1 + GATE_MX), round(bottom))


def port_crop_box(x, y, side) -> tuple[int, int, int, int]:
    """Kadr portu (bake-off kr-9p8.4, krok ④): `x`, `y` = grot szewronu (port.x/y); wiersz
    `y - PORT_UP … y + PORT_DOWN`, `PORT_OUT` na zewnątrz arkusza i `PORT_IN` w głąb."""
    x, y = float(x), float(y)
    if side == "right":
        return (round(x - PORT_IN), round(y - PORT_UP), round(x + PORT_OUT), round(y + PORT_DOWN))
    return (round(x - PORT_OUT), round(y - PORT_UP), round(x + PORT_IN), round(y + PORT_DOWN))


def xref_crop_box(x, y, side) -> tuple[int, int, int, int]:
    """Kadr cross-refa (bake-off kr-9p8.4, krok ④): `x`, `y` = koniec drutu (cross_ref.x/y);
    wiersz `y - XREF_UP … y + XREF_DOWN`; przy prawym końcu `XREF_BACK` w lewo (etykieta)
    i `XREF_FWD` w prawo (arkusze), przy lewym (`side: left`) `XREF_LEFT_BACK` / `XREF_LEFT_FWD`."""
    x, y = float(x), float(y)
    if side == "left":
        return (round(x - XREF_LEFT_BACK), round(y - XREF_UP), round(x + XREF_LEFT_FWD), round(y + XREF_DOWN))
    return (round(x - XREF_BACK), round(y - XREF_UP), round(x + XREF_FWD), round(y + XREF_DOWN))


def render_box(scan, bbox, mark_y, scale: int, keep_rows=None):
    """Wycina bbox (z białym dopełnieniem poza skanem), skaluje, dorysowuje znaczniki wiersza.
    `keep_rows` = (ya, yb) w px skanu: wiersze poza nimi zamalowane na biało (sąsiednie wiersze
    odsyłaczy, krok ④)."""
    from PIL import Image, ImageDraw

    x0, y0, x1, y1 = bbox
    canvas = Image.new("L", (x1 - x0, y1 - y0), 255)
    sx0, sy0 = max(0, x0), max(0, y0)
    sx1, sy1 = min(scan.width, x1), min(scan.height, y1)
    if sx1 > sx0 and sy1 > sy0:
        canvas.paste(scan.crop((sx0, sy0, sx1, sy1)), (sx0 - x0, sy0 - y0))
    if keep_rows is not None:
        ya, yb = (int(round(v)) - y0 for v in keep_rows)
        dr0 = ImageDraw.Draw(canvas)
        if ya > 0:
            dr0.rectangle((0, 0, canvas.width, ya - 1), fill=255)
        if yb < canvas.height - 1:
            dr0.rectangle((0, yb + 1, canvas.width, canvas.height), fill=255)
    if scale != 1:
        canvas = canvas.resize((canvas.width * scale, canvas.height * scale), Image.LANCZOS)
    if mark_y is None:
        return canvas
    pad = MARK_PAD * scale
    out = Image.new("RGB", (canvas.width + 2 * pad, canvas.height), (255, 255, 255))
    out.paste(canvas.convert("RGB"), (pad, 0))
    my = (mark_y - y0) * scale
    dr = ImageDraw.Draw(out)
    hh = 5 * scale
    dr.polygon([(1, my - hh), (pad - 2, my), (1, my + hh)], fill=(220, 0, 0))
    w = out.width
    dr.polygon([(w - 2, my - hh), (w - pad + 1, my), (w - 2, my + hh)], fill=(220, 0, 0))
    return out


def png_bytes(im) -> bytes:
    buf = io.BytesIO()
    im.save(buf, format="PNG", optimize=True)
    return buf.getvalue()


# ---------------------------------------------------------------------------
# prompty i schematy
# ---------------------------------------------------------------------------

PROMPTS = {
    "v1": {
        "gate": (
            "This is a crop from a hand-lettered 1970s Polish logic schematic (TTL 74xx). "
            "It shows ONE gate or IC block: a rectangle drawn with thick lines. Inside the rectangle, "
            "top to bottom: a function symbol in the top-left corner (\"&\", \"1\" or \"R\"), the IC "
            "type number (e.g. 00, 03, 04, 10, H11, 20, 51, 170, 175), and at the bottom the "
            "underlined reference designator (the letter M followed by a number). Outside the "
            "rectangle, small pin numbers are written just above the wires: on the left side "
            "(inputs), on the right side (outputs, often after a small circle) and sometimes on top. "
            "Large blocks also contain signal names inside (A1, B1, ER, WA, C, R ...) - ignore those. "
            "Zero is drawn with a slash (Ø) - write it as the digit 0. Ignore partial text cut by the "
            "crop edge that belongs to neighbouring elements.\n"
            "Return JSON: symbol, type, ref, pins_left (top to bottom), pins_right (top to bottom), "
            "pins_top (left to right). Use \"\" or [] when absent."
        ),
        "port": (
            "This is a crop from the edge of a hand-lettered 1970s Polish logic schematic. Red "
            "triangles on the left and right image borders mark the target row. On that row there is "
            "an edge-connector symbol shaped like a chevron (< or >) with a connector letter and pin "
            "number inside (e.g. A50, B94, C03). A signal name may be written above the wire next to "
            "that chevron (it starts with + or -, e.g. -BLR, +LPC, -W/R, -STROB1). Some connectors "
            "have no signal name of their own - then return an empty label. Read only the marked row. "
            "Zero is drawn with a slash (Ø) - write it as the digit 0. Keep Polish letters (e.g. Ł).\n"
            "Return JSON: connector (letter+number as printed), label."
        ),
        "xref": (
            "This is a crop from a hand-lettered 1970s Polish logic schematic. Red triangles on the "
            "left and right image borders mark the target wire. That wire ends in an off-sheet "
            "reference: a signal name written just above the wire (starts with + or -, e.g. +RPA, "
            "-CZYTRW, +W10) and, at the wire end, a list of sheet numbers separated by commas "
            "(e.g. 2,3,4,5 or 7). Read only the marked wire. Zero is drawn with a slash (Ø) - write it "
            "as the digit 0. Keep Polish letters (e.g. Ł).\n"
            "Return JSON: label, sheets (list of integers)."
        ),
    },
}
# v2: ten sam cel, inne sformułowanie, bez przykładowych wartości (drugi „głos” do flag (a)).
PROMPTS["v2"] = {
    "gate": (
        "Read the text of the logic gate shown in this schematic crop. Report: the small symbol in "
        "the top-left corner of the box, the number printed below it (the 74xx type, may contain a "
        "letter), the underlined name at the bottom of the box, and the pin numbers printed outside "
        "the box next to each wire, per side (left and right listed top to bottom, top listed left "
        "to right). A slashed zero is 0. Return JSON: symbol, type, ref, pins_left, pins_right, pins_top."
    ),
    "port": (
        "In this schematic crop, the red triangles mark one row. Read the text inside the chevron "
        "(connector) on that row and the signal name written on the wire next to it, if any "
        "(else empty). A slashed zero is 0. Return JSON: connector, label."
    ),
    "xref": (
        "In this schematic crop, the red triangles mark one wire. Read the signal name written "
        "above it and the comma-separated sheet numbers at its end. A slashed zero is 0. "
        "Return JSON: label, sheets (list of integers)."
    ),
}

# v3 = v1 + wskazówki o piśmie, wyprowadzone WYŁĄCZNIE z błędów na stronach strojenia
# (2-58/2-59: R czytane jako Q/D/A, 5 jako S, glif ∤ jako 0, pominięty numer arkusza
# przy lewej krawędzi, L czytane jako Ł, pola bramki pomieszane).
LETTERING_HINTS = (
    "\nLettering hints: in this hand lettering the letter R has a curly top and often looks like Q, D or A - "
    "signal names here use R and never contain Q. Digits inside names may look like letters (5 like S). "
    "A vertical stroke crossed by a short slash between letters (as in W/R) is the separator /."
)
PROMPTS["v3"] = {k: v + (LETTERING_HINTS if k in ("port", "xref") else "") for k, v in PROMPTS["v1"].items()}
# 2-58 (Qwen3.6): typ wpisany jako symbol, ref jako typ — przypomnienie formatu pól.
PROMPTS["v3"]["gate"] = PROMPTS["v1"]["gate"] + (
    "\nField format: symbol is one character (&, 1 or R); type is the number below it (digits, optionally "
    "prefixed with H) and never starts with M; ref always starts with M."
)
# 2-59: przy lewej krawędzi numer arkusza stoi PRZED etykietą („1 +RPA”), modele go pomijały.
PROMPTS["v3"]["xref"] = PROMPTS["v3"]["xref"].replace(
    "and, at the wire end, a list of sheet numbers separated by commas (e.g. 2,3,4,5 or 7).",
    "and a list of sheet numbers separated by commas (e.g. 2,3,4,5 or 7) written at the free end of the wire: "
    "to the right of the wire end, or - for wires coming from the left sheet edge - to the left, before the "
    "signal name. Every reference has at least one sheet number.",
)
assert "free end of the wire" in PROMPTS["v3"]["xref"]
PROMPTS["v3"]["port"] = PROMPTS["v3"]["port"].replace("Keep Polish letters (e.g. Ł).", "Keep Polish letters (Ł) only "
                                                      "where the L has a clear crossbar.")
PROMPTS["v3"]["xref"] = PROMPTS["v3"]["xref"].replace("Keep Polish letters (e.g. Ł).", "Keep Polish letters (Ł) only "
                                                      "where the L has a clear crossbar.")

JSON_ONLY = "\nAnswer with a single JSON object and nothing else."

SCHEMAS = {
    "gate": {
        "type": "object",
        "properties": {
            "symbol": {"type": "string"},
            "type": {"type": "string"},
            "ref": {"type": "string"},
            "pins_left": {"type": "array", "items": {"type": "integer"}},
            "pins_right": {"type": "array", "items": {"type": "integer"}},
            "pins_top": {"type": "array", "items": {"type": "integer"}},
        },
        "required": ["symbol", "type", "ref", "pins_left", "pins_right", "pins_top"],
        "additionalProperties": False,
    },
    "port": {
        "type": "object",
        "properties": {"connector": {"type": "string"}, "label": {"type": "string"}},
        "required": ["connector", "label"],
        "additionalProperties": False,
    },
    "xref": {
        "type": "object",
        "properties": {"label": {"type": "string"}, "sheets": {"type": "array", "items": {"type": "integer"}}},
        "required": ["label", "sheets"],
        "additionalProperties": False,
    },
}

FIELDS = {"gate": ["symbol", "type", "ref", "pins"], "port": ["conn", "label"], "xref": ["label", "pages"]}


def parse_json_text(text: str) -> dict | None:
    """Wyłuskuje pierwszy obiekt JSON z odpowiedzi (także w ```json ...```)."""
    if not text:
        return None
    t = re.sub(r"<think>.*?</think>", "", text, flags=re.S).strip()
    m = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", t, flags=re.S)
    if m:
        t = m.group(1)
    start = t.find("{")
    if start < 0:
        return None
    depth = 0
    for i in range(start, len(t)):
        if t[i] == "{":
            depth += 1
        elif t[i] == "}":
            depth -= 1
            if depth == 0:
                try:
                    return json.loads(t[start : i + 1])
                except json.JSONDecodeError:
                    return None
    return None


def to_pred(kind: str, obj: dict | None) -> dict:
    """Surowa odpowiedź modelu → znormalizowane pola jak w truth."""
    if not isinstance(obj, dict):
        return {f: None for f in FIELDS[kind]}
    if kind == "gate":
        return {
            "symbol": norm_text(obj.get("symbol")),
            "type": norm_type(obj.get("type")),
            "ref": norm_text(obj.get("ref")),
            "pins": {"left": norm_pins(obj.get("pins_left")), "right": norm_pins(obj.get("pins_right")),
                     "top": norm_pins(obj.get("pins_top"))},
        }
    if kind == "port":
        return {"conn": norm_conn(obj.get("connector")), "label": norm_label(obj.get("label"))}
    return {"label": norm_label(obj.get("label")), "pages": norm_pages(obj.get("sheets"))}


# --- parser wolnego tekstu (modele OCR bez JSON) ---

def ocr_to_obj(kind: str, text: str) -> dict:
    toks = re.findall(r"[+\-−–]?[A-Za-zĄĆĘŁŃÓŚŹŻØ0-9/#&]+", text or "")
    if kind == "port":
        conn = next((t for t in toks if re.fullmatch(r"[A-D][0-9Ø]{1,2}", t)), "")
        label = next((t for t in toks if t[:1] in "+-−–" and len(t) > 1), "")
        return {"connector": conn, "label": label}
    if kind == "xref":
        label = next((t for t in toks if t[:1] in "+-−–" and len(t) > 1), "")
        rest = (text or "").split(label, 1)[-1] if label else (text or "")
        return {"label": label, "sheets": [int(x) for x in re.findall(r"\d+", rest)]}
    ref = next((t for t in toks if re.fullmatch(r"M[0-9Ø]+", t)), "")
    sym = next((t for t in toks if t in ("&", "1", "R")), "")
    typ = next((t for t in toks if re.fullmatch(r"H?[0-9Ø]{2,3}", t) and t != ref), "")
    return {"symbol": sym, "type": typ, "ref": ref, "pins_left": [], "pins_right": [], "pins_top": []}



class VlmTimeout(Exception):
    """Odpowiedź modelu nie zmieściła się w limicie czasu (na jeden wycinek)."""


@contextmanager
def deadline(seconds: float | None):
    """Limit czasu jednego wywołania modelu w procesie (SIGALRM; generacja mlx-vlm to pętla
    w Pythonie po tokenach, więc sygnał przerywa ją między tokenami). Poza głównym wątkiem
    albo bez `setitimer` — bez limitu (`max_tokens` i tak ogranicza długość odpowiedzi)."""
    if not seconds or seconds <= 0 or threading.current_thread() is not threading.main_thread() \
            or not hasattr(signal, "setitimer"):
        yield
        return

    def on_alarm(_sig, _frame):
        raise VlmTimeout(f"brak odpowiedzi modelu w {seconds:g} s")

    old = signal.signal(signal.SIGALRM, on_alarm)
    signal.setitimer(signal.ITIMER_REAL, float(seconds))
    try:
        yield
    finally:
        signal.setitimer(signal.ITIMER_REAL, 0)
        signal.signal(signal.SIGALRM, old)


class Adapter:
    name = "?"
    online = False

    @property
    def cache_id(self) -> str:
        """Tożsamość modelu w kluczu cache (dla MLX: z hashem pełnej ścieżki)."""
        return self.name

    def legacy_cache_ids(self) -> list[str]:
        """Dawne tożsamości (sprzed zmiany klucza) — odczyt starych wpisów cache."""
        return []

    def params(self) -> dict:
        return {}

    def ask(self, png: bytes, kind: str, prompt: str, timeout_s: float | None = None) -> dict:
        """→ {text, in_tok, out_tok, latency, peak_gb, error}"""
        raise NotImplementedError


def model_label(path: str) -> str:
    """Nazwa modelu z katalogu; dla cache HF (models--org--name/snapshots/<hash>) → name."""
    m = re.search(r"models--[^/]+--([^/]+)/snapshots/", path)
    return m.group(1) if m else Path(path).name


def path_hash(path: str) -> str:
    return hashlib.sha256(str(Path(path).expanduser().resolve()).encode()).hexdigest()[:12]


class MlxAdapter(Adapter):
    """Lokalny VLM przez `mlx-vlm` (0.8.1): temperatura 0, myślenie wyłączone, JSON w odpowiedzi.
    Model ładowany raz, przy pierwszym wywołaniu (`load`). `tmp` — plik PNG wycinka podawany
    do `generate` (mlx-vlm bierze ścieżkę)."""

    prefix = "mlx"

    def __init__(self, path: str, max_tokens: int = 300, tmp: Path | None = None):
        self.path = str(path)
        self.name = f"{self.prefix}:" + model_label(self.path)
        self.max_tokens = max_tokens
        self.model = self.processor = self.config = None  # ładowane przy pierwszym wywołaniu
        self.tmp = Path(tmp) if tmp else Path(os.environ.get("TMPDIR", "/tmp")) / "vlm-bakeoff-mlx.png"
        self.load_s: float | None = None

    @property
    def cache_id(self) -> str:
        return f"{self.name}#{path_hash(self.path)}"

    def legacy_cache_ids(self) -> list[str]:
        # do kr-9p8.4 v1: sama nazwa katalogu; najpierw Path.name (snapshot HF), potem model_label
        ids = [f"{self.prefix}:" + Path(self.path).name, f"{self.prefix}:" + model_label(self.path)]
        return list(dict.fromkeys(ids))

    def load(self):
        if self.model is None:
            llm_env()
            t0 = time.perf_counter()
            from mlx_vlm import load
            from mlx_vlm.utils import load_config

            self.model, self.processor = load(self.path)
            self.config = load_config(self.path)
            self.load_s = time.perf_counter() - t0

    def params(self):
        return {"max_tokens": self.max_tokens, "temperature": 0.0, "thinking": False}

    def _generate(self, png, text, timeout_s, **tmpl):
        self.load()  # najpierw llm_env() — przed pierwszym importem mlx_vlm
        import mlx.core as mx
        from mlx_vlm import apply_chat_template, generate

        self.tmp.write_bytes(png)
        formatted = apply_chat_template(self.processor, self.config, text, num_images=1, **tmpl)
        t0 = time.perf_counter()
        with deadline(timeout_s):
            res = generate(self.model, self.processor, formatted, image=[str(self.tmp)],
                           max_tokens=self.max_tokens, temperature=0.0, verbose=False)
        dt = time.perf_counter() - t0
        return {"text": res.text, "in_tok": res.prompt_tokens, "out_tok": res.generation_tokens, "latency": dt,
                "peak_gb": max(float(res.peak_memory or 0), mx.get_peak_memory() / 1e9), "error": None}

    def ask(self, png, kind, prompt, timeout_s=None):
        return self._generate(png, prompt + JSON_ONLY, timeout_s, enable_thinking=False)


class OcrAdapter(MlxAdapter):
    """PaddleOCR-VL i podobne: stały prompt 'OCR:', wynik parsowany regułami (zawsze na nowo
    z surowego tekstu, także z cache — patrz `raw_to_obj`)."""

    prefix = "ocr"

    def __init__(self, path: str):
        super().__init__(path, max_tokens=200)

    def ask(self, png, kind, prompt, timeout_s=None):
        return self._generate(png, "OCR:", timeout_s)
