"""Testy scripts/cv-gates.py na syntetycznych obrazach (bez skanów).

Uruchomienie (nie zostawia __pycache__ ani .pytest_cache):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy \\
      --with opencv-python-headless pytest -p no:cacheprovider scripts/test_cv_gates.py

Mutacje: CVG_MUTATE="NAZWA=wartość[,NAZWA=wartość]" nadpisuje PARAMS przed testami
(np. CVG_MUTATE="CORNERS_MIN=0"); CVG_SCRIPT=<plik> testuje zmienioną kopię skryptu.

Rysunek jak skan 200 dpi: drut 2–3 px, ramka bramki 3–5 px, znak ~16 px (cv2.putText).
"""
from __future__ import annotations

import ast
import importlib.util
import os
from pathlib import Path

import cv2
import numpy as np
import pytest

_src = os.environ.get("CVG_SCRIPT") or Path(__file__).with_name("cv-gates.py")
_spec = importlib.util.spec_from_file_location("cv_gates", _src)
cvg = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cvg)

for _kv in filter(None, os.environ.get("CVG_MUTATE", "").split(",")):
    _k, _v = _kv.split("=", 1)
    assert _k in cvg.PARAMS, _k
    cvg.PARAMS[_k] = ast.literal_eval(_v)

W = 3  # drut


# --------------------------------------------------------------------------- rysowanie

def blank(w=600, h=600):
    return np.full((h, w), 255, np.uint8)


def hline(img, x0, x1, y, w=W):
    img[y - w // 2 : y - w // 2 + w, x0 : x1 + 1] = 0


def vline(img, x, y0, y1, w=W):
    img[y0 : y1 + 1, x - w // 2 : x - w // 2 + w] = 0


def frame(img, x0, y0, x1, y1, t=5):
    """Zewnętrzne krawędzie x0..x1, y0..y1, grubość t."""
    img[y0 : y0 + t, x0 : x1 + 1] = 0
    img[y1 - t + 1 : y1 + 1, x0 : x1 + 1] = 0
    img[y0 : y1 + 1, x0 : x0 + t] = 0
    img[y0 : y1 + 1, x1 - t + 1 : x1 + 1] = 0


def text(img, s, x, y, scale=0.55, th=2):
    """Znak ~16 px (FONT_HERSHEY_SIMPLEX 0.55)."""
    cv2.putText(img, s, (x, y), cv2.FONT_HERSHEY_SIMPLEX, scale, 0, th, cv2.LINE_AA)


def bubble(img, x, y, r=6, th=2):
    cv2.circle(img, (x, y), r, 0, th)


def gate_with_pins(img, x0, y0, x1, y1, ins=(), outs=(), t=5, label=None):
    frame(img, x0, y0, x1, y1, t)
    for y in ins:
        hline(img, x0 - 70, x0, y)
    for y in outs:
        hline(img, x1, x1 + 70, y)
    if label:
        text(img, label, x0 + 8, y1 - 10)


def run(img, **over):
    return cvg.detect(img, over)


def boxes(res, cls=None):
    return [g["box"] for g in res["gates"] if cls is None or g["cls"] == cls]


def near(a, b, tol):
    return all(abs(u - v) <= tol for u, v in zip(a, b))


# --------------------------------------------------------------------------- bramki

def test_single_gate_with_text_is_one_gate():
    img = blank()
    gate_with_pins(img, 250, 200, 305, 290, ins=(225, 265), outs=(245,), label="M54")
    text(img, "04", 258, 230)
    res = run(img)
    b = boxes(res)
    assert len(b) == 1, res["gates"]
    assert near(b[0], (250, 200, 305, 290), 3), b
    assert res["gates"][0]["cls"] == "gate"
    assert {p[0] for p in res["gates"][0]["pins"]} == {"left", "right"}
    assert len(res["gates"][0]["pins"]) == 3


def test_stack_of_three_is_split_at_dividers():
    # 2-58 M54/M64/M64: jedna ramka, dwie pełne przegródki, podpis tuż nad przegródką
    img = blank()
    x0, x1 = 250, 305
    frame(img, x0, 100, x1, 340)
    img[180:185, x0 : x1 + 1] = 0
    img[260:265, x0 : x1 + 1] = 0
    for y0, y1 in ((100, 182), (182, 262), (262, 340)):
        hline(img, x0 - 70, x0, y0 + 25)
        hline(img, x1, x1 + 70, y0 + 40)
        text(img, "M64", x0 + 6, y1 - 6)  # dotyka przegródki — nie może dać cięcia
    res = run(img)
    b = sorted(boxes(res), key=lambda r: r[1])
    assert len(b) == 3, b
    assert len(res["blocks"]) == 1
    for r, (y0, y1) in zip(b, ((100, 182), (182, 262), (262, 340))):
        assert near(r, (x0, y0, x1, y1), 4), b
    # kandydaci pinów przypisani do własnej bramki
    for g in sorted(res["gates"], key=lambda g: g["box"][1]):
        y0, y1 = g["box"][1], g["box"][3]
        assert sorted(p[0] for p in g["pins"]) == ["left", "right"], g
        assert all(y0 < p[2] < y1 for p in g["pins"]), g


def test_stack_gate_with_invisible_pins_keeps_full_dividers():
    # środkowa bramka stosu ma blade (niewidoczne) piny: pełne przegródki (100 %) zostają,
    # bramka nie zlewa się z sąsiadem
    img = blank()
    x0, x1 = 250, 305
    frame(img, x0, 100, x1, 340)
    img[180:185, x0 : x1 + 1] = 0
    img[260:265, x0 : x1 + 1] = 0
    for y0 in (100, 262):
        hline(img, x0 - 70, x0, y0 + 25)
        hline(img, x1, x1 + 70, y0 + 40)
    res = run(img)
    assert len(res["gates"]) == 3, [g["box"] for g in res["gates"]]


def test_gate_with_single_internal_column_is_a_gate():
    # 2-58 M52: kolumna „&” po lewej, jedna wewnętrzna ściana, 81 x 133 — bramka, nie układ
    img = blank()
    x0, y0, x1, y1 = 250, 200, 331, 333
    frame(img, x0, y0, x1, y1, 4)
    vline(img, 272, y0, y1)
    for y in (220, 245, 270, 295):
        hline(img, x0 - 70, x0, y)
    hline(img, x1, x1 + 70, 230)
    res = run(img)
    assert len(res["gates"]) == 1 and res["gates"][0]["cls"] == "gate", res["gates"]


def test_composite_with_internal_columns_is_one_gate():
    # 74175 (P-X3-2 M6): kolumna etykiet | korpus | kolumna A/B/C/D z krótkimi przegródkami
    img = blank(700, 700)
    x0, x1, y0, y1 = 250, 380, 100, 480
    frame(img, x0, y0, x1, y1, 4)
    vline(img, 285, y0, y1)  # kolumna etykiet
    vline(img, 350, y0, y1)  # kolumna A/B/C/D
    for y in (195, 290):
        hline(img, 350, x1, y)  # przegródki tylko w prawej kolumnie
    hline(img, x0, 285, 400)  # sekcja C/R w kolumnie etykiet ...
    hline(img, 350, x1, 400)  # ... i przegródka D na tej samej wysokości: ~50 % szerokości
    for k, y in enumerate((130, 160, 190, 220, 430, 460)):
        hline(img, x0 - 70, x0, y)
    for y in (130, 160, 225, 255, 320, 350, 415, 445):
        hline(img, x1, x1 + 70, y)
    text(img, "R", 292, 130)
    text(img, "175", 292, 150)
    for k, s in enumerate("ABCD"):
        text(img, s, 357, 150 + 95 * k)
    res = run(img)
    assert len(res["gates"]) == 1, res["gates"]
    g = res["gates"][0]
    assert g["cls"] == "composite"
    assert near(g["box"], (x0, y0, x1, y1), 3)


def test_tall_ic_with_label_column_is_composite():
    # JPP-16-18 K565: wysoki układ, jedna wewnętrzna kolumna etykiet pinów
    img = blank(600, 700)
    x0, x1, y0, y1 = 250, 360, 80, 560
    frame(img, x0, y0, x1, y1, 4)
    vline(img, 280, y0, y1)
    hline(img, x0, 280, 400)
    for y in range(110, 540, 25):
        hline(img, x0 - 70, x0, y)
    hline(img, x1, x1 + 70, 520)
    res = run(img)
    assert len(res["gates"]) == 1 and res["gates"][0]["cls"] == "composite", res["gates"]


def test_stack_of_two_composites_with_continuous_right_column():
    # 2-59 M56/M57 (74170): przegródka przez kolumnę etykiet i korpus (~80 % szerokości),
    # prawa wąska kolumna ciągła — dwie bramki złożone, nie jedna
    img = blank(700, 900)
    x0, x1, y0, y1 = 250, 358, 100, 800
    frame(img, x0, y0, x1, y1, 4)
    vline(img, 280, y0, y1)
    vline(img, 335, y0, y1)
    hline(img, x0, 335, 450, 4)
    for y in range(140, 440, 30):
        hline(img, x0 - 70, x0, y)
        hline(img, x0 - 70, x0, y + 350)
    for y in (200, 230, 260, 290):
        hline(img, x1, x1 + 70, y)
        hline(img, x1, x1 + 70, y + 350)
    res = run(img)
    b = sorted(boxes(res), key=lambda r: r[1])
    assert len(b) == 2, b
    assert all(g["cls"] == "composite" for g in res["gates"])
    assert abs(b[0][3] - 450) <= 4 and abs(b[1][1] - 450) <= 4, b


def test_gate_with_negation_bubble_in_corner():
    # 2-58 M54: kółko wyjścia w prawym górnym narożniku przerywa górę i prawy bok
    img = blank()
    x0, y0, x1, y1 = 250, 200, 305, 290
    frame(img, x0, y0, x1, y1, 4)
    cv2.circle(img, (x1 - 1, y0 + 5), 6, 255, -1)  # linie kończą się na kółku
    bubble(img, x1 - 1, y0 + 5, r=6)
    hline(img, x1 + 6, x1 + 80, y0 + 5)        # wyjście z kółka
    hline(img, x0 - 70, x0, 240)
    hline(img, x0 - 70, x0, 270)
    res = run(img)
    b = boxes(res)
    assert len(b) == 1, (b, res["rejected"])
    assert near(b[0], (x0, y0, x1, y1), 6), b


def test_pins_close_to_corners_keep_corners_clean():
    # SPP-32-16 (7400): wejścia 7–8 px od górnej i dolnej ściany — to piny, nie przedłużenie
    # ściany; narożniki zostają czyste
    img = blank()
    x0, y0, x1, y1 = 250, 200, 305, 290
    frame(img, x0, y0, x1, y1, 3)
    hline(img, x0 - 70, x0, y0 + 8)
    hline(img, x0 - 70, x0, y1 - 8)
    hline(img, x1, x1 + 70, y0 + 8)
    hline(img, x1, x1 + 70, y1 - 8)
    res = run(img)
    assert len(res["gates"]) == 1, res["rejected"]


def test_gate_with_bubbles_on_input_side():
    # 2-59 M56: kółka negacji na lewym boku przerywają bok
    img = blank()
    x0, y0, x1, y1 = 250, 150, 305, 330
    frame(img, x0, y0, x1, y1, 4)
    for y in (200, 280):
        img[y - 7 : y + 8, x0 : x0 + 4] = 255
        bubble(img, x0 - 5, y, r=6)
        hline(img, x0 - 80, x0 - 11, y)
    hline(img, x1, x1 + 70, 240)
    res = run(img)
    assert len(boxes(res)) == 1, res["rejected"]


def test_thin_frame_gate():
    # SM-POSE11: ramka tak cienka jak drut (~1,6 px)
    img = blank()
    frame(img, 250, 200, 305, 290, t=2)
    for y in (225, 265):
        hline(img, 180, 250, y, 2)
    hline(img, 305, 380, 245, 2)
    text(img, "86", 258, 235, th=1)
    res = run(img)
    assert len(boxes(res)) == 1, res["rejected"]


def test_skewed_tall_stack_with_broken_side():
    # I-SK1-1 2-87 / 2-63 M31-M42: stos ~900 px ze skosem ~1 % (lewy bok 9 px dalej na dole)
    # i przerwą w boku — para lewy/prawy się nie składa, para góra/dół musi znieść skos
    img = blank(500, 1050)
    x0, x1, y0, y1, dx = 200, 260, 60, 960, 10
    cv2.line(img, (x0, y0), (x1, y0), 0, 4)
    cv2.line(img, (x0 + dx, y1), (x1 + dx, y1), 0, 4)
    cv2.line(img, (x0, y0), (x0 + dx, y1), 0, 3)
    cv2.line(img, (x1, y0), (x1 + dx, y1), 0, 3)
    img[500:510, x0 - 5 : x0 + 10] = 255  # blada przerwa 10 px w lewym boku
    for k in range(1, 10):
        y = y0 + 90 * k
        sx = int(round(dx * (y - y0) / (y1 - y0)))
        cv2.line(img, (x0 + sx, y), (x1 + sx, y), 0, 4)
    for k in range(10):
        y = y0 + 90 * k + 45
        sx = int(round(dx * (y - y0) / (y1 - y0)))
        hline(img, x0 + sx - 70, x0 + sx, y - 15)
        hline(img, x1 + sx, x1 + sx + 70, y)
    res = run(img)
    assert len(res["gates"]) == 10, (len(res["gates"]), res["rejected"][:5])


def test_pale_dashed_output_wire_is_a_pin():
    # I-SK1-1 2-87 G2: wyjście to blady drut 1 px z przerwami 1–3 px
    img = blank()
    x0, y0, x1, y1 = 250, 200, 305, 290
    frame(img, x0, y0, x1, y1, 4)
    hline(img, x0 - 70, x0, 240)
    for x in range(x1 + 1, x1 + 80):
        if x % 5 not in (0, 1):
            img[245, x] = 0
    res = run(img)
    assert len(res["gates"]) == 1, res["rejected"]


def test_pale_wire_wobbling_between_rows_is_a_pin():
    # blady drut 1 px, który „przeskakuje” między sąsiednimi wierszami (skos, JPEG)
    img = blank()
    x0, y0, x1, y1 = 250, 200, 305, 290
    frame(img, x0, y0, x1, y1, 4)
    hline(img, x0 - 70, x0, 240)
    for x in range(x1 + 1, x1 + 80):
        img[245 + (x // 6) % 2, x] = 0
    res = run(img)
    assert len(res["gates"]) == 1, res["rejected"]


def test_short_output_after_bubble_is_a_pin():
    # JPP-16-18 M18: wyjście W = kółko na boku + ~20 px drutu i zakręt w dół
    img = blank()
    x0, y0, x1, y1 = 250, 150, 330, 330
    frame(img, x0, y0, x1, y1, 4)
    for y in range(170, 320, 25):
        hline(img, x0 - 70, x0, y)
    bubble(img, x1 + 3, 300, r=6)
    hline(img, x1 + 9, x1 + 22, 300)
    vline(img, x1 + 22, 300, 380)
    res = run(img)
    assert len(res["gates"]) == 1, res["rejected"]


def test_output_turning_down_after_wall_is_a_pin():
    # wyjście: 12 px drutu za ścianą i zakręt w dół (pozioma część za krótka na LINE_L)
    img = blank()
    x0, y0, x1, y1 = 250, 200, 305, 290
    frame(img, x0, y0, x1, y1, 4)
    hline(img, x0 - 70, x0, 230)
    hline(img, x0 - 70, x0, 265)
    hline(img, x1, x1 + 12, 245)
    vline(img, x1 + 12, 245, 400)
    res = run(img)
    assert len(res["gates"]) == 1, res["rejected"]


def test_output_joining_vertical_bus_with_dot_is_a_pin():
    # wyjście dochodzi kropką do pionowej magistrali 13 px od ściany
    img = blank()
    x0, y0, x1, y1 = 250, 200, 305, 290
    frame(img, x0, y0, x1, y1, 4)
    hline(img, x0 - 70, x0, 230)
    hline(img, x0 - 70, x0, 265)
    hline(img, x1, x1 + 13, 245)
    vline(img, x1 + 13, 100, 500)
    cv2.circle(img, (x1 + 13, 245), 6, 0, -1)
    res = run(img)
    assert len(res["gates"]) == 1, res["rejected"]


def test_side_gap_counts_once():
    # P-P3-2 M49: 9 px przerwy w prawym boku bramki ~80 px — przerwa <= SIDE_GAP nie może
    # dodatkowo obniżać pokrycia poniżej SIDE_COV
    img = blank()
    x0, y0, x1, y1 = 250, 200, 306, 280
    frame(img, x0, y0, x1, y1, 4)
    img[237:246, x1 - 5 : x1 + 2] = 255
    hline(img, x0 - 70, x0, 220)
    hline(img, x0 - 70, x0, 260)
    hline(img, x1, x1 + 70, 225)
    res = run(img)
    assert len(res["gates"]) == 1, res["rejected"]


def test_passive_with_label_touching_body():
    # P-A3-2 R8/R14: pogrubiony podpis „R8-1k” dotyka korpusu, a nad nim biegnie drut
    img = blank()
    x0, y0, x1, y1 = 250, 300, 306, 326
    frame(img, x0, y0, x1, y1, 5)
    for x in (x0 + 12, x0 + 19, x0 + 26):                  # pogrubione kreski znaków:
        img[y0 - 18 : y0, x : x + 4] = 0                   # dotykają korpusu i drutu nad nim
        img[y0 - 42 : y0 - 21, x : x + 4] = 0              # podpis drutu nad drutem
    hline(img, 150, 450, y0 - 20)
    hline(img, 150, x0, 313)
    hline(img, x1, x1 + 30, 313)
    vline(img, x1 + 30, y0 - 22, 313)
    res = run(img)
    assert [g["cls"] for g in res["gates"]] == ["passive"], (res["gates"], res["rejected"])


def test_passive_with_text_touching_both_walls():
    # P-A3-2 R9: napis „0,25” dotyka górnej i dolnej ściany — obie ściany to jedna składowa
    # mapy linii; trzeba ją rozdzielić na dwie linie
    img = blank()
    x0, y0, x1, y1 = 250, 300, 306, 324
    frame(img, x0, y0, x1, y1, 4)
    img[y0 : y1 + 1, x0 + 12 : x0 + 38] = 0  # gruby, zlany napis od ściany do ściany
    hline(img, 150, x0, 312)
    hline(img, x1, 400, 312)
    res = run(img)
    assert [g["cls"] for g in res["gates"]] == ["passive"], (res["gates"], res["rejected"])


def test_vertical_resistor_30px_wide_is_passive():
    # pionowy rezystor 30 x 70: mieści się też w rozmiarach bramki — najpierw element bierny
    img = blank()
    x0, y0, x1, y1 = 280, 250, 310, 320
    frame(img, x0, y0, x1, y1, 4)
    vline(img, 295, 150, y0)
    vline(img, 295, y1, 420)
    res = run(img)
    assert [g["cls"] for g in res["gates"]] == ["passive"], (res["gates"], res["rejected"])


def test_small_box_with_two_leads_on_one_short_side_is_not_passive():
    img = blank()
    frame(img, 250, 300, 306, 328, t=4)
    hline(img, 150, 250, 314)
    hline(img, 306, 400, 307)
    hline(img, 306, 400, 321)
    res = run(img)
    assert not boxes(res, "passive"), res["gates"]


def test_passive_resistor():
    # P-X3-2 2-1 R1: 56 x 28 px, wyprowadzenia na krótkich bokach, tekst w środku
    img = blank()
    frame(img, 250, 300, 306, 328, t=5)
    text(img, "0.25", 258, 321, scale=0.45)
    hline(img, 150, 250, 314)
    hline(img, 306, 400, 314)
    res = run(img)
    assert boxes(res, "passive") and len(res["gates"]) == 1, res["gates"]
    assert near(res["gates"][0]["box"], (250, 300, 306, 328), 3)


# --------------------------------------------------------------------------- nie-bramki

def test_page_border_is_not_a_gate():
    img = blank(800, 700)
    frame(img, 20, 20, 779, 679, t=3)
    hline(img, 20, 200, 300)  # drut dochodzący do ramki strony
    gate_with_pins(img, 350, 300, 405, 390, ins=(325, 365), outs=(345,))
    res = run(img)
    assert len(res["gates"]) == 1
    assert near(res["gates"][0]["box"], (350, 300, 405, 390), 3)


def test_title_block_grid_is_not_a_gate():
    # tabliczka: kratka; prostokąty kratki mają T i skrzyżowania w narożnikach
    img = blank(900, 500)
    xs = [100, 160, 260, 330, 430, 520, 700]
    ys = [100, 130, 160, 190, 220, 260, 300]
    for y in ys:
        hline(img, xs[0], xs[-1], y)
    for x in xs:
        vline(img, x, ys[0], ys[-1])
    for k, y in enumerate(ys[:-1]):
        text(img, "A1", xs[1] + 8, y + 22, scale=0.45)
    # druty dochodzą do tabliczki z zewnątrz (nie powinny tworzyć pinów bramki)
    hline(img, 20, 100, 145)
    hline(img, 700, 860, 205)
    res = run(img)
    assert res["gates"] == [], res["gates"]


def test_page_number_frame_is_not_a_gate():
    # ramka numeru arkusza „2-97 | 6/12” — duży tekst, bez drutów
    img = blank(700, 400)
    frame(img, 200, 150, 333, 245, t=4)
    vline(img, 290, 150, 245)
    hline(img, 290, 333, 198)
    text(img, "2-97", 210, 210, scale=1.0, th=3)
    text(img, "6", 300, 185)
    text(img, "12", 298, 235)
    text(img, "12-006368-01-8A", 350, 210, scale=0.9, th=2)
    res = run(img)
    assert res["gates"] == [], res["gates"]


def test_text_block_is_not_a_gate():
    img = blank(700, 400)
    for k in range(6):
        text(img, "-CZYTRN +RA 2,3,4,5 M54", 60, 80 + 30 * k)
    res = run(img)
    assert res["gates"] == []


def test_wire_grid_rectangles_are_not_gates():
    # magistrala: druty krzyżujące się bez kropek tworzą prostokąty o „otwartych” narożnikach
    img = blank()
    for y in range(150, 400, 40):
        hline(img, 60, 540, y)
    for x in range(150, 500, 60):
        vline(img, x, 100, 450)
    res = run(img)
    assert res["gates"] == [], res["gates"]


def test_wire_loop_next_to_gate_does_not_change_gate():
    # 2-58 M64: piny 12 i 13 zwarte pionowym drutem — pętla przy boku bramki
    img = blank()
    x0, y0, x1, y1 = 250, 200, 305, 290
    gate_with_pins(img, x0, y0, x1, y1, outs=(245,))
    hline(img, 215, x0, 225)
    hline(img, 180, x0, 265)
    vline(img, 215, 150, 265)
    res = run(img)
    b = boxes(res)
    assert len(b) == 1 and near(b[0], (x0, y0, x1, y1), 3), b


def test_two_bars_without_sides_are_not_a_gate():
    # dwie równe poziome kreski z drutami przy końcach, bez boków
    img = blank()
    hline(img, 250, 305, 200, 5)
    hline(img, 250, 305, 290, 5)
    hline(img, 150, 248, 240)
    hline(img, 307, 400, 250)
    res = run(img)
    assert res["gates"] == []


def test_box_with_wires_on_one_side_only_is_not_a_gate():
    # ramka z drutami tylko z jednej strony (np. opis złącza) — bramka ma wejścia i wyjście
    img = blank()
    frame(img, 250, 200, 305, 290)
    for y in (220, 245, 270):
        hline(img, 150, 250, y)
    res = run(img)
    assert res["gates"] == []


def test_too_tall_single_box_is_rejected():
    img = blank(500, 900)
    gate_with_pins(img, 200, 50, 260, 810, ins=(100, 400, 700), outs=(450,))
    res = run(img)
    assert res["gates"] == []


def test_overlapping_frames_give_one_gate():
    # dwie nakładające się ramki (I-SK1-1 v1: ta sama bramka z dwóch par odcinków przesuniętych
    # o 3 px dawała dwa wpisy) — bramki się nie nakładają
    img = blank()
    gate_with_pins(img, 250, 200, 305, 300, ins=(230, 270), outs=(250,))
    frame(img, 262, 215, 317, 312, t=3)
    hline(img, 317, 390, 280)
    res = run(img)
    assert len(res["gates"]) == 1, res["gates"]


def test_oversized_frame_is_rejected():
    img = blank(800, 400)
    gate_with_pins(img, 200, 100, 500, 280, ins=(150, 200), outs=(180,))
    res = run(img)
    assert res["gates"] == []


def test_yaml_entries():
    img = blank()
    gate_with_pins(img, 250, 200, 305, 290, ins=(225, 265), outs=(245,))
    res = run(img)
    doc = cvg.to_yaml_doc(res, "2-1", "X", img.shape)
    g = doc["gates"][0]
    assert g["ref"] == "?" and g["gate"] is None and g["pins"] == [] and g["verified"] is False
    assert g["rotation"] == 0 and isinstance(g["x"], float) and isinstance(g["w"], int)
    assert abs(g["x"] - 277.5) <= 2 and abs(g["w"] - 55) <= 3
    assert all(set(p) == {"side", "px", "py"} for p in g["cv_pins"])
