"""Krok ④ `labels` pipeline'u (kr-9p8.28): porty, odsyłacze (cross-refy) i symbole zasilania na
wolnych końcach drutów. Czyste funkcje (bez I/O i bez modelu) — `scripts/auto.py` czyta skan,
woła model i zapisuje stronę.

1. Kandydaci (`free_ends`): końce odcinków BIEŻĄCEJ strony (druty po ③, także poprawione przez
   człowieka), przy których nie ma innego odcinka (koniec ≤ `CONNECT_TOL` Chebyshev albo
   wnętrze ≤ `TOUCH_TOL` = 8 px, jak walidator), pinu ani ramki bramki. Kierunek `dir` = na zewnątrz drutu (koniec
   lewy poziomego drutu → 'left').
2. Klasyfikacja CV (`classify_end`) na binarnym skanie, w oknie ZA końcem (na zewnątrz drutu):
   - port: wysoka kreska szewronu `< A50 >` (składowa wys. `CHEV_H_MIN…CHEV_H_MAX`, nie pionowy
     drut) w `CHEV_FAR` px za końcem poziomego drutu — numery arkuszy są niższe;
   - odsyłacz: niskie znaki (cyfry arkuszy) przy wysokości drutu tuż za końcem poziomego drutu;
   - zasilanie: znaki za końcem pionowego drutu (napis +5V / 0V nad / pod drutem) — do
     przeczytania; bez znaków kandydat masy: krótka pozioma kreska w poprzek końca (bez tuszu
     za nią, nie przy ramce bramki, nie w tabliczce) albo krótki odcinek ③ z pionowym drutem
     kończącym się w jego środku (T) — masę potwierdza model (POWER_PROMPT, pole `ground`).
   Koniec bez niczego za sobą = `None` (wyprowadzenie wolnej bramki, drut do poprawy w ③…).
3. Odczyt (auto.py): port i odsyłacz promptami v3 bake-offu (kadr `_vlm.port_crop_box` /
   `xref_crop_box`, skala 2); odsyłacz przy lewym końcu — osobno kolumna numerów
   (`xref_sheets_box`, SHEETS_PROMPT) i etykieta (`xref_label_box`, XREF_LABEL_PROMPT)
   z zamalowanymi sąsiednimi wierszami; zasilanie promptem `POWER_PROMPT`.
4. Samokorekta (`check_port`, `check_xref`, `check_power`, `LabelContext`): złącze (litera
   z konwencji danych / backplane, pin 1…`PIN_MAX`), arkusze z `package.yaml` (nie własny),
   format etykiety (+/−), etykiety innych stron pakietu (powrót odsyłacza, mylone
   znaki R/A/Q/D, P/D, B/8, 5/S, 11/H, 0/O, Ł/L), port o tym samym złączu na innej stronie.
   Odczyt zostaje, jaki jest; niezgodność → `steps.labels.uncertain` (`{kind, label, x, y,
   why}`, jak ② — „KOD: opis”).
5. Scalanie (`label_plan`, `merge_labels`): ludzkie (i chronione) porty / odsyłacze /
   zasilanie zostają i zajmują swoje końce (`claim_dist`: wzdłuż drutu ≤ 45 px, w poprzek ≤ 12);
   własne `src: auto` (net pusty albo `auto` z niezatwierdzonego ⑤) są czytane ponownie
   i zastępowane udanym odczytem, bez potwierdzenia znikają (błąd modelu i elementy ludzkiego
   pochodzenia z `human_filled` snapshotu zostają: PREVIOUS_KEPT / NO_WIRE_END); element z całym pustym aspektem (`aspectEmpty`, np.
   port dodany w viewerze bez złącza i etykiety) dostaje odczyt końca, przy którym stoi.
   Nowe elementy: `src: auto`, `net: ""` (nety to krok ⑤), bez `net_src`.
"""
from __future__ import annotations

import copy
import math
import re
from collections import Counter
from typing import Any

import _steps
import _vlm

CONNECT_TOL = _steps.CONNECT_TOL  # px, koniec ↔ koniec (jak walidator / viewer)
TOUCH_TOL = CONNECT_TOL  # px: koniec ≤ tyle od innego odcinka (także wnętrza: T bez kropki,
                         # przestrzał drutu o 3–8 px za drut) = połączony — jak walidator
AXIS_TOL = 3.0        # px: odcinek poziomy / pionowy (kreska masy z odcinków ③)
PIN_TOL = 8.0         # px: koniec przy pinie bramki = nie wolny
GATE_PAD = 6.0        # px: koniec w ramce bramki (pin nieodczytany) = nie wolny
STUB_MAX = 90.0       # px: odcinek od pinu do wolnego końca krótszy = wyprowadzenie bramki
CLAIM_ALONG, CLAIM_ACROSS = 45.0, 12.0  # px: istniejący port / odsyłacz / zasilanie zajmuje koniec
                      # wzdłuż drutu ≤ 45, w poprzek ≤ 12 (ręczne odsyłacze stoją 25–35 px od końca
                      # drutu z ③; wiersze odsyłaczy co ≥ 25 px)
NEAR_EXISTING = 60.0  # px (Chebyshev): nowy element auto tak blisko ludzkiego tego rodzaju — flaga
# okna CV (px skanu 200 dpi), liczone od końca drutu na zewnątrz
CHEV_NEAR, CHEV_FAR, CHEV_HALF = -4, 135, 34   # szewron: od tuż przed końcem do 135 px, ±34 px
CHEV_H_MIN, CHEV_H_MAX, CHEV_W_MIN = 28, 66, 10
CHEV_SLANT_MIN = 8   # px: rozrzut (p90 − p10) środka tuszu w wierszach — kreska skośna, nie pion
TEXT_NEAR, TEXT_FAR = -6, 70                    # cyfry arkuszy / napis za końcem poziomego drutu
                                                # (od 6 px przed końcem: „1” bywa wpisane w koniec)
TEXT_UP, TEXT_DOWN = 18, 24
TEXT_H_MIN, TEXT_H_MAX, TEXT_AREA_MIN = 7, 34, 12
VTEXT_NEAR, VTEXT_FAR, VTEXT_HALF = 2, 48, 40   # napis za końcem pionowego drutu
VTEXT_LINE_W, VTEXT_MIN_WIDTH = 5, 14  # px: składowa ≤ 5 px szer. = kreska; napis ≥ 14 px szer. razem
GND_ROWS = (-3, 14)   # kreska masy: wiersze od końca (w dół / w górę) …
GND_HALF = 32         # … w poziomie ±32 px
GND_RUN_MIN, GND_SIDE_MIN, GND_RUN_MAX = 14, 5, 70
GND_SEG_MAX = 70.0    # px: krótki odcinek ③ w poprzek końca pionowego drutu = kreska masy
GND_BEYOND = (3, 12)  # px za kreską: tusz tam = kółko zacisku / ramka / tekst, nie masa
GND_GATE_PAD = 12.0   # px: kreska przy ramce bramki = dół ramki, nie masa
# tabliczka rysunkowa (prawy dolny róg; jak cv-wires P["TITLE"]): bez zasilania / masy
TITLE_FRAC = (0.62, 0.76)  # x od 0,62 W: tabliczka SPP-32-16 2-137 sięga dalej w lewo niż w cv-wires
# odczyt zasilania: kadr wokół końca
POWER_HALF, POWER_FAR, POWER_BACK = 45, 60, 8
PIN_MAX = 96          # styki złącza krawędziowego MERA-400 (A01…A96 — tabela zasilania 2-69)
# litery złączy: z portów pakietu (ludzkich / zatwierdzonych) i backplane projektu; nic nie
# wiadomo → każda litera A–Z (SM-POSE11 ma X / Y, SPP-32-16 Y)
LABEL_SCALE = 2       # jak bake-off (Qwen3.8-27B: ×2)
LABEL_PROMPT = "v3"

POWER_PROMPT = (
    "This is a crop from a hand-lettered 1970s Polish logic schematic around the free end of one "
    "wire; red triangles on the left and right image borders mark the height of that wire end. A "
    "power supply label may be written at that wire end (e.g. +5V, 0V, -12V, +12V). Zero may be "
    "drawn with a slash (Ø) - write it as the digit 0. Ignore pin numbers, signal names and text "
    "cut by the crop edge. A ground symbol is a short thick bar drawn across the wire end, with no "
    "text and no small circle. Return JSON: label (the supply label exactly as printed, \"\" if "
    "there is none at the wire end), ground (true only if the wire ends in a ground bar)."
)
# odsyłacz przy lewej krawędzi („9 -L”): numer arkusza i etykieta osobno, sąsiednie wiersze
# zamalowane (zgłoszenie opiekuna 2-62: „-L9 [0, 8]” zamiast „-L [9]”)
SHEETS_PROMPT = (
    "This is a crop from a hand-lettered 1970s Polish logic schematic at the left sheet edge. Red "
    "triangles mark the height of one wire; just before its left end (the right side of this crop) "
    "the sheet numbers of an off-sheet reference are written: one or more integers separated by "
    "commas (e.g. 9, 1 or 6,7). Other rows are blanked out; ignore small fragments at the top and "
    "bottom crop edges. Zero is drawn with a slash (Ø) - write "
    "it as the digit 0. Return JSON: sheets (list of integers, [] if there are none)."
)
XREF_LABEL_PROMPT = (
    "This is a crop from a hand-lettered 1970s Polish logic schematic. Red triangles mark one "
    "wire; a signal name is written just above its left end (it starts with + or -, e.g. +RPA, "
    "-CZYTRW, +W10, -L). Text of other rows is blanked out. Zero is drawn with a slash (Ø) - write "
    "it as the digit 0. Keep Polish letters (Ł) only where the L has a clear crossbar.\n"
    "Lettering hints: the letter R has a curly top and often looks like Q, D or A. Digits inside "
    "names may look like letters (5 like S). A vertical stroke crossed by a short slash between "
    "letters (as in W/R) is the separator /.\nReturn JSON: label."
)
XREF_LEFT_SHEETS = (75, 6)  # px: kolumna numerów arkuszy przed lewym końcem drutu
XREF_LEFT_LABEL = 200     # px: etykieta nad drutem w prawo od końca
XREF_ROW_NEIGHBOUR = 40.0  # px w poziomie: końce w tej samej kolumnie odsyłaczy (odstępy wierszy)

POWER_RE = re.compile(r"([+-]?)(\d+(?:[.,]\d+)?)V")
LABEL_RE = re.compile(r"[+-]\S+")
# mylone znaki (bake-off kr-9p8.4): R z zawijasem → A/Q/D, P↔D, B↔8, 5↔S, 11→H, 0↔O, Ł↔L
CONFUSABLE: dict[str, tuple[str, ...]] = {
    "R": ("A", "Q", "D"), "A": ("R",), "Q": ("R",), "D": ("R", "P"), "P": ("D", "B", "R"),
    "B": ("P", "8"), "8": ("B",), "5": ("S",), "S": ("5",), "H": ("11", "1"), "0": ("O",),
    "O": ("0",), "Ł": ("L",), "L": ("Ł",), "1": ("I", "H"), "I": ("1",),
}
DIRS = ("left", "right", "up", "down")
ROT_BY_DIR = {"up": 0, "right": 90, "down": 180, "left": 270}  # Konva: zgodnie z zegarem


# --------------------------------------------------------------------------- geometria

def _seg(s) -> tuple[float, float, float, float]:
    return tuple(float(v) for v in s)  # type: ignore[return-value]


def _cheb(a, b) -> float:
    return max(abs(a[0] - b[0]), abs(a[1] - b[1]))


def _dist_pt_seg(p, s) -> tuple[float, float]:
    """(odległość, t) punktu od odcinka; t = położenie rzutu 0…1."""
    x, y = p
    x0, y0, x1, y1 = s
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / L2))
    return math.hypot(x - (x0 + t * dx), y - (y0 + t * dy)), t


def page_segments(page: dict) -> list[tuple[tuple[float, float, float, float], str]]:
    """Odcinki strony z nazwą netu (net o pustej nazwie pomijany — viewer go nie rysuje)."""
    out = []
    nets = page.get("nets")
    for name, n in (nets.items() if isinstance(nets, dict) else []):
        if not str(name).strip() or not isinstance(n, dict):
            continue
        for s in _steps.list_of(n.get("segments")):
            if _steps.is_segment(s):
                out.append((_seg(s), str(name)))
    return out


def gate_pins_abs(gates: list) -> list[tuple[float, float]]:
    pts = []
    for g in gates:
        for p in _steps.list_of(g.get("pins") if isinstance(g, dict) else None):
            if isinstance(p, dict) and _steps._is_num(p.get("px")) and _steps._is_num(p.get("py")):
                pts.append((float(p["px"]), float(p["py"])))
    return pts


def _direction(p, q) -> str:
    dx, dy = p[0] - q[0], p[1] - q[1]
    if abs(dx) >= abs(dy):
        return "left" if dx < 0 else "right"
    return "up" if dy < 0 else "down"


def free_ends(page: dict, gate_rects: list, pins: list) -> list[dict]:
    """Wolne końce drutów strony: koniec odcinka bez innego odcinka (koniec ≤ CONNECT_TOL albo
    wnętrze ≤ TOUCH_TOL), bez pinu (≤ PIN_TOL) i poza ramkami bramek (+GATE_PAD). Zwraca
    [{x, y, dir, net, seg, length, stub}] posortowane po (y, x); `stub` = krótki odcinek, którego
    drugi koniec jest przy pinie (wyprowadzenie bramki).

    Odcinki ≤ CONNECT_TOL (ręczne „dociągnięcie” końca do kotwicy, np. [1638, 810, 1638, 814])
    nie łączą — koniec zostaje wolny, a jego położenie to dalszy koniec takiego ogonka."""
    segs = page_segments(page)
    tiny = [math.hypot(s[2] - s[0], s[3] - s[1]) <= CONNECT_TOL for s, _n in segs]
    out = []
    for i, (s, name) in enumerate(segs):
        ends = ((s[0], s[1]), (s[2], s[3]))
        length = math.hypot(s[2] - s[0], s[3] - s[1])
        if tiny[i]:
            continue
        for k in (0, 1):
            p, q = ends[k], ends[1 - k]
            hit = False
            for j, (t, _n) in enumerate(segs):
                if j == i:
                    continue
                if tiny[j]:
                    a, b = (t[0], t[1]), (t[2], t[3])
                    for u, v in ((a, b), (b, a)):  # ogonek przy końcu: koniec przesuwa się na jego drugi koniec
                        if _cheb(p, u) <= CONNECT_TOL and math.hypot(v[0] - q[0], v[1] - q[1]) > \
                                math.hypot(p[0] - q[0], p[1] - q[1]):
                            p = v
                    continue
                if _cheb(p, (t[0], t[1])) <= CONNECT_TOL or _cheb(p, (t[2], t[3])) <= CONNECT_TOL:
                    hit = True
                    break
                if _dist_pt_seg(p, t)[0] <= TOUCH_TOL:
                    hit = True
                    break
            if hit:
                continue
            if any(_cheb(p, pp) <= PIN_TOL for pp in pins):
                continue
            if any(r[0] - GATE_PAD <= p[0] <= r[2] + GATE_PAD and r[1] - GATE_PAD <= p[1] <= r[3] + GATE_PAD
                   for r in gate_rects):
                continue
            stub = length <= STUB_MAX and any(_cheb(q, pp) <= PIN_TOL for pp in pins)
            out.append({"x": int(round(p[0])), "y": int(round(p[1])), "dir": _direction(p, q),
                        "net": name, "seg": [int(round(v)) for v in s], "length": round(length, 1),
                        "stub": stub})
    out.sort(key=lambda e: (e["y"], e["x"]))
    # ten sam punkt z dwóch odcinków (dubel) — raz
    uniq: list[dict] = []
    for e in out:
        if not any(_cheb((e["x"], e["y"]), (u["x"], u["y"])) <= 1 and e["dir"] == u["dir"] for u in uniq):
            uniq.append(e)
    return uniq


def ground_bars(page: dict, ends: list[dict]) -> list[dict]:
    """Symbol masy z drutów ③: krótki poziomy odcinek (≤ GND_SEG_MAX), którego oba końce są
    wolne, a w jego wnętrzu (środkowa część) kończy się pionowy drut. Zwraca [{x, y, rot,
    ends: [indeksy w `ends`]}] — punkt = koniec pionowego drutu na kresce."""
    segs = page_segments(page)
    idx = {(e["x"], e["y"]): i for i, e in enumerate(ends)}
    out = []
    for s, _name in segs:
        if abs(s[1] - s[3]) > AXIS_TOL or not (8 <= abs(s[2] - s[0]) <= GND_SEG_MAX):
            continue
        a = (int(round(s[0])), int(round(s[1])))
        b = (int(round(s[2])), int(round(s[3])))
        if a not in idx or b not in idx:
            continue
        lo, hi = min(s[0], s[2]), max(s[0], s[2])
        for t, _n in segs:
            if abs(t[0] - t[2]) > AXIS_TOL or t is s:
                continue
            for p, q in (((t[0], t[1]), (t[2], t[3])), ((t[2], t[3]), (t[0], t[1]))):
                if abs(p[1] - s[1]) <= AXIS_TOL + 1 and lo + 4 <= p[0] <= hi - 4:
                    rot = 180 if q[1] < p[1] else 0  # drut z góry → masa w dół
                    out.append({"x": int(round(p[0])), "y": int(round(s[1])), "rot": rot,
                                "ends": [idx[a], idx[b]]})
    return out


# --------------------------------------------------------------------------- CV

def _window(bw, x, y, d: str, near: int, far: int, half_up: int, half_down: int | None = None):
    """Okno binarnego obrazu za końcem (x, y) w kierunku `d`: wzdłuż [near, far] od końca,
    w poprzek [-half_up, +half_down]. Zwraca (okno, (x0, y0)) w układzie obrazu (przycięte)."""
    hd = half_up if half_down is None else half_down
    if d == "left":
        x0, x1, y0, y1 = x - far, x - near, y - half_up, y + hd
    elif d == "right":
        x0, x1, y0, y1 = x + near, x + far, y - half_up, y + hd
    elif d == "up":
        x0, x1, y0, y1 = x - half_up, x + hd, y - far, y - near
    else:
        x0, x1, y0, y1 = x - half_up, x + hd, y + near, y + far
    H, W = bw.shape[:2]
    cx0, cy0, cx1, cy1 = max(0, int(x0)), max(0, int(y0)), min(W, int(x1) + 1), min(H, int(y1) + 1)
    if cx1 <= cx0 or cy1 <= cy0:
        return bw[0:0, 0:0], (cx0, cy0)
    return bw[cy0:cy1, cx0:cx1], (cx0, cy0)


def _components(win):
    """Składowe 8-spójne: [(x, y, w, h, area)] w układzie okna."""
    import cv2
    import numpy as np

    if win.size == 0:
        return []
    n, _lab, stats, _c = cv2.connectedComponentsWithStats(np.ascontiguousarray(win, dtype=np.uint8), 8)
    return [tuple(int(v) for v in stats[i][:5]) for i in range(1, n)]


def binarize(gray):
    """Tusz = 1 (Otsu, jak cv-wires)."""
    import cv2

    th, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    return (gray <= th).astype("uint8")


def chevron_parts(bw, x: int, y: int, d: str) -> list[tuple]:
    """Wysokie skośne kreski szewronu za końcem poziomego drutu (składowe wys. CHEV_H_MIN…
    CHEV_H_MAX, szer. ≥ CHEV_W_MIN — pionowy drut albo kreska ramki ma szerokość ~3 px — i nie
    przecinające całego okna w pionie)."""
    import cv2
    import numpy as np

    win, _o = _window(bw, x, y, d, CHEV_NEAR, CHEV_FAR, CHEV_HALF)
    if win.size == 0:
        return []
    H = win.shape[0]
    n, lab, stats, _c = cv2.connectedComponentsWithStats(np.ascontiguousarray(win, dtype=np.uint8), 8)
    out = []
    for i in range(1, n):
        cx, cy, w, h, area = (int(v) for v in stats[i][:5])
        if not (CHEV_H_MIN <= h <= CHEV_H_MAX and w >= CHEV_W_MIN and area >= 30):
            continue
        if cy <= 0 and cy + h >= H:
            continue
        # kreski szewronu są skośne: środek tuszu w wierszu przesuwa się z wysokością; pionowy
        # drut (także z doklejoną kreską przerywanej linii albo drutu) ma go w jednym miejscu
        rows = [np.flatnonzero(lab[r] == i) for r in range(cy, cy + h)]
        mids = [float(np.median(c)) for c in rows if c.size]
        if len(mids) < 5 or np.percentile(mids, 90) - np.percentile(mids, 10) < CHEV_SLANT_MIN:
            continue
        out.append((cx, cy, w, h, area))
    return out


def text_parts(bw, x: int, y: int, d: str) -> list[tuple]:
    """Znaki (składowe wys. TEXT_H_MIN…TEXT_H_MAX) za końcem: przy poziomym drucie na wysokości
    drutu (cyfry arkuszy, napis), przy pionowym nad / pod końcem (napis zasilania)."""
    if d in ("left", "right"):
        win, _o = _window(bw, x, y, d, TEXT_NEAR, TEXT_FAR, TEXT_UP, TEXT_DOWN)
        return [c for c in _components(win)
                if TEXT_H_MIN <= c[3] <= TEXT_H_MAX and c[4] >= TEXT_AREA_MIN and c[2] <= 60]
    win, (ox, _oy) = _window(bw, x, y, d, VTEXT_NEAR, VTEXT_FAR, VTEXT_HALF)
    out = []
    for c in _components(win):
        if not (TEXT_H_MIN <= c[3] <= TEXT_H_MAX and c[4] >= TEXT_AREA_MIN and c[2] <= 60):
            continue
        if c[2] <= VTEXT_LINE_W:  # cienka pionowa kreska: przerwany drut / ramka (2-137), nie znak
            continue
        out.append(c)
    # napis zasilania („0V”, „+5V”) ma ≥ 2 znaki — pojedynczy kawałek to zwykle kreska
    return out if sum(c[2] for c in out) >= VTEXT_MIN_WIDTH else []


def ground_bar_at(bw, x: int, y: int, d: str) -> bool:
    """Kreska masy w poprzek końca pionowego drutu: w wierszu blisko końca ciągły poziomy
    odcinek tuszu ≥ GND_RUN_MIN px przez x, wystający ≥ GND_SIDE_MIN po obu stronach i nie
    dłuższy niż GND_RUN_MAX (dłuższy = poziomy drut). Odrzucone (przegląd kr-9p8.28): tusz ZA
    kreską (GND_BEYOND — kółko zacisku „o +5V”, ramka, tekst) i kreska, której końce schodzą
    w pion (róg ramki bramki / tabliczki)."""
    if d not in ("up", "down"):
        return False
    H, W = bw.shape[:2]
    sign = 1 if d == "down" else -1
    for k in range(GND_ROWS[0], GND_ROWS[1] + 1):
        r = y + sign * k
        if not (0 <= r < H):
            continue
        row = bw[r]
        if not any(row[c] for c in range(max(0, x - 2), min(W, x + 3))):
            continue
        c0 = next((c for c in range(max(0, x - 2), min(W, x + 3)) if row[c]), x)
        lo = c0
        while lo - 1 >= 0 and row[lo - 1] and c0 - lo < GND_RUN_MAX + 2:
            lo -= 1
        hi = c0
        while hi + 1 < W and row[hi + 1] and hi - c0 < GND_RUN_MAX + 2:
            hi += 1
        run = hi - lo + 1
        if not (GND_RUN_MIN <= run <= GND_RUN_MAX and x - lo >= GND_SIDE_MIN and hi - x >= GND_SIDE_MIN):
            continue
        # grubość kreski (wiersze tuszu przez x w dalszą stronę)
        t = 0
        while 0 <= r + sign * (t + 1) < H and bw[r + sign * (t + 1)][x] and t < 8:
            t += 1
        r_end = r + sign * t
        x0, x1 = max(0, lo - 2), min(W, hi + 3)
        beyond = [r_end + sign * q for q in range(GND_BEYOND[0], GND_BEYOND[1] + 1)]
        if any(0 <= rr < H and bw[rr][x0:x1].any() for rr in beyond):
            return False
        back = [r - sign * q for q in range(4, 11)]  # strona drutu: końce kreski nie schodzą w pion
        for cc in (lo, hi):
            c_a, c_b = max(0, cc - 2), min(W, cc + 3)
            if any(0 <= rr < H and bw[rr][c_a:c_b].any() for rr in back):
                return False
        return True
    return False


def in_title_block(x: float, y: float, shape) -> bool:
    """Tabliczka rysunkowa (prawy dolny róg, jak cv-wires TITLE): x ≥ 0,66 W i y ≥ 0,76 H."""
    H, W = shape[:2]
    return x >= TITLE_FRAC[0] * W and y >= TITLE_FRAC[1] * H


def classify_end(bw, e: dict, gate_rects=()) -> dict:
    """Rodzaj końca z obrazu: {'kind': 'port'|'xref'|'power'|'ground'|None, 'cv': {...}}.
    Pionowy koniec: najpierw napis (zasilanie do odczytu), dopiero bez napisu kreska masy —
    kandydat, który i tak potwierdza model (POWER_PROMPT, pole `ground`). Zasilania i masy nie ma
    w tabliczce rysunkowej, kreski masy nie ma przy ramce bramki."""
    x, y, d = int(e["x"]), int(e["y"]), e["dir"]
    if d in ("left", "right"):
        chev = chevron_parts(bw, x, y, d)
        if chev:
            return {"kind": "port", "cv": {"chevron": [list(c) for c in chev]}}
        txt = text_parts(bw, x, y, d)
        if txt:
            return {"kind": "xref", "cv": {"text": [list(c) for c in txt]}}
        return {"kind": None, "cv": {}}
    if in_title_block(x, y, bw.shape):
        return {"kind": None, "cv": {"title_block": True}}
    txt = text_parts(bw, x, y, d)
    if txt:
        return {"kind": "power", "cv": {"text": [list(c) for c in txt]}}
    near_gate = any(r[0] - GND_GATE_PAD <= x <= r[2] + GND_GATE_PAD and r[1] - GND_GATE_PAD <= y <= r[3] + GND_GATE_PAD
                    for r in gate_rects)
    if not near_gate and ground_bar_at(bw, x, y, d):
        return {"kind": "ground", "cv": {"bar": True}}
    return {"kind": None, "cv": {"near_gate": True} if near_gate else {}}


# --------------------------------------------------------------------------- kadry

def port_tip(x: float, y: float, side: str, pid: str = "A10") -> tuple[int, int]:
    """Grot portu (port.x/y), którego otwarty koniec (PortLayer / `_steps._port_open_end`) leży
    w (x, y) — końcu drutu. Szerokość szewronu zależy od długości `connector+pin`."""
    bw = max(60, len(pid) * 16 + 12) + 16
    return (int(round(x - bw)), int(round(y))) if side == "left" else (int(round(x + bw)), int(round(y)))


def xref_sheets_box(x: float, y: float, gap_up=None, gap_down=None):
    """Odsyłacz przy lewej krawędzi: kolumna numerów arkuszy PRZED końcem drutu (75 px w lewo,
    6 px w prawo). Zwraca (bbox, keep_rows): widoczny tylko pas wiersza — połowa odstępu do
    sąsiednich wierszy minus 2 px (najwyżej 14, co najmniej 8), reszta zamalowana."""
    x, y = int(round(x)), int(round(y))

    def half(g):  # 2-61 (wiersze co 24–29 px): przy ±16 resztki cyfr sąsiadów dawały [1, 8]
        return 14 if g is None else max(8, min(14, int(g) // 2 - 2))

    return (x - XREF_LEFT_SHEETS[0], y - 30, x + XREF_LEFT_SHEETS[1], y + 30), (y - half(gap_up), y + half(gap_down))


def xref_label_box(x: float, y: float, gap_up=None):
    """Odsyłacz przy lewej krawędzi: etykieta nad drutem (od 4 px przed końcem do 200 px
    w prawo). Widoczne od drutu wiersza wyżej (+4 px) do 2 px pod własnym drutem — etykieta
    wiersza niżej i numery sąsiadów zamalowane."""
    x, y = int(round(x)), int(round(y))
    up = 34 if gap_up is None else max(14, min(34, int(gap_up) - 4))
    return (x - 4, y - 34, x + XREF_LEFT_LABEL, y + 8), (y - up, y + 2)


def power_crop_box(x: float, y: float, d: str) -> tuple[int, int, int, int]:
    x, y = float(x), float(y)
    if d == "up":
        return (round(x - POWER_HALF), round(y - POWER_FAR), round(x + POWER_HALF), round(y + POWER_BACK))
    if d == "down":
        return (round(x - POWER_HALF), round(y - POWER_BACK), round(x + POWER_HALF), round(y + POWER_FAR))
    if d == "left":
        return (round(x - POWER_FAR - 40), round(y - 30), round(x + POWER_BACK), round(y + 16))
    return (round(x - POWER_BACK), round(y - 30), round(x + POWER_FAR + 40), round(y + 16))


def side_of(d: str) -> str:
    return {"left": "left", "right": "right", "up": "top", "down": "bottom"}[d]


# --------------------------------------------------------------------------- normalizacja

def norm_power(s) -> str | None:
    """Napis zasilania → typ jak w danych ('+5V', '+0V', '-12V'); spoza wzorca → None."""
    t = _vlm.norm_text(s).upper().replace("O", "0") if s is not None else ""
    m = POWER_RE.fullmatch(t)
    if not m:
        return None
    sign = m.group(1) or "+"
    val = m.group(2).replace(",", ".")
    return f"{sign}{val}V"


def parse_conn(s) -> tuple[str, int | None]:
    """'B22' / 'B 22' / 'b022' → ('B', 22); nieparsowalne → (litery, None)."""
    t = _vlm.norm_conn(s)
    m = re.fullmatch(r"([A-Z])(\d+)", t)
    if m:
        return m.group(1), int(m.group(2))
    lett = re.sub(r"[^A-Z]", "", t)[:1]
    return lett, None


def variants(label: str) -> set[str]:
    """Etykiety różniące się jedną pomyłką z CONFUSABLE (także 11 ↔ H)."""
    out: set[str] = set()
    for i, c in enumerate(label):
        for alt in CONFUSABLE.get(c, ()):
            out.add(label[:i] + alt + label[i + 1:])
        if label[i:i + 2] == "11":
            out.add(label[:i] + "H" + label[i + 2:])
    out.discard(label)
    return out


# --------------------------------------------------------------------------- samokorekta

class LabelContext:
    """Wiedza pakietu do samokorekty kroku ④ (bez I/O — auto.py wczytuje strony).

    sheets       numer arkusza → id strony (package.yaml pages[].sheet)
    own_sheet    numer arkusza tej strony (None — strona bez `sheet`)
    other_pages  id strony → {'ports': [...], 'cross_refs': [...]} INNYCH stron pakietu
    connectors   litery złączy znane w pakiecie: z portów `other_pages` ∪ podane (backplane
                 projektu); puste = nic nie wiadomo → każda litera A–Z bez flagi
    backplane    zbiór 'A50' z project.backplane dla tego pakietu (pusty = nie sprawdzamy)
    """

    def __init__(self, sheets: dict[int, str], own_sheet: int | None, other_pages: dict[str, dict],
                 connectors=(), backplane: set[str] | None = None):
        self.sheets = sheets
        self.own_sheet = own_sheet
        self.other_pages = other_pages
        self.connectors = {str(c).strip().upper() for c in connectors if str(c).strip()}
        for pg in other_pages.values():
            for prt in _steps.list_of(pg.get("ports")):
                if isinstance(prt, dict) and not _steps._blank(prt.get("connector")):
                    self.connectors.add(str(prt["connector"]).strip().upper())
        self.backplane = backplane or set()
        self.labels: set[str] = set()
        self.port_labels: dict[str, set[tuple[str, str]]] = {}
        for pid, pg in other_pages.items():
            for el in _steps.list_of(pg.get("ports")) + _steps.list_of(pg.get("cross_refs")):
                if isinstance(el, dict) and not _steps._blank(el.get("label")):
                    self.labels.add(_vlm.norm_label(el["label"]))
            for p in _steps.list_of(pg.get("ports")):
                if isinstance(p, dict) and not _steps._blank(p.get("connector")) and _steps._is_num(p.get("pin")):
                    key = f"{str(p['connector']).strip().upper()}{int(p['pin'])}"
                    self.port_labels.setdefault(key, set()).add((pid, _vlm.norm_label(p.get("label"))))

    def xref_labels_on(self, sheet: int) -> set[str] | None:
        """Etykiety odsyłaczy na stronie arkusza `sheet` (None — strony nie ma albo nie ma na
        niej żadnego opisanego odsyłacza, czyli nie ma z czym porównać)."""
        pid = self.sheets.get(sheet)
        pg = self.other_pages.get(pid) if pid else None
        if not pg:
            return None
        labs = {_vlm.norm_label(c["label"]) for c in _steps.list_of(pg.get("cross_refs"))
                if isinstance(c, dict) and not _steps._blank(c.get("label"))}
        return labs or None


def _label_why(label: str, ctx: LabelContext) -> list[str]:
    why = []
    if not label:
        return ["LABEL_EMPTY: nie odczytano etykiety"]
    if not LABEL_RE.fullmatch(label):
        why.append(f"LABEL_FORMAT: etykieta „{label}” nie zaczyna się od + / −")
    if ctx.labels and label not in ctx.labels:
        near = sorted(variants(label) & ctx.labels)
        if near:
            why.append(f"LABEL_CONFUSABLE: „{label}” — na innych stronach pakietu jest {', '.join(near)}")
    return why


def check_port(read: dict, ctx: LabelContext) -> dict:
    """Odczyt portu ({conn, label} z _vlm.to_pred) → {connector, pin, label, why}."""
    letter, pin = parse_conn(read.get("conn"))
    label = read.get("label") or ""
    why = []
    if not letter and pin is None:
        why.append("CONN_EMPTY: nie odczytano złącza")
    elif pin is None or not re.fullmatch(r"[A-Z]", letter) or not (1 <= pin <= PIN_MAX):
        why.append(f"CONN_INVALID: złącze „{read.get('conn')}” (litera A–Z + styk 1…{PIN_MAX})")
    elif ctx.connectors and letter not in ctx.connectors:
        why.append(f"CONN_UNKNOWN: litery {letter} nie ma w pakiecie (są {'/'.join(sorted(ctx.connectors))})")
    conn = f"{letter}{pin}" if pin is not None else ""
    if conn and ctx.backplane and conn not in ctx.backplane:
        why.append(f"PORT_NOT_ON_BACKPLANE: {conn} nie ma w backplane projektu dla tego pakietu")
    if label:
        why += _label_why(label, ctx)
    else:
        why.append("LABEL_EMPTY: port bez etykiety (bywa: drut opisany raz przy innym porcie)")
    other = ctx.port_labels.get(conn, set()) if conn else set()
    diff = sorted((pid, lab) for pid, lab in other if lab != label)
    if diff:
        why.append(f"CONN_OTHER_PAGE: {conn} jest też na " +
                   ", ".join(f"{pid} ({lab or 'bez etykiety'})" for pid, lab in diff))
    return {"connector": letter, "pin": pin, "label": label, "why": why}


def check_xref(read: dict, ctx: LabelContext) -> dict:
    """Odczyt odsyłacza ({label, pages}) → {label, pages: [str], why}."""
    label = read.get("label") or ""
    sheets = sorted(set(int(s) for s in (read.get("pages") or [])))
    why = _label_why(label, ctx)
    if not sheets:
        why.append("SHEETS_EMPTY: nie odczytano numerów arkuszy")
    for s in sheets:
        if ctx.own_sheet is not None and s == ctx.own_sheet:
            why.append(f"SHEET_SELF: arkusz {s} to ta strona")
        elif s not in ctx.sheets:
            why.append(f"SHEET_UNKNOWN: arkusza {s} nie ma w package.yaml "
                       f"(są {min(ctx.sheets) if ctx.sheets else '-'}…{max(ctx.sheets) if ctx.sheets else '-'})")
        elif label:
            there = ctx.xref_labels_on(s)
            if there is not None and label not in there:
                near = sorted(variants(label) & there)
                why.append(f"XREF_NO_RETURN: na arkuszu {s} ({ctx.sheets[s]}) nie ma odsyłacza „{label}”"
                           + (f" — jest {', '.join(near)}" if near else ""))
    return {"label": label, "pages": [str(s) for s in sheets], "why": why}


def check_power(label: str) -> dict:
    t = norm_power(label)
    if t is None:
        return {"type": None, "why": [f"POWER_UNKNOWN: „{label}” to nie napis zasilania"]}
    return {"type": t, "why": []}


# --------------------------------------------------------------------------- scalanie

KINDS = (("ports", "port"), ("cross_refs", "cross_ref"), ("power", "power"))
KEY_OF = {kind: key for key, kind in KINDS}
_PROTECTED = ("approved", "stale")


def anchor(kind: str, el: dict) -> tuple[float, float] | None:
    """Punkt, w którym element dotyka drutu: otwarty koniec portu, odsyłacz / zasilanie x, y."""
    if kind == "port":
        return _steps._port_open_end(el)
    if _steps._finite(el.get("x")) and _steps._finite(el.get("y")):
        return (float(el["x"]), float(el["y"]))
    return None


def element_mode(page: dict, kind: str, el: Any) -> str:
    """'fill' — aspekt etykiety cały pusty (także element ludzki); 'replace' — własny wynik
    kroku (src 'auto', net pusty albo 'auto' z niezatwierdzonego ⑤); 'keep' — reszta."""
    if not isinstance(el, dict):
        return "keep"
    if _steps.aspect_empty(kind, el, "src"):
        return "fill"
    if _steps.element_src(el, "src") != "auto":
        return "keep"
    if _steps.aspect_empty(kind, el, "net_src"):
        return "replace"
    if _steps.element_src(el, "net_src") == "auto" and _steps.step_status(page, "nets") not in _PROTECTED:
        return "replace"
    return "keep"


def claim_dist(a, e: dict) -> float | None:
    """Odległość kotwicy elementu od wolnego końca, gdy element może zająć ten koniec: wzdłuż
    drutu ≤ CLAIM_ALONG, w poprzek ≤ CLAIM_ACROSS (ręczne odsyłacze bywają 25–35 px od końca
    drutu z ③, a wiersze leżą co ≥ 25 px); inaczej None."""
    dx, dy = abs(a[0] - e["x"]), abs(a[1] - e["y"])
    along, across = (dx, dy) if e["dir"] in ("left", "right") else (dy, dx)
    if along > CLAIM_ALONG or across > CLAIM_ACROSS:
        return None
    return along + 2 * across


def label_plan(page: dict, ends: list[dict], human_filled=()) -> dict:
    """Co krok ④ robi na stronie:
      keep     {key: [idx]} — elementy, które zostają (ludzkie, chronione, z pustym aspektem);
      replace  {key: [idx]} — własne `auto`; nowy udany odczyt ich końca je zastępuje; bez niego
               znikają (FREE_END, pusty odczyt, brak końca), poza błędem modelu (zostają) i poza
               elementami ludzkiego pochodzenia — `human_filled` z poprzedniego snapshotu ④ (pusty
               aspekt wypełniony przez krok, potem `src: auto`): te zostają zawsze;
      human_origin {(key, idx)} — które z `replace` są ludzkiego pochodzenia;
      fill     [(key, idx, end|None)] — pusty aspekt, odczyt końca, przy którym stoi;
      refresh  [(key, idx, end|None)] — końce elementów `replace`;
      claimed  {end: (key, idx)} — koniec zajęty przez element (każdy koniec raz);
      targets  [end] — końce do klasyfikacji i odczytu: wolne + zajęte przez `replace`."""
    plan = {"keep": {}, "replace": {}, "fill": [], "refresh": [], "claimed": {}, "targets": [],
            "human_origin": set()}
    hf = {(str(k), v[0], v[1]) for k, *v in human_filled if len(v) == 2}
    anchors: list[tuple[str, int, tuple[float, float], str]] = []
    for key, kind in KINDS:
        plan["keep"][key] = []
        plan["replace"][key] = []
        for i, el in enumerate(_steps.list_of(page.get(key))):
            m = element_mode(page, kind, el)
            plan["replace" if m == "replace" else "keep"][key].append(i)
            if m == "replace" and isinstance(el, dict) and (kind, el.get("x"), el.get("y")) in hf:
                plan["human_origin"].add((key, i))
            a = anchor(kind, el) if isinstance(el, dict) else None
            if a is not None:
                anchors.append((key, i, a, m))
    # każda kotwica zajmuje najbliższy wolny koniec, każdy koniec raz; najpierw elementy, które
    # zostają (ludzkie), potem własne auto
    pairs = sorted((0 if m != "replace" else 1, d, n, j) for n, (_k, _i, a, m) in enumerate(anchors)
                   for j, e in enumerate(ends) if (d := claim_dist(a, e)) is not None)
    used_a, used_e = set(), set()
    for _pr, _d, n, j in pairs:
        if n in used_a or j in used_e:
            continue
        used_a.add(n)
        used_e.add(j)
        key, i, _a, _m = anchors[n]
        plan["claimed"][j] = (key, i)
    by_el = {v: j for j, v in plan["claimed"].items()}
    for key, i, _a, m in anchors:
        if m == "fill":
            plan["fill"].append((key, i, by_el.get((key, i))))
        elif m == "replace":
            plan["refresh"].append((key, i, by_el.get((key, i))))
    for key in plan["replace"]:  # auto bez położenia — też zostaje (bez końca)
        for i in plan["replace"][key]:
            if not any(k == key and ii == i for k, ii, _j in plan["refresh"]):
                plan["refresh"].append((key, i, None))
    refresh_ends = {j for _k, _i, j in plan["refresh"] if j is not None}
    plan["targets"] = [j for j in range(len(ends)) if j not in plan["claimed"] or j in refresh_ends]
    return plan


def new_port(end: dict, chk: dict) -> dict:
    side = side_of(end["dir"])
    pid = f"{chk['connector']}{chk['pin'] if chk['pin'] is not None else ''}"
    x, y = port_tip(end["x"], end["y"], side, pid)
    out = {"connector": chk["connector"], "pin": chk["pin"] if chk["pin"] is not None else 0,
           "label": chk["label"], "net": "", "x": x, "y": y, "side": side, "src": "auto"}
    return out


def new_xref(end: dict, chk: dict) -> dict:
    return {"label": chk["label"], "pages": chk["pages"], "net": "", "x": end["x"], "y": end["y"],
            "side": side_of(end["dir"]), "src": "auto"}


def new_power(end: dict, ptype: str, rot: int | None = None) -> dict:
    r = ROT_BY_DIR[end["dir"]] if rot is None else rot
    out = {"type": ptype, "x": end["x"], "y": end["y"], "net": ""}
    if r:
        out["rotation"] = r
    out["src"] = "auto"
    return out


def _apply_fill(el: dict, kind: str, new: dict) -> None:
    """Pusty aspekt etykiety elementu (ludzkiego też) dostaje odczyt; położenie zostaje."""
    if kind == "port":
        for f in ("connector", "pin", "label"):
            el[f] = new[f]
        el.setdefault("side", new["side"])
    elif kind == "cross_ref":
        el["label"], el["pages"] = new["label"], new["pages"]
        el.setdefault("side", new["side"])
    else:
        el["type"] = new["type"]
    el["src"] = "auto"


def uncertain_entry(kind: str, el: dict | None, end: dict | None, why: list[str]) -> dict:
    """Wpis `steps.labels.uncertain`: {kind, label, x, y, why} (port także `conn`); klucz =
    położenie elementu (port: grot), a bez elementu (błąd modelu, pusty odczyt, wolny koniec)
    — koniec drutu (`kind: end`, gdy nie wiadomo, co tam jest)."""
    if el is not None:
        lab = el.get("type") if kind == "power" else el.get("label")
        out = {"kind": kind, "label": "" if lab is None else str(lab), "x": el.get("x"), "y": el.get("y")}
        if kind == "port":
            out["conn"] = f"{el.get('connector') or ''}{el.get('pin') if el.get('pin') else ''}"
        out["why"] = list(why)
        return out
    return {"kind": kind, "label": "", "x": end["x"], "y": end["y"], "why": list(why)}


def merge_labels(page: dict, ends: list[dict], plan: dict, results: dict[int, dict]) -> tuple[dict, dict, list]:
    """Nowe listy `ports` / `cross_refs` / `power` + liczniki + niepewne. Nie mutuje `page`.

    `results`: indeks końca → {kind: 'port'|'cross_ref'|'power'|None, el: nowy element albo
    None, why: [...], error: bool, empty: bool, ground: bool} (z auto.py).
    - koniec zajęty przez element z pustym aspektem (`plan['fill']`): udany odczyt go wypełnia;
    - koniec elementu `auto` (`plan['refresh']`): udany odczyt go zastępuje (w miejscu, gdy ten
      sam rodzaj); bez potwierdzenia (FREE_END, pusty, brak końca) element znika, przy błędzie
      modelu zostaje (`PREVIOUS_KEPT`); element ludzkiego pochodzenia (`plan['human_origin']`)
      zostaje zawsze (`PREVIOUS_KEPT` / `NO_WIRE_END`). `counts['human_filled']` = takie
      elementy po scaleniu (do snapshotu);
    - wolny koniec: nowy element.
    Nowy element `auto` ≤ NEAR_EXISTING od ludzkiego elementu tego rodzaju → `NEAR_EXISTING`."""
    out: dict[str, list] = {}
    fills = {(key, i): j for key, i, j in plan["fill"] if j is not None}
    refresh = {(key, i): j for key, i, j in plan.get("refresh", [])}
    uncertain: list[dict] = []
    counts = {"ends": len(ends), "targets": len(plan["targets"]),
              "claimed": len(plan["claimed"]) - sum(1 for j in refresh.values() if j is not None),
              "replaced": 0, "kept_auto": 0, "removed_auto": 0,
              "kept": sum(len(v) for v in plan["keep"].values()), "filled": 0,
              "ports": 0, "cross_refs": 0, "power": 0, "ground": 0, "uncertain": 0, "errors": 0,
              "empty_reads": 0, "unexplained": 0, "stubs": sum(1 for e in ends if e.get("stub"))}
    new_by_key: dict[str, list[dict]] = {"ports": [], "cross_refs": [], "power": []}
    fresh: list[tuple[str, dict]] = []  # (key, element) nowych / zastąpionych odczytów
    origin: list[tuple[str, dict]] = []  # elementy ludzkiego pochodzenia z `src: auto` (wypełnione)

    def add_new(kind, el, res, end):
        new_by_key[KEY_OF[kind]].append(el)
        fresh.append((KEY_OF[kind], el))
        counts[KEY_OF[kind]] += 1
        counts["ground"] += 1 if res.get("ground") else 0
        if res.get("why"):
            uncertain.append(uncertain_entry(kind, el, end, res["why"]))

    for j, res in sorted(results.items()):
        counts["errors"] += 1 if res.get("error") else 0
        counts["empty_reads"] += 1 if res.get("empty") else 0
        if j in plan["claimed"]:
            continue  # wynik dla elementu (pusty aspekt / auto do odświeżenia) — niżej
        end = ends[j] if 0 <= j < len(ends) else res.get("at")
        if res.get("el") is not None and res.get("kind"):
            add_new(res["kind"], res["el"], res, end)
        elif res.get("why"):
            uncertain.append(uncertain_entry(res.get("kind") or "end", None, end, res["why"]))
    for key, kind in KINDS:
        old = _steps.list_of(page.get(key))
        replace = set(plan["replace"][key])
        kept = []
        for i, el0 in enumerate(old):
            el = copy.deepcopy(el0)
            if i in replace:
                j = refresh.get((key, i))
                res = results.get(j) if j is not None else None
                human = (key, i) in plan.get("human_origin", set())
                if res and res.get("el") is not None and res.get("kind"):
                    counts["replaced"] += 1
                    if human and res["kind"] == kind:
                        origin.append((kind, res["el"]))
                    if res["kind"] == kind:  # ten sam rodzaj — w tym samym miejscu listy
                        kept.append(res["el"])
                        fresh.append((key, res["el"]))
                        counts[key] += 1
                        counts["ground"] += 1 if res.get("ground") else 0
                        if res.get("why"):
                            uncertain.append(uncertain_entry(kind, res["el"], ends[j], res["why"]))
                    else:
                        add_new(res["kind"], res["el"], res, ends[j])
                    continue
                if not human and not (res and res.get("error")):
                    counts["removed_auto"] += 1  # własny wynik bez potwierdzenia (FREE_END, pusty, brak końca)
                    continue
                counts["kept_auto"] += 1
                if human:
                    origin.append((kind, el))
                why = list(res.get("why") or []) if res else []
                why.append("PREVIOUS_KEPT: nowy odczyt nieudany — poprzedni wynik kroku zostaje" if j is not None
                           else "NO_WIRE_END: element bez wolnego końca drutu (druty zmienione?) — zostaje")
                if isinstance(el, dict):
                    uncertain.append(uncertain_entry(kind, el, ends[j] if j is not None else None, why))
                kept.append(el)
                continue
            j = fills.get((key, i))
            res = results.get(j) if j is not None else None
            if isinstance(el, dict) and res and res.get("el") is not None and res.get("kind") == kind:
                _apply_fill(el, kind, res["el"])
                counts["filled"] += 1
                origin.append((kind, el))
                if res.get("why"):
                    uncertain.append(uncertain_entry(kind, el, None, res["why"]))
            elif res and res.get("why"):
                uncertain.append(uncertain_entry(kind, None, ends[j], res["why"]))
            kept.append(el)
        out[key] = kept
    for key in out:
        out[key] = out[key] + sorted(new_by_key[key], key=lambda e: (e["y"], e["x"]))

    def flag(key, el, code):
        kind = dict((k, v) for k, v in KINDS)[key]
        u = next((u for u in uncertain if u["kind"] == kind and u["x"] == el.get("x") and u["y"] == el.get("y")), None)
        if u is None:
            u = uncertain_entry(kind, el, None, [])
            uncertain.append(u)
        if code not in u["why"]:
            u["why"].append(code)

    # to samo złącze dwa razy na stronie (dotyczy nowych odczytów)
    seen = Counter(f"{p.get('connector')}{p.get('pin')}" for p in out["ports"]
                   if isinstance(p, dict) and not _steps._blank(p.get("connector")) and p.get("pin"))
    for key, el in fresh:
        if key == "ports" and el.get("pin") and seen[f"{el.get('connector')}{el.get('pin')}"] > 1:
            flag(key, el, f"CONN_DUPLICATE: {el.get('connector')}{el.get('pin')} jest na stronie więcej niż raz")
    # nowy auto tuż obok ludzkiego tego samego rodzaju — prawdopodobny dubel
    for key, el in fresh:
        kind = dict(KINDS)[key]
        a = anchor(kind, el)
        for i in plan["keep"][key]:
            h = _steps.list_of(page.get(key))[i]
            if not isinstance(h, dict) or _steps.element_src(h, "src") == "auto":
                continue
            b = anchor(kind, h)
            if a and b and _cheb(a, b) <= NEAR_EXISTING:
                lab = h.get("type") if kind == "power" else h.get("label")
                flag(key, el, f"NEAR_EXISTING: obok ludzki {kind} „{lab or ''}” ({h.get('x')},{h.get('y')}) — dubel?")
                break
    counts["uncertain"] = len(uncertain)
    counts["unexplained"] = sum(1 for u in uncertain if u["kind"] == "end"
                                and any(w.startswith("FREE_END") for w in u["why"]))
    uncertain.sort(key=lambda u: (u["y"], u["x"]))
    counts["human_filled"] = [[k, e.get("x"), e.get("y")] for k, e in origin if isinstance(e, dict)]
    return out, counts, uncertain
