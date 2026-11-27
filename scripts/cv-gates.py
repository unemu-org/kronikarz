#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["opencv-python-headless", "numpy", "pyyaml"]
# ///
"""SPIKE (kr-9p8.3): prostokąty bramek ze skanu klasycznym CV (bez modelu).

Pytanie spike'a: czy bramki (pojedyncze, stosy, złożone układy z kolumnami, elementy
bierne) da się znaleźć z samej geometrii ramek tak dobrze, żeby potok nie potrzebował
detektora uczonego (YOLO). Wyniki: docs/auto-digitalizacja.md, „Wyniki: bramki (kr-9p8.3)”.

Usage:
  uv run scripts/cv-gates.py --scan <skan.jpg> --out <kandydat.sch.yaml>
                             [--overlay <png>] [--page 2-58 --package P-R3-2]
                             [--set NAZWA=wartość ...]

Idea: grubość ramki NIE jest kryterium (na SM-POSE11 ramki mają ~1,6 px, tyle co druty;
poprzedni tryb (b) cv-wires.py szukał grubych kresek). Kryterium jest topologia:
  - bramka to prostokąt z czterech długich linii (tekst w środku nie przeszkadza — znaki są
    krótsze niż LINE_L i znikają z map linii);
  - jej zewnętrzne narożniki są „czyste” — linie ramki kończą się w narożniku; prostokąty
    utworzone przez druty (także oparte o ścianę układu) i kratka tabliczki mają
    w narożnikach skrzyżowania i T (linie biegną dalej);
  - do boków dochodzą druty (piny: tusz od ściany łączący się z dowolną linią albo prosta
    linia w pasie), z co najmniej dwóch stron (wejścia i wyjście); ramka numeru arkusza
    i opisy nie mają.

Potok:
  1. Binaryzacja (max(Otsu, THR)), pomiar `sw` (jak cv-wires.py), kółka negacji (małe
     okrągłe dziury tła) wypełnione — kółko w narożniku albo na boku przerywa ramkę.
  2. Mapy linii H i V: otwarcie LINE_L, domknięcie LINE_GAP wzdłuż. Osobne mapy pinów
     z poszerzeniem w poprzek (PIN_WOBBLE) i domknięciem (PIN_GAP) — blady, przerywany drut.
  3. Kandydaci: para odcinków (góra/dół albo lewy/prawy) o zgodnych końcach (END_TOL
     + SKEW * odległość, skos skanu), dwa pozostałe boki ciągłe w pasie WALL_BAND, który
     idzie za skosem (pokrycie >= SIDE_COV, przerwa <= SIDE_GAP). Położenie ścian bocznych
     = najlepiej pokryta linia w pasie.
  4. Odrzucenie (kod powodu, overlay — przerywana linia):
       size    — rozmiar poza GATE_* / PAS_* / BLOCK_HMAX (ramka strony, tabliczka);
       corner  — mniej niż CORNERS_MIN czystych narożników (sonda na linii ściany za
                 narożnikiem; prostokąty z drutów, kratka tabliczki);
       pins    — mniej niż PINS_MIN pinów albo piny tylko z jednej strony;
       leads   — element bierny bez dokładnie jednego wyprowadzenia na każdym krótkim boku;
       overlap — przykryta (> OVERLAP_MAX, także zawarta) przez przyjętą.
     Kandydaci od największego, więc cały stos wygrywa z kawałkami.
  5. Podział bloku na bramki: poziome cięcie, gdy linie pokrywają >= CUT_FRAC szerokości
     wnętrza (stos 7404: 100 %; stos 74170 M56/M57 ~80 %; przegródki kolumny etykiet albo
     A/B/C/D w 74175: 20–50 %). Kawałek bez pinu albo niższy niż GATE_HMIN traci słabsze
     cięcie (podpis „M65” przyklejony do ściany daje cięcie ~0,6 tuż nad przegródką 1,0).
     Złożony układ (74170/74175/K565) = JEDNA bramka, tak jak we wzorcu (M47/M48/M56/M57
     to po jednej bramce A z 14 pinami).
  6. Klasy: `gate`, `composite` (>= 2 wewnętrzne pionowe ściany przez >= CUT_FRAC wysokości
     albo wysokość >= COMP_H — także wysoka 7430), `passive` (mały płaski prostokąt
     z jednym wyprowadzeniem na każdym krótkim boku: rezystor; kondensatory nie).
  7. Kandydaci pinów (`cv_pins`, side/px/py): druty przy bokach. Pole spoza schematu — nie
     trafia do `pins`, żeby nie psuć metryk pinów eval-digitize (brak numerów).

Wynik YAML: `gates: [{ref: "?", gate: null, x, y, w, h, rotation: 0, pins: [],
verified: false, cv_class, cv_pins}]` — ref i literę czyta później VLM. Elementy bierne
też są w `gates` (model danych: Gate z gate: null).

Strojone na P-R3-2 2-58/2-59 + ogląd P-X3-2 2-1; 2-60/2-61/2-63 = held-out. v1 (ślepy
wynik) zamrożona przed held-out i stronami spoza P-R3-2; wersja końcowa stroiła się także po
obejrzeniu 2-63, JPP-16-18 2-115, SM-POSE11 2-97, P-M3-2 2-13 i I-SK1-1 2-87; v3 (po
recenzji) także po P-D3-2 2-31, SPP-32-16 2-142, P-A3-2 2-72, P-P3-2 2-46 i PPS-32 2-150
(zob. docs).
"""
from __future__ import annotations

import argparse
import ast
import sys
import time
from pathlib import Path

import cv2
import numpy as np
import yaml

PARAMS = dict(
    THR=190,             # próg tuszu (max z Otsu) — blade ramki
    SW=None,             # grubość kreski; None = mierzona
    SW_PROBE_LEN=61, SW_MAX_RUN=15, SW_REF=2.2,
    # --- obraz linii (200 dpi; znak ~16 px)
    LINE_L=25,           # minimalna długość linii ramki (znak < LINE_L)
    PIN_WOBBLE=3,        # mapy linii dla pinów: poszerzenie w poprzek przed otwarciem — blady
                         #  drut 1 px z przerwami 1 px (I-SK1-1 2-87, szarość 168–206 w dziurach)
                         #  ginie w otwarciu; dla ramek NIE (pionowe kreski tekstu poszerzone
                         #  w poziomie sklejają się w fałszywe ściany i cięcia, P-M3-2)
    PIN_GAP=3,           # ... i domknięcie wzdłuż przed otwarciem (przerywany blady drut
                         #  I-SK1-1 2-87 G2 wyjście 2); dla ramek NIE — na 2-58/2-59 domknięcie
                         #  2 px skleja podpisy „M58” w fałszywe cięcia i daje „piny” ramce
                         #  numeru arkusza
    LINE_GAP=4,          # domknięcie wzdłuż linii (przerwy ze skanu)
    BUB_AMIN=8, BUB_AMAX=200,  # kółko negacji: pole dziury (wnętrze ~4–14 px średnicy)
    BUB_ASPECT=1.5, BUB_EXTENT=0.5,
    BUB_RING=1.5,        # promień wypełnienia = pół boku dziury + BUB_RING * sw
    # --- ramki
    SEG_SPLIT=1.5,       # składowa grubsza niż SEG_SPLIT * sw + 2 = linie sklejone tekstem
    END_TOL=6,           # zgodność końców pary odcinków (góra/dół albo lewy/prawy) ...
    SKEW=0.012,          # ... + SKEW * odległość między nimi: skos skanu ~1 % (2-63 stos
                         #  M31/M30/M42, 960 px: końce góry i dołu rozjechane o 9 px)
    WALL_BAND=None,      # pas boku w poprzek; None = round(2 sw + 3)
    SIDE_COV=0.9,        # pozostałe dwa boki: pokrycie tuszem ...
    SIDE_WOBBLE=False,   # boki poprzeczne na mapach pinów (PIN_WOBBLE/PIN_GAP). True ratuje
                         #  bladą, falującą ramkę (SPP-32-16 2-142: +8 bramek 7400), ale z pinami
                         #  z domknięcia daje ramki w dużym tekście tabliczki/numeru arkusza
                         #  (+1 FP na 2-61, P-X3-2 2-1, JPP 2-115) — zob. docs
    SIDE_GAP=16,         # ... i najdłuższa przerwa (2-63 M18: prawy bok ma 14 px bladej przerwy)
    # --- blok / bramka (wymiary zewnętrzne)
    GATE_WMIN=30, GATE_WMAX=200,
    GATE_HMIN=40, GATE_HMAX=700,
    BLOCK_HMAX=1500,
    # --- narożniki
    CORNER_E=14,         # długość sondy przedłużenia boku za narożnikiem
    CORNER_OFF=3,        # sonda zaczyna się tyle px za zewnętrzną krawędzią
    CORNER_FRAC=0.6,     # udział tuszu w sondzie = linia biegnie dalej
    CORNERS_MIN=3,
    # --- piny
    PIN_NEAR=6,          # pas sondy pinów: od PIN_NEAR ... (kółko negacji jest wypełnione,
    PIN_FAR=20,          # ... do PIN_FAR px od zewn. krawędzi; JPP M18: wyjście W = kółko
                         #  + 20 px drutu i zakręt — pas 14–28 go nie widział)
    PIN_FRAC=0.85,       # udział tuszu linii w pasie
    PIN_TEXT_WIN=8,      # długi bok elementu biernego: pin nie w gęstym tekście — okno
                         #  +- PIN_TEXT_WIN wzdłuż boku,
    PIN_TEXT_DENS=0.3,   # ... udział tuszu <= PIN_TEXT_DENS (drut ~0,15, podpis „R8-1k” ~0,5)
    PIN_INSET=4,         # piny nie w samym narożniku
    PINS_MIN=2,
    PIN_SIDES_MIN=2,     # wejścia i wyjście: druty przy co najmniej dwóch bokach
    # --- podział
    CUT_FRAC=0.6,
    CUT_KEEP=0.95,       # pełna przegródka — nigdy nie usuwana przy łączeniu kawałków
    OVERLAP_MAX=0.3,     # ramka przykryta w większej części przez przyjętą = odrzucona
    # --- elementy bierne (rezystor: P-X3-2 2-1 R1 56 x 28 px)
    PAS_SMIN=14, PAS_SMAX=39,    # krótszy bok (zewn.)
    PAS_LMIN=30, PAS_LMAX=120,   # dłuższy bok
    PAS_ASPECT=1.6,
    COMP_H=200,
)


# --------------------------------------------------------------------------- podstawy

def binarize(gray: np.ndarray, thr: int | None = None) -> np.ndarray:
    """Tusz = 1. thr=None -> Otsu; inaczej max(Otsu, thr) (jak cv-wires.py)."""
    th, _ = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    if thr is not None:
        th = max(th, thr)
    return (gray <= th).astype(np.uint8)


def _runs(m: np.ndarray, axis: int) -> np.ndarray:
    a = (m if axis == 0 else m.T).astype(np.int8)
    pad = np.zeros((1, a.shape[1]), np.int8)
    d = np.diff(np.vstack([pad, a, pad]), axis=0)
    s = np.nonzero(d.T == 1)[1]
    e = np.nonzero(d.T == -1)[1]
    return e - s


def measure_stroke(bw: np.ndarray, P: dict) -> float:
    """Średni przekrój długich linii (kopia z cv-wires.py)."""
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
    return float(r[r <= np.median(r) + 1].mean())


def line_maps(bw: np.ndarray, P: dict, wobble: int = 1, g0: int = 0) -> tuple[np.ndarray, np.ndarray]:
    """Mapy długich linii H i V: poszerzenie w poprzek `wobble` i domknięcie `g0` wzdłuż
    (blada, przerywana kreska; tylko mapa pinów), otwarcie LINE_L, domknięcie LINE_GAP
    wzdłuż (przerwy między kawałkami linii)."""
    L, g = P["LINE_L"], P["LINE_GAP"]
    out = []
    for horiz in (True, False):
        ko = (L, 1) if horiz else (1, L)
        m = bw
        if wobble > 1:
            kw = (1, wobble) if horiz else (wobble, 1)
            m = cv2.dilate(m, cv2.getStructuringElement(cv2.MORPH_RECT, kw))
        if g0 > 0:
            k0 = (g0 + 1, 1) if horiz else (1, g0 + 1)
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, k0))
        m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_RECT, ko))
        if g > 0:
            kc = (g + 1, 1) if horiz else (1, g + 1)
            m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, kc))
        out.append(m)
    return out[0], out[1]


# --------------------------------------------------------------------------- ramki

def bubble_mask(bw: np.ndarray, P: dict) -> np.ndarray:
    """Kółka negacji (i oczka liter): małe okrągłe dziury tła -> wypełnione koła. Kółko
    w narożniku ramki przerywa obie linie (2-58 M54: wyjście 10), a kółko na boku przerywa
    bok (2-59 M56: wejścia ER/EN); po wypełnieniu linia biegnie przez koło. Oczka liter
    to wyspy wewnątrz bramki — nieszkodliwe."""
    n, lab, st, cen = cv2.connectedComponentsWithStats((1 - bw).astype(np.uint8), connectivity=4)
    H, W = bw.shape
    m = np.zeros_like(bw)
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if not (P["BUB_AMIN"] <= a <= P["BUB_AMAX"]) or x == 0 or y == 0 or x + w >= W or y + h >= H:
            continue
        if max(w, h) > P["BUB_ASPECT"] * min(w, h) or a < P["BUB_EXTENT"] * w * h:
            continue
        r = int(round(max(w, h) / 2 + P["BUB_RING"] * P["SW"]))
        cv2.circle(m, (int(round(cen[i][0])), int(round(cen[i][1]))), r, 1, -1)
    return m


def segments(m: np.ndarray, horizontal: bool, split_t: float = 1e9) -> list[tuple[int, int, float, float]]:
    """Odcinki mapy linii: (a0, a1, c, t) — wzdłuż od-do (zewnętrzne końce), oś w poprzek
    (mediana), grubość (pole / długość). Składowa grubsza niż `split_t` to kilka linii
    sklejonych tekstem (rezystor P-A3-2 R9: napis „0,25” dotyka górnej i dolnej ściany,
    obie ściany to jedna składowa; R14: podpis „R14-1k” sklejony z górną ścianą) —
    dodatkowo dzielona na grupy wierszy z tuszem na >= połowie długości; zasięg grupy =
    najdłuższy ciągły bieg kolumn."""
    n, lab, st, _ = cv2.connectedComponentsWithStats(m if horizontal else m.T.copy(), connectivity=8)
    out = []
    for i in range(1, n):
        x, y, w, h, area = st[i]
        sub = lab[y:y + h, x:x + w] == i
        if area / max(1, w) > split_t:
            rows = sub.sum(axis=1) >= 0.5 * w
            for r0, r1 in _true_runs(rows):
                cols = sub[r0:r1 + 1].any(axis=0)
                runs = _true_runs(cols)
                c0, c1 = max(runs, key=lambda r: r[1] - r[0])
                blk = sub[r0:r1 + 1, c0:c1 + 1]
                ys = np.nonzero(blk)[0]
                out.append((int(x + c0), int(x + c1), float(np.median(ys) + y + r0),
                            float(blk.sum()) / max(1, c1 - c0 + 1)))
            # cała składowa też zostaje kandydatem: skośna gruba ściana nie ma wierszy
            # pokrytych w połowie, a fałszywe pary odrzucą narożniki i piny
        ys = np.nonzero(sub)[0]
        out.append((int(x), int(x + w - 1), float(np.median(ys) + y), area / max(1, w)))
    return out


def side_gap(m: np.ndarray, vertical: bool, e_a: int, e_b: int, a0: int, a1: int,
             lo: int, hi: int) -> tuple[float, int, int, int]:
    """Bok od a0 do a1 (wzdłuż); w poprzek pas [e + lo, e + hi], gdzie e przesuwa się
    liniowo od e_a (przy a0) do e_b (przy a1) — skos skanu (I-SK1-1 2-87: stos 920 px,
    lewy bok przesunięty o 8 px). Zwraca (pokrycie bez najdłuższej przerwy, najdłuższa
    przerwa, k0, k1) — przerwę ogranicza SIDE_GAP, więc nie liczy się podwójnie (P-P3-2
    M49: 9 px przerwy w 80-px boku dawało pokrycie 0,87 < SIDE_COV). k0..k1 =
    przesunięcia w pasie zajęte przez samą linię boku (wokół najlepiej pokrytego, >= połowa
    jego pokrycia) — tam leży ściana, nie tam, gdzie kończy się odcinek pary."""
    H, W = m.shape
    a0, a1 = max(0, a0), min((H if vertical else W) - 1, a1)
    if a1 < a0:
        return 0.0, 10**9, 0, 0
    t = np.arange(a0, a1 + 1)
    e = np.round(e_a + (e_b - e_a) * (t - a0) / max(1, a1 - a0)).astype(int)
    lim = W if vertical else H
    prof = np.zeros(len(t), np.uint8)
    ks = list(range(lo, hi + 1))
    covk = []
    for k in ks:
        c = np.clip(e + k, 0, lim - 1)
        col = m[t, c] if vertical else m[c, t]
        covk.append(float(col.mean()))
        prof |= col
    gaps = [q - p + 1 for p, q in _true_runs(prof == 0)]
    g = max(gaps) if gaps else 0
    cov = float(prof.sum()) / max(1, len(prof) - g)  # bez najdłuższej przerwy (<= SIDE_GAP)
    jb = int(np.argmax(covk))
    j0 = j1 = jb
    while j0 > 0 and covk[j0 - 1] >= covk[jb] / 2:
        j0 -= 1
    while j1 < len(ks) - 1 and covk[j1 + 1] >= covk[jb] / 2:
        j1 += 1
    return cov, g, ks[j0], ks[j1]


def frame_candidates(hm, vm, ink, P: dict, side_maps=None) -> list[dict]:
    """Prostokąty z czterech boków: para odcinków (góra/dół albo lewy/prawy) o zgodnych
    końcach (+- END_TOL + SKEW * odległość) i ciągłe dwa pozostałe boki (pokrycie
    >= SIDE_COV, przerwa <= SIDE_GAP; pas boku idzie za skosem od końca do końca).
    Boki poprzeczne sprawdzane na `side_maps` (mapy z poszerzeniem w poprzek — blada,
    falująca między wierszami ramka, SPP-32-16 2-142 A7), krótkie boki (< LINE_L + 5, np.
    rezystor 56 x 28) na samym tuszu `ink`, bo w mapie linii ich nie ma. Zwraca [dict(box=ramka zewnętrzna (bbox), corners=((x, y)
    lewy-górny, prawy-górny, lewy-dolny, prawy-dolny))]."""
    tol, T = P["END_TOL"], P["WALL_BAND"]
    out = []
    for horiz in (True, False):
        S = sorted(segments(hm if horiz else vm, horiz, P["SEG_SPLIT"] * P["SW"] + 2), key=lambda s: s[2])
        lmin = min(P["PAS_LMIN"], P["GATE_WMIN"] if horiz else P["GATE_HMIN"])
        S = [s for s in S if s[1] - s[0] + 1 >= lmin
             and s[1] - s[0] + 1 <= (P["GATE_WMAX"] if horiz else P["BLOCK_HMAX"]) + tol]
        lo = P["PAS_SMIN"]
        hi = P["BLOCK_HMAX"] if horiz else P["GATE_WMAX"]
        sm = side_maps or (hm, vm)
        other = sm[1] if horiz else sm[0]
        for i, a in enumerate(S):
            for b in S[i + 1:]:
                d = b[2] - a[2]
                if d < lo - 2 * T:
                    continue
                if d > hi:
                    break
                t2 = tol + P["SKEW"] * d
                if abs(a[0] - b[0]) > t2 or abs(a[1] - b[1]) > t2:
                    continue
                c0, c1 = int(round(a[2] - a[3] / 2)), int(round(b[2] + b[3] / 2))
                ok = True
                short = c1 - c0 + 1 < P["LINE_L"] + 5
                walls = []  # boki poprzeczne: (k0, k1) względem końców pary
                for ea, eb, rng in ((a[0], b[0], (-2, T)), (a[1], b[1], (-T, 2))):
                    cov, gap, k0, k1 = side_gap(ink if short else other, horiz, ea, eb,
                                                c0 + T, c1 - T, *rng)
                    if cov < P["SIDE_COV"] or gap > P["SIDE_GAP"]:
                        ok = False
                        break
                    walls.append((k0, k1))
                if not ok:
                    continue
                # ściany w narożnikach: (wzdłuż-od, wzdłuż-do) linii pary i linii boku
                ha = (int(round(a[2] - a[3] / 2)), int(round(a[2] + a[3] / 2)))
                hb = (int(round(b[2] - b[3] / 2)), int(round(b[2] + b[3] / 2)))
                (l0, l1), (r0, r1) = walls
                pa = ((a[0] + l0, a[0] + l1), (a[1] + r0, a[1] + r1))  # przy odcinku a
                pb = ((b[0] + l0, b[0] + l1), (b[1] + r0, b[1] + r1))  # przy odcinku b
                # narożnik: (x0, x1) pionowej ściany, (y0, y1) poziomej ściany
                if horiz:
                    corners = ((pa[0], ha), (pa[1], ha), (pb[0], hb), (pb[1], hb))
                else:
                    corners = ((ha, pa[0]), (hb, pb[0]), (ha, pa[1]), (hb, pb[1]))
                xs = [v for c in corners for v in c[0]]
                ys = [v for c in corners for v in c[1]]
                box = (min(a[0], b[0]), c0, max(a[1], b[1]), c1) if horiz else \
                    (c0, min(a[0], b[0]), c1, max(a[1], b[1]))
                out.append(dict(box=box, corners=corners))
    # duplikaty (ta sama ramka z pary H i z pary V)
    out.sort(key=lambda r: -(r["box"][2] - r["box"][0]) * (r["box"][3] - r["box"][1]))
    keep = []
    for r in out:
        if not any(max(abs(u - v) for u, v in zip(r["box"], k["box"])) <= tol for k in keep):
            keep.append(r)
    return keep


def _wall(bw: np.ndarray, ob, side: str, P: dict) -> int:
    """Grubość ściany przy zewnętrznej krawędzi `side` (mediana biegów tuszu do środka)."""
    H, W = bw.shape
    x0, y0, x1, y1 = ob
    lim = P["WALL_BAND"] + 4
    vals = []
    for f in (0.2, 0.35, 0.5, 0.65, 0.8):
        if side in "lr":
            y = int(round(y0 + f * (y1 - y0)))
            xs = range(x0 - 2, x0 + lim) if side == "l" else range(x1 + 2, x1 - lim, -1)
            prof = [bw[y, x] if 0 <= x < W else 0 for x in xs]
        else:
            x = int(round(x0 + f * (x1 - x0)))
            ys = range(y0 - 2, y0 + lim) if side == "t" else range(y1 + 2, y1 - lim, -1)
            prof = [bw[y, x] if 0 <= y < H else 0 for y in ys]
        runs = _true_runs(np.array(prof, bool))
        vals.append(runs[0][1] - runs[0][0] + 1 if runs else 1)
    return max(1, int(np.median(vals)))


def clean_corners(hm, vm, corners, P: dict) -> int:
    """Liczba narożników, w których linie ramki NIE biegną dalej na zewnątrz. Sonda leży
    na samej linii ściany (jej wiersze / kolumny +- 1 px, położenie z frame_candidates),
    nie na końcu odcinka pary: drut wchodzący w ścianę układu kończy się kilka px dalej niż
    ściana (2-63: prostokąt z drutów oparty o lewą ścianę M30 — ściana biegnie dalej), a pin
    kilka px pod górną ścianą nie jest przedłużeniem ściany (test syntetyczny; na stronach
    z tej pracy bez zmiany wyniku wobec pasu WALL_BAND).
    Przedłużenie = wiersz/kolumna sondy pokryta w >= CORNER_FRAC."""
    e, o, fr = P["CORNER_E"], P["CORNER_OFF"], P["CORNER_FRAC"]
    H, W = hm.shape

    def cover(m, ya, yb, xa, xb, axis):
        sub = m[max(0, ya):min(H, yb + 1), max(0, xa):min(W, xb + 1)]
        return float(sub.mean(axis=axis).max()) if sub.size else 0.0

    n = 0
    for ((x0, x1), (y0, y1)), (sx, sy) in zip(corners, ((-1, -1), (1, -1), (-1, 1), (1, 1))):
        ex = (x0 - o - e, x0 - o) if sx < 0 else (x1 + o, x1 + o + e)
        ey = (y0 - o - e, y0 - o) if sy < 0 else (y1 + o, y1 + o + e)
        h_ext = cover(hm, y0 - 1, y1 + 1, ex[0], ex[1], 1)  # pozioma ściana biegnie dalej
        v_ext = cover(vm, ey[0], ey[1], x0 - 1, x1 + 1, 0)  # pionowa ściana biegnie dalej
        if h_ext < fr and v_ext < fr:
            n += 1
    return n


def _strip(m: np.ndarray, side: str, corners, ins: int, depth: int):
    """Pas na zewnątrz boku `side`, wyprostowany za skosem: wiersz = pozycja wzdłuż boku,
    kolumna j = odległość od zewnętrznej krawędzi ściany (j=0 -> 2 px za krawędzią).
    Krawędź liniowo między narożnikami (lewy: x0 lewej ściany przy górze i przy dole).
    Zwraca (strip, pozycje wzdłuż)."""
    (tl, tr, bl, br) = corners
    H, W = m.shape
    if side in ("left", "right"):
        ea, eb = (tl[0][0], bl[0][0]) if side == "left" else (tr[0][1], br[0][1])
        a0, a1 = min(tl[1][0], tr[1][0]) + ins, max(bl[1][1], br[1][1]) - ins
        sgn = -1 if side == "left" else 1
    else:
        ea, eb = (tl[1][0], tr[1][0]) if side == "top" else (bl[1][1], br[1][1])
        a0, a1 = min(tl[0][0], bl[0][0]) + ins, max(tr[0][1], br[0][1]) - ins
        sgn = -1 if side == "top" else 1
    if a1 < a0:
        return np.zeros((0, depth), np.uint8), np.zeros(0, int)
    t = np.arange(a0, a1 + 1)
    e = np.round(ea + (eb - ea) * (t - a0) / max(1, a1 - a0)).astype(int)
    j = np.arange(depth)
    c = e[:, None] + sgn * (2 + j[None, :])
    if side in ("left", "right"):
        ok = (c >= 0) & (c < W) & (t[:, None] >= 0) & (t[:, None] < H)
        st = m[np.clip(t, 0, H - 1)[:, None], np.clip(c, 0, W - 1)]
    else:
        ok = (c >= 0) & (c < H) & (t[:, None] >= 0) & (t[:, None] < W)
        st = m[np.clip(c, 0, H - 1), np.clip(t, 0, W - 1)[:, None]]
    return (st * ok).astype(np.uint8), t


def find_pins(lines_h, lines_v, ink, corners, ob, P: dict,
              sides=("left", "right", "top", "bottom"), strict: bool = False) -> list[tuple[str, int, int]]:
    """Druty przy bokach: (side, px, py) na zewnętrznej krawędzi. Pin, gdy:
      (a) tusz dotykający ściany (do 3 px od krawędzi) sięga >= PIN_NEAR px na zewnątrz
          i łączy się w pasie PIN_FAR z jakąkolwiek linią (H albo V) — drut skręcający
          12 px za ścianą albo dochodzący kropką do pionowej magistrali 13 px dalej;
      (b) albo linia prostopadła pokrywa >= PIN_FRAC pasa PIN_NEAR..PIN_FAR (drut kończący
          się kilka px przed ścianą, wyjście za kółkiem).
    Linia liczy się dopiero od PIN_NEAR px (sama ściana i jej poszarpana krawędź to też
    linia). `strict`: linia musi dochodzić do końca pasa, a okno wokół nie może być gęstym
    tekstem — pogrubiony podpis „R8-1k” dotyka korpusu rezystora (P-A3-2) i drutu nad nim,
    więc w mapie V daje długie kreski; drut wyprowadzenia jest cienki i samotny.
    Kółka negacji są w `ink` wypełnione, więc kółko + drut dotyka ściany."""
    a, b, fr, ins = P["PIN_NEAR"], P["PIN_FAR"], P["PIN_FRAC"], P["PIN_INSET"]
    lines = lines_h | lines_v
    out = []
    for side in sides:
        perp = lines_h if side in ("left", "right") else lines_v
        ink_s, t = _strip(ink, side, corners, ins, b - 1)
        if not len(t):
            continue
        line_s, _ = _strip(lines, side, corners, ins, b - 1)
        perp_s, _ = _strip(perp, side, corners, ins, b - 1)
        hit = np.zeros(len(t), bool)
        n, lab = cv2.connectedComponents(ink_s, connectivity=8)
        if n > 1:
            good = np.zeros(n, bool)
            jj = np.broadcast_to(np.arange(ink_s.shape[1]), ink_s.shape)
            reach = np.zeros(n, int)
            np.maximum.at(reach, lab.ravel(), jj.ravel())
            on_line = np.zeros(n, bool)
            j0 = (b - 4) if strict else (a - 2)
            far = np.zeros_like(line_s)
            far[:, j0:] = line_s[:, j0:]
            on_line[np.unique(lab[(far > 0) & (lab > 0)])] = True
            good = on_line & (reach >= a - 2)
            good[0] = False
            hit |= good[lab[:, :2]].any(axis=1)
        hit |= perp_s[:, a - 2:].mean(axis=1) >= fr
        if strict:
            # wyprowadzenie to cienki drut; w gęstym tekście (podpis dotykający korpusu,
            # kreski znaków sklejone z drutem nad nim) gęstość tuszu w oknie jest wysoka
            k = P["PIN_TEXT_WIN"]
            dens = np.array([ink_s[max(0, i - k):i + k + 1, :P["PIN_FAR"]].mean() for i in range(len(t))])
            hit &= dens <= P["PIN_TEXT_DENS"]
        for s0, e0 in _true_runs(hit):
            pos = int(t[(s0 + e0) // 2])
            if side == "left":
                out.append((side, ob[0], pos))
            elif side == "right":
                out.append((side, ob[2], pos))
            elif side == "top":
                out.append((side, pos, ob[1]))
            else:
                out.append((side, pos, ob[3]))
    return out


def _true_runs(prof: np.ndarray) -> list[tuple[int, int]]:
    p = np.concatenate([[0], prof.astype(np.int8), [0]])
    d = np.diff(p)
    return list(zip(np.nonzero(d == 1)[0], np.nonzero(d == -1)[0] - 1))


def split_block(lines, ob, wt, pins, P: dict) -> list[tuple[int, int]]:
    """Poziome cięcia stosu: zwraca listę (y0, y1) bramek w bloku. Cięcie = wiersze, w których
    linie pokrywają >= CUT_FRAC szerokości wnętrza; siła cięcia = maks. pokrycie. Kawałek bez
    pinu albo niższy niż GATE_HMIN traci słabsze ze swoich cięć (podpis „M65” przyklejony
    do ściany daje fałszywe cięcie ~0,6 tuż nad prawdziwą przegródką 1,0); cięcie
    o sile >= CUT_KEEP (pełna przegródka) zostaje zawsze."""
    X0, Y0, X1, Y1 = ob
    xa, xb = X0 + wt["l"] + 1, X1 - wt["r"] - 1
    ya, yb = Y0 + wt["t"] + 3, Y1 - wt["b"] - 3
    if xb <= xa or yb <= ya:
        return [(Y0, Y1)]
    prof = lines[ya:yb + 1, xa:xb + 1].mean(axis=1)
    cuts = [(ya + (s + e) // 2, float(prof[s:e + 1].max())) for s, e in _true_runs(prof >= P["CUT_FRAC"])]

    def npins(y0, y1):
        return sum(1 for side, _px, py in pins if side in ("left", "right") and y0 < py < y1)

    while cuts:
        bounds = [Y0] + [c for c, _ in cuts] + [Y1]
        low = [k for k in range(len(bounds) - 1) if bounds[k + 1] - bounds[k] < P["GATE_HMIN"]]
        nop = [k for k in range(len(bounds) - 1) if npins(bounds[k], bounds[k + 1]) == 0]
        # cięcia ograniczające zły kawałek: cuts[k-1] (góra) i cuts[k] (dół). Za niski
        # kawałek traci słabsze z nich zawsze; kawałek bez pinu tylko cięcie < CUT_KEEP —
        # pełna przegródka zostaje, bramka z bladymi pinami nie zlewa się z sąsiadem
        opts = [j for k in low for j in (k - 1, k) if 0 <= j < len(cuts)]
        if not opts:
            opts = [j for k in nop for j in (k - 1, k)
                    if 0 <= j < len(cuts) and cuts[j][1] < P["CUT_KEEP"]]
        if not opts:
            break
        j = min(opts, key=lambda j: cuts[j][1])
        del cuts[j]
    bounds = [Y0] + [c for c, _ in cuts] + [Y1]
    return [(bounds[k], bounds[k + 1]) for k in range(len(bounds) - 1)]


def internal_vwalls(lines, ob, wt, P: dict) -> int:
    """Liczba wewnętrznych pionowych ścian przez >= CUT_FRAC wysokości."""
    X0, Y0, X1, Y1 = ob
    xa, xb = X0 + wt["l"] + 3, X1 - wt["r"] - 3
    ya, yb = Y0 + wt["t"] + 1, Y1 - wt["b"] - 1
    if xb <= xa or yb <= ya:
        return 0
    cov = lines[ya:yb + 1, xa:xb + 1].mean(axis=0) >= P["CUT_FRAC"]
    return len(_true_runs(cov))


# --------------------------------------------------------------------------- detekcja

def detect(gray: np.ndarray, P: dict | None = None) -> dict:
    """Rdzeń: skan -> dict(gates, blocks, rejected, params).

    gates:    [dict(box=(x0,y0,x1,y1), cls, pins=[(side,px,py)], block=idx)]
    blocks:   [dict(box, wall, pins, vwalls)] — zaakceptowane ramki w całości (stos bramek,
              złożony układ); cv-wires.py maskuje bloki
    rejected: [dict(box, why)]
    """
    P = {**PARAMS, **(P or {})}
    bw = binarize(gray, P["THR"])
    sw = float(P["SW"]) if P.get("SW") else measure_stroke(bw, P)
    P["SW"] = sw
    if P.get("WALL_BAND") is None:
        P["WALL_BAND"] = int(round(2 * sw + 3))
    bwb = bw | bubble_mask(bw, P)
    hm, vm = line_maps(bwb, P)
    hmw, vmw = line_maps(bwb, P, P["PIN_WOBBLE"], P["PIN_GAP"])
    lines = hm | vm
    cands = frame_candidates(hm, vm, bwb, P, (hmw, vmw) if P["SIDE_WOBBLE"] else None)

    gates, blocks, rejected = [], [], []
    for cand in cands:
        ob, cn = cand["box"], cand["corners"]
        bwid, bhei = ob[2] - ob[0] + 1, ob[3] - ob[1] + 1
        is_gate = P["GATE_WMIN"] <= bwid <= P["GATE_WMAX"] and P["GATE_HMIN"] <= bhei <= P["BLOCK_HMAX"]
        is_pas = _passive_size(bwid, bhei, P)
        why = None if (is_gate or is_pas) else "size"
        wt = {s: _wall(bwb, ob, s, P) for s in "ltrb"}
        pins, kind = [], None
        if why is None:
            nc = clean_corners(hm, vm, cn, P)
            if nc < P["CORNERS_MIN"]:
                why = f"corner{nc}"
        if why is None:
            pins = find_pins(hmw, vmw, bwb, cn, ob, P)
            if is_pas:
                # najpierw element bierny (pionowy rezystor 30–39 px szeroki mieści się też
                # w rozmiarach bramki); długie boki na mapach bez domknięcia: podpis
                # „R8-1k” dotykający korpusu nie jest wyprowadzeniem
                horiz = bwid >= bhei
                short = ("left", "right") if horiz else ("top", "bottom")
                long_ = ("top", "bottom") if horiz else ("left", "right")
                strict = find_pins(hm, vm, bwb, cn, ob, P, sides=long_, strict=True)
                lead = [p for p in pins if p[0] in short]
                if not strict and _passive_leads(lead, horiz):
                    kind, pins = "passive", lead
            if kind is None and is_gate:
                if len(pins) < P["PINS_MIN"] or len({p[0] for p in pins}) < P["PIN_SIDES_MIN"]:
                    why = f"pins{len(pins)}"
                else:
                    kind = "gate"
            elif kind is None:
                why = "leads"
        if why is None and any(_overlap(ob, b["box"]) > P["OVERLAP_MAX"] for b in blocks):
            why = "overlap"  # bramki się nie nakładają; większa (wcześniejsza) ramka wygrywa
        if why is None and kind == "passive":
            blocks.append(dict(box=ob, wall=wt, pins=pins, vwalls=0))
            gates.append(dict(box=ob, cls="passive", pins=pins, block=len(blocks) - 1))
            continue
        if why is None:
            segs = split_block(lines, ob, wt, pins, P)
            if any(y1 - y0 + 1 > P["GATE_HMAX"] for y0, y1 in segs):
                why = "size"
        if why is not None:
            rejected.append(dict(box=ob, why=why))
            continue
        bi = len(blocks)
        nv = internal_vwalls(lines, ob, wt, P)
        blocks.append(dict(box=ob, wall=wt, pins=pins, vwalls=nv))
        for y0, y1 in segs:
            box = (ob[0], y0, ob[2], y1)
            gp = [p for p in pins if (p[0] in ("left", "right") and y0 <= p[2] <= y1)
                  or (p[0] == "top" and y0 == ob[1]) or (p[0] == "bottom" and y1 == ob[3])]
            cls = "composite" if (nv >= 2 or y1 - y0 + 1 >= P["COMP_H"]) else "gate"
            gates.append(dict(box=box, cls=cls, pins=gp, block=bi))
    gates.sort(key=lambda d: (d["box"][0] // 50, d["box"][1]))
    return dict(gates=gates, blocks=blocks, rejected=rejected, params=P, ncand=len(cands))


def _passive_size(w: int, h: int, P: dict) -> bool:
    s, l = min(w, h), max(w, h)
    return P["PAS_SMIN"] <= s <= P["PAS_SMAX"] and P["PAS_LMIN"] <= l <= P["PAS_LMAX"] and l >= P["PAS_ASPECT"] * s


def _passive_leads(pins, horizontal: bool) -> bool:
    """Element bierny: dokładnie po jednym wyprowadzeniu na obu krótkich bokach, nic na długich."""
    sides = [p[0] for p in pins]
    a, b = ("left", "right") if horizontal else ("top", "bottom")
    return sides.count(a) == 1 and sides.count(b) == 1 and len(sides) == 2


def _overlap(a, b) -> float:
    """Część pola `a` przykryta przez `b`."""
    ix = max(0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0, min(a[3], b[3]) - max(a[1], b[1]))
    return ix * iy / max(1, (a[2] - a[0]) * (a[3] - a[1]))


# --------------------------------------------------------------------------- wyjście

CLS_COL = {"gate": (0, 160, 0), "composite": (200, 80, 0), "passive": (180, 0, 180)}


def _dashed_rect(img, b, col, th=1, dash=6):
    x0, y0, x1, y1 = (int(v) for v in b)
    for (ax, ay, bx, by) in ((x0, y0, x1, y0), (x1, y0, x1, y1), (x1, y1, x0, y1), (x0, y1, x0, y0)):
        n = max(1, int(max(abs(bx - ax), abs(by - ay)) // dash))
        for k in range(0, n, 2):
            t0, t1 = k / n, min(1.0, (k + 1) / n)
            cv2.line(img, (int(ax + (bx - ax) * t0), int(ay + (by - ay) * t0)),
                     (int(ax + (bx - ax) * t1), int(ay + (by - ay) * t1)), col, th)


def draw_overlay(gray, res, path, show_rejected: str = "plausible"):
    base = (gray.astype(np.float32) * 0.35 + 255 * 0.65).astype(np.uint8)
    img = cv2.cvtColor(base, cv2.COLOR_GRAY2BGR)
    for r in res["rejected"]:
        if show_rejected == "plausible" and r["why"] == "size":
            continue
        _dashed_rect(img, r["box"], (0, 120, 255), 1)
        cv2.putText(img, r["why"], (int(r["box"][0]), int(r["box"][1]) - 3),
                    cv2.FONT_HERSHEY_SIMPLEX, 0.35, (0, 120, 255), 1, cv2.LINE_AA)
    for b in res["blocks"]:
        x0, y0, x1, y1 = (int(v) for v in b["box"])
        cv2.rectangle(img, (x0 - 3, y0 - 3), (x1 + 3, y1 + 3), (200, 200, 120), 1)
    for i, g in enumerate(res["gates"], 1):
        col = CLS_COL[g["cls"]]
        x0, y0, x1, y1 = (int(v) for v in g["box"])
        cv2.rectangle(img, (x0, y0), (x1, y1), col, 2)
        cv2.putText(img, str(i), (x0 + 3, y0 + 16), cv2.FONT_HERSHEY_SIMPLEX, 0.5, col, 1, cv2.LINE_AA)
        for side, px, py in g["pins"]:
            cv2.circle(img, (int(px), int(py)), 3, (255, 0, 0), -1)
    cv2.imwrite(str(path), img)


def to_gate_entries(res) -> list[dict]:
    out = []
    for g in res["gates"]:
        x0, y0, x1, y1 = g["box"]
        out.append({
            "ref": "?", "gate": None,
            "x": round(float(x0 + x1) / 2, 1), "y": round(float(y0 + y1) / 2, 1),
            "w": int(x1 - x0), "h": int(y1 - y0), "rotation": 0,
            "pins": [], "verified": False,
            "cv_class": g["cls"],
            "cv_pins": [{"side": s, "px": int(px), "py": int(py)} for s, px, py in g["pins"]],
        })
    return out


def to_yaml_doc(res, page, package, shape) -> dict:
    return {
        "kronikarz": "1", "page": page, "package": package,
        "scan_size": [int(shape[1]), int(shape[0])],
        "gates": to_gate_entries(res),
        "power": [], "ports": [], "cross_refs": [], "nets": {},
        "annotations": [], "decorations": [],
    }


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--scan", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--overlay")
    ap.add_argument("--page")
    ap.add_argument("--package")
    ap.add_argument("--set", action="append", default=[], metavar="NAZWA=wartość",
                    help="nadpisanie PARAMS (literał Pythona), np. --set CORNERS_MIN=4")
    a = ap.parse_args(argv)
    over = {}
    for kv in a.set:
        k, v = kv.split("=", 1)
        if k not in PARAMS:
            sys.exit(f"nieznany parametr {k}")
        over[k] = ast.literal_eval(v)
    t0 = time.perf_counter()
    gray = cv2.imread(a.scan, cv2.IMREAD_GRAYSCALE)
    if gray is None:
        sys.exit(f"nie mogę wczytać {a.scan}")
    res = detect(gray, over)
    page = a.page or Path(a.scan).stem
    package = a.package or Path(a.scan).parent.parent.name
    doc = to_yaml_doc(res, page, package, gray.shape)
    Path(a.out).parent.mkdir(parents=True, exist_ok=True)
    Path(a.out).write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True))
    cnt = {}
    for g in res["gates"]:
        cnt[g["cls"]] = cnt.get(g["cls"], 0) + 1
    rej = {}
    for r in res["rejected"]:
        k = r["why"].rstrip("0123456789")
        rej[k] = rej.get(k, 0) + 1
    print(f"{package} {page}: sw={res['params']['SW']:.2f}; kandydatów {res['ncand']}, "
          f"bloków {len(res['blocks'])}, bramek {len(res['gates'])} {cnt}; odrzucone {rej}; "
          f"{time.perf_counter() - t0:.2f} s")
    if a.overlay:
        Path(a.overlay).parent.mkdir(parents=True, exist_ok=True)
        draw_overlay(gray, res, a.overlay)


if __name__ == "__main__":
    main()
