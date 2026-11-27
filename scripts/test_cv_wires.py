"""Testy scripts/cv-wires.py na syntetycznych obrazach (bez skanów).

Uruchomienie (nie zostawia __pycache__ ani .pytest_cache):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy \\
      --with opencv-python-headless pytest -p no:cacheprovider scripts/test_cv_wires.py

Mutacje: CVW_MUTATE="NAZWA=wartość[,NAZWA=wartość]" nadpisuje PARAMS przed testami
(np. CVW_MUTATE="PIN_BAND=0"); CVW_SCRIPT=<plik> testuje zmienioną kopię skryptu (mutacje
kodu). Każda mutacja z listy w docs powinna wywalić co najmniej jeden test.

Rysunek syntetyczny jak skan 200 dpi: drut 2–3 px (dokładna szerokość, bez zaokrągleń
cv2.line), ramka bramki 5 px, kropka r = 4 + szerokość drutu (zmierzone kropki: promień
koła wpisanego 6–8 px przy kresce 2–3 px).
"""
from __future__ import annotations

import ast
import importlib.util
import os
from pathlib import Path

import cv2
import numpy as np
import pytest

_src = os.environ.get("CVW_SCRIPT") or Path(__file__).with_name("cv-wires.py")  # mutacje kodu
_spec = importlib.util.spec_from_file_location("cv_wires", _src)
cvw = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(cvw)

for _kv in filter(None, os.environ.get("CVW_MUTATE", "").split(",")):
    _k, _v = _kv.split("=", 1)
    assert _k in cvw.PARAMS, _k
    cvw.PARAMS[_k] = ast.literal_eval(_v)

P0 = {"TITLE": None}  # syntetyczny arkusz jest mały — bez maski tabliczki
W = 3  # domyślna szerokość drutu


# --------------------------------------------------------------------------- rysowanie

def blank(w=420, h=420):
    return np.full((h, w), 255, np.uint8)


def hline(img, x0, x1, y, w=W, val=0):
    img[y - w // 2 : y - w // 2 + w, x0 : x1 + 1] = val


def vline(img, x, y0, y1, w=W, val=0):
    img[y0 : y1 + 1, x - w // 2 : x - w // 2 + w] = val


def dot(img, x, y, r=None, w=W):
    cv2.circle(img, (x, y), r if r is not None else 4 + w, 0, -1)


def frame(img, x0, y0, x1, y1, t=5):
    """Ramka bramki: zewnętrzne krawędzie x0..x1, y0..y1, grubość t."""
    img[y0 : y0 + t, x0 : x1 + 1] = 0
    img[y1 - t + 1 : y1 + 1, x0 : x1 + 1] = 0
    img[y0 : y1 + 1, x0 : x0 + t] = 0
    img[y0 : y1 + 1, x1 - t + 1 : x1 + 1] = 0


def gate(x0, y0, x1, y1, pins=()):
    return {"ref": "M1", "gate": "A", "x": (x0 + x1) / 2, "y": (y0 + y1) / 2,
            "w": x1 - x0, "h": y1 - y0, "rotation": 0,
            "pins": [{"num": n, "side": s, "px": px, "py": py, "net": "X"} for n, s, px, py in pins]}


def run(img, gates=None, **over):
    """gates=None -> tryb b (wykrywanie bramek); lista -> tryb a."""
    return cvw.digitize(img, gates, {**P0, **over})


def junctions(res):
    return [j for n in res["nets"] for j in n["junctions"]]


def near(p, q, tol=3):
    return abs(p[0] - q[0]) <= tol and abs(p[1] - q[1]) <= tol


def total_len(net):
    return sum(abs(a - c) + abs(b - d) for a, b, c, d in net["pieces"])


def net_at(res, pt, tol=3):
    for n in res["nets"]:
        if any(cvw._dist_pt_seg(pt, p) <= tol for p in n["pieces"]):
            return n["name"]
    return None


# --------------------------------------------------------------------------- połączenia

@pytest.mark.parametrize("w", [2, 3, 4, 5, 6])
def test_cross_with_dot_stroke_sweep(w):
    img = blank()
    hline(img, 50, 350, 200, w)
    vline(img, 200, 50, 350, w)
    dot(img, 200, 200, w=w)
    res = run(img, [])
    assert len(res["nets"]) == 1
    js = junctions(res)
    assert len(js) == 1 and near(js[0], (200, 200))
    ends = [p for x0, y0, x1, y1 in res["nets"][0]["pieces"] for p in ((x0, y0), (x1, y1))]
    assert ends.count(tuple(js[0])) == 4  # reguła viewera: >= 3 końce = kropka


@pytest.mark.parametrize("w", [2, 3, 4, 5, 6])
def test_cross_without_dot_stroke_sweep(w):
    img = blank()
    hline(img, 50, 350, 200, w)
    vline(img, 200, 50, 350, w)
    res = run(img, [])
    assert len(res["nets"]) == 2
    assert junctions(res) == []


@pytest.mark.parametrize("w", [2, 3, 5])
def test_t_joint_with_dot_is_connected(w):
    img = blank()
    hline(img, 50, 350, 200, w)
    vline(img, 200, 200, 350, w)
    dot(img, 200, 200, w=w)
    res = run(img, [])
    assert len(res["nets"]) == 1
    js = junctions(res)
    assert len(js) == 1 and near(js[0], (200, 200))


def test_t_joint_without_dot_follows_t_needs_dot():
    img = blank()
    hline(img, 50, 350, 200)
    vline(img, 200, 200, 350)
    assert len(run(img, [])["nets"]) == 2  # konwencja rysunku: prawdziwe T ma kropkę
    res = run(img, [], T_NEEDS_DOT=False)  # tryb dosłowny: T bez kropki też łączy
    assert len(res["nets"]) == 1
    assert len(junctions(res)) == 1


def test_l_corner_without_dot_is_connected():
    img = blank()
    hline(img, 50, 200, 200)
    vline(img, 200, 200, 350)
    res = run(img, [])
    assert len(res["nets"]) == 1
    assert junctions(res) == []


def test_hollow_dot_is_a_dot():
    # kropka blada w środku (P-X3-2 2-1 (1480, 243)): po progu ma dziurę 3x3 o szarości ~170;
    # bez zamalowania promień koła wpisanego spada poniżej DOT_DT
    img = blank()
    hline(img, 50, 350, 200)
    vline(img, 200, 200, 350)
    dot(img, 200, 200, r=8)
    img[199:202, 199:202] = 170
    assert len(run(img, [])["nets"]) == 1


@pytest.mark.parametrize("gap", [10, 12, 14, 16, 19, 22])
def test_dot_does_not_bridge_to_parallel_wire(gap):
    # T z kropką, a pod nim równoległy drut: domknięcie nie może przeciągnąć trzonu T
    # przez kropkę na sąsiedni drut (2-58 [884,1175,884,1201], 2-61 [690,678,792,678])
    img = blank()
    hline(img, 50, 350, 200)
    vline(img, 200, 60, 200)
    dot(img, 200, 200)
    hline(img, 50, 350, 200 + gap)
    for tnd in (True, False):
        res = run(img, [], T_NEEDS_DOT=tnd)
        assert len(res["nets"]) == 2, (gap, tnd)
        assert net_at(res, (100, 200)) != net_at(res, (100, 200 + gap))
        stub = [p for n in res["nets"] for p in n["pieces"]
                if p[0] == p[2] and max(p[1], p[3]) > 200 + 3]
        assert stub == [], stub


def test_negation_bubble_on_crossing_is_not_a_dot():
    # kółko negacji (r=6, pierścień 2 px) na skrzyżowaniu: puste w środku, to nie kropka
    img = blank()
    hline(img, 50, 350, 200)
    vline(img, 200, 50, 350)
    cv2.circle(img, (200, 200), 6, 0, 2)
    assert len(run(img, [])["nets"]) == 2


def test_pale_hollow_dot_is_still_a_dot():
    # kropka szara w środku (po progu ma małą dziurę o szarości ~180)
    img = blank()
    hline(img, 50, 350, 200)
    vline(img, 200, 50, 350)
    dot(img, 200, 200, r=8)
    img[199:202, 199:202] = 180
    assert len(run(img, [])["nets"]) == 1


def test_speckle_hole_in_crossing_blot_is_not_a_dot():
    # 1-pikselowa szara dziurka (szum JPEG) w kleksie na skrzyżowaniu cienkich linii
    # (SM-POSE11 2-97): po zamalowaniu kleks ma r ~4 < DOT_DT + DOT_FILL_EXTRA
    img = blank()
    hline(img, 50, 350, 200, 2)
    vline(img, 200, 50, 350, 2)
    cv2.circle(img, (200, 200), 4, 0, -1)
    img[200, 200] = 170
    res = run(img, [])
    assert res["params"]["DOT_D"] == 7
    assert len(res["nets"]) == 2


def test_parallel_stub_next_to_dot_is_merged():
    # równoległy pasek 4 px obok drutu przy kropce (2-59 [1290,1031,1318,1031]) to ten sam drut
    img = blank()
    hline(img, 50, 350, 200)
    hline(img, 280, 330, 194, 2)
    vline(img, 330, 200, 350)
    dot(img, 330, 200)
    res = run(img, [])
    assert len(res["nets"]) == 1
    hs = [p for p in res["nets"][0]["pieces"] if p[1] == p[3]]
    assert {p[1] for p in hs} == {200}, hs


# --------------------------------------------------------------------------- przerwy i tekst

def test_wire_with_2px_scan_gap_is_one_segment():
    img = blank()
    hline(img, 50, 198, 200)
    hline(img, 201, 350, 200)
    res = run(img, [])
    assert len(res["nets"]) == 1
    assert len(res["nets"][0]["pieces"]) == 1
    x0, y0, x1, y1 = res["nets"][0]["pieces"][0]
    assert min(x0, x1) <= 52 and max(x0, x1) >= 348 and abs(y0 - 200) <= 1


def test_faint_dashed_section_is_bridged():
    # blady odcinek z kresek 10 px (usuwanych jako „znaki”) między pełnymi kawałkami
    img = blank()
    hline(img, 30, 150, 200)
    for x in range(156, 216, 16):
        hline(img, x, x + 9, 200, 1)
    hline(img, 220, 390, 200)
    res = run(img, [])
    assert len(res["nets"]) == 1
    xs = [v for p in res["nets"][0]["pieces"] for v in (p[0], p[2])]
    assert min(xs) <= 32 and max(xs) >= 388


def test_pale_wire_is_detected():
    img = blank()
    hline(img, 50, 350, 120)  # czarny — ustawia próg Otsu
    vline(img, 380, 50, 350)
    hline(img, 50, 350, 250, val=175)  # blady drut
    res = run(img, [])
    assert net_at(res, (200, 250)) is not None


def test_wire_touching_text_has_no_spurs():
    img = blank()
    hline(img, 50, 350, 200)
    cv2.putText(img, "13", (120, 199), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    cv2.putText(img, "-RB", (230, 199), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    res = run(img, [])
    assert len(res["nets"]) == 1
    net = res["nets"][0]
    assert all(y0 == y1 for x0, y0, x1, y1 in net["pieces"]), net["pieces"]
    assert abs(total_len(net) - 300) <= 6
    assert len(net["free"]) == 2


@pytest.mark.parametrize("iters", [1, 5])
def test_spur_removal_rebuilds_graph(iters):
    # odgałęzienie usunięte w ostatnim (tu: jedynym) obrocie przesuwa indeksy odcinków —
    # graf musi być zbudowany od nowa, inaczej nety składają się z cudzych węzłów
    img = blank()
    hline(img, 100, 350, 100)
    vline(img, 100, 76, 100)  # kreska znaku na końcu drutu (narożnik)
    hline(img, 50, 350, 200)
    hline(img, 50, 350, 300)
    vline(img, 380, 150, 350)
    res = run(img, [], SPUR_ITERS=iters)
    pieces = [p for n in res["nets"] for p in n["pieces"]]
    assert all(p[0] == p[2] or p[1] == p[3] for p in pieces), pieces
    assert len(res["nets"]) == 4
    assert net_at(res, (200, 100)) and net_at(res, (100, 90)) is None


def test_text_stroke_at_wire_end_is_pruned_as_spur():
    # kreska znaku przyklejona do końca drutu tworzy narożnik L — to nie drut
    img = blank()
    hline(img, 100, 350, 200)
    vline(img, 100, 178, 200, 3)
    res = run(img, [])
    assert len(res["nets"]) == 1
    assert all(p[1] == p[3] for p in res["nets"][0]["pieces"]), res["nets"][0]["pieces"]


def test_isolated_short_dash_is_not_a_net():
    img = blank()
    hline(img, 50, 350, 300)
    hline(img, 100, 134, 150, 2)  # samotna kreska 35 px (np. podkreślenie)
    res = run(img, [])
    assert len(res["nets"]) == 1


def test_dense_text_glued_between_wires_is_split():
    # gęsty tekst sklejony z oboma drutami (2-60 y 1060/1086) — po domknięciu jedna gruba
    # składowa; bez rozdzielania (MAX_THICK) powstaje fałszywa linia pośrodku
    img = blank()
    hline(img, 50, 350, 180)
    hline(img, 50, 350, 200)
    for y in range(182, 199, 2):
        hline(img, 150, 249, y, 1)
    res = run(img, [])
    ys = sorted({p[1] for n in res["nets"] for p in n["pieces"] if p[1] == p[3]})
    assert ys == [180, 200], ys
    assert len(res["nets"]) == 2


def test_blot_at_crossing_is_not_a_dot():
    # kleks na skrzyżowaniu (2-59 (500, 1137): promień 3,6 px przy kresce 2,35) to nie kropka
    img = blank()
    # kleks-romb 7 px: przechodzi przez otwarcie dyskiem DOT_D=7, ale promień koła
    # wpisanego ~3,2 px < DOT_DT (sw + 1,6 ~ 3,6)
    hline(img, 50, 350, 200, 2)
    vline(img, 200, 50, 350, 2)
    k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (7, 7)).astype(bool)
    img[197:204, 197:204][k] = 0
    res = run(img, [])
    assert res["params"]["DOT_D"] == 7
    assert len(res["nets"]) == 2


def test_text_between_parallel_wires_does_not_merge_them():
    img = blank()
    hline(img, 50, 350, 180)
    hline(img, 50, 350, 206)
    for x in range(70, 330, 30):
        cv2.putText(img, "+RB", (x, 203), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    res = run(img, [])
    assert len(res["nets"]) == 2
    ys = sorted({p[1] for n in res["nets"] for p in n["pieces"] if p[1] == p[3]})
    assert ys == [180, 206], ys


# --------------------------------------------------------------------------- bramki

def test_pin_gets_net_of_wire_ending_at_gate_with_bubble():
    img = blank()
    frame(img, 150, 150, 210, 250)
    cv2.circle(img, (216, 180), 6, 0, 2)  # kółko negacji
    hline(img, 222, 350, 180)
    hline(img, 50, 150, 220)
    gates = cvw.clean_gates([gate(150, 150, 210, 250, [(2, "right", 210, 180), (1, "left", 150, 220)])])
    res = run(img, gates)
    hit, tot = cvw.assign_pins(gates, res["nets"], res["params"])
    assert (hit, tot) == (2, 2)
    out_net = gates[0]["pins"][0]["net"]
    net = next(n for n in res["nets"] if n["name"] == out_net)
    assert any(near(f, (210, 180), 4) for f in net["free"])
    assert gates[0]["pins"][0]["net"] != gates[0]["pins"][1]["net"]


def test_clean_gates_whitelist():
    g = gate(0, 0, 10, 10, [(1, "left", 0, 5)])
    g.update(verified=True, disconnected=True, note="x", label_left="1")
    g["pins"][0]["cross"] = {"page": "4"}
    (c,) = cvw.clean_gates([g])
    assert c["verified"] is False
    assert set(c) == {"ref", "gate", "x", "y", "w", "h", "rotation", "pins", "verified"}
    assert set(c["pins"][0]) == {"num", "side", "px", "py", "net"} and c["pins"][0]["net"] == ""


def test_pin_number_digits_next_to_gate_do_not_join_pins():
    # numery pinów stoją przy końcach drutów pinów — bez pasa PIN_BAND kreska cyfry
    # tworzy narożniki z oboma drutami i skleja dwa piny
    img = blank()
    frame(img, 200, 150, 260, 280)
    hline(img, 60, 200, 180)
    hline(img, 60, 200, 206)
    vline(img, 192, 182, 204, 3)  # pionowa kreska cyfry między drutami, przy krawędzi
    gates = cvw.clean_gates([gate(200, 150, 260, 280, [(1, "left", 200, 180), (2, "left", 200, 206)])])
    res = run(img, gates)
    cvw.assign_pins(gates, res["nets"], res["params"])
    n1, n2 = (p["net"] for p in gates[0]["pins"])
    assert n1 and n2 and n1 != n2


def test_stacked_pin_number_ones_are_not_a_wire():
    # pionowy słupek „1” numerów pinów 22 px od krawędzi (2-61 [770,651,770,706]):
    # każda „1” stoi na drucie pinu, domknięcie skleja je w pionową kreskę
    img = blank()
    frame(img, 200, 140, 260, 280)
    for y in (180, 206, 232, 258):
        hline(img, 60, 200, y)
        vline(img, 178, y - 22, y - 2, 2)
    res = run(img, [gate(200, 140, 260, 280)])
    vert = [p for n in res["nets"] for p in n["pieces"] if p[0] == p[2] and abs(p[0] - 178) <= 3]
    assert vert == [], vert
    assert len(res["nets"]) == 4


@pytest.mark.parametrize("dx", [12, 15, 18])
def test_wire_running_in_pin_band_is_kept(dx):
    # pionowy drut 12–18 px od krawędzi z pinami biegnie wzdłuż całej bramki
    img = blank()
    frame(img, 200, 120, 260, 300)
    vline(img, 200 - dx, 60, 360)
    hline(img, 60, 200 - dx, 360)
    res = run(img, [gate(200, 120, 260, 300)])
    n = net_at(res, (200 - dx, 100))
    assert n is not None and n == net_at(res, (200 - dx, 340))


def test_gate_frame_beyond_yaml_rect_is_not_a_wire():
    # prostokąt bramki z YAML-a mniejszy od ramki (2-58 M53) — reszta ramki to nie drut
    img = blank()
    frame(img, 200, 143, 260, 300)  # ramka zaczyna się 7 px nad prostokątem z YAML-a
    hline(img, 60, 200, 220)
    res = run(img, [gate(200, 150, 260, 300)])
    assert net_at(res, (230, 145)) is None
    assert len(res["nets"]) == 1


def test_mode_b_detects_gate_and_keeps_wires():
    img = blank()
    frame(img, 200, 120, 260, 300)
    hline(img, 60, 200, 160)
    hline(img, 60, 200, 260)
    hline(img, 260, 380, 210)
    vline(img, 120, 160, 260)
    dot(img, 120, 160)
    dot(img, 120, 260)
    res = run(img)
    assert len(res["boxes"]) == 1
    x0, y0, x1, y1 = res["boxes"][0]
    assert near((x0, y0), (200, 120), 4) and near((x1, y1), (260, 300), 4)
    assert len(res["nets"]) == 2  # wejścia połączone kropkami + wyjście
    assert net_at(res, (230, 122)) is None  # ramka nie jest drutem


def test_mode_b_two_bars_without_sides_are_not_a_gate():
    # dwie grube poziome belki o zgodnych końcach, bez boków — to nie bramka
    img = blank()
    img[120:125, 200:261] = 0
    img[296:301, 200:261] = 0
    hline(img, 60, 380, 210)
    res = run(img)
    assert res["boxes"] == []


@pytest.mark.parametrize("size", [(300, 180), (60, 760)])
def test_mode_b_oversized_box_is_rejected(size):
    # 300 px szerokości > BOX_WMAX albo 760 px wysokości > BOX_HMAX
    w, h = size
    img = blank(w=w + 300, h=h + 200)
    frame(img, 150, 100, 150 + w, 100 + h)
    for y in range(106, 100 + h, 10):  # dużo cienkich drutów: sw ~ 3, BOX_T = 5
        hline(img, 10, 140, y)
    for x in range(160 + w, w + 290, 10):
        vline(img, x, 10, h + 190)
    res = run(img)
    assert res["params"]["BOX_T"] <= 5
    assert res["boxes"] == []


def test_mode_b_box_side_with_gap_is_rejected():
    # bok z przerwą 12 px (> BOX_SIDE_GAP) — czworobok niedomknięty
    img = blank()
    frame(img, 200, 120, 260, 300)
    img[200:212, 200:205] = 255
    img[200:212, 256:261] = 255
    res = run(img)
    assert res["boxes"] == []


def test_mode_b_stack_with_thin_top_frame_is_one_rect():
    # stos dwóch bramek (P-X3-2 2-1 M2): grube są tylko przegródka i dół, boki i górna
    # krawędź cienkie — prostokąt dolnej bramki trzeba przedłużyć w górę stosu
    img = blank()
    img[100:340, 200:202] = 0  # cienki lewy bok
    img[100:340, 259:261] = 0  # cienki prawy bok
    img[100:102, 200:261] = 0  # cienka górna krawędź
    img[218:223, 200:261] = 0  # gruba przegródka
    img[336:341, 200:261] = 0  # gruby dół
    hline(img, 60, 200, 150)
    hline(img, 60, 200, 280)
    res = run(img)
    assert len(res["boxes"]) == 1, res["boxes"]
    x0, y0, x1, y1 = res["boxes"][0]
    assert y0 <= 104 and y1 >= 336, res["boxes"]


def test_mode_b_thick_wires_are_not_gates():
    # drut 5 px, ramka 8 px: grube druty nie mogą zostać „bramką” (cały rysunek zamaskowany)
    img = blank()
    frame(img, 200, 120, 270, 300, t=8)
    for y in (160, 200, 240):
        hline(img, 40, 200, y, 5)
    hline(img, 270, 390, 210, 5)
    vline(img, 100, 40, 380, 5)
    hline(img, 40, 390, 380, 5)
    res = run(img)
    assert len(res["boxes"]) == 1
    assert len(res["nets"]) >= 4


@pytest.mark.parametrize("sw,dot_d", [(2.09, 7), (2.58, 7), (2.97, 9), (6.0, 15)])
def test_derive_dot_d_nearest_odd(sw, dot_d):
    # DOT_D = najbliższa nieparzysta od 7 + 2 (sw - SW_REF); 7,76 -> 7, nie 9
    assert cvw.derive(cvw.PARAMS, sw)["DOT_D"] == dot_d


@pytest.mark.parametrize("ortho", [True, False])
def test_yaml_doc_roundtrip(ortho):
    img = blank()
    hline(img, 50, 350, 200)
    vline(img, 200, 200, 350)
    dot(img, 200, 200)
    res = cvw.digitize(img, [], P0, ortho=ortho)
    doc = cvw.to_yaml_doc(res, "x-1", "PKG", [], img.shape)
    assert doc["kronikarz"] == "1"
    (name, net), = doc["nets"].items()
    assert name.startswith("CVNET_")
    assert all(len(s) == 4 and all(isinstance(v, int) for v in s) for s in net["segments"])
