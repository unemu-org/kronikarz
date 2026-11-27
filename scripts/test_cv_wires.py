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


GLYPHS = {  # pochyłe znaki szablonowe (własny rysunek): łamane w polu 0..0.7 x 0..1, y w dół
    "1": [[(0.15, 0.2), (0.45, 0.0), (0.45, 1.0)]],
    "2": [[(0.05, 0.2), (0.3, 0.0), (0.6, 0.1), (0.6, 0.35), (0.05, 1.0), (0.65, 1.0)]],
    "3": [[(0.05, 0.1), (0.35, 0.0), (0.6, 0.15), (0.55, 0.4), (0.3, 0.5), (0.6, 0.65), (0.6, 0.9),
           (0.3, 1.0), (0.0, 0.9)]],
    "4": [[(0.5, 1.0), (0.5, 0.0), (0.0, 0.65), (0.7, 0.65)]],
    "5": [[(0.6, 0.0), (0.1, 0.0), (0.05, 0.45), (0.4, 0.4), (0.6, 0.6), (0.55, 0.9), (0.3, 1.0),
           (0.0, 0.9)]],
    "L": [[(0.05, 0.0), (0.05, 1.0), (0.6, 1.0)]],
    "+": [[(0.0, 0.55), (0.5, 0.55)], [(0.25, 0.3), (0.25, 0.8)]],
    "8": [[(0.3, 0.0), (0.6, 0.15), (0.55, 0.4), (0.3, 0.5), (0.05, 0.4), (0.05, 0.15), (0.3, 0.0)],
          [(0.3, 0.5), (0.6, 0.65), (0.6, 0.9), (0.3, 1.0), (0.0, 0.9), (0.0, 0.65), (0.3, 0.5)]],
    "9": [[(0.6, 0.4), (0.3, 0.5), (0.05, 0.4), (0.05, 0.15), (0.3, 0.0), (0.6, 0.15), (0.6, 0.7),
           (0.4, 1.0), (0.05, 0.95)]],
    # v6
    "B": [[(0.05, 1.0), (0.05, 0.0), (0.45, 0.0), (0.6, 0.15), (0.55, 0.4), (0.3, 0.5), (0.05, 0.5)],
          [(0.3, 0.5), (0.6, 0.62), (0.6, 0.88), (0.45, 1.0), (0.05, 1.0)]],
    "N": [[(0.0, 1.0), (0.0, 0.0), (0.6, 1.0), (0.6, 0.0)]],
    "D": [[(0.05, 0.0), (0.05, 1.0), (0.4, 1.0), (0.6, 0.75), (0.6, 0.25), (0.4, 0.0), (0.05, 0.0)]],
    "T": [[(0.0, 0.0), (0.7, 0.0)], [(0.35, 0.0), (0.35, 1.0)]],
    "Y": [[(0.0, 0.0), (0.35, 0.5), (0.7, 0.0)], [(0.35, 0.5), (0.35, 1.0)]],
    "-": [[(0.1, 0.55), (0.55, 0.55)]],
}


def text(img, s, x, y_base, h=20, th=4, slant=0.22):
    """Napis szablonem jak na skanie 200 dpi: znaki wysokości h px, kreska th px, pochylenie
    slant (2-62: ~5 px na 20 px); dolny brzeg kreski w wierszu y_base."""
    for i, ch in enumerate(s):
        x0 = x + i * 0.6 * h
        for line in GLYPHS[ch]:
            pts = [(int(round(x0 + 0.75 * px * h + slant * (1 - py) * h)),
                    int(round(y_base - th // 2 - (1 - py) * (h - th)))) for px, py in line]
            cv2.polylines(img, [np.array(pts, np.int32)], False, 0, th, lineType=cv2.LINE_8)


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


@pytest.mark.parametrize("h", [21, 22, 24])
def test_pin_number_stack_touching_wires_is_not_a_wire(h):
    # 2-62 M24: numery pinów 14/13/12 stoją na drutach pinów i prawie dotykają drutu nad sobą;
    # w v4 słupek był „pewną” linią pionową (i przechodził przez pas pinów, bo bieg łączył
    # się przez druty) — druty WA/WE/EN skręcały przez cyfry i sklejały piny
    img = blank()
    frame(img, 200, 120, 260, 300)
    for y in (160, 186, 212, 238):
        hline(img, 40, 200, y)
    for y, s in ((186, "14"), (212, "13"), (238, "12")):
        text(img, s, 164, y - 2, h=h)
    g = cvw.clean_gates([gate(200, 120, 260, 300, [(14, "left", 200, 186), (13, "left", 200, 212),
                                                   (12, "left", 200, 238)])])
    res = run(img, g)
    cvw.assign_pins(g, res["nets"], res["params"])
    nets = [p["net"] for p in g[0]["pins"]]
    assert all(nets) and len(set(nets)) == 3, nets
    vert = [p for n in res["nets"] for p in n["pieces"] if p[0] == p[2]]
    assert vert == [], vert
    assert len(res["nets"]) == 4


def test_label_stack_on_wires_is_not_a_wire():
    # 2-62 lewy dół: etykiety „+L15”…„+L12” na kolejnych drutach (co 26 px) — kreski „L”
    # i „1” tworzyły pionowe „druty” przez cały słupek
    img = blank()
    for i, y in enumerate((150, 176, 202, 228)):
        hline(img, 40, 380, y)
        text(img, f"+L1{5 - i}", 60, y - 2, h=22)
    res = run(img, [])
    assert len(res["nets"]) == 4
    assert all(p[1] == p[3] for n in res["nets"] for p in n["pieces"]), res["nets"]


def test_short_stub_with_digit_reaches_pin():
    # 2-58 M64.12 / M40.3: od narożnika do pinu odcinek ~25 px, na nim numer pinu — w v4
    # cała składowa (odcinek + cyfra) szła do kosza jako znak i pin zostawał bez drutu
    img = blank()
    frame(img, 200, 120, 260, 300)
    hline(img, 40, 200, 150)
    vline(img, 168, 150, 220)
    dot(img, 168, 150)
    hline(img, 168, 200, 220)
    text(img, "12", 174, 218, h=20)
    g = cvw.clean_gates([gate(200, 120, 260, 300, [(2, "left", 200, 150), (12, "left", 200, 220)])])
    res = run(img, g)
    cvw.assign_pins(g, res["nets"], res["params"])
    n2, n12 = (p["net"] for p in g[0]["pins"])
    assert n12 and n12 == n2


def test_short_corner_wire_around_digit_is_kept():
    # 2-62 M24.C1: drut z dołu skręca w górę 22–28 px od krawędzi i krótkim odcinkiem
    # dochodzi do pinu; cyfra „3” stoi w środku narożnika i dotyka obu kawałków
    img = blank()
    frame(img, 200, 120, 260, 300)
    hline(img, 40, 200, 206)              # drut innego pinu, krzyżuje pion bez kropki
    hline(img, 40, 172, 232)              # drut C1 z lewej, narożnik w x=172
    vline(img, 172, 180, 232)
    hline(img, 172, 200, 180)             # krótki odcinek do pinu C1 (< MIN_LEN1)
    text(img, "3", 176, 201, h=18)        # dotyka odcinka i pionu, nie drutu pod spodem
    g = cvw.clean_gates([gate(200, 120, 260, 300, [(1, "left", 200, 180), (2, "left", 200, 206)])])
    res = run(img, g, SW=3.0)  # mało drutów na obrazku: pomiar sw łapałby kreski znaków
    cvw.assign_pins(g, res["nets"], res["params"])
    n1, n2 = (p["net"] for p in g[0]["pins"])
    assert n1 and n1 == net_at(res, (100, 232)), res["nets"]
    assert n2 and n2 != n1


def test_wire_through_dot_to_pin_between_digits_is_kept():
    # 2-64 M7.8: drut z lewej przez kropkę na pionie i dalej ~20 px do pinu; cyfry „8” nad
    # i „9” pod nim dotykają odcinka. Przebieg „v” (odjęte piony) widzi sam odcinek z cyframi
    # — bez ochrony pewnych linii poziomych ginął razem z nimi
    img = blank()
    frame(img, 200, 120, 260, 300)
    hline(img, 40, 200, 180)
    vline(img, 180, 180, 330)
    dot(img, 180, 180)
    hline(img, 40, 200, 206)
    text(img, "8", 186, 178, h=20, slant=0.15)
    text(img, "9", 186, 203, h=20, slant=0.15)
    g = cvw.clean_gates([gate(200, 120, 260, 300, [(8, "left", 200, 180), (9, "left", 200, 206)])])
    res = run(img, g)
    cvw.assign_pins(g, res["nets"], res["params"])
    n8, n9 = (p["net"] for p in g[0]["pins"])
    assert n8 and n8 == net_at(res, (100, 180)) == net_at(res, (180, 300)), res["nets"]
    assert n9 and n9 != n8


def test_corner_below_dot_with_digit_is_kept():
    # 2-58 M40.1: z kropki pion 27 px w dół i odcinek 25 px do pinu, cyfra „1” w narożniku;
    # pół kropki wydłuża składową — rdzeń liczony względem rozmiaru bez kropki
    img = blank()
    frame(img, 200, 120, 260, 300)
    hline(img, 40, 172, 200)
    vline(img, 172, 160, 227)
    dot(img, 172, 200)
    hline(img, 172, 200, 160)
    hline(img, 172, 200, 227)
    text(img, "1", 180, 224, h=20)
    g = cvw.clean_gates([gate(200, 120, 260, 300, [(3, "left", 200, 160), (1, "left", 200, 227)])])
    res = run(img, g, SW=3.0)
    cvw.assign_pins(g, res["nets"], res["params"])
    n3, n1 = (p["net"] for p in g[0]["pins"])
    assert n1 and n1 == n3 == net_at(res, (100, 200)), res["nets"]


def test_upright_digit_between_pin_wires_does_not_join_pins():
    # 2-65 C/Q: prosta kreska cyfry przy krawędzi bramki dotyka drutu pinu nad i pod sobą;
    # to dotknięcie (drut biegnie dalej do bramki), nie narożnik — piny zostają osobno
    img = blank()
    frame(img, 200, 120, 260, 300)
    hline(img, 40, 200, 180)
    hline(img, 40, 200, 206)
    text(img, "1", 188, 204, h=23, slant=0.0)
    g = cvw.clean_gates([gate(200, 120, 260, 300, [(11, "left", 200, 180),
                                                   (13, "left", 200, 206)])])
    res = run(img, g, SW=3.0)
    cvw.assign_pins(g, res["nets"], res["params"])
    n11, n13 = (p["net"] for p in g[0]["pins"])
    assert n11 and n13 and n11 != n13, res["nets"]


def test_wire_between_close_dots_is_kept():
    # 2-65 (766, 1400): pion między dwiema kropkami na drutach 25 px od siebie — po odjęciu
    # drutów reszta (pół kropki + 8 px pionu + pół kropki) wyglądała na znak
    img = blank()
    hline(img, 40, 380, 200)
    hline(img, 40, 380, 225)
    vline(img, 200, 120, 330)
    dot(img, 200, 200)
    dot(img, 200, 225)
    res = run(img, [])
    assert len(res["nets"]) == 1, res["nets"]


def test_stacked_port_chevrons_are_not_a_wire():
    # 2-62 A18/A05, 2-61 x 1722: zewnętrzne „>” sąsiednich portów jeden nad drugim — końce
    # ukośnych kresek w jednej kolumnie domknięcie (GAP2) i mostkowanie sklejają w pionową
    # „linię”, pod którą tusz jest na małej części długości. Synteza odtwarza to tylko dla
    # części kształtów (szewron 20 x 40 px; przy 12–16 px szerokości kreski są zbyt strome,
    # od ~24 x 46 px pion nie powstaje wcale)
    img = blank()
    for i in range(4):
        y0 = 100 + 40 * i
        hline(img, 40, 280, y0 + 20)                       # drut do portu
        for x in (282, 330):                               # lewy i prawy szewron portu
            cv2.polylines(img, [np.array([(x, y0), (x + 20, y0 + 20), (x, y0 + 40)], np.int32)],
                          False, 0, 3)
    # profil osi (v6, AXIS_RUN) też usuwa ten pion — wyłączony, żeby test sprawdzał MIN_COVER
    res = run(img, [], AXIS_RUN=None)
    vert = [p for n in res["nets"] for p in n["pieces"] if p[0] == p[2]]
    assert vert == [], vert
    assert [p for n in run(img, [])["nets"] for p in n["pieces"] if p[0] == p[2]] == []


def test_skewed_long_wire_with_dot_is_not_split():
    # 2-66 x ≈ 494–500: długi pion ze skosem skanu i kropką jest szerszy niż MAX_THICK;
    # profil bez odjęcia skosu brał tylko kolumny dolnej części i gubił kawałek nad kropką
    img = blank(h=440)
    for y in range(30, 411):  # skos nierówny: górne 40 % odchylone o 8 px, reszta prosto
        x = 200 + (int(round(8 * (182 - y) / 152)) if y < 182 else 0)
        img[y, x - 1 : x + 2] = 0
    hline(img, 40, 207, 60)
    dot(img, 207, 60)
    hline(img, 100, 380, 300)
    res = run(img, [])
    v = [p for n in res["nets"] for p in n["pieces"] if p[0] == p[2]]
    assert v and min(min(p[1], p[3]) for p in v) <= 35 and max(max(p[1], p[3]) for p in v) >= 405, v


@pytest.mark.parametrize("w", [2, 3])
@pytest.mark.parametrize("r", [5, 6, 7])
@pytest.mark.parametrize("up", [18, 21, 24])
def test_pullup_stub_from_dot_into_gate(w, r, up):
    # recenzja v5 (SPP-32-16 2-137, SM-POSE11 2-100): z kropki na drucie pion `up` px w górę
    # i krótki odcinek do pinu (rezystor), bez tekstu. Przebieg „h” nie odejmuje pionu, więc
    # całe L jest składową w rozmiarze znaku; ratuje je rdzeń z kropką jako kotwicą
    img = blank()
    frame(img, 200, 200, 260, 380)
    hline(img, 20, 400, 395, w=w)
    dot(img, 170, 395, r=r)
    vline(img, 170, 395 - up, 395, w=w)
    hline(img, 170, 200, 395 - up, w=w)
    for k in range(4):
        hline(img, 20, 160, 40 + 40 * k, w=w)
    g = cvw.clean_gates([gate(200, 200, 260, 380, [(1, "left", 200, 395 - up)])])
    res = run(img, g, SW=float(w))
    cvw.assign_pins(g, res["nets"], res["params"])
    assert g[0]["pins"][0]["net"] and g[0]["pins"][0]["net"] == net_at(res, (60, 395)), res["nets"]


@pytest.mark.parametrize("r", [5, 6, 7])
def test_filled_glyph_below_corner_keeps_corner(r):
    # 2-63 (recenzja): zamalowane „0” etykiety pod drutem, obok (12 px w lewo) prawdziwy
    # narożnik L, pod znakiem kreska litery na drucie etykiety. Nie ma pionu przez znak,
    # drut narożnika nie wchodzi w znak, a oba ramiona narożnika są w jednym necie.
    # (Synteza nie odtwarza błędu z 2-63 — test pilnuje zachowania; mechanizmy sprawdzają
    # dot_anchor_only_on_line i core_keeps_stroke_only_across_its_run)
    img = blank()
    vline(img, 170, 100, 200)
    hline(img, 170, 380, 200)
    cy = 208 + r                                    # „0” 7 px pod drutem narożnika
    ul = cy + r + 1
    hline(img, 40, 380, ul + 1)                     # drut etykiety pod znakiem
    cv2.circle(img, (158, cy), r, 0, -1)            # zamalowane „0”
    text(img, "1", 152, ul + 23, h=22)              # kreska litery na następnym drucie
    hline(img, 40, 380, ul + 26)
    for k in range(3):
        hline(img, 40, 380, 330 + 25 * k)
    res = run(img, [])
    vert = [p for n in res["nets"] for p in n["pieces"] if p[0] == p[2] and 140 <= p[0] <= 165]
    assert vert == [], vert
    top = [p for n in res["nets"] for p in n["pieces"] if p[1] == p[3] and abs(p[1] - 200) <= 2]
    assert top and min(min(p[0], p[2]) for p in top) >= 166, top
    assert net_at(res, (170, 150)) is not None and net_at(res, (170, 150)) == net_at(res, (300, 200))


@pytest.mark.parametrize("on_line", [False, True])
def test_strip_pass_dot_anchor_only_on_line(on_line):
    # 2-63 „+NB0” (1011, 830): zamalowane „0” etykiety detektor bierze za kropkę. Kotwicą
    # rdzenia jest tylko kropka, przez której środek przechodzi odjęta linia (prawdziwe
    # złącze); kreska litery między takim „0” a drutem, którego tylko dotyka, ginie
    H, W = 90, 120
    bw = np.zeros((H, W), np.uint8)
    bw[62:65, 5:115] = 1                            # drut, którego kreska dotyka od góry
    bw[46:62, 37:43] = 1                            # kreska znaku 16 px, gruba 6 px
    cv2.circle(bw, (40, 41), 5, 1, -1)              # „kropka” nad nią
    if on_line:
        bw[40:43, 5:115] = 1                        # prawdziwe złącze: drut przez środek
    keep = np.zeros((H, W), np.uint8)
    cv2.circle(keep, (40, 41), 6, 1, -1)
    P = cvw.derive({**cvw.PARAMS, "TITLE": None}, 3.0)
    out = cvw._strip_pass(bw, True, False, P, keep, None)
    assert out[49:58, 37:43].all() == on_line


def test_core_keeps_stroke_only_across_its_run():
    # cała kreska wokół rdzenia (+-1 px) tylko w poprzek biegu: kreska znaku za końcem rdzenia
    # (stopka pod pionem) nie może zostać, bo wydłużała drut w znak (2-63 (1011, 823))
    H, W = 60, 60
    bw = np.zeros((H, W), np.uint8)
    bw[10:31, 20:23] = 1                            # pion 21 px
    bw[31:33, 15:20] = 1                            # stopka znaku za końcem, ukośnie obok
    gate = np.zeros((H, W), np.uint8)
    gate[5:10, 15:28] = 1                           # maska nad pionem
    gate[33:38, 15:28] = 1                          # maska pod stopką
    comp = bw[10:33, 15:28] > 0
    P = cvw.derive({**cvw.PARAMS}, 3.0)
    core = cvw._core(comp, 15, 10, bw, np.zeros_like(bw), gate, P)
    assert core is not None and core[0:21, 6].all()
    assert not core[21:23, :].any(), core[19:23].astype(int)


# --------------------------------------------------------------------------- jednostki v5

def _hband(shape, y0, y1, x0, x1):
    m = np.zeros(shape, np.uint8)
    m[y0:y1, x0:x1] = 1
    return m


def test_anchored_touch_crossing_corner_free():
    # bieg pionowy (kolumna 20) kończy się w wierszu 9, pod nim linia pozioma w wierszach 10–12
    H, W = 40, 41
    line = _hband((H, W), 10, 13, 0, W)             # linia przez całą szerokość
    bw = line.copy()
    bw[0:10, 19:22] = 1                             # bieg nad linią
    none = np.zeros((H, W), np.uint8)
    # dotknięcie: linia biegnie dalej w obie strony, pod nią nic
    assert cvw._anchored(bw, line, none, 9, 20, 1, 0, 6) == 1
    # skrzyżowanie: tusz biegu ciągnie się pod linią
    bw2 = bw.copy()
    bw2[13:25, 19:22] = 1
    assert cvw._anchored(bw2, line, none, 9, 20, 1, 0, 6) == 2
    # narożnik: linia tylko po prawej stronie biegu
    line3 = _hband((H, W), 10, 13, 19, W)
    bw3 = line3 | (bw & (1 - line))
    assert cvw._anchored(bw3, line3, none, 9, 20, 1, 0, 6) == 2
    # wolny koniec: po biegu biały papier
    bw4 = np.zeros((H, W), np.uint8)
    bw4[0:10, 19:22] = 1
    assert cvw._anchored(bw4, none, none, 9, 20, 1, 0, 6) == 0
    # kropka / maska bramki (`strong`) tuż za końcem
    strong = _hband((H, W), 10, 16, 15, 26)
    bw5 = bw4 | strong
    assert cvw._anchored(bw5, none, strong, 9, 20, 1, 0, 6) == 2


def test_core_perpendicular_needs_strong_end():
    # kreska pionowa stoi na drucie (dotknięcie); u góry poprzeczka. Poprzeczka z wolnymi
    # końcami („T”, flaga „1”) nie jest kotwicą — rdzenia nie ma. Ta sama poprzeczka
    # dochodząca do bramki (maski) jest — zostaje narożnik L (krótki drut do pinu)
    H, W = 80, 80
    line = _hband((H, W), 52, 55, 0, W)             # drut pod spodem
    bw = line.copy()
    bw[30:52, 29:32] = 1                            # pion 22 px, dotyka drutu
    bw[30:33, 29:41] = 1                            # poprzeczka w prawo, 12 px
    x0, y0 = 29, 30
    comp = bw[30:52, 29:41] > 0
    none = np.zeros((H, W), np.uint8)
    P = cvw.derive({**cvw.PARAMS}, 3.0)
    assert cvw._core(comp, x0, y0, bw, line & bw, none, P) is None
    gate_mask = _hband((H, W), 20, 45, 41, 60)      # bramka tuż za końcem poprzeczki
    core = cvw._core(comp, x0, y0, bw, line & bw, gate_mask, P)
    assert core is not None and core[0:3, :].all() and core[:, 0:3].all()


@pytest.mark.parametrize("wobbly", [False, True])
def test_strip_pass_h_keeps_l_corner_to_gate(wobbly):
    # SM-POSE11 2-100 (642, 518): pion tylko dotyka drutu (kropki nie wykryto), mocny koniec
    # ma wyłącznie odcinek przy bramce. Przebieg „h” zostawia całe L: pion przyjęty dzięki
    # odcinkowi, odcinek dzięki przyjętemu pionowi (przyjęcie iteracyjne). Pion falujący
    # (SPP-32-16 2-137, SM-POSE11 2-100 (740, 543)): pełny bieg ma tylko środkowa kolumna —
    # odcinek zaczyna się kolumnę przed nią, a zostać ma cała kreska, nie 1-px kolumna
    H, W = 100, 120
    bw = np.zeros((H, W), np.uint8)
    bw[79:82, 5:115] = 1                            # drut
    bw[58:79, 39:42] = 1                            # pion 21 px w górę
    if wobbly:
        bw[62:79:5, 39] = 0
        bw[64:79:5, 41] = 0
    bw[58:61, 39:62] = 1                            # odcinek 23 px do bramki
    gate_mask = _hband((H, W), 30, 75, 62, 90)
    P = cvw.derive({**cvw.PARAMS, "TITLE": None}, 3.0)
    out = cvw._strip_pass(bw, True, False, P, None, gate_mask)
    assert out[58:61, 39:62].all()
    assert (out[61:76, 39:42] == bw[61:76, 39:42]).all()


@pytest.mark.parametrize("r", [4, 5, 6, 7])
def test_strip_pass_h_keeps_wire_between_small_dots(r):
    # pion między dwiema kropkami na równoległych drutach 26 px od siebie. Kropka (maska
    # `keep_px`) jest mocnym końcem rdzenia niezależnie od promienia — bez tego mała kropka
    # (r ~5 przy 200 dpi, SM-POSE11) dawała tylko „dotknięcie” i pion ginął w przebiegu „h”
    H, W = 100, 120
    bw = np.zeros((H, W), np.uint8)
    bw[29:32, 5:115] = 1
    bw[55:58, 5:115] = 1
    bw[30:57, 59:62] = 1
    keep = np.zeros((H, W), np.uint8)
    for y in (30, 56):
        cv2.circle(bw, (60, y), r, 1, -1)
        cv2.circle(keep, (60, y), r + 2, 1, -1)
    P = cvw.derive({**cvw.PARAMS, "TITLE": None}, 3.0)
    out = cvw._strip_pass(bw, True, False, P, keep, None)
    assert out[30:57, 59:62].all()


def test_strip_pass_h_keeps_wire_from_dot_into_box_edge():
    # SM-POSE11 2-101 (685, 320–338): z kropki pion do górnej krawędzi nierozpoznanego
    # rezystora (tryb b — bez maski). Koniec na długiej (>= CORE_T_MIN) prostopadłej kresce
    # to dotknięcie, więc pion z kropką na drugim końcu zostaje
    H, W = 100, 120
    bw = np.zeros((H, W), np.uint8)
    bw[19:22, 5:115] = 1                            # drut z kropką
    cv2.circle(bw, (60, 20), 5, 1, -1)
    bw[20:41, 59:62] = 1                            # pion do rezystora
    bw[40:43, 48:73] = 1                            # górna krawędź rezystora (25 px)
    bw[40:50, 48:51] = 1                            # boki rezystora
    bw[40:50, 70:73] = 1
    bw[50:53, 5:115] = 1                            # drut przecina rezystor niżej
    keep = np.zeros((H, W), np.uint8)
    cv2.circle(keep, (60, 20), 7, 1, -1)
    P = cvw.derive({**cvw.PARAMS, "TITLE": None}, 3.0)
    out = cvw._strip_pass(bw, True, False, P, keep, None)
    assert out[28:40, 59:62].all()


def test_strip_pass_length_without_half_dot():
    # 2-58 M40.1: pion od kropki 18 px w dół i odcinek do bramki; pół kropki poszerza
    # składową. CORE_FRAC liczone od długości bez pikseli kropki — pion i odcinek zostają
    H, W = 120, 120
    bw = np.zeros((H, W), np.uint8)
    bw[18:21, 10:110] = 1                           # drut z kropką
    cv2.circle(bw, (40, 19), 7, 1, -1)              # kropka
    bw[19:46, 39:42] = 1                            # pion w dół do odcinka
    bw[43:46, 39:62] = 1                            # odcinek do bramki (23 px < MIN_LEN1)
    gate_mask = _hband((H, W), 30, 70, 62, 90)
    keep = np.zeros((H, W), np.uint8)
    cv2.circle(keep, (40, 19), 9, 1, -1)
    P = cvw.derive({**cvw.PARAMS, "TITLE": None}, 3.0)
    out = cvw._strip_pass(bw, True, False, P, keep, gate_mask)
    assert out[28:42, 39:42].sum() >= 3 * 12 and out[43:46, 45:60].all()


def test_strip_pass_v_protects_horizontal_lines():
    # przebieg „v” odejmuje tylko piony; kawałek pewnej linii poziomej odcięty przez pion
    # (od kropki do bramki, 2-64 M7.8) z cyfrą na nim nie może zginąć — nawet bez rdzeni
    H, W = 100, 140
    bw = np.zeros((H, W), np.uint8)
    bw[49:52, 5:120] = 1                            # drut poziomy przez pion
    bw[10:95, 99:102] = 1                           # pion 18 px przed końcem drutu
    bw[36:49, 105:115] = 1                          # „cyfra” na odcinku za pionem
    P = cvw.derive({**cvw.PARAMS, "CORE_FRAC": None}, 3.0)
    out = cvw._strip_pass(bw, False, True, P, None, None)
    assert out[49:52, 104:120].all(), out[49:52, 100:120]
    assert out[36:46, 105:115].sum() == 0


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
    # BOX_EDGE_FRAC (v6) też usuwa resztę ramki — wyłączony, żeby test sprawdzał BOX_SEARCH
    res = run(img, [gate(200, 150, 260, 300)], BOX_EDGE_FRAC=None)
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


# --------------------------------------------------------------------------- v6 (kr-9p8.23)

V6_OFF = {"AXIS_RUN": None, "ISO_TEXT_FRAC": None, "BRIDGE_TEXT": False}


def _label_stack(img, x=150, ys=(200, 226, 252), h=22):
    """2-63 „+NB0/+NB3/+NB2”: etykiety na kolejnych drutach, „B” jedno nad drugim."""
    for y in ys:
        hline(img, 40, 380, y)
        text(img, "+NB", x, y - 1, h=h)


@pytest.mark.parametrize("off", [{}, {"AXIS_RUN": None, "ISO_TEXT_FRAC": None}])
def test_stacked_letters_across_wires_are_not_a_wire(off):
    # pion z kresek „B” przecina trzy druty bez kropek — wizualnie skleja trzy sygnały
    img = blank()
    _label_stack(img)
    res = run(img, [], **off)
    vert = [p for n in res["nets"] for p in n["pieces"] if p[0] == p[2]]
    assert vert == [], vert
    assert len(res["nets"]) == 3


def test_stacked_letters_fixture_reproduces_column():
    # bez mechanizmów v6 synteza daje pion przez druty (inaczej test wyżej niczego nie sprawdza)
    img = blank()
    _label_stack(img)
    res = run(img, [], **V6_OFF)
    assert [p for n in res["nets"] for p in n["pieces"] if p[0] == p[2]]


def _port(img, xt, yw, label, th=4):
    """Port jak na SM-POSE11 2-100: „<” napis „>”, drut od czubka prawego szewronu."""
    for tip, s in ((xt, 1), (xt - 94, -1)):
        cv2.polylines(img, [np.array([(tip - 14 * s, yw - 16), (tip, yw), (tip - 14 * s, yw + 16)],
                                     np.int32)], False, 0, 3)
    if label:
        text(img, label, xt - 70, yw + 10, h=20, th=th)


@pytest.mark.parametrize("label", ["Y52", "Y85", "Y22"])
def test_wire_does_not_run_through_port_label(label):
    # SM-POSE11 2-100 „<Y50>”: wierzchołki / spody liter etykiety portu dawały poziome „druty”
    img = blank()
    for yw in (120, 200, 280):
        _port(img, 150, yw, label)
        hline(img, 150, 380, yw)
    res = run(img, [])
    hs = [p for n in res["nets"] for p in n["pieces"] if p[1] == p[3]]
    assert len(hs) == 3 and all(min(p[0], p[2]) >= 140 for p in hs), hs


@pytest.mark.parametrize("off", [{}, {"AXIS_RUN": None}])
def test_isolated_short_stroke_flanked_by_text_is_not_a_wire(off):
    # samotna krótka kreska obłożona tekstem z obu stron, ale nie przecinana (dół / spód
    # słowa, SM-POSE11 2-100 „<Y50”): ani wolne końce, ani profil osi jej nie usuwają
    img = blank()
    hline(img, 40, 380, 320)                 # długi drut: pomiar grubości
    hline(img, 100, 150, 200)
    text(img, "DD", 100, 198, h=20)          # litery stojące na kresce (lewa połowa)
    text(img, "DD", 127, 223, h=20)          # litery wiszące pod nią (prawa połowa)
    res = run(img, [], **off)
    hs = [p for n in res["nets"] for p in n["pieces"] if p[1] == p[3] and abs(p[1] - 200) <= 3]
    assert hs == [], hs


def test_axis_profile_letter_crossing_vs_label_touching():
    # kreska przecinająca oś = tusz tuż za pasem po obu stronach; cyfra dotykająca drutu od
    # dołu z 1 px przerwą (słupek etykiet na kolejnych drutach) to nie przecięcie
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    bw = np.zeros((60, 200), np.uint8)
    bw[29:32, 10:190] = 1                    # drut y 30
    bw[20:41, 50:54] = 1                     # kreska litery przez drut
    bw[18:29, 100:104] = 1                   # znak stojący na drucie
    bw[34:44, 100:104] = 1                   # znak pod drutem, przerwa 2 px
    s = cvw.Seg("h", 10, 189, 30)
    on, cross, flank = cvw.axis_profile(s, bw, P)
    assert on.all()
    assert cross[50 - 10 : 54 - 10].all()
    assert not cross[100 - 10 : 104 - 10].any()
    assert flank[100 - 10 : 104 - 10].all() and not flank[150 - 10]


def test_trim_text_ends_drops_letter_run_behind_empty_gap_only():
    # krótki bieg na końcu za PUSTĄ przerwą (kreska litery przed szewronem, „Y62”) odpada;
    # przerwa pełna tuszu (kleks niewykrytej kropki, P-A3-2 2-70) nie dzieli drutu
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    bw = np.zeros((60, 200), np.uint8)
    bw[29:32, 20:34] = 1                     # 14 px „litery”
    bw[29:32, 50:190] = 1                    # drut od x 50, pusta przerwa 16 px
    out = cvw.trim_text_ends([cvw.Seg("h", 20, 189, 30)], bw, P)
    assert len(out) == 1 and out[0].a0 >= 48, [(t.a0, t.a1) for t in out]
    bw[25:36, 34:50] = 1                     # przerwa zalana kleksem (po obu stronach osi)
    out = cvw.trim_text_ends([cvw.Seg("h", 20, 189, 30)], bw, P)
    assert len(out) == 1 and out[0].a0 <= 22, [(t.a0, t.a1) for t in out]


def test_trim_text_ends_keeps_gate_end():
    # koniec przy bramce (pin) nie jest przycinany — numery pinów dotykają drutu z obu stron
    P = cvw.derive({**cvw.PARAMS, "TITLE": None}, 2.0)
    bw = np.zeros((60, 200), np.uint8)
    bw[29:32, 10:150] = 1
    for x in range(120, 148, 6):
        bw[20:41, x : x + 3] = 1             # kreski „cyfr” przez drut tuż przy bramce
    s = cvw.Seg("h", 10, 149, 30)
    box = (150.0, 0.0, 190.0, 59.0)
    assert cvw.trim_text_ends([s], bw, P)[0].a1 < 140
    assert cvw.trim_text_ends([cvw.Seg("h", 10, 149, 30)], bw, P, None, [box])[0].a1 == 149


@pytest.mark.parametrize("hole,dot_at,cut", [(True, False, True), (False, False, False),
                                              (True, True, False)])
def test_cut_glyph_overhang(hole, dot_at, cut):
    # SM-POSE11 2-100 (606, 1212–1264): pion biegnie za drutem, który się na nim kończy
    # (1237), w literę pod drutem — przez pustą przerwę w tuszu na osi; kropka w styku = T
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    s = cvw.Seg("v", 10, 64, 100)
    t = cvw.Seg("h", 98, 200, 37)            # kończy się na pionie
    on = np.ones(55, bool)
    if hole:
        on[29:33] = False
    flank = np.zeros(55, bool)
    hold = np.zeros((80, 220), np.uint8)
    if dot_at:
        hold[37, 100] = 1
    a0, a1 = cvw._cut_glyph_overhang(s, 10.0, 64.0, [s, t], on, flank, 10, hold, P, (False, False))
    assert (a1 == 37.0) == cut and a0 == 10.0


def test_cut_glyph_overhang_skips_crossings():
    # skrzyżowanie bez kropki po drodze nie jest stykiem — cięcie przy drucie, który się kończy
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    s = cvw.Seg("v", 10, 64, 100)
    segs = [s, cvw.Seg("h", 98, 200, 37), cvw.Seg("h", 40, 200, 50)]
    on = np.ones(55, bool)
    on[29:33] = False
    a0, a1 = cvw._cut_glyph_overhang(s, 10.0, 64.0, segs, on, np.zeros(55, bool), 10, None, P,
                                     (False, False))
    assert a1 == 37.0
    # krótka kreska (<= TEXT_MAX) kończąca się na odcinku to znak, nie drut (2-66 „Q07”)
    segs = [s, cvw.Seg("h", 98, 120, 37)]
    a0, a1 = cvw._cut_glyph_overhang(s, 10.0, 64.0, segs, on, np.zeros(55, bool), 10, None, P,
                                     (False, False))
    assert a1 == 64.0


def test_trim_text_ends_ignores_crossing_wire_ink():
    # tusz długiego drutu drugiej orientacji nie jest kreską litery: koniec 10 px za
    # skrzyżowaniem bez kropki nie może się przyciąć do skrzyżowania (zrobiłby się T/narożnik)
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    bw = np.zeros((160, 200), np.uint8)
    bw[29:32, 10:111] = 1
    bw[0:150, 99:102] = 1
    out = cvw.trim_text_ends([cvw.Seg("h", 10, 110, 30), cvw.Seg("v", 0, 149, 100)], bw, P)
    assert [t.a1 for t in out if t.o == "h"] == [110.0]


def test_connected_short_wire_under_label_is_kept():
    # krótki drut od narożnika z etykietą stojącą na nim (2-100 „-DDT1”) nie jest „samotny”
    img = blank()
    vline(img, 200, 40, 200)
    hline(img, 200, 245, 200)
    text(img, "DDT", 203, 198, h=20, th=4)
    res = run(img, [])
    assert net_at(res, (240, 200)) is not None and net_at(res, (240, 200)) == net_at(res, (200, 100))



@pytest.mark.parametrize("letters,axis_dot,kept", [(52, "default", True), (52, None, False),
                                                   (44, "default", False)])
def test_trim_text_ends_keeps_t_stem_at_dot(letters, axis_dot, kept):
    # recenzja v6, F1: kleks kropki (większy niż maska kropek) i litery obok trzonu T czytały
    # się jak kreski przez oś — trzon był przycinany 8–20 px przed kropką i złącze się
    # rozłączało (P-R3-2 2-65 (505, 546)). B2: ochrona tylko dla krótkiego przycięcia
    # (AXIS_DOT_MAX) — dłuższe (25 px) to napis przy fałszywej „kropce” w literze, przez który
    # drut portu dochodził do sąsiedniego pionu (JPP-16-18 2-116 (1131, 503))
    P = cvw.derive({**cvw.PARAMS} if axis_dot == "default" else {**cvw.PARAMS, "AXIS_DOT": None}, 2.0)
    bw = np.zeros((120, 220), np.uint8)
    bw[10:70, 99:102] = 1                    # trzon T
    bw[66:69, 20:200] = 1                    # drut, na którym trzon się kończy
    cv2.circle(bw, (100, 67), 8, 1, -1)      # kropka
    bw[letters : letters + 12, 88:112] = 1   # litery po obu stronach trzonu nad kropką
    hold = np.zeros_like(bw)
    cv2.circle(hold, (100, 67), 5, 1, -1)    # maska kropki mniejsza niż kleks
    out = cvw.trim_text_ends([cvw.Seg("v", 10, 67, 100), cvw.Seg("h", 20, 199, 67)], bw, P, hold)
    a1 = [t.a1 for t in out if t.o == "v"]
    assert (a1 == [67.0]) == kept, a1


def test_overhang_ignores_short_junk_perpendicular():
    # recenzja v6, F3: pion-śmieć (kreski etykiety, bieg < AXIS_CORNER) „kończący się” na
    # drucie portu nie jest narożnikiem — drut nie może być ucinany do niego
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    bw = np.zeros((260, 320), np.uint8)
    bw[199:202, 60:300] = 1                  # drut portu
    for y in range(202, 232, 6):
        bw[y : y + 4, 79:82] = 1             # pion z kresek liter pod drutem
    bw[186:199, 62:78] = 1                   # litery na lewym końcu drutu
    out = cvw.trim_text_ends([cvw.Seg("h", 60, 299, 200), cvw.Seg("v", 200, 231, 80)], bw, P)
    assert [t.a0 for t in out if t.o == "h"] == [60.0]


@pytest.mark.parametrize("kind", ["strokes", "clean", "step"])
def test_short_bracket_between_parallel_wires(kind):
    # recenzja v6, F2: krótki pion z narożnikami bez kropek na dwóch drutach w tę samą stronę
    # („⊐”) z kresek cyfr etykiet (bez czystego biegu drutu, tu: przerywany) zwierał druty
    # portów (PPS-32 2-150 (263, 983–1010)); B1: czysta pętla do pinu / wyprowadzenie
    # kondensatora (P-A3-2 2-78 (1121, 391–417)) i schodek zostają połączone
    img = blank()
    hline(img, 100, 380, 200)
    hline(img, 20 if kind == "step" else 100, 100 if kind == "step" else 380, 225)
    hline(img, 40, 380, 320)                 # długi drut: pomiar grubości
    if kind in ("strokes", "step"):          # schodek też przerywany: chroni go tylko strona
        for y in range(202, 224, 8):
            vline(img, 100, y, min(223, y + 4))
    else:
        vline(img, 100, 200, 225)
    res = run(img, [])
    a, b = net_at(res, (300, 200)), net_at(res, (40 if kind == "step" else 300, 225))
    assert a is not None and b is not None and (a != b) == (kind == "strokes"), res["nets"]


def test_short_flanked_wire_with_dot_joint_is_not_isolated():
    # strażnik reguły samotnego odcinka (recenzja v6, F8): oba końce wolne i tekst wokół, ale
    # w środku T z kropką — odcinek ma połączenie, więc nie jest „samotny” i zostaje
    img = blank()
    hline(img, 40, 380, 320)                 # długi drut: pomiar grubości
    hline(img, 100, 150, 200)
    text(img, "DD", 127, 198, h=20)          # litery stojące na prawej połowie
    text(img, "DD", 100, 223, h=20)          # litery wiszące pod lewą połową
    vline(img, 120, 200, 300)
    dot(img, 120, 200)
    res = run(img, [])
    a = net_at(res, (105, 199))
    assert a is not None and a == net_at(res, (120, 280)), res["nets"]


def test_text_bridge_needs_two_contacts_and_short_overhang():
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    hs = [cvw.Seg("h", 0, 300, y) for y in (100, 126, 152)]
    assert cvw._text_bridge(hs + [cvw.Seg("v", 90, 155, 150)], 3, P)
    assert not cvw._text_bridge(hs + [cvw.Seg("v", 40, 155, 150)], 3, P)   # wystaje 60 px
    assert not cvw._text_bridge(hs[:1] + [cvw.Seg("v", 90, 110, 150)], 1, P)


def test_drop_box_edges():
    # SM-POSE11 2-100 H1: prawy bok ramki ze skosem poza maską był pionowym „drutem”
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    box = (200.0, 120.0, 260.0, 320.0)
    segs = [cvw.Seg("v", 120, 200, 264), cvw.Seg("v", 60, 360, 272), cvw.Seg("h", 266, 380, 150)]
    out = cvw.drop_box_edges(segs, [box], P)
    assert [(t.o, t.cmid()) for t in out] == [("v", 272.0), ("h", 150.0)]


@pytest.mark.parametrize("ext", [None, False])
def test_pin_band_keeps_wire_entering_band_from_outside(ext):
    # SM-POSE11 2-100 T1 pin 3: pion (737, 980–1085) z góry, tylko końcówka 30 px w pasie;
    # ext=None — domyślne PARAMS (BAND_EXT), False — v5 (pion w pasie skasowany)
    P = {**cvw.PARAMS} if ext is None else {**cvw.PARAMS, "BAND_EXT": ext}
    img = np.zeros((300, 120), np.uint8)
    img[40:191, 80:83] = 1
    img[175:190, 90:93] = 1                  # cyfra w pasie
    cvw.clear_pin_band(img, (160, 300, 75, 100), 0, P)
    assert img[160:191, 80:83].all() == (ext is None)
    assert not img[175:190, 90:93].any()


@pytest.mark.parametrize("corner", ["default", None])
def test_trim_text_ends_keeps_corner_end(corner):
    # SM-POSE11 2-98 (1964, 877): zaokrąglony róg grubej kreski z jednej strony i litera
    # z drugiej dają „przecięcie” tuż przy narożniku — koniec w narożniku z długim drutem zostaje
    P = cvw.derive({**cvw.PARAMS} if corner == "default" else {**cvw.PARAMS, "AXIS_CORNER": None}, 2.0)
    bw = np.zeros((160, 200), np.uint8)
    bw[29:32, 10:102] = 1                    # drut poziomy do narożnika
    bw[29:150, 99:102] = 1                   # długi pion w dół od narożnika
    bw[18:29, 86:98] = 1                     # litera nad końcem drutu
    bw[32:36, 86:97] = 1                     # zgrubienie rogu pod końcem
    out = cvw.trim_text_ends([cvw.Seg("h", 10, 100, 30), cvw.Seg("v", 30, 149, 100)], bw, P)
    a1 = [t.a1 for t in out if t.o == "h"]
    assert (a1 == [100.0]) == (corner is not None), a1


def test_trim_text_ends_cuts_overhang_into_letter_below_corner():
    # SM-POSE11 2-100 Y71: pion schodzi do drutu, który się na nim kończy, a domknięcie
    # przedłuża go przez 4 px przerwy w „D” etykiety pod drutem — T bez kropki zamiast narożnika
    P = cvw.derive({**cvw.PARAMS}, 2.0)
    bw = np.zeros((120, 220), np.uint8)
    bw[10:39, 99:102] = 1                    # pion do drutu
    bw[36:39, 99:200] = 1                    # drut w prawo od narożnika (y 37)
    bw[43:65, 99:102] = 1                    # pionowa kreska „D” pod drutem
    v, h = cvw.Seg("v", 10, 64, 100), cvw.Seg("h", 99, 199, 37)
    out = cvw.trim_text_ends([v, h], bw, P)
    assert [(t.o, t.a1) for t in out if t.o == "v"] == [("v", 37.0)]


def test_cross_center_short_segment_ignores_glued_label():
    # SM-POSE11 2-100 (606, 1212–1236): etykieta „-DDT3” przyklejona do krótkiego pionu
    # przesuwała medianę o 7 px i narożnik się rozłączał
    P = {**cvw.PARAMS}
    cr = np.array([100] * 30 + [101] * 30 + [99] * 20 + list(range(103, 112)) * 12)
    assert abs(cvw._cross_center(cr, P, 30) - 100) <= 1
    assert cvw._cross_center(cr, P, 200) == float(np.median(cr))   # długi: skos, mediana


@pytest.mark.parametrize("sw,dot_d",[(2.09, 7), (2.58, 7), (2.97, 9), (6.0, 15)])
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
