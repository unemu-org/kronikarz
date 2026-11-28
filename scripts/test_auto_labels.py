"""Testy kroku ④ `labels` (kr-9p8.28): wolne końce drutów, klasyfikacja CV (szewron portu,
cyfry odsyłacza, napis zasilania, kreska masy) na syntetycznym skanie, samokorekta, scalanie
z elementami ludzkimi / auto, stan kroku, snapshot, dry-run, kody wyjścia, hak płatnego
modelu. Model podmieniony (FakeVlm) — testy nie ładują prawdziwego modelu. Własne fixture'y
(bez treści z data/).

Uruchomienie (nie zostawia __pycache__ ani .pytest_cache):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy \\
      --with opencv-python-headless --with pillow pytest -p no:cacheprovider \\
      scripts/test_auto_labels.py
"""
from __future__ import annotations

import copy
import importlib.util
import json
import sys
from pathlib import Path

import cv2
import numpy as np
import pytest

_HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(_HERE))
sys.dont_write_bytecode = True
_spec = importlib.util.spec_from_file_location("auto", _HERE / "auto.py")
auto = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(auto)
import _labels as L  # noqa: E402
import _steps as S  # noqa: E402
import _vlm  # noqa: E402

# --------------------------------------------------------------------------- syntetyczny arkusz

W_, H_ = 900, 520
# (wiersz y) port z lewej, odsyłacz z lewej, odsyłacz z prawej; pion: +5V, masa; wolny drut
PORT_Y, XL_Y, XR_Y = 80, 160, 240
PORT_END = 230            # koniec drutu przy grocie „>” szewronu
XL_END, XR_END = 120, 640
VCC_X, GND_X, V_TOP, V_BOT = 720, 800, 120, 330
FREE_Y = 450


def draw_scan() -> np.ndarray:
    img = np.full((H_, W_), 255, np.uint8)
    t = 3
    # port: „<  B22  >” — grot „>” na końcu drutu
    y = PORT_Y
    cv2.line(img, (60, y), (85, y - 25), 0, t)
    cv2.line(img, (60, y), (85, y + 25), 0, t)
    cv2.line(img, (PORT_END - 25, y - 25), (PORT_END, y), 0, t)
    cv2.line(img, (PORT_END - 25, y + 25), (PORT_END, y), 0, t)
    cv2.putText(img, "B22", (100, y + 8), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 0, 2)
    cv2.line(img, (PORT_END, y), (420, y), 0, t)
    cv2.putText(img, "-W4", (PORT_END + 10, y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    # odsyłacz z lewej: „9 -L” — numer arkusza przed końcem drutu
    cv2.putText(img, "9", (XL_END - 30, XL_Y + 9), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 0, 2)
    cv2.line(img, (XL_END, XL_Y), (420, XL_Y), 0, t)
    cv2.putText(img, "-L", (XL_END + 8, XL_Y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    # odsyłacz z prawej: „+W4 9”
    cv2.line(img, (450, XR_Y), (XR_END, XR_Y), 0, t)
    cv2.putText(img, "+W4", (XR_END - 60, XR_Y - 8), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    cv2.putText(img, "9", (XR_END + 10, XR_Y + 9), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 0, 2)
    # +5V nad pionowym drutem
    cv2.line(img, (VCC_X, V_TOP), (VCC_X, V_BOT), 0, t)
    cv2.putText(img, "+5V", (VCC_X - 22, V_TOP - 12), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    # masa: kreska w poprzek dolnego końca
    cv2.line(img, (GND_X, V_TOP), (GND_X, V_BOT), 0, t)
    cv2.line(img, (GND_X - 15, V_BOT), (GND_X + 15, V_BOT), 0, 4)
    # wolny drut bez niczego
    cv2.line(img, (300, FREE_Y), (500, FREE_Y), 0, t)
    return img


def sheet_nets() -> dict:
    def n(*segs):
        return {"pins": [], "segments": [list(s) for s in segs], "junctions": None}
    return {
        "NET_AUTO_1": n((PORT_END, PORT_Y, 420, PORT_Y)),
        "NET_AUTO_2": n((XL_END, XL_Y, 420, XL_Y)),
        "NET_AUTO_3": n((450, XR_Y, XR_END, XR_Y)),
        "NET_AUTO_4": n((VCC_X, V_TOP, VCC_X, V_BOT)),
        "NET_AUTO_5": n((GND_X, V_TOP, GND_X, V_BOT)),
        "NET_AUTO_6": n((300, FREE_Y, 500, FREE_Y)),
    }


def page_doc(**over):
    p = {"kronikarz": "1", "page": "2-1", "package": "P-T", "scan_size": [W_, H_],
         "gates": [], "power": [], "ports": [], "cross_refs": [], "nets": {},
         "annotations": [], "decorations": []}
    p.update(over)
    return p


def seg_nets(*segs):
    return {f"N{i}": {"pins": [], "segments": [list(s)], "junctions": None} for i, s in enumerate(segs)}


def ends_of(page, rects=(), pins=()):
    return {(e["x"], e["y"]): e for e in L.free_ends(page, list(rects), list(pins))}


# --------------------------------------------------------------------------- wolne końce

def test_free_ends_connections_pins_gates_and_direction():
    page = page_doc(nets=seg_nets(
        (10, 100, 200, 100),     # lewy koniec wolny; prawy na końcu pionowego
        (200, 100, 200, 300),    # dolny koniec wolny
        (100, 50, 100, 98),      # górny wolny, dolny na wnętrzu poziomego (T bez kropki = połączony)
        (300, 10, 380, 10),      # lewy przy pinie, prawy wolny → stub (krótki od pinu)
        (500, 200, 560, 200),    # prawy koniec w ramce bramki
    ))
    ends = ends_of(page, rects=[(565, 150, 625, 250)], pins=[(305, 12)])
    assert set(ends) == {(10, 100), (200, 300), (100, 50), (380, 10), (500, 200)}
    assert ends[(10, 100)]["dir"] == "left" and ends[(200, 300)]["dir"] == "down"
    assert ends[(100, 50)]["dir"] == "up" and ends[(380, 10)]["dir"] == "right"
    assert ends[(380, 10)]["stub"] is True and ends[(10, 100)]["stub"] is False
    assert ends[(10, 100)]["net"] == "N0"
    # koniec ≤ 8 px od końca innego odcinka (Chebyshev) = połączony; net o pustej nazwie pomijany
    page = page_doc(nets={"A": {"segments": [[0, 0, 50, 0]]}, "B": {"segments": [[57, 7, 57, 90]]},
                          " ": {"segments": [[0, 0, 0, 40]]}})
    assert set(ends_of(page)) == {(0, 0), (57, 90)}
    # ręczny ogonek ≤ 8 px na końcu drutu nie łączy — koniec wolny, położenie na końcu ogonka
    page = page_doc(nets=seg_nets((1423, 810, 1638, 810), (1638, 810, 1638, 814)))
    assert set(ends_of(page)) == {(1423, 810), (1638, 814)}
    assert ends_of(page)[(1638, 814)]["dir"] == "right"
    # podwójny odcinek (ten sam drut dwa razy) — każdy koniec łączy się z kopią, więc nie jest wolny
    assert ends_of(page_doc(nets=seg_nets((0, 0, 50, 0), (0, 0, 50, 0)))) == {}


def test_ground_bars_from_wire_segments():
    page = page_doc(nets=seg_nets((100, 20, 100, 200), (85, 200, 115, 200)))
    ends = L.free_ends(page, [], [])
    assert {(e["x"], e["y"]) for e in ends} == {(100, 20), (85, 200), (115, 200)}
    gb = L.ground_bars(page, ends)
    assert len(gb) == 1 and (gb[0]["x"], gb[0]["y"], gb[0]["rot"]) == (100, 200, 180)  # drut z góry → masa w dół
    idx = {(e["x"], e["y"]): i for i, e in enumerate(ends)}
    assert sorted(gb[0]["ends"]) == sorted([idx[(85, 200)], idx[(115, 200)]])
    # długa kreska (drut) albo pion poza środkiem — nie masa
    assert L.ground_bars(page_doc(nets=seg_nets((100, 20, 100, 200), (0, 200, 300, 200))),
                         L.free_ends(page_doc(nets=seg_nets((100, 20, 100, 200), (0, 200, 300, 200))), [], [])) == []


# --------------------------------------------------------------------------- CV

def test_classify_synthetic_sheet():
    bw = L.binarize(draw_scan())
    page = page_doc(nets=sheet_nets())
    ends = ends_of(page)
    kinds = {k: L.classify_end(bw, e)["kind"] for k, e in ends.items()}
    assert kinds[(PORT_END, PORT_Y)] == "port"
    assert kinds[(XL_END, XL_Y)] == "xref"
    assert kinds[(XR_END, XR_Y)] == "xref"
    assert kinds[(VCC_X, V_TOP)] == "power"
    assert kinds[(GND_X, V_BOT)] == "ground"
    # drugie końce drutów (bez niczego za sobą) i wolny drut
    for k in [(420, PORT_Y), (420, XL_Y), (450, XR_Y), (VCC_X, V_BOT), (GND_X, V_TOP), (300, FREE_Y),
              (500, FREE_Y)]:
        assert kinds[k] is None, k


def test_chevron_rejects_vertical_wire_and_digits():
    img = np.full((200, 300), 255, np.uint8)
    cv2.line(img, (100, 100), (250, 100), 0, 3)
    cv2.line(img, (60, 0), (60, 199), 0, 3)  # pionowy drut za końcem (cały w poprzek okna)
    cv2.putText(img, "9", (75, 108), cv2.FONT_HERSHEY_SIMPLEX, 0.7, 0, 2)
    bw = L.binarize(img)
    e = {"x": 100, "y": 100, "dir": "left"}
    assert L.chevron_parts(bw, 100, 100, "left") == []
    assert L.classify_end(bw, e)["kind"] == "xref"
    # przerywana linia (2-69) kończy się przy pionowym drucie, który zaczyna się w oknie: wysoka
    # składowa „T” bez skosu — nie szewron
    img = np.full((200, 300), 255, np.uint8)
    cv2.line(img, (100, 100), (250, 100), 0, 3)
    cv2.line(img, (60, 80), (60, 199), 0, 3)
    cv2.line(img, (40, 100), (80, 100), 0, 3)
    assert L.chevron_parts(L.binarize(img), 100, 100, "left") == []


def test_ground_bar_needs_both_sides_and_short_run():
    img = np.full((200, 200), 255, np.uint8)
    cv2.line(img, (100, 20), (100, 150), 0, 3)
    cv2.line(img, (100, 150), (130, 150), 0, 3)  # tylko w prawo — zakręt drutu, nie masa
    assert not L.ground_bar_at(L.binarize(img), 100, 150, "down")
    cv2.line(img, (85, 150), (100, 150), 0, 3)
    assert L.ground_bar_at(L.binarize(img), 100, 150, "down")
    assert not L.ground_bar_at(L.binarize(img), 100, 150, "left")


# --------------------------------------------------------------------------- geometria wyniku

@pytest.mark.parametrize("side,pid", [("left", "B22"), ("right", "A9"), ("left", "A100")])
def test_port_tip_open_end_lands_on_wire_end(side, pid):
    x, y = L.port_tip(300, 120, side, pid)
    m = __import__("re").fullmatch(r"([A-Z])(\d+)", pid)
    port = {"connector": m.group(1), "pin": int(m.group(2)), "x": x, "y": y, "side": side}
    assert S._port_open_end(port) == (300.0, 120.0)


def test_crop_boxes_shared_with_bakeoff():
    assert _vlm.port_crop_box(150, 300, "left") == (102, 270, 365, 326)
    assert _vlm.port_crop_box(1600, 300, "right") == (1385, 270, 1648, 326)
    assert _vlm.xref_crop_box(246, 400, "left") == (171, 370, 446, 414)
    assert _vlm.xref_crop_box(1530, 400, "right") == (1355, 370, 1655, 414)


# --------------------------------------------------------------------------- samokorekta

def ctx(**over):
    pages = {
        "2-2": {"ports": [{"connector": "A", "pin": 10, "label": "+L5"}],
                "cross_refs": [{"label": "+RPA", "pages": ["1"]}, {"label": "-W/R", "pages": ["1"]}]},
        "2-3": {"ports": [], "cross_refs": []},
    }
    kw = dict(sheets={1: "2-1", 2: "2-2", 3: "2-3"}, own_sheet=1, other_pages=pages, connectors={"B"})
    kw.update(over)
    return L.LabelContext(**kw)


def codes(why):
    return sorted(w.split(":")[0] for w in why)


@pytest.mark.parametrize("raw,exp", [
    ("+5V", "+5V"), ("5V", "+5V"), ("0V", "+0V"), ("+ØV", "+0V"), ("OV", "+0V"), ("-12V", "-12V"),
    ("+5 V", "+5V"), ("+12,5V", "+12.5V"), ("-W4", None), ("", None), (None, None), ("5", None),
])
def test_norm_power(raw, exp):
    assert L.norm_power(raw) == exp


def test_parse_conn_and_variants():
    assert L.parse_conn("B 22") == ("B", 22) and L.parse_conn("b022") == ("B", 22)
    assert L.parse_conn("A") == ("A", None) and L.parse_conn("") == ("", None)
    assert "+RPA" in L.variants("+QPA") and "+A52" in L.variants("+AS2")
    assert "+L11" in L.variants("+LH1") and "+LH" in L.variants("+L11")  # 1→H, 11→H
    assert "+L11" not in L.variants("+L11")


def test_check_port_rules():
    # litery złączy z portów innych stron pakietu (tu: A) i z backplane (tu: B)
    c = L.check_port({"conn": "B22", "label": "-W4"}, ctx(connectors={"B"}))
    assert (c["connector"], c["pin"], c["label"], c["why"]) == ("B", 22, "-W4", [])
    assert codes(L.check_port({"conn": "E5", "label": "-W4"}, ctx())["why"]) == ["CONN_UNKNOWN"]
    assert codes(L.check_port({"conn": "A97", "label": "-W4"}, ctx())["why"]) == ["CONN_INVALID"]
    assert codes(L.check_port({"conn": "Ł5", "label": "-W4"}, ctx())["why"]) == ["CONN_EMPTY"]
    assert codes(L.check_port({"conn": "", "label": "-W4"}, ctx())["why"]) == ["CONN_EMPTY"]
    assert codes(L.check_port({"conn": "A3", "label": ""}, ctx())["why"]) == ["LABEL_EMPTY"]
    # to samo złącze na innej stronie z inną etykietą
    assert codes(L.check_port({"conn": "A10", "label": "+L6"}, ctx())["why"]) == ["CONN_OTHER_PAGE"]
    assert L.check_port({"conn": "A10", "label": "+L5"}, ctx())["why"] == []
    # backplane projektu: złącze spoza backplane — flaga
    bp = ctx(connectors={"E"}, backplane={"E5"})
    assert L.check_port({"conn": "E5", "label": "-X"}, bp)["why"] == []
    assert codes(L.check_port({"conn": "A3", "label": "-X"}, bp)["why"]) == ["PORT_NOT_ON_BACKPLANE"]
    # format, mylone znaki względem etykiet pakietu; Q jest w danych (+QS1, -DQB) — bez flagi za samo Q
    assert codes(L.check_port({"conn": "A3", "label": "+QPA"}, ctx())["why"]) == ["LABEL_CONFUSABLE"]
    assert L.check_port({"conn": "A3", "label": "+QS1"}, ctx())["why"] == []
    assert codes(L.check_port({"conn": "A3", "label": "W4"}, ctx())["why"]) == ["LABEL_FORMAT"]


def test_connector_letters_from_package_or_any():
    # pakiet bez znanych portów (SM-POSE11: X / Y) — każda litera bez flagi
    empty = L.LabelContext({1: "2-1"}, 1, {})
    assert L.check_port({"conn": "X12", "label": "-A"}, empty)["why"] == []
    assert L.check_port({"conn": "Y3", "label": "-A"}, empty)["why"] == []
    # litery z portów innych stron (tylko te, które auto.py uzna za wiarygodne)
    known = L.LabelContext({1: "2-1"}, 1, {"2-2": {"ports": [{"connector": "y", "pin": 4, "label": "-B"}]}})
    assert known.connectors == {"Y"}
    assert L.check_port({"conn": "Y7", "label": "-A"}, known)["why"] == []
    assert codes(L.check_port({"conn": "X7", "label": "-A"}, known)["why"]) == ["CONN_UNKNOWN"]


def test_check_xref_rules():
    c = L.check_xref({"label": "-W/R", "pages": [2]}, ctx())
    assert (c["label"], c["pages"], c["why"]) == ("-W/R", ["2"], [])
    assert codes(L.check_xref({"label": "-X", "pages": []}, ctx())["why"]) == ["SHEETS_EMPTY"]
    assert codes(L.check_xref({"label": "-X", "pages": [1]}, ctx())["why"]) == ["SHEET_SELF"]
    assert codes(L.check_xref({"label": "-X", "pages": [9]}, ctx())["why"]) == ["SHEET_UNKNOWN"]
    # na arkuszu 2 nie ma „+DPA”, jest „+RPA” — brak powrotu z podpowiedzią
    w = L.check_xref({"label": "+DPA", "pages": [2]}, ctx())["why"]
    assert codes(w) == ["LABEL_CONFUSABLE", "XREF_NO_RETURN"] and "+RPA" in w[-1]
    # arkusz 3 nie ma odsyłaczy (strona jeszcze nie opisana) — nie ma z czym porównać
    assert L.check_xref({"label": "-X", "pages": [3, 2, 2]}, ctx())["pages"] == ["2", "3"]
    assert codes(L.check_xref({"label": "-X", "pages": [3]}, ctx())["why"]) == []
    # strona bez numeru arkusza: własny arkusz nie jest sprawdzany
    assert L.check_xref({"label": "-W/R", "pages": [2]}, ctx(own_sheet=None))["why"] == []


def test_check_power():
    assert L.check_power("+5V") == {"type": "+5V", "why": []}
    assert codes(L.check_power("M3")["why"]) == ["POWER_UNKNOWN"]


# --------------------------------------------------------------------------- plan i scalanie

def test_label_plan_keep_replace_fill_and_claims():
    page = page_doc(
        steps={"nets": {"status": "approved"}},
        nets=seg_nets((100, 100, 300, 100), (100, 200, 300, 200), (100, 300, 300, 300), (100, 400, 300, 400)),
        cross_refs=[
            {"label": "-L", "pages": ["2"], "net": "", "x": 104, "y": 98, "side": "left"},  # ludzki
            {"label": "-X", "pages": ["2"], "net": "", "x": 100, "y": 200, "side": "left", "src": "auto"},
            {"label": "-Y", "pages": ["2"], "net": "N2", "x": 100, "y": 300, "side": "left", "src": "auto",
             "net_src": "auto"},  # net z zatwierdzonego ⑤ — chroniony
        ],
        power=[{"type": "", "x": 101, "y": 401, "net": ""}],  # dodany w viewerze, typ pusty
    )
    ends = L.free_ends(page, [], [])
    idx = {(e["x"], e["y"]): i for i, e in enumerate(ends)}
    plan = L.label_plan(page, ends)
    assert plan["keep"]["cross_refs"] == [0, 2] and plan["replace"]["cross_refs"] == [1]
    assert plan["keep"]["power"] == [0]
    assert plan["claimed"][idx[(100, 100)]] == ("cross_refs", 0)
    assert plan["claimed"][idx[(100, 300)]] == ("cross_refs", 2)
    assert plan["fill"] == [("power", 0, idx[(100, 400)])]
    assert idx[(100, 200)] in plan["targets"] and idx[(100, 100)] not in plan["targets"]
    # ⑤ niezatwierdzony: auto z netem auto też zastępowalny
    page["steps"]["nets"]["status"] = "auto"
    assert L.label_plan(page, ends)["replace"]["cross_refs"] == [1, 2]


def test_merge_labels_builds_lists_uncertain_and_duplicates():
    page = page_doc(
        nets=seg_nets((230, 80, 420, 80), (230, 140, 420, 140), (120, 200, 420, 200), (300, 450, 500, 450)),
        ports=[{"connector": "B", "pin": 22, "label": "-W4", "net": "N9", "x": 1, "y": 1, "side": "left"}],
        power=[{"type": "", "x": 300, "y": 450, "net": ""}])
    ends = L.free_ends(page, [], [])
    idx = {(e["x"], e["y"]): i for i, e in enumerate(ends)}
    plan = L.label_plan(page, ends)
    e1, e2, e3 = ends[idx[(230, 80)]], ends[idx[(230, 140)]], ends[idx[(120, 200)]]
    lctx = ctx()
    results = {
        idx[(230, 80)]: auto.decide_label("port", e1, {"pred": {"conn": "B22", "label": "-W4"}}, lctx),
        idx[(230, 140)]: auto.decide_label("port", e2, {"pred": {"conn": "B23", "label": "-W5"}}, lctx),
        idx[(120, 200)]: auto.decide_label("cross_ref", e3, {"pred": {"label": "+RPA", "pages": [2]}}, lctx),
        idx[(500, 450)]: {"kind": None, "el": None, "why": ["FREE_END: wolny koniec"]},
        idx[(300, 450)]: auto.decide_label("power", ends[idx[(300, 450)]], {"pred": {"label": "0V"}}, lctx),
    }
    out, counts, unc = L.merge_labels(page, ends, plan, results)
    assert [p["connector"] + str(p["pin"]) for p in out["ports"]] == ["B22", "B22", "B23"]
    new = out["ports"][1]
    assert new["src"] == "auto" and new["net"] == "" and "net_src" not in new and new["side"] == "left"
    assert S._port_open_end(new) == (230.0, 80.0)
    assert out["cross_refs"] == [{"label": "+RPA", "pages": ["2"], "net": "", "x": 120, "y": 200,
                                  "side": "left", "src": "auto"}]
    # pusty typ ludzkiego symbolu wypełniony, położenie zostaje
    assert out["power"] == [{"type": "+0V", "x": 300, "y": 450, "net": "", "src": "auto"}]
    assert page["power"][0]["type"] == ""  # wejście nietknięte
    kinds = {(u["kind"], u["x"], u["y"]): codes(u["why"]) for u in unc}
    assert kinds[("port", new["x"], new["y"])] == ["CONN_DUPLICATE"]
    assert kinds[("end", 500, 450)] == ["FREE_END"]
    assert counts["unexplained"] == 1 and counts["ports"] == 2 and counts["cross_refs"] == 1
    assert counts["filled"] == 1 and counts["kept"] == 2


def test_decide_label_power_text_on_horizontal_end_and_errors():
    e = {"x": 10, "y": 50, "dir": "left", "stub": False}
    r = auto.decide_label("cross_ref", e, {"pred": {"label": "+5V", "pages": []}}, ctx())
    assert r["kind"] == "power" and r["el"]["type"] == "+5V" and r["el"]["rotation"] == 270
    r = auto.decide_label("cross_ref", e, {"error": "VlmTimeout: x"}, ctx())
    assert r["el"] is None and codes(r["why"]) == ["MODEL_ERROR"]
    r = auto.decide_label("port", e, {"pred": {"conn": "", "label": ""}}, ctx())
    assert r["el"] is None and codes(r["why"]) == ["MODEL_EMPTY"]
    r = auto.decide_label("power", {**e, "dir": "up"}, {"pred": {"label": "12"}}, ctx())
    assert r["el"] is None and codes(r["why"]) == ["FREE_END"]
    r = auto.decide_label("power", {**e, "dir": "up", "stub": True}, {"pred": {"label": ""}}, ctx())
    assert r["el"] is None and r["why"] == []
    # drugi odczyt (×1) niezgodny
    r = auto.decide_label("port", e, {"pred": {"conn": "B22", "label": "-W4"}}, ctx(),
                          {"pred": {"conn": "B22", "label": "-WA"}})
    assert codes(r["why"]) == ["LABEL_DISAGREE"]


def test_labels_fingerprint_and_stale_targets():
    a = page_doc(ports=[{"connector": "B", "pin": 2, "label": "-X", "net": "", "x": 1, "y": 2, "side": "left"}])
    b = copy.deepcopy(a)
    b["ports"][0]["net"] = "N1"  # net to krok ⑤, nie ④
    b["ports"][0]["src"] = "auto"
    assert S.step_fingerprint(a, "labels") == S.step_fingerprint(b, "labels")
    b["ports"][0]["label"] = "-Y"
    assert S.step_fingerprint(a, "labels") != S.step_fingerprint(b, "labels")
    c = page_doc(power=[{"type": "+5V", "x": 1, "y": 2, "net": ""}])
    d = copy.deepcopy(c)
    d["power"][0]["rotation"] = 0  # brak = 0
    assert S.step_fingerprint(c, "labels") == S.step_fingerprint(d, "labels")
    e = page_doc(cross_refs=[{"label": "-L", "pages": ["2"], "x": 1, "y": 2, "side": "left"}])
    f = copy.deepcopy(e)
    f["cross_refs"][0]["pages"] = ["2", "3"]
    assert S.step_fingerprint(e, "labels") != S.step_fingerprint(f, "labels")
    assert S.stale_targets("labels", False) == ["nets"]


# --------------------------------------------------------------------------- CLI

PKG_YAML = """kronikarz: "1"
package:
  id: P-T
  pages:
    - {id: "2-1", file: pages/2-1.sch.yaml, scan: scans/2-1.jpg, sheet: 1}
    - {id: "2-2", file: pages/2-2.sch.yaml, scan: scans/2-2.jpg, sheet: 2}
    - {id: "2-9", file: pages/2-9.sch.yaml, scan: scans/2-9.jpg, sheet: 9}
components: {}
"""


class FakeVlm:
    """Odpowiedzi według rodzaju wycinka — kolejka na rodzaj: port, xref (prawy koniec, prompt v3),
    sheets / xlabel (lewy koniec: kolumna numerów / etykieta), power (zasilanie i masa)."""
    name = "mlx:fake"

    def __init__(self):
        self.answers = {"port": [], "xref": [], "sheets": [], "xlabel": [], "power": []}
        self.calls = []
        self.loads = 0

    def load(self):
        self.loads += 1

    def params(self):
        return {"max_tokens": 300, "temperature": 0.0, "thinking": False}

    def ask(self, png, kind, prompt, timeout_s=None):
        key = ("sheets" if prompt == L.SHEETS_PROMPT else "xlabel" if prompt == L.XREF_LABEL_PROMPT else kind)
        self.calls.append({"kind": key, "prompt": prompt, "timeout_s": timeout_s, "png": png})
        q = self.answers[key]
        a = q.pop(0) if q else {}
        if isinstance(a, Exception):
            raise a
        text = a if isinstance(a, str) else json.dumps(a)
        return {"text": text, "latency": 0.2, "in_tok": 80, "out_tok": 12, "peak_gb": None, "error": None}


def base_page(pid="2-1", **over):
    st = {"gates": {"status": "approved"}, "text": {"status": "approved"}, "wires": {"status": "approved"}}
    return page_doc(page=pid, nets=sheet_nets(), steps=st, **over)


@pytest.fixture
def data(tmp_path):
    root = tmp_path / "data"
    pkg = root / "MOD" / "P-T"
    (pkg / "pages").mkdir(parents=True)
    (pkg / "scans").mkdir()
    (root / "MOD" / "project.yaml").write_text('kronikarz: "1"\nbackplane: []\n')
    (pkg / "package.yaml").write_text(PKG_YAML)
    (pkg / "pages" / "2-1.sch.yaml").write_text(auto.dump_yaml(base_page()))
    # inna strona: ludzkie odsyłacze (powrót „-L” na arkusz 1) i port A10
    other = page_doc(page="2-9", cross_refs=[{"label": "-L", "pages": ["1"], "net": "", "x": 5, "y": 5,
                                              "side": "right"},
                                             {"label": "+W4", "pages": ["1"], "net": "", "x": 5, "y": 9,
                                              "side": "left"}])
    (pkg / "pages" / "2-9.sch.yaml").write_text(auto.dump_yaml(other))
    (pkg / "pages" / "2-2.sch.yaml").write_text(auto.dump_yaml(page_doc(page="2-2")))
    for pid in ("2-1", "2-2", "2-9"):
        cv2.imwrite(str(pkg / "scans" / f"{pid}.jpg"), draw_scan())
    return root


@pytest.fixture
def vlm(monkeypatch):
    holder = {"fake": FakeVlm(), "made": 0}

    def make(spec, tmp_dir):
        holder["made"] += 1
        return holder["fake"]

    monkeypatch.setattr(auto, "make_vlm", make)
    return holder


def page_path(root, pid="2-1"):
    return root / "MOD" / "P-T" / "pages" / f"{pid}.sch.yaml"


def read_page(root, pid="2-1"):
    return auto.load_yaml(page_path(root, pid).read_text())


def write_page(root, page, pid="2-1"):
    page_path(root, pid).write_text(auto.dump_yaml(page))


def run(root, *args):
    return auto.main(["--data", str(root), "--pkg", "P-T", *args])


def tree(root):
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))


def good_answers(fake):
    fake.answers["port"] = [{"connector": "B22", "label": "-W4"}]
    fake.answers["sheets"] = [{"sheets": [9]}]
    fake.answers["xlabel"] = [{"label": "-L"}]
    fake.answers["xref"] = [{"label": "+W4", "sheets": [9]}]
    # końce czytane po (y, x): +5V (V_TOP), potem masa (V_BOT)
    fake.answers["power"] = [{"label": "+5V", "ground": False}, {"label": "", "ground": True}]


def unc_codes(page):
    return {(u["kind"], u["x"], u["y"]): codes(u["why"]) for u in page["steps"]["labels"].get("uncertain") or []}


def test_cli_labels_writes_elements_snapshot_and_uncertain(data, vlm, capsys):
    good_answers(vlm["fake"])
    before = read_page(data)
    assert run(data, "--page", "2-1", "--step", "labels", "--json") == 0
    res = json.loads(capsys.readouterr().out)
    r = res["pages"][0]
    assert r["status"] == "ok" and r["step"] == "labels"
    c = r["counts"]
    assert (c["ports"], c["cross_refs"], c["power"], c["ground"], c["reads"]) == (1, 2, 2, 1, 5)
    # drugie końce syntetycznych drutów (bez bramek) i wolny drut — do przeglądu
    assert c["unexplained"] == 7 and c["errors"] == 0
    p = read_page(data)
    assert p["ports"] == [{"connector": "B", "pin": 22, "label": "-W4", "net": "",
                           "x": L.port_tip(PORT_END, PORT_Y, "left")[0], "y": PORT_Y, "side": "left",
                           "src": "auto"}]
    assert [(x["label"], x["pages"], x["side"], x["x"], x["y"]) for x in p["cross_refs"]] == [
        ("-L", ["9"], "left", XL_END, XL_Y), ("+W4", ["9"], "right", XR_END, XR_Y)]
    assert [(w["type"], w["x"], w["y"], w.get("rotation", 0)) for w in p["power"]] == [
        ("+5V", VCC_X, V_TOP, 0), ("+0V", GND_X, V_BOT, 180)]
    assert all(e["src"] == "auto" and e["net"] == "" and "net_src" not in e
               for e in p["ports"] + p["cross_refs"] + p["power"])
    for k in ("gates", "nets", "annotations", "decorations"):
        assert p[k] == before[k], k
    st = p["steps"]["labels"]
    assert st["status"] == "auto"
    u = unc_codes(p)
    # każdy symbol zasilania z kroku do przeglądu; masa z CV osobnym kodem
    assert u[("power", VCC_X, V_TOP)] == ["POWER_AUTO"] and u[("power", GND_X, V_BOT)] == ["GROUND_CV"]
    assert sorted((x, y) for k, x, y in u if k == "end") == sorted([
        (420, PORT_Y), (420, XL_Y), (450, XR_Y), (VCC_X, V_BOT), (GND_X, V_TOP), (300, FREE_Y), (500, FREE_Y)])
    snap = data / ".auto" / "P-T" / "2-1" / f"labels-{st['run']}.yaml"
    sd = auto.load_yaml(snap.read_text())
    assert sd["auto_run"]["step"] == "labels" and sd["auto_run"]["params"]["prompt"] == "v3"
    assert sd["auto_run"]["params"]["ground_type"] == "+0V"
    by = {(e["x"], e["y"]): e for e in sd["ends"]}
    assert by[(PORT_END, PORT_Y)]["cv"]["kind"] == "port"
    assert by[(PORT_END, PORT_Y)]["vlm"]["pred"] == {"conn": "B22", "label": "-W4"}
    assert by[(GND_X, V_BOT)]["cv"]["kind"] == "ground" and by[(GND_X, V_BOT)]["vlm"]["pred"]["ground"] is True
    # lewy odsyłacz: dwa wycinki (numery i etykieta) z zamalowanymi sąsiednimi wierszami
    parts = by[(XL_END, XL_Y)]["vlm"]["parts"]
    assert [q["part"] for q in parts] == ["sheets", "label"] and all(q["keep_rows"] for q in parts)
    assert len(sd["ports"]) == 1 and len(sd["power"]) == 2
    assert sorted(cl["kind"] for cl in vlm["fake"].calls) == ["port", "power", "power", "sheets", "xlabel", "xref"]
    assert vlm["fake"].calls[0]["timeout_s"] == auto.GATE_TIMEOUT_S


def test_cli_labels_ground_needs_model_and_text_wins(data, vlm, capsys):
    good_answers(vlm["fake"])
    # +5V: model nic nie widzi → bez symbolu (FREE_END); przy kresce masy napis +5V → +5V, nie masa
    vlm["fake"].answers["power"] = [{"label": "", "ground": False}, {"label": "+5V", "ground": True}]
    assert run(data, "--page", "2-1", "--step", "labels") == 0
    p = read_page(data)
    assert [(w["type"], w["y"]) for w in p["power"]] == [("+5V", V_BOT)]
    u = unc_codes(p)
    assert u[("end", VCC_X, V_TOP)] == ["FREE_END"]
    assert u[("power", GND_X, V_BOT)] == ["POWER_AUTO"]


def test_cli_labels_self_correction_flags(data, vlm, capsys):
    vlm["fake"].answers["port"] = [{"connector": "B99", "label": "+QPA"}]
    vlm["fake"].answers["sheets"] = [{"sheets": [1]}]
    vlm["fake"].answers["xlabel"] = [{"label": "-L"}]
    vlm["fake"].answers["xref"] = [{"label": "+WA", "sheets": [9, 77]}]
    vlm["fake"].answers["power"] = [{"label": "M3"}, {"label": "", "ground": True}]
    assert run(data, "--page", "2-1", "--step", "labels", "--json") == 0
    p = read_page(data)
    u = unc_codes(p)
    port = p["ports"][0]
    assert (port["connector"], port["pin"], port["label"]) == ("B", 99, "+QPA")  # odczyt zostaje
    assert u[("port", port["x"], port["y"])] == ["CONN_INVALID"]
    assert u[("cross_ref", XL_END, XL_Y)] == ["SHEET_SELF"]
    assert u[("cross_ref", XR_END, XR_Y)] == ["SHEET_UNKNOWN", "XREF_NO_RETURN"]
    assert u[("end", VCC_X, V_TOP)] == ["FREE_END"]  # napis to nie zasilanie
    assert [w["type"] for w in p["power"]] == ["+0V"]


def test_cli_labels_rerun_keeps_human_refreshes_auto_and_force_marks_nets_stale(data, vlm, capsys):
    good_answers(vlm["fake"])
    assert run(data, "--page", "2-1", "--step", "labels") == 0
    p = read_page(data)
    # człowiek poprawia etykietę odsyłacza (src znika), zatwierdza ④ i ⑤
    p["cross_refs"][0]["label"] = "-LL"
    del p["cross_refs"][0]["src"]
    p["steps"]["labels"]["status"] = "approved"
    p["steps"]["nets"] = {"status": "approved"}
    write_page(data, p)
    assert run(data, "--page", "2-1", "--step", "labels") == 2  # zatwierdzony — tylko z --force
    n0 = len(vlm["fake"].calls)
    vlm["fake"].answers["port"] = [{"connector": "B23", "label": "-W4"}]
    vlm["fake"].answers["xref"] = [{"label": "+W4", "sheets": [9]}]
    vlm["fake"].answers["power"] = [_vlm.VlmTimeout("x"), {"label": "", "ground": True}]
    assert run(data, "--page", "2-1", "--step", "labels", "--force") == 0
    q = read_page(data)
    assert [x["label"] for x in q["cross_refs"]] == ["-LL", "+W4"]  # ludzki zostaje, nie zdublowany
    assert "src" not in q["cross_refs"][0]
    assert [x["pin"] for x in q["ports"]] == [23]  # auto zastąpiony udanym odczytem (w miejscu)
    # +5V: nowy odczyt nieudany → poprzedni wynik zostaje (nie znika), flaga
    assert [w["type"] for w in q["power"]] == ["+5V", "+0V"]
    assert unc_codes(q)[("power", VCC_X, V_TOP)] == ["MODEL_ERROR", "PREVIOUS_KEPT"]
    assert q["steps"]["labels"]["status"] == "auto" and q["steps"]["nets"]["status"] == "stale"
    # ludzki odsyłacz zajął swój koniec — model czytał port, odsyłacz z prawej i dwa zasilania
    assert len(vlm["fake"].calls) - n0 == 4


def test_label_plan_axis_aware_claim_and_near_existing():
    # ręczny odsyłacz 30 px za końcem drutu z ③ (wzdłuż drutu) zajmuje koniec; 30 px w poprzek — nie
    page = page_doc(nets=seg_nets((350, 200, 900, 200), (350, 300, 900, 300)),
                    cross_refs=[{"label": "-L", "pages": ["9"], "net": "", "x": 381, "y": 201, "side": "left"},
                                {"label": "-G", "pages": ["9"], "net": "", "x": 352, "y": 330, "side": "left"}])
    ends = L.free_ends(page, [], [])
    idx = {(e["x"], e["y"]): i for i, e in enumerate(ends)}
    plan = L.label_plan(page, ends)
    assert plan["claimed"].get(idx[(350, 200)]) == ("cross_refs", 0)
    assert idx[(350, 300)] in plan["targets"]
    assert L.claim_dist((381, 201), {"x": 350, "y": 200, "dir": "left"}) is not None
    assert L.claim_dist((350, 230), {"x": 350, "y": 200, "dir": "left"}) is None
    assert L.claim_dist((352, 230), {"x": 350, "y": 200, "dir": "up"}) is not None
    # nowy odsyłacz tuż obok ludzkiego (-G 30 px niżej) — NEAR_EXISTING
    e = ends[idx[(350, 300)]]
    res = {idx[(350, 300)]: auto.decide_label("cross_ref", e, {"pred": {"label": "-G", "pages": [2]}}, ctx())}
    out, _c, unc = L.merge_labels(page, ends, plan, res)
    assert len(out["cross_refs"]) == 3
    u = {(x["kind"], x["x"], x["y"]): codes(x["why"]) for x in unc}
    assert "NEAR_EXISTING" in u[("cross_ref", 350, 300)]


def test_free_end_overshoot_within_8px_is_connected():
    # pion przestrzeliwuje poziomy drut o 6 px (T bez kropki) — koniec nie jest wolny (jak walidator)
    page = page_doc(nets=seg_nets((100, 100, 400, 100), (250, 20, 250, 106)))
    assert set(ends_of(page)) == {(100, 100), (400, 100), (250, 20)}


def test_cli_labels_filled_human_element_survives_failed_rerun(data, vlm, capsys):
    # symbol zasilania dodany w viewerze z pustym typem, przy górnym końcu (+5V)
    p = read_page(data)
    p["power"] = [{"type": "", "x": VCC_X + 3, "y": V_TOP - 2, "net": ""}]
    write_page(data, p)
    good_answers(vlm["fake"])
    # najpierw wolne końce (masa), potem element z pustym aspektem
    vlm["fake"].answers["power"] = [{"label": "", "ground": True}, {"label": "+5V"}]
    assert run(data, "--page", "2-1", "--step", "labels") == 0
    q = read_page(data)
    assert q["power"][0] == {"type": "+5V", "x": VCC_X + 3, "y": V_TOP - 2, "net": "", "src": "auto"}
    # ponowny przebieg: model nic nie widzi przy tym końcu → element zostaje (nie znika)
    good_answers(vlm["fake"])
    vlm["fake"].answers["power"] = [{"label": "", "ground": False}, {"label": "", "ground": True}]
    assert run(data, "--page", "2-1", "--step", "labels") == 0
    r = read_page(data)
    assert r["power"][0] == q["power"][0]
    assert "PREVIOUS_KEPT" in unc_codes(r)[("power", VCC_X + 3, V_TOP - 2)]


def test_cli_labels_own_auto_dropped_without_confirmation_human_origin_kept(data, vlm, capsys):
    # własny wynik ④ bez końca drutu znika; wypełniony kiedyś ludzki (human_filled w snapshocie) zostaje
    p = read_page(data)
    p["cross_refs"] = [{"label": "-Q", "pages": ["9"], "net": "", "x": 50, "y": 500, "side": "left", "src": "auto"},
                       {"label": "-H", "pages": ["9"], "net": "", "x": 60, "y": 470, "side": "left", "src": "auto"}]
    p["steps"]["labels"] = {"status": "auto", "run": "R1"}
    write_page(data, p)
    snap = data / ".auto" / "P-T" / "2-1" / "labels-R1.yaml"
    snap.parent.mkdir(parents=True)
    snap.write_text(auto.dump_yaml({"human_filled": [["cross_ref", 60, 470]]}))
    good_answers(vlm["fake"])
    assert run(data, "--page", "2-1", "--step", "labels", "--json") == 0
    res = json.loads(capsys.readouterr().out)["pages"][0]["counts"]
    q = read_page(data)
    assert [x["label"] for x in q["cross_refs"]] == ["-H", "-L", "+W4"]
    assert unc_codes(q)[("cross_ref", 60, 470)] == ["NO_WIRE_END"]
    assert res["removed_auto"] == 1 and res["kept_auto"] == 1
    # nowy snapshot niesie pochodzenie dalej
    s2 = auto.load_yaml((snap.parent / f"labels-{q['steps']['labels']['run']}.yaml").read_text())
    assert ["cross_ref", 60, 470] in s2["human_filled"]


def test_cli_labels_own_auto_at_free_end_dropped_model_error_kept(data, vlm, capsys):
    # 2-137: fałszywe +0V z pierwszego przebiegu — ponowny przebieg (FREE_END) je usuwa;
    # błąd modelu (chwilowy) zostawia poprzedni wynik
    good_answers(vlm["fake"])
    assert run(data, "--page", "2-1", "--step", "labels") == 0
    good_answers(vlm["fake"])
    vlm["fake"].answers["power"] = [{"label": "", "ground": False}, _vlm.VlmTimeout("x")]
    assert run(data, "--page", "2-1", "--step", "labels") == 0
    q = read_page(data)
    assert [(w["type"], w["y"]) for w in q["power"]] == [("+0V", V_BOT)]
    assert unc_codes(q)[("power", GND_X, V_BOT)] == ["MODEL_ERROR", "PREVIOUS_KEPT"]


def test_cli_labels_refuses_without_approved_wires_and_dry_run_writes_nothing(data, vlm):
    p = read_page(data)
    p["steps"]["wires"]["status"] = "auto"
    write_page(data, p)
    t0 = tree(data)
    assert run(data, "--page", "2-1", "--step", "labels") == 2
    assert tree(data) == t0 and vlm["made"] == 0
    good_answers(vlm["fake"])
    assert run(data, "--page", "2-1", "--step", "labels", "--draft", "--dry-run") == 0
    assert tree(data) == t0 and page_path(data).read_text() == auto.dump_yaml(p)


def test_cli_labels_page_without_reads_does_not_load_model(data, vlm, capsys):
    p = read_page(data, "2-2")
    p["steps"] = base_page()["steps"]
    p["nets"] = {"N1": {"pins": [], "segments": [[300, FREE_Y, 500, FREE_Y]], "junctions": None}}
    write_page(data, p, "2-2")
    assert run(data, "--page", "2-2", "--step", "labels", "--json") == 0
    assert vlm["made"] == 0
    q = read_page(data, "2-2")
    assert q["power"] == [] and q["ports"] == [] and q["cross_refs"] == []
    assert len(q["steps"]["labels"]["uncertain"]) == 2  # dwa wolne końce


def test_cli_labels_model_error_and_bad_shapes_keep_page_going(data, vlm, capsys):
    vlm["fake"].answers["port"] = [_vlm.VlmTimeout("brak odpowiedzi modelu w 1 s")]
    vlm["fake"].answers["sheets"] = ["nie wiem"]
    vlm["fake"].answers["xlabel"] = [{"label": "-L"}]
    vlm["fake"].answers["xref"] = [{"label": "+W4", "sheets": {"a": 1}}]  # zły kształt pola → []
    vlm["fake"].answers["power"] = [{"label": "+5V"}, {"label": "", "ground": True}]
    assert run(data, "--page", "2-1", "--step", "labels", "--json", "--gate-timeout", "1") == 0
    res = json.loads(capsys.readouterr().out)
    c = res["pages"][0]["counts"]
    assert c["errors"] == 2 and c["ports"] == 0 and c["cross_refs"] == 1
    unc = read_page(data)["steps"]["labels"]["uncertain"]
    assert sum(1 for u in unc if codes(u["why"])[0] == "MODEL_ERROR") == 2
    assert unc_codes(read_page(data))[("cross_ref", XR_END, XR_Y)] == ["SHEETS_EMPTY"]


def test_scalar_sheets_and_pins_normalised():
    # model bywa zwraca skalar zamiast listy: "sheets": 9, "pins_left": 3
    assert _vlm.to_pred("xref", {"label": "-L", "sheets": 9}) == {"label": "-L", "pages": [9]}
    assert _vlm.to_pred("xref", {"label": "-L", "sheets": "6,7"})["pages"] == [6, 7]
    assert _vlm.to_pred("xref", {"label": "-L", "sheets": {"a": 1}})["pages"] == []
    g = _vlm.to_pred("gate", {"symbol": "1", "type": "04", "ref": "M1", "pins_left": 3, "pins_right": [4],
                              "pins_top": None})
    assert g["pins"] == {"left": [3], "right": [4], "top": []}


def test_cli_labels_scalar_sheets_reads_fine(data, vlm, capsys):
    good_answers(vlm["fake"])
    vlm["fake"].answers["sheets"] = [{"sheets": 9}]
    vlm["fake"].answers["xref"] = [{"label": "+W4", "sheets": 9}]
    assert run(data, "--page", "2-1", "--step", "labels") == 0
    assert [x["pages"] for x in read_page(data)["cross_refs"]] == [["9"], ["9"]]


def test_cli_labels_paid_model_hook_and_next(data, vlm, capsys):
    t0 = tree(data)
    assert run(data, "--page", "2-1", "--step", "labels", "--model", "anthropic:claude-opus-5-5") == 2
    assert run(data, "--page", "2-1", "--step", "labels", "--model", "openai:x", "--allow-paid") == 3
    assert tree(data) == t0 and vlm["made"] == 0
    good_answers(vlm["fake"])
    assert run(data, "--page", "2-1", "--step", "next") == 0
    assert read_page(data)["steps"]["labels"]["status"] == "auto"
    assert run(data, "--page", "2-1", "--step", "nets") == 3


def test_cli_labels_second_read_disagreement(data, vlm, capsys):
    vlm["fake"].answers["port"] = [{"connector": "B22", "label": "-W4"}, {"connector": "B22", "label": "-WA"}]
    vlm["fake"].answers["sheets"] = [{"sheets": [9]}, {"sheets": [9]}]
    vlm["fake"].answers["xlabel"] = [{"label": "-L"}, {"label": "-L"}]
    vlm["fake"].answers["xref"] = [{"label": "+W4", "sheets": [9]}, {"label": "+W4", "sheets": [9]}]
    vlm["fake"].answers["power"] = [{"label": "+5V"}, {"label": "+5V"}, {"ground": True}, {"ground": True}]
    assert run(data, "--page", "2-1", "--step", "labels", "--second-read") == 0
    p = read_page(data)
    unc = [u for u in p["steps"]["labels"]["uncertain"] if u["kind"] == "port"]
    assert len(unc) == 1 and codes(unc[0]["why"]) == ["LABEL_DISAGREE"]
    assert len(vlm["fake"].calls) == 12


# --------------------------------------------------------------------------- masa: fałszywe trafienia (przegląd)

def test_ground_rejects_terminal_circle_with_text():
    # „o +5V”: drut kończy się na kółku zacisku, obok napis — zasilanie do odczytu, nie masa
    img = np.full((300, 300), 255, np.uint8)
    cv2.line(img, (100, 20), (100, 150), 0, 3)
    cv2.circle(img, (100, 158), 8, 0, 2)
    cv2.putText(img, "+5V", (112, 170), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    assert L.classify_end(L.binarize(img), {"x": 100, "y": 150, "dir": "down"})["kind"] == "power"
    # samo kółko (bez napisu) też nie jest kreską masy (tusz za „kreską”)
    img = np.full((300, 300), 255, np.uint8)
    cv2.line(img, (100, 20), (100, 150), 0, 3)
    cv2.circle(img, (100, 160), 10, 0, 2)
    assert not L.ground_bar_at(L.binarize(img), 100, 150, "down")


def test_power_text_ignores_broken_line_beyond_vertical_end():
    # przerwany pionowy drut / ramka (2-137): kreski za końcem to nie napis zasilania
    img = np.full((300, 300), 255, np.uint8)
    cv2.line(img, (100, 150), (100, 280), 0, 3)
    for y0 in (110, 80):
        cv2.line(img, (100, y0), (100, y0 + 20), 0, 3)
    cv2.line(img, (125, 100), (125, 125), 0, 3)  # róg innej ramki w oknie
    assert L.text_parts(L.binarize(img), 100, 150, "up") == []
    cv2.putText(img, "0V", (88, 135), cv2.FONT_HERSHEY_SIMPLEX, 0.6, 0, 2)
    assert L.text_parts(L.binarize(img), 100, 150, "up") != []


def test_ground_rejects_frame_corner_gate_and_title_block():
    # dół ramki: kreska, której końce schodzą w pion
    img = np.full((300, 300), 255, np.uint8)
    cv2.line(img, (100, 20), (100, 150), 0, 3)
    cv2.rectangle(img, (80, 110), (125, 150), 0, 3)
    assert not L.ground_bar_at(L.binarize(img), 100, 150, "down")
    # prawdziwa kreska masy, ale przy ramce bramki — nie masa
    img = np.full((300, 300), 255, np.uint8)
    cv2.line(img, (100, 20), (100, 150), 0, 3)
    cv2.line(img, (85, 150), (115, 150), 0, 4)
    bw = L.binarize(img)
    e = {"x": 100, "y": 150, "dir": "down"}
    assert L.classify_end(bw, e)["kind"] == "ground"
    assert L.classify_end(bw, e, [(60, 160, 140, 220)])["kind"] is None
    # tabliczka rysunkowa (prawy dolny róg) — ani zasilania, ani masy
    big = np.full((1000, 1000), 255, np.uint8)
    cv2.line(big, (900, 700), (900, 850), 0, 3)
    cv2.line(big, (885, 850), (915, 850), 0, 4)
    c = L.classify_end(L.binarize(big), {"x": 900, "y": 850, "dir": "down"})
    assert c["kind"] is None and c["cv"]["title_block"]


def test_read_gate_and_read_label_bad_shape_is_model_error(monkeypatch):
    from PIL import Image

    class Ad:
        def ask(self, png, kind, prompt, timeout_s=None):
            return {"text": json.dumps({"connector": ["B", "x"], "label": "-A", "ref": "M1"}), "latency": 0.1}

    scan = Image.new("L", (400, 300), 255)
    rec = auto.read_label(Ad(), scan, "port", {"x": 200, "y": 100, "dir": "left"}, 1)
    assert rec["pred"] is None and "zły kształt" in rec["error"]
    r = auto.decide_label("port", {"x": 200, "y": 100, "dir": "left"}, rec, ctx())
    assert r["el"] is None and codes(r["why"]) == ["MODEL_ERROR"]

    def boom(kind, obj):
        raise TypeError("x")
    monkeypatch.setattr(_vlm, "to_pred", boom)
    g = {"x": 200, "y": 150, "w": 60, "h": 90}
    rec = auto.read_gate(Ad(), scan, g, [], 1)
    assert rec["pred"] is None and "zły kształt" in rec["error"]


def test_xref_left_boxes_mask_neighbour_rows():
    bb, keep = L.xref_sheets_box(350, 300, 28, 28)
    assert bb == (275, 270, 356, 330) and keep == (288, 312)
    assert L.xref_sheets_box(350, 300, 24, 40)[1] == (290, 314)
    bb, keep = L.xref_label_box(350, 300, 28)
    assert keep == (276, 302) and bb[0] == 346
    # bez sąsiadów — pełny pas
    assert L.xref_sheets_box(350, 300)[1] == (286, 314) and L.xref_label_box(350, 300)[1] == (266, 302)
    gaps = auto.row_gaps([{"x": 350, "y": 300, "dir": "left"}, {"x": 352, "y": 328, "dir": "left"},
                          {"x": 900, "y": 310, "dir": "left"}, {"x": 350, "y": 250, "dir": "right"}])
    assert gaps[0] == (None, 28) and gaps[1] == (28, None) and gaps[2] == (None, None)
