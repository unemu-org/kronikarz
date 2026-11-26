#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["opencv-python-headless", "numpy", "pyyaml"]
# ///
"""SPIKE (kr-9p8.2): klasyczne CV wyciąga druty, kropki połączeń i wolne końce ze skanu.

Bez modelu uczonego — tylko OpenCV/numpy. Pytanie spike'a: czy sama morfologia wystarcza,
żeby z czystego rysunku (linie wyłącznie poziome/pionowe, jedna grubość kreski, pełna kropka =
połączenie, skrzyżowanie bez kropki = brak połączenia) zbudować nety. Wynik oceniamy
`scripts/eval-digitize.py` względem `data/gold` (wyniki: docs/auto-digitalizacja.md,
„Wyniki: druty CV (kr-9p8.2)”).

Usage:
  uv run scripts/cv-wires.py --scan <skan.jpg> [--gates <strona.sch.yaml>]
                             --out <kandydat.sch.yaml> [--overlay <png>]
                             [--gold <wzorzec.sch.yaml> --diff <png>]
                             [--page 2-58 --package P-R3-2] [--fit]

Tryby:
  (a) `--gates` podane: prostokąty bramek z tego YAML są maskowane (izoluje problem drutów).
      Do kandydata trafiają bramki z białej listy pól (ref, gate, x, y, w, h, rotation,
      pins{num, side, px, py, net}, verified: false); `pin.net` = net drutu, którego wolny
      koniec leży przy pinie (<= PIN_TOL px), inaczej "" (singleton).
  (b) bez `--gates`: bramki wykrywane same przez scripts/cv-gates.py (kr-9p8.3): domknięte
      ramki o czystych narożnikach z drutami przy bokach; maskowane są całe bloki (stos
      bramek, złożony układ, element bierny); `gates: []`.

Rozmiary względem grubości kreski. Grubość `sw` jest mierzona na stronie (średni bieg
poprzeczny pikseli długich linii, Otsu, bez biegów > mediana + 1 — ramki bramek). Parametry z wartością None w PARAMS są liczone ze `sw` (wzory w
`derive`); liczba w PARAMS albo w nadpisaniu wyłącza wzór. Rozmiary związane z tekstem
i rozdzielczością (200 dpi: wysokość znaku ~16 px) są bezwzględne — nie zależą od
grubości pióra. Przerwy ze skanowania (GAP2, BRIDGE_*) też są bezwzględne: to cecha
skanu, nie rysunku, a ich skalowanie w górę przy grubej kresce zwiększałoby mostkowanie
na sąsiednie druty.

Potok:
  1. Binaryzacja (Otsu; dla linii próg podniesiony do THR — blade, cienkie linie); pomiar
     `sw`; maska bramek (prostokąt dociągnięty do narysowanej ramki, BOX_SEARCH, + PAD)
     i tabliczki rysunkowej (prawy dolny róg, TITLE).
  2. Kropki: małe (<= DOT_HOLE) szare (<= DOT_HOLE_GRAY) dziury zamalowane — kropka bywa
     blada w środku; białe wnętrza kółek negacji i oczek liter zostają puste. Otwarcie
     dyskiem DOT_D (kreska znika, kropka zostaje), promień koła wpisanego >= DOT_DT
     (kandydat, który przechodzi dopiero po zamalowaniu: >= DOT_DT + DOT_FILL_EXTRA),
     bbox <= DOT_MAX_SIDE. Środek = środek obszaru maksimum transformaty odległości.
  3. Tekst: samodzielne składowe w rozmiarze znaku znikają (GLYPH_MIN..TEXT_MAX, poza
     cienkimi prostymi kreskami). Znaki dotykające drutów: przebieg zachowawczy (GAP1,
     MIN_LEN1) wyznacza pewne linie, reszta po ich odjęciu w rozmiarze znaku jest kasowana.
     W pasie PIN_BAND przy krawędzi bramki z pinami kasowane są tylko krótkie (< BAND_RUN)
     kreski równoległe do krawędzi (numery pinów); długi drut biegnący w pasie zostaje.
  4. Linie: poszerzenie w poprzek (WOBBLE), domknięcie wzdłuż (GAP2) liczone BEZ pikseli
     kropek (kropka dokładana po domknięciu, przed otwarciem), więc drut kończący się na
     kropce nie przedłuża się przez nią na równoległy drut obok. Otwarcie długim cienkim
     jądrem (MIN_LEN), osobno H i V. Składowa grubsza niż MAX_THICK = równoległe linie
     sklejone tekstem -> rozdzielane po profilu. Odcinek ściśle H/V (mediana) — wzorzec jest
     ortogonalny, choć skan ma skos do ~1 %; `--fit` = prosta dopasowana do skosu.
     Współliniowe kawałki scalane, równoległe zachodzące na siebie kawałki bliżej niż
     PAR_OFF też (kropka potrafi dać drugi, równoległy pasek); przerwy do BRIDGE_MAX px
     mostkowane, jeśli w przerwie jest blady tusz (BRIDGE_INK). Koniec odcinka leżący
     w kropce przycinany do jej środka (DOT_TRIM_TOL) — SNAP liczony od środka kropki.
  5. Spójność H×V: oba końce przy sobie (<= SNAP) = narożnik = połączone; skrzyżowanie
     wnętrz = połączone tylko z kropką (<= DOT_R); T = połączone tylko z kropką, jeśli
     T_NEEDS_DOT (domyślnie; konwencja rysunku — każde prawdziwe złącze wzorca leżące na
     rysunku ma kropkę), inaczej zawsze. Odcinki dzielone w węzłach o wspólnych, całkowitych
     współrzędnych — reguła viewera „>= 3 końce w punkcie” daje kropkę na T i na
     skrzyżowaniu z kropką. Krótkie odgałęzienia (< SPUR_LEN) z wolnym końcem, który nie
     wchodzi prostopadle w bramkę = kreski tekstu, usuwane iteracyjnie (graf budowany od
     nowa po ostatnim usunięciu).
  6. Nety = składowe spójne (union-find). Wolne końce dociągane do krawędzi bramki
     (<= EXT_GATE px — kółko negacji odsuwa drut od krawędzi). Odrzucane: nety bez wolnego
     końca (zamknięte ramki) i samotne krótkie odcinki (< MIN_ISOLATED px).
  7. Overlay: skan w jasnej szarości, odcinki w kolorze netu, kropki czerwone, wolne końce
     niebieskie. `--diff` + `--gold`: druty tylko we wzorcu = magenta (pominięte), tylko
     u kandydata = pomarańczowy (nadmiarowe), wspólne = zielony (tolerancja 3 px).

Parametry strojone WYŁĄCZNIE na 2-58 i 2-59 (2-60, 2-61 = held-out). v1 (ślepy wynik
held-out) i późniejsze wersje opisane w docs/auto-digitalizacja.md.
"""
from __future__ import annotations

import argparse
import colorsys
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import yaml

PARAMS = dict(
    # --- binaryzacja, maski
    THR=190,             # próg tuszu dla linii (max z Otsu); kropki i ramki z samego Otsu
    TITLE=(0.66, 0.76),  # tabliczka: x >= 0.66 W i y >= 0.76 H maskowane (None = bez)
    # --- grubość kreski
    SW=None,             # grubość kreski [px]; None = mierzona na stronie
    SW_REF=2.2,          # grubość stron strojenia (zmierzone: 2-58 2,09, 2-59 2,35)
    SW_PROBE_LEN=61,     # pomiar: tylko linie co najmniej tak długie
    SW_MAX_RUN=15,       # pomiar: biegi dłuższe to nie przekrój kreski
    # --- pochodne grubości (None = wzór w derive(), liczba = nadpisanie)
    DOT_D=None,          # najbliższa nieparzysta od 7 + 2 (sw - SW_REF), >= 5
    DOT_DT=None,         # sw + DOT_DT_ADD — min. promień koła wpisanego kropki
    DOT_DT_ADD=1.6,      # (skrzyżowanie 2-59: 3,6 px przy sw 2,58; kropki po zamalowaniu
                         #  dziur >= 5,4 px; skrzyżowanie ~0,7 sw + 0,7)
    DOT_MAX_SIDE=None,   # round(2 DOT_D + 2 sw + 1)
    DOT_HOLE=None,       # ceil(sw^2) — maks. pole dziury zamalowywanej w kropce
    DOT_FILL_EXTRA=1.5,  # kropka z zamalowaną dziurą: promień >= DOT_DT + DOT_FILL_EXTRA
                         #  (P-X3-2 (1480,243) 5,39 vs próg 5,26; szum na 2-97 <= 4,2)
    DOT_HOLE_GRAY=200,   # ... i średnia szarość dziury <= (zmierzone: środki bladych kropek
                         #     162–196, oczka/kółka to papier ~230–255)
    DOT_ASPECT=1.8,      # kandydat na kropkę: maks. proporcja bboxu
    DOT_CENTER_FRAC=0.8, # środek kropki = średnia pikseli z DT >= frac * max
    DOT_MASK_MARGIN=1.5, # piksele kropki wyłączone z domknięcia: promień r + margin
    DOT_TRIM_TOL=1,      # koniec odcinka <= r + tol od środka kropki = koniec w kropce
    DOT_R=None,          # = DOT_D (kropka przy punkcie skrzyżowania)
    SNAP=None,           # round(2.5 sw) — koniec przy drugim odcinku = T/narożnik
    END_SNAP=None,       # DOT_D + 2 — węzeł tak blisko końca = koniec przyłączony
    BOX_T=None,          # round(sw + 1.6) — ramka bramki grubsza od drutu
    PAD=None,            # = BOX_T — margines maski bramki
    MAX_THICK=None,      # round(2 sw + 4) — grubsza składowa = sklejone równoległe linie
    THIN_W=None,         # round(sw + 1.6) — cienka kreska (kawałek drutu, nie znak)
    PAR_OFF=None,        # round(2 sw + 1) — równoległe zachodzące kawałki = ten sam drut
    # --- tekst / rozdzielczość (200 dpi) — bezwzględne
    TEXT_MAX=26,         # składowa (lub reszta po odjęciu linii) z bbox <= TEXT_MAX = znak
    GLYPH_MIN=9,         # ... i o boku >= GLYPH_MIN (mniejsze okruchy = linia przerywana)
    GLYPH_DIL=5,         # odjęcie pewnych linii: poszerzenie (px)
    THIN_LEN=15,         # cienka kreska co najmniej tak długa = kawałek drutu
    GAP1=3,              # przebieg zachowawczy (wykrywanie znaków przy drutach): domknięcie
    MIN_LEN1=28,         # ... i długość (cyfra 16 px + drut 3 px nie przejdzie)
    MIN_LEN=21,          # przebieg główny: długość jądra otwarcia
    PIN_BAND=25,         # pas numerów pinów (2-61: słupek „1” 22 px od krawędzi; kasowane
                         #  są tylko krótkie kreski, więc drut 24 px od krawędzi zostaje)
    BAND_RUN=32,         # w pasie kasowane kreski równoległe krótsze niż BAND_RUN
    SPUR_LEN=30,         # krótsze odgałęzienie z wolnym końcem z dala od bramki = tekst
    SPUR_ITERS=5,
    MIN_ISOLATED=40,     # samotny odcinek krótszy = śmieć (tekst)
    EXT_GATE=16,         # wolny koniec do krawędzi bramki (kółko negacji)
    ENTER_TOL=2,         # koniec może wejść tyle px w krawędź bramki
    PIN_TOL=8,           # wolny koniec <-> pin (tryb a)
    # --- skan (przerwy, falowanie) — bezwzględne
    WOBBLE=3,            # poszerzenie w poprzek linii przed otwarciem
    GAP2=15,             # przebieg główny: domknięcie wzdłuż (linie przerywane ze skanu)
    MERGE_LONG=40,       # duża przerwa scalana tylko między długimi kawałkami
    MERGE_GAP=12,        # scalanie współliniowych kawałków: przerwa (długie)
    MERGE_GAP_SHORT=2,   # ... (krótkie)
    MERGE_OFF=3,         # ... i przesunięcie poprzeczne
    BRIDGE_MAX=80,       # linia przerywana: maks. przerwa między współliniowymi kawałkami
    BRIDGE_INK=0.5,      # ... i minimalny udział tuszu w przerwie
    BRIDGE_BAND=2,       # ... w pasie +- px wokół osi
    SPLIT_FRAC=0.5,      # rozdzielanie: wiersz-linia ma tusz na >= tej części długości
    FIT_MIN_LEN=60,      # --fit: krótszy odcinek bierze medianę
    MAX_SLOPE=0.02,      # --fit: większy skos = mediana
    DOT_ON_WIRE=4,       # kropka w raporcie/overlayu tylko <= tyle px od drutu
    T_NEEDS_DOT=True,    # T bez kropki = brak połączenia
    # --- bramki
    GATES_P={"PIN_SIDES_MIN": 1},  # tryb b: nadpisania PARAMS scripts/cv-gates.py — do
                         #  maski wystarczą druty z jednej strony: domknięta ramka o czystych
                         #  narożnikach nie jest drutem, nawet jeśli to nie bramka
    BOX_SEARCH=6,        # dociąganie boku bramki do narysowanej ramki (+- px)
    BOX_INSET=6,         # ... pomiar ramki z pominięciem narożników
    BOX_FRAC=0.6,        # ... wiersz/kolumna ramki: udział tuszu wzdłuż boku
)

DERIVED = ("DOT_D", "DOT_DT", "DOT_MAX_SIDE", "DOT_HOLE", "DOT_R", "SNAP", "END_SNAP", "BOX_T", "PAD",
           "MAX_THICK", "THIN_W", "PAR_OFF")


def _odd(v: float) -> int:
    """Najbliższa liczba nieparzysta."""
    return 2 * int(round((v - 1) / 2)) + 1


def derive(P: dict, sw: float) -> dict:
    """Uzupełnia parametry None wzorami od grubości kreski `sw` (px)."""
    P = dict(P)
    d = {}
    d["DOT_D"] = max(5, _odd(7 + 2 * (sw - P["SW_REF"])))
    dot_d = P["DOT_D"] if P["DOT_D"] is not None else d["DOT_D"]
    d["DOT_DT"] = sw + P["DOT_DT_ADD"]
    d["DOT_MAX_SIDE"] = int(round(2 * dot_d + 2 * sw + 1))
    d["DOT_R"] = dot_d
    d["DOT_HOLE"] = int(np.ceil(sw * sw))
    d["SNAP"] = int(round(2.5 * sw))
    d["END_SNAP"] = dot_d + 2
    d["BOX_T"] = int(round(sw + 1.6))
    d["PAD"] = P["BOX_T"] if P["BOX_T"] is not None else d["BOX_T"]
    d["MAX_THICK"] = int(round(2 * sw + 4))
    d["THIN_W"] = int(round(sw + 1.6))
    d["PAR_OFF"] = int(round(2 * sw + 1))
    for k in DERIVED:
        if P.get(k) is None:
            P[k] = d[k]
    P["SW"] = sw
    return P


def _runs(m: np.ndarray, axis: int) -> np.ndarray:
    """Długości biegów jedynek wzdłuż osi (axis=0: biegi pionowe w kolumnach)."""
    a = (m if axis == 0 else m.T).astype(np.int8)
    pad = np.zeros((1, a.shape[1]), np.int8)
    d = np.diff(np.vstack([pad, a, pad]), axis=0)
    s = np.nonzero(d.T == 1)[1]
    e = np.nonzero(d.T == -1)[1]
    return e - s


def measure_stroke(bw: np.ndarray, P: dict) -> float:
    """Średni przekrój długich linii H i V (piksele Otsu), bez biegów > mediana + 1."""
    L = P["SW_PROBE_LEN"]
    rs = []
    for horiz in (True, False):
        k = (L, 1) if horiz else (1, L)
        m = cv2.morphologyEx(bw, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, k))
        r = _runs(m, 0 if horiz else 1)
        rs.append(r[(r >= 1) & (r <= P["SW_MAX_RUN"])])
    r = np.concatenate(rs)
    if not len(r):
        return float(P["SW_REF"])
    # średnia bez grubego ogona (ramki bramek): tylko biegi <= mediana + 1
    return float(r[r <= np.median(r) + 1].mean())


# --------------------------------------------------------------------------- bramki / maski

def _auto_box(g: dict) -> tuple[float, float]:
    """autoBox viewera (viewer/src/layers/box.ts) dla bramek bez w/h."""
    pins = g.get("pins") or []
    nl = sum(1 for p in pins if p.get("side") == "left")
    nr = sum(1 for p in pins if p.get("side") == "right")
    return 80.0, float(max(90, 22 * max(nl, nr, 1) + 20))


def gate_rects(gates: list[dict]) -> list[tuple[float, float, float, float]]:
    """(x0, y0, x1, y1) prostokątów bramek ze środka + w/h (rotation 90/270 = zamiana)."""
    out = []
    for g in gates or []:
        w, h = g.get("w"), g.get("h")
        if not w or not h:
            w, h = _auto_box(g)
        if (g.get("rotation") or 0) % 180 == 90:
            w, h = h, w
        x, y = float(g["x"]), float(g["y"])
        out.append((x - w / 2, y - h / 2, x + w / 2, y + h / 2))
    return out


def binarize(gray: np.ndarray, thr: int | None = None) -> np.ndarray:
    """Tusz = 1. thr=None -> Otsu; inaczej max(Otsu, thr)."""
    th, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if thr is not None:
        th = max(th, thr)
    return (gray <= th).astype(np.uint8)  # <=: na obrazie 0/255 Otsu daje th=0


def _load_cv_gates():
    """scripts/cv-gates.py (nazwa z myślnikiem — ładowana z pliku, raz)."""
    global _CVG
    if _CVG is None:
        import importlib.util
        spec = importlib.util.spec_from_file_location("cv_gates", Path(__file__).with_name("cv-gates.py"))
        _CVG = importlib.util.module_from_spec(spec)
        old, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # bez scripts/__pycache__
        try:
            spec.loader.exec_module(_CVG)
        finally:
            sys.dont_write_bytecode = old
    return _CVG


_CVG = None


def detect_gate_boxes(gray: np.ndarray, P: dict) -> list[tuple[float, float, float, float]]:
    """Tryb b: ramki bramek z scripts/cv-gates.py (kr-9p8.3) — bloki w całości (stos bramek,
    złożony układ, element bierny), bo maska nie musi dzielić stosu. Parametry cv-gates można
    nadpisać przez P["GATES_P"]."""
    res = _load_cv_gates().detect(gray, P.get("GATES_P"))
    return [tuple(float(v) for v in b["box"]) for b in res["blocks"]]


def refine_rects(bw: np.ndarray, rects, P: dict):
    """Dociąga każdy bok prostokąta do narysowanej ramki: w pasie +-BOX_SEARCH px szuka
    wiersza/kolumny z ramką (udział tuszu >= BOX_FRAC wzdłuż boku) najdalej na zewnątrz.
    Wzorcowe w/h bywają o kilka px mniejsze od ramki — reszta ramki udawałaby drut."""
    H, W = bw.shape
    r_, ins, fr = P["BOX_SEARCH"], P["BOX_INSET"], P["BOX_FRAC"]
    out = []
    for x0, y0, x1, y1 in rects:
        x0, y0, x1, y1 = (int(round(v)) for v in (x0, y0, x1, y1))
        ix0, ix1 = max(0, x0 + ins), min(W, x1 - ins + 1)
        iy0, iy1 = max(0, y0 + ins), min(H, y1 - ins + 1)
        if ix1 - ix0 < 5 or iy1 - iy0 < 5 or r_ <= 0:
            out.append((float(x0), float(y0), float(x1), float(y1)))
            continue
        top = [y for y in range(max(0, y0 - r_), min(H, y0 + r_ + 1)) if bw[y, ix0:ix1].mean() >= fr]
        bot = [y for y in range(max(0, y1 - r_), min(H, y1 + r_ + 1)) if bw[y, ix0:ix1].mean() >= fr]
        lef = [x for x in range(max(0, x0 - r_), min(W, x0 + r_ + 1)) if bw[iy0:iy1, x].mean() >= fr]
        rig = [x for x in range(max(0, x1 - r_), min(W, x1 + r_ + 1)) if bw[iy0:iy1, x].mean() >= fr]
        out.append((
            float(min(lef)) if lef else float(x0),
            float(min(top)) if top else float(y0),
            float(max(rig)) if rig else float(x1),
            float(max(bot)) if bot else float(y1),
        ))
    return out


def mask_rects(shape, rects, pad) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    H, W = shape
    for x0, y0, x1, y1 in rects:
        a, b = max(0, int(np.floor(x0 - pad))), max(0, int(np.floor(y0 - pad)))
        c, d = min(W, int(np.ceil(x1 + pad)) + 1), min(H, int(np.ceil(y1 + pad)) + 1)
        m[b:d, a:c] = 1
    return m


# --------------------------------------------------------------------------- kropki

def fill_holes(bw: np.ndarray, max_area: int, gray: np.ndarray | None = None,
               max_gray: float = 255) -> tuple[np.ndarray, np.ndarray]:
    """Zamalowuje dziury w środku bladych kropek: składowa tła (4-spójna, nie dotyka brzegu)
    o polu <= max_area i (jeśli podano `gray`) średniej szarości <= max_gray. Środek bladej
    kropki to kilka szarych pikseli (P-X3-2 2-1: 2–4 px, szarość 162–196); wnętrze kółka
    negacji (~50 px), oczka liter i kratki ramki to biały papier albo są za duże.
    Zwraca (obraz po zamalowaniu, maska zamalowanych pikseli)."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(1 - bw, connectivity=4)
    H, W = bw.shape
    fill = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a > max_area or x == 0 or y == 0 or x + w >= W or y + h >= H:
            continue
        if gray is not None:
            sel = lab[y : y + h, x : x + w] == i
            if float(gray[y : y + h, x : x + w][sel].mean()) > max_gray:
                continue
        fill[i] = True
    added = fill[lab].astype(np.uint8)
    return bw | added, added


def detect_dots(bw: np.ndarray, P: dict, gray: np.ndarray | None = None) -> list[tuple[float, float, float]]:
    """Kropki (x, y, r): otwarcie dyskiem DOT_D, promień koła wpisanego >= DOT_DT."""
    # blada w środku kropka (P-X3-2 2-1 (1480, 243), 2-61 (716, 679))
    dt0 = cv2.distanceTransform(bw, cv2.DIST_L2, 5)  # przed zamalowaniem
    bw, added = fill_holes(bw, P["DOT_HOLE"], gray, P["DOT_HOLE_GRAY"])
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (P["DOT_D"], P["DOT_D"]))
    m = cv2.morphologyEx(bw, cv2.MORPH_OPEN, k)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    dt = cv2.distanceTransform(bw, cv2.DIST_L2, 5)
    dots = []
    for i in range(1, n):
        x, y, w, h, _a = stats[i]
        if max(w, h) > P["DOT_MAX_SIDE"] or max(w, h) > P["DOT_ASPECT"] * min(w, h):
            continue
        comp = lab[y : y + h, x : x + w] == i
        sub = dt[y : y + h, x : x + w] * comp
        r = float(sub.max())
        # kropka „zrobiona” zamalowaniem musi być wyraźnie większa: 1–2-pikselowe dziury
        # (szum JPEG) w kleksie na skrzyżowaniu cienkich linii dają r ~3,2 (SM-POSET-1 2-97)
        r0 = float((dt0[y : y + h, x : x + w] * comp).max())
        filled = added[y : y + h, x : x + w][comp].any()
        if not (r0 >= P["DOT_DT"] or (filled and r >= P["DOT_DT"] + P["DOT_FILL_EXTRA"])
                or (not filled and r >= P["DOT_DT"])):
            continue
        ys, xs = np.nonzero(sub >= P["DOT_CENTER_FRAC"] * r)
        dots.append((float(xs.mean() + x), float(ys.mean() + y), r))
    return dots


def dot_mask(shape, dots, margin: float) -> np.ndarray:
    m = np.zeros(shape, np.uint8)
    for x, y, r in dots:
        cv2.circle(m, (int(round(x)), int(round(y))), int(np.ceil(r + margin)), 1, -1)
    return m


class DotIndex:
    """Siatka kubełków do zapytań „czy jest kropka w promieniu r”."""

    def __init__(self, dots, cell: float):
        self.cell = max(1.0, float(cell))
        self.g: dict[tuple[int, int], list[tuple[float, float]]] = {}
        for x, y, *_ in dots:
            self.g.setdefault((int(x // self.cell), int(y // self.cell)), []).append((x, y))

    def any_within(self, x: float, y: float, r: float) -> bool:
        cx, cy = int(x // self.cell), int(y // self.cell)
        k = int(np.ceil(r / self.cell))
        for i in range(cx - k, cx + k + 1):
            for j in range(cy - k, cy + k + 1):
                for px, py in self.g.get((i, j), ()):
                    if (px - x) ** 2 + (py - y) ** 2 <= r * r:
                        return True
        return False


# --------------------------------------------------------------------------- tekst

def _thin(w: int, h: int, P: dict) -> bool:
    """Cienka prosta kreska (kawałek drutu, także przerywanego) — nie znak."""
    return min(w, h) <= P["THIN_W"] and max(w, h) >= P["THIN_LEN"]


def remove_text(bw: np.ndarray, P: dict) -> np.ndarray:
    """Usuwa samodzielne składowe w rozmiarze znaku (bok GLYPH_MIN..TEXT_MAX), poza cienkimi kreskami."""
    n, lab, stats, _ = cv2.connectedComponentsWithStats(bw, connectivity=8)
    keep = np.ones(n, bool)
    keep[0] = False
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if P["GLYPH_MIN"] <= max(w, h) <= P["TEXT_MAX"] and not _thin(w, h, P):
            keep[i] = False  # okruchy < GLYPH_MIN zostają: to kawałki linii przerywanej
    return keep[lab].astype(np.uint8)


def line_mask(bw: np.ndarray, horizontal: bool, gap: int, min_len: int, P: dict,
              hold: np.ndarray | None = None) -> np.ndarray:
    """Piksele długich linii jednej orientacji: poszerzenie w poprzek (WOBBLE — cienka, falująca
    linia staje się ciągła), domknięcie wzdłuż (mostkuje przerwy < gap), otwarcie min_len.
    `hold` (maska kropek): te piksele nie biorą udziału w domknięciu, dokładane są dopiero
    przed otwarciem — kropka nie mostkuje drutu na sąsiedni równoległy drut."""
    if horizontal:
        kd, kc, ko = (1, P["WOBBLE"]), (gap, 1), (min_len, 1)
    else:
        kd, kc, ko = (P["WOBBLE"], 1), (1, gap), (1, min_len)
    sd = cv2.getStructuringElement(cv2.MORPH_RECT, kd)
    base = bw if hold is None else bw & (1 - hold)
    m = cv2.dilate(base, sd)
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, kc))
    if hold is not None:
        m = m | cv2.dilate(bw & hold, sd)
    return cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, ko))


def strip_glyphs(bw: np.ndarray, P: dict) -> np.ndarray:
    """Kasuje znaki dotykające drutów: odejmuje pewne linie (przebieg zachowawczy), z reszty
    usuwa składowe o boku GLYPH_MIN..TEXT_MAX, chyba że to cienka prosta kreska (krótki drut)."""
    lines = line_mask(bw, True, P["GAP1"], P["MIN_LEN1"], P) | line_mask(
        bw, False, P["GAP1"], P["MIN_LEN1"], P
    )
    lines = cv2.dilate(lines, np.ones((P["GLYPH_DIL"], P["GLYPH_DIL"]), np.uint8))
    resid = bw & (1 - lines)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(resid, connectivity=8)
    kill = np.zeros(n, bool)
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        if P["GLYPH_MIN"] <= max(w, h) <= P["TEXT_MAX"] and not _thin(w, h, P):
            kill[i] = True
    out = bw.copy()
    out[kill[lab]] = 0
    return out


def clear_pin_band(img: np.ndarray, region, along_axis: int, P: dict) -> None:
    """W pasie numerów pinów kasuje krótkie (< BAND_RUN) kreski biegnące wzdłuż `along_axis`
    (0 = pionowe). Długi drut biegnący w pasie równolegle do krawędzi zostaje."""
    y0, y1, x0, x1 = region
    if y1 <= y0 or x1 <= x0:
        return
    crop = img[y0:y1, x0:x1]
    k = (P["WOBBLE"], 1) if along_axis == 0 else (1, P["WOBBLE"])
    d = cv2.dilate(crop, cv2.getStructuringElement(cv2.MORPH_RECT, k))
    a = d if along_axis == 0 else d.T
    keep = np.zeros_like(a)
    for c in range(a.shape[1]):
        col = a[:, c].astype(np.int8)
        dd = np.diff(np.concatenate([[0], col, [0]]))
        for s, e in zip(np.nonzero(dd == 1)[0], np.nonzero(dd == -1)[0]):
            if e - s >= P["BAND_RUN"]:
                keep[s:e, c] = 1
    if along_axis != 0:
        keep = keep.T
    # zostaw piksele długich biegów (z marginesem WOBBLE) i nic poza tym
    keep = cv2.dilate(keep, cv2.getStructuringElement(cv2.MORPH_RECT, k))
    crop &= keep


# --------------------------------------------------------------------------- odcinki

class Seg:
    """Odcinek H ('h': wzdłuż = x, w poprzek = y) albo V ('v'): od a0 do a1, w poprzek c0..c1."""

    __slots__ = ("o", "a0", "a1", "c0", "c1")

    def __init__(self, o, a0, a1, c0, c1=None):
        self.o, self.a0, self.a1 = o, float(a0), float(a1)
        self.c0 = float(c0)
        self.c1 = float(c0 if c1 is None else c1)

    def c(self, a: float) -> float:
        if self.a1 == self.a0:
            return (self.c0 + self.c1) / 2
        return self.c0 + (self.c1 - self.c0) * (a - self.a0) / (self.a1 - self.a0)

    def pt(self, a: float, c: float | None = None) -> tuple[float, float]:
        c = self.c(a) if c is None else c
        return (a, c) if self.o == "h" else (c, a)

    def length(self) -> float:
        return self.a1 - self.a0

    def cmid(self) -> float:
        return (self.c0 + self.c1) / 2


def _split_thick(along: np.ndarray, cross: np.ndarray, P: dict):
    """Składowa grubsza niż MAX_THICK = dwie równoległe linie sklejone tekstem między nimi
    (np. etykiety „+RA/+RB” w odstępie 26 px). Wiersze z tuszem na >= SPLIT_FRAC długości
    to linie; każda grupa sąsiednich takich wierszy daje osobny odcinek."""
    c_lo, c_hi = int(cross.min()), int(cross.max())
    if c_hi - c_lo + 1 <= P["MAX_THICK"]:
        return [(along, cross)]
    length = float(along.max() - along.min() + 1)
    prof = np.bincount(cross - c_lo, minlength=c_hi - c_lo + 1)
    rows = np.nonzero(prof >= P["SPLIT_FRAC"] * length)[0]
    if len(rows) == 0:
        return [(along, cross)]
    groups, cur = [], [rows[0]]
    w = P["WOBBLE"]
    for r in rows[1:]:
        if r - cur[-1] <= w - 1:
            cur.append(r)
        else:
            groups.append(cur)
            cur = [r]
    groups.append(cur)
    out = []
    for g in groups:
        lo, hi = g[0] + c_lo - w + 1, g[-1] + c_lo + w - 1
        sel = (cross >= lo) & (cross <= hi)
        out.append((along[sel], cross[sel]))
    return out


def extract_lines(bw: np.ndarray, horizontal: bool, P: dict, ortho: bool = True,
                  hold: np.ndarray | None = None) -> list[Seg]:
    m = line_mask(bw, horizontal, P["GAP2"], P["MIN_LEN"], P, hold)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    o = "h" if horizontal else "v"
    segs = []
    for i in range(1, n):
        x, y, w, h, area = stats[i]
        ys, xs = np.nonzero(lab[y : y + h, x : x + w] == i)
        xs = xs + x
        ys = ys + y
        along, cross = (xs, ys) if horizontal else (ys, xs)
        for al, cr in _split_thick(along, cross, P):
            a0, a1 = float(al.min()), float(al.max())
            med = float(np.median(cr))
            c0 = c1 = med
            if not ortho and a1 - a0 >= P["FIT_MIN_LEN"]:
                k, b = np.polyfit(al.astype(float), cr.astype(float), 1)
                if abs(k) <= P["MAX_SLOPE"]:
                    c0, c1 = k * a0 + b, k * a1 + b
            segs.append(Seg(o, a0, a1, c0, c1))
    return merge_collinear(segs, P)


def _clusters(segs: list[Seg], tol: float):
    """Grupy odcinków jednej orientacji o współrzędnej poprzecznej różniącej się łańcuchowo
    o <= tol (posortowane po a0)."""
    out = []
    for o in ("h", "v"):
        ss = sorted((s for s in segs if s.o == o), key=lambda s: s.cmid())
        cur: list[Seg] = []
        for s in ss:
            if cur and s.cmid() - cur[-1].cmid() > tol:
                out.append(sorted(cur, key=lambda t: t.a0))
                cur = []
            cur.append(s)
        if cur:
            out.append(sorted(cur, key=lambda t: t.a0))
    return out


def merge_collinear(segs: list[Seg], P: dict) -> list[Seg]:
    """Jeden przebieg: współliniowe kawałki (przesunięcie <= MERGE_OFF, przerwa <= MERGE_GAP
    dla długich / MERGE_GAP_SHORT dla krótkich) i równoległe zachodzące na siebie kawałki
    (przesunięcie <= PAR_OFF — np. pasek obok kropki) łączone; współrzędna poprzeczna
    z dłuższego."""
    out: list[Seg] = []
    for cl in _clusters(segs, max(P["MERGE_OFF"], P["PAR_OFF"])):
        merged: list[Seg] = []
        for t in cl:
            done = False
            for k in range(len(merged) - 1, -1, -1):
                cur = merged[k]
                gap = t.a0 - cur.a1
                lng = min(cur.length(), t.length()) >= P["MERGE_LONG"]
                g = P["MERGE_GAP"] if lng else P["MERGE_GAP_SHORT"]
                at = min(max(t.a0, cur.a0), min(t.a1, cur.a1))
                off = abs(t.c(at) - cur.c(at))
                if gap <= 0 and off <= P["PAR_OFF"] or 0 < gap <= g and off <= P["MERGE_OFF"]:
                    lo = cur if cur.a0 <= t.a0 else t
                    hi = cur if cur.a1 >= t.a1 else t
                    main = cur if cur.length() >= t.length() else t
                    if off <= P["MERGE_OFF"]:
                        merged[k] = Seg(cur.o, lo.a0, hi.a1, lo.c0, hi.c1)
                    else:
                        merged[k] = Seg(cur.o, lo.a0, hi.a1, main.c0, main.c1)
                    done = True
                    break
            if not done:
                merged.append(Seg(t.o, t.a0, t.a1, t.c0, t.c1))
        out += merged
    return out


def bridge_gaps(segs: list[Seg], bw: np.ndarray, P: dict) -> list[Seg]:
    """Linia przerywana ze skanu (blady, cienki tusz): współliniowe kawałki z przerwą
    <= BRIDGE_MAX scalane, jeśli w przerwie (pas +-BRIDGE_BAND px wokół osi) tusz jest
    w >= BRIDGE_INK wierszy/kolumn — dowód, że linia tam jest, tylko słabo odbita.
    Jeden przebieg po grupach współliniowych posortowanych wzdłuż."""
    if P["BRIDGE_MAX"] <= 0:
        return segs
    b = P["BRIDGE_BAND"]
    out: list[Seg] = []
    for cl in _clusters(segs, P["MERGE_OFF"]):
        cur = cl[0]
        for t in cl[1:]:
            gap0, gap1 = int(cur.a1) + 1, int(t.a0)
            ok = False
            if 0 < gap1 - gap0 <= P["BRIDGE_MAX"] and abs(t.c0 - cur.c1) <= P["MERGE_OFF"]:
                c = int(round((cur.c1 + t.c0) / 2))
                if cur.o == "h":
                    band = bw[max(0, c - b) : c + b + 1, gap0:gap1].max(axis=0)
                else:
                    band = bw[gap0:gap1, max(0, c - b) : c + b + 1].max(axis=1)
                ok = band.size > 0 and band.mean() >= P["BRIDGE_INK"]
            if ok:
                cur = Seg(cur.o, cur.a0, max(cur.a1, t.a1), cur.c0, t.c1)
            else:
                out.append(cur)
                cur = t
        out.append(cur)
    return out


def trim_to_dots(segs: list[Seg], dots, P: dict) -> list[Seg]:
    """Koniec odcinka leżący w kropce (trzon T, narożnik z kropką) przycięty do środka kropki.
    Kropka wydłuża bieg linii o swój promień; bez przycięcia SNAP liczony od takiego końca
    sięga równoległego drutu 10–14 px dalej."""
    if not dots:
        return segs
    D = np.array([(x, y, r) for x, y, r in dots], float)
    for s in segs:
        da, dc = (D[:, 0], D[:, 1]) if s.o == "h" else (D[:, 1], D[:, 0])
        r = D[:, 2] + P["DOT_TRIM_TOL"]
        for end in (0, 1):
            a = s.a0 if end == 0 else s.a1
            on = (np.abs(dc - s.c(a)) <= r) & (np.abs(da - a) <= r)
            if not on.any():
                continue
            k = int(np.argmin(np.abs(da - a) + np.where(on, 0, 1e9)))
            if end == 0 and da[k] < s.a1:
                s.a0 = float(da[k])
            elif end == 1 and da[k] > s.a0:
                s.a1 = float(da[k])
    return segs


# --------------------------------------------------------------------------- graf

class DSU:
    def __init__(self, n):
        self.p = list(range(n))

    def find(self, a):
        while self.p[a] != a:
            self.p[a] = self.p[self.p[a]]
            a = self.p[a]
        return a

    def union(self, a, b):
        a, b = self.find(a), self.find(b)
        if a != b:
            self.p[b] = a


def build_graph(segs: list[Seg], dots: DotIndex, P):
    """Spójność H×V. Zwraca (dsu, nodes, t_rejected): nodes[k] = lista (along, (x, y))
    węzłów odcinka k; t_rejected = punkty T odrzucone z braku kropki (diagnostyka)."""
    dsu = DSU(len(segs))
    nodes: list[list[tuple[float, tuple[int, int]]]] = [[] for _ in segs]
    t_rej = []
    snap, dr = P["SNAP"], P["DOT_R"]
    hs = sorted((i for i, s in enumerate(segs) if s.o == "h"), key=lambda i: segs[i].a0)
    vs = sorted((i for i, s in enumerate(segs) if s.o == "v"), key=lambda i: segs[i].cmid())
    vx = np.array([segs[j].cmid() for j in vs])
    for i in hs:
        h = segs[i]
        m = snap + P["MERGE_OFF"]  # zapas: oś pionowego odcinka vs jego mediana
        lo = np.searchsorted(vx, h.a0 - m)
        hi = np.searchsorted(vx, h.a1 + m, side="right")
        for j in vs[lo:hi]:
            v = segs[j]
            y = h.c(v.cmid())
            x = v.c(y)
            y = h.c(x)
            if not (h.a0 - snap <= x <= h.a1 + snap and v.a0 - snap <= y <= v.a1 + snap):
                continue
            h_end = min(abs(x - h.a0), abs(x - h.a1)) <= snap
            v_end = min(abs(y - v.a0), abs(y - v.a1)) <= snap
            if h_end and v_end:
                ok = True  # narożnik (bez kropki)
            else:
                has_dot = dots.any_within(x, y, dr)
                if h_end or v_end:  # T
                    ok = has_dot or not P["T_NEEDS_DOT"]
                    if not ok:
                        t_rej.append((int(round(x)), int(round(y))))
                else:  # skrzyżowanie
                    ok = has_dot
            if ok:
                dsu.union(i, j)
                p = (int(round(x)), int(round(y)))
                nodes[i].append((x, p))
                nodes[j].append((y, p))
    return dsu, nodes, t_rej


def chain(s: Seg, nds, P):
    """Punkty łamanej odcinka: [początek, węzły..., koniec] + flagi wolnych końców."""
    nds = sorted(nds, key=lambda t: t[0])
    snap = P["END_SNAP"]  # kropka wydłuża bieg linii poza oś drugiej linii
    pts = []
    free0 = free1 = True
    if nds and abs(nds[0][0] - s.a0) <= snap:
        free0 = False
    else:
        pts.append(_ipt(s.pt(s.a0)))
    pts += [p for _, p in nds]
    if nds and abs(nds[-1][0] - s.a1) <= snap:
        free1 = False
    else:
        pts.append(_ipt(s.pt(s.a1)))
    if len(nds) == 1 and not free0 and not free1:
        # jeden węzeł przy obu końcach (bardzo krótki odcinek) — koniec dalszy jest wolny
        if abs(nds[0][0] - s.a0) <= abs(nds[0][0] - s.a1):
            free1 = True
            pts.append(_ipt(s.pt(s.a1)))
        else:
            free0 = True
            pts.insert(0, _ipt(s.pt(s.a0)))
    return pts, free0, free1


def _ipt(p):
    return (int(round(p[0])), int(round(p[1])))


def _enters_box(s: Seg, end: int, r, near, tol) -> bool:
    """Koniec (0/1) odcinka wchodzi prostopadle w krawędź bramki r (przerwa <= near) — pin."""
    x0, y0, x1, y1 = r
    if s.o == "h":
        lo, hi, e_lo, e_hi = y0, y1, x0, x1
    else:
        lo, hi, e_lo, e_hi = x0, x1, y0, y1
    a = s.a0 if end == 0 else s.a1
    if not (lo <= s.c(a) <= hi):
        return False
    if end == 0:
        return -tol <= s.a0 - e_hi <= near
    return -tol <= e_lo - s.a1 <= near


def _extend(pts, s: Seg, end: int, boxes, P):
    """Wolny koniec dociągnięty do krawędzi bramki (przerwa <= EXT_GATE + PAD)."""
    ext = P["EXT_GATE"] + P["PAD"]
    for r in boxes:
        if not _enters_box(s, end, r, ext, P["ENTER_TOL"]):
            continue
        x0, y0, x1, y1 = r
        if s.o == "h":
            a = x1 if end == 0 else x0
        else:
            a = y1 if end == 0 else y0
        p = _ipt(s.pt(a))
        if end == 0:
            pts[0] = p
        else:
            pts[-1] = p
        return


def digitize(gray: np.ndarray, gates: list[dict] | None, P: dict | None = None, ortho=True):
    """Rdzeń: skan (uint8) -> dict(nets, dots, boxes, params, t_rejected)."""
    P = {**PARAMS, **(P or {})}
    H_, W_ = gray.shape
    bw = binarize(gray)
    sw = float(P["SW"]) if P.get("SW") else measure_stroke(bw, P)
    P = derive(P, sw)
    if gates is not None:
        boxes = gate_rects(gates)
        pin_sides = ["tb" if (g.get("rotation") or 0) % 180 == 90 else "lr" for g in gates]
    else:
        boxes = detect_gate_boxes(gray, P)
        pin_sides = ["lr" if (r[3] - r[1]) >= (r[2] - r[0]) else "tb" for r in boxes]
    boxes = refine_rects(bw, boxes, P)
    mask = mask_rects(bw.shape, boxes, P["PAD"])
    if P.get("TITLE"):
        fx, fy = P["TITLE"]
        mask[int(fy * H_) :, int(fx * W_) :] = 1
    dots = [d for d in detect_dots(bw, P, gray) if not mask[int(d[1]), int(d[0])]]
    dindex = DotIndex(dots, P["DOT_R"])
    bw_w = binarize(gray, P["THR"])
    bw_w[mask > 0] = 0
    bw_raw = bw_w.copy()
    bw_w = remove_text(bw_w, P)
    bw_w = strip_glyphs(bw_w, P)
    hold = dot_mask(bw.shape, dots, P["DOT_MASK_MARGIN"])
    # pas numerów pinów przy krawędzi z pinami: krótkie kreski równoległe do krawędzi
    # (cyfry) kasowane z obrazu dla tej orientacji; długi drut w pasie zostaje
    bw_h, bw_v = bw_w.copy(), bw_w.copy()
    b = P["PIN_BAND"]
    if b > 0:
        for r, side in zip(boxes, pin_sides):
            x0, y0, x1, y1 = (int(round(v)) for v in r)
            y0c, y1c, x0c, x1c = max(0, y0), min(H_, y1 + 1), max(0, x0), min(W_, x1 + 1)
            if side == "lr":
                clear_pin_band(bw_v, (y0c, y1c, max(0, x0 - b), x0c), 0, P)
                clear_pin_band(bw_v, (y0c, y1c, min(W_, x1 + 1), min(W_, x1 + 1 + b)), 0, P)
            else:
                clear_pin_band(bw_h, (max(0, y0 - b), y0c, x0c, x1c), 1, P)
                clear_pin_band(bw_h, (min(H_, y1 + 1), min(H_, y1 + 1 + b), x0c, x1c), 1, P)
    segs = extract_lines(bw_h, True, P, ortho, hold) + extract_lines(bw_v, False, P, ortho, hold)
    segs = bridge_gaps(segs, bw_raw, P)
    segs = trim_to_dots(segs, dots, P)

    # krótkie odgałęzienia z wolnym końcem, który nie wchodzi w bramkę = kreski tekstu
    near = P["EXT_GATE"] + P["PAD"] + P["ENTER_TOL"]
    for _ in range(P["SPUR_ITERS"]):
        dsu, nodes, t_rej = build_graph(segs, dindex, P)
        drop = set()
        for k, s in enumerate(segs):
            if s.length() >= P["SPUR_LEN"]:
                continue
            _, f0, f1 = chain(s, nodes[k], P)
            for end, free in ((0, f0), (1, f1)):
                if free and not any(_enters_box(s, end, bx, near, P["ENTER_TOL"]) for bx in boxes):
                    drop.add(k)
        if not drop:
            break
        segs = [s for k, s in enumerate(segs) if k not in drop]
    else:
        dsu, nodes, t_rej = build_graph(segs, dindex, P)  # segs zmienione w ostatnim obrocie

    groups: dict[int, list[int]] = {}
    for k in range(len(segs)):
        groups.setdefault(dsu.find(k), []).append(k)

    nets = []
    for members in groups.values():
        pieces, fe, total = [], [], 0.0
        for k in members:
            s = segs[k]
            pts, f0, f1 = chain(s, nodes[k], P)
            if f0:
                _extend(pts, s, 0, boxes, P)
                fe.append(pts[0])
            if f1:
                _extend(pts, s, 1, boxes, P)
                fe.append(pts[-1])
            total += s.length()
            for p, q in zip(pts[:-1], pts[1:]):
                if p != q:
                    pieces.append((p[0], p[1], q[0], q[1]))
        if not pieces or not fe:
            continue  # zamknięta ramka — drut zawsze gdzieś prowadzi
        if len(members) == 1 and total < P["MIN_ISOLATED"]:
            continue  # samotny krótki kawałek = tekst
        deg: dict[tuple[int, int], int] = {}
        for x0, y0, x1, y1 in set(pieces):
            for p in ((x0, y0), (x1, y1)):
                deg[p] = deg.get(p, 0) + 1
        juncs = sorted(p for p, d in deg.items() if d >= 3)
        nets.append(dict(pieces=pieces, free=fe, junctions=juncs, length=total))
    nets.sort(key=lambda n: (min(min(p[1], p[3]) for p in n["pieces"]), min(p[0] for p in n["pieces"])))
    for i, n in enumerate(nets, 1):
        n["name"] = f"CVNET_{i}"
    allp = [p for n in nets for p in n["pieces"]]
    used_dots = [(x, y) for x, y, _r in dots
                 if any(_dist_pt_seg((x, y), p) <= P["DOT_ON_WIRE"] for p in allp)]
    return dict(nets=nets, dots=used_dots, boxes=boxes, params=P, t_rejected=t_rej)


def _dist_pt_seg(p, s):
    x, y = p
    x0, y0, x1, y1 = s
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / L2))
    return float(np.hypot(x - (x0 + t * dx), y - (y0 + t * dy)))


GATE_KEYS = ("ref", "gate", "x", "y", "w", "h", "rotation")
PIN_KEYS = ("num", "side", "px", "py")


def clean_gates(gates: list[dict]) -> list[dict]:
    """Kopia bramek z białej listy pól (bez verified/disconnected/cross/note wzorca)."""
    out = []
    for g in gates or []:
        d = {k: g[k] for k in GATE_KEYS if k in g}
        d["pins"] = [{k: p[k] for k in PIN_KEYS if k in p} | {"net": ""} for p in g.get("pins") or []]
        d["verified"] = False
        out.append(d)
    return out


def assign_pins(gates: list[dict], nets: list[dict], P: dict) -> tuple[int, int]:
    """Tryb a: pin.net = net, którego wolny koniec leży najbliżej pinu (<= PIN_TOL)."""
    ends = [(fx, fy, n["name"]) for n in nets for fx, fy in n["free"]]
    hit = total = 0
    for g in gates:
        for p in g.get("pins") or []:
            total += 1
            best, bd = "", P["PIN_TOL"] + 1e-9
            if p.get("px") is not None:
                for fx, fy, name in ends:
                    d = float(np.hypot(fx - p["px"], fy - p["py"]))
                    if d <= bd:
                        best, bd = name, d
            p["net"] = best
            hit += bool(best)
    return hit, total


# --------------------------------------------------------------------------- wyjście

def palette(n: int) -> list[tuple[int, int, int]]:
    cols = []
    for i in range(n):
        h = (i * 0.618033988749895) % 1.0
        r, g, b = colorsys.hsv_to_rgb(h, 0.85, 0.75 if i % 2 else 0.95)
        cols.append((int(b * 255), int(g * 255), int(r * 255)))
    return cols


def draw_overlay(gray, res, path):
    base = (gray.astype(np.float32) * 0.35 + 255 * 0.65).astype(np.uint8)
    img = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)
    for x0, y0, x1, y1 in res["boxes"]:
        cv2.rectangle(img, (int(x0), int(y0)), (int(x1), int(y1)), (200, 200, 120), 1)
    for n, col in zip(res["nets"], palette(len(res["nets"]))):
        for x0, y0, x1, y1 in n["pieces"]:
            cv2.line(img, (x0, y0), (x1, y1), col, 3)
    for x, y in res["dots"]:
        cv2.circle(img, (int(round(x)), int(round(y))), 8, (0, 0, 255), 2)
    for n in res["nets"]:
        for x, y in n["free"]:
            cv2.rectangle(img, (x - 3, y - 3), (x + 3, y + 3), (255, 0, 0), -1)
    cv2.imwrite(str(path), img)


def _raster(shape, segs, thick):
    m = np.zeros(shape, np.uint8)
    for x0, y0, x1, y1 in segs:
        cv2.line(m, (int(round(x0)), int(round(y0))), (int(round(x1)), int(round(y1))), 1, thick)
    return m


def draw_diff(gray, res, gold: dict, path):
    """Magenta = tylko wzorzec (pominięte), pomarańcz = tylko kandydat, zielony = zgodne (3 px)."""
    gsegs = [s for name, n in (gold.get("nets") or {}).items() if str(name).strip()
             for s in (n.get("segments") or [])]
    csegs = [p for n in res["nets"] for p in n["pieces"]]
    sh = gray.shape
    g1, c1 = _raster(sh, gsegs, 1), _raster(sh, csegs, 1)
    g7, c7 = _raster(sh, gsegs, 7), _raster(sh, csegs, 7)
    base = (gray.astype(np.float32) * 0.3 + 255 * 0.7).astype(np.uint8)
    img = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)
    k = np.ones((3, 3), np.uint8)
    img[cv2.dilate((g1 & c7) | (c1 & g7), k) > 0] = (0, 170, 0)
    img[cv2.dilate(c1 & (1 - g7), k) > 0] = (0, 140, 255)
    img[cv2.dilate(g1 & (1 - c7), k) > 0] = (255, 0, 255)
    cv2.imwrite(str(path), img)


def to_yaml_doc(res, page, package, gates, shape):
    nets = {}
    for n in res["nets"]:
        nets[n["name"]] = dict(
            pins=[],
            segments=[[int(a), int(b), int(c), int(d)] for a, b, c, d in n["pieces"]],
            junctions=[[int(x), int(y)] for x, y in n["junctions"]] or None,
        )
    return {
        "kronikarz": "1",
        "page": page,
        "package": package,
        "scan_size": [int(shape[1]), int(shape[0])],
        "gates": gates or [],
        "power": [],
        "ports": [],
        "cross_refs": [],
        "nets": nets,
        "annotations": [],
        "decorations": [],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scan", required=True)
    ap.add_argument("--gates", help="*.sch.yaml z bramkami (tryb a)")
    ap.add_argument("--out", required=True)
    ap.add_argument("--overlay")
    ap.add_argument("--gold", help="wzorzec do --diff")
    ap.add_argument("--diff")
    ap.add_argument("--page")
    ap.add_argument("--package")
    ap.add_argument("--fit", action="store_true",
                    help="odcinki wzdłuż dopasowanej prostej (skos skanu) zamiast ściśle H/V")
    a = ap.parse_args(argv)

    t0 = time.perf_counter()
    gray = cv2.imread(a.scan, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        sys.exit(f"nie mogę wczytać {a.scan}")
    gates = None
    src = {}
    if a.gates:
        src = yaml.safe_load(Path(a.gates).read_text()) or {}
        gates = clean_gates(src.get("gates") or [])
    res = digitize(gray, gates, ortho=not a.fit)
    P = res["params"]
    page = a.page or src.get("page") or Path(a.scan).stem
    package = a.package or src.get("package") or Path(a.scan).parent.parent.name
    msg = ""
    if gates is not None:
        hit, tot = assign_pins(gates, res["nets"], P)
        msg = f", piny z netem {hit}/{tot}"
    doc = to_yaml_doc(res, page, package, gates or [], gray.shape)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True))
    dt = time.perf_counter() - t0
    nseg = sum(len(n["pieces"]) for n in res["nets"])
    nfree = sum(len(n["free"]) for n in res["nets"])
    nj = sum(len(n["junctions"]) for n in res["nets"])
    print(f"{page}: sw={P['SW']:.2f} DOT_D={P['DOT_D']} DOT_DT={P['DOT_DT']:.2f} "
          f"BOX_T={P['BOX_T']}; {len(res['nets'])} netów, {nseg} odcinków, "
          f"{len(res['dots'])} kropek, {nj} węzłów >=3, {nfree} wolnych końców, "
          f"T bez kropki {len(res['t_rejected'])}, bramek/masek {len(res['boxes'])}{msg}, "
          f"{dt:.2f} s")
    if a.overlay:
        draw_overlay(gray, res, a.overlay)
    if a.diff and a.gold:
        draw_diff(gray, res, yaml.safe_load(Path(a.gold).read_text()), a.diff)


if __name__ == "__main__":
    main()
