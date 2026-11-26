"""Testy scripts/eval-digitize.py.

Uruchomienie (PYTHONDONTWRITEBYTECODE + bez cache pytesta = nic nie zostaje w scripts/):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy --with scipy \
    pytest -p no:cacheprovider scripts/test_eval_digitize.py

EVAL_DIGITIZE_PATH=<plik> podmienia testowany skrypt (testy mutacyjne na kopii poza repo).

Dwie grupy: (1) mikro-strony z ręcznie policzonymi DOKŁADNYMI wartościami liczników,
(2) wzorzec vs wzorzec i perturbacje wzorca, z wartościami oczekiwanymi liczonymi niezależną
wyrocznią (brute force po parach / endpointach / próbkach) zamiast „< 1.0”.
"""
from __future__ import annotations

import copy
import importlib.util
import math
import os
import random
import shutil
from collections import Counter
from itertools import combinations
from pathlib import Path

import pytest
import yaml

REPO = Path(__file__).resolve().parent.parent
GOLD = REPO / "data" / "gold"
PAGE = "2-59"
PKG = "P-R3-2"

_path = Path(os.environ.get("EVAL_DIGITIZE_PATH") or Path(__file__).with_name("eval-digitize.py"))
_spec = importlib.util.spec_from_file_location("eval_digitize", _path)
ev = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(ev)

A = pytest.approx


# --- budowanie mikro-stron -----------------------------------------------------------------


def G(ref, letter, x, y, pins=(), w=40, h=40, rotation=0):
    """pins: (num, net, px, py[, side])"""
    g = {"ref": ref, "gate": letter, "x": x, "y": y, "rotation": rotation, "verified": True, "note": None,
         "pins": [{"num": p[0], "net": p[1], "px": p[2], "py": p[3],
                   "side": p[4] if len(p) > 4 else "left"} for p in pins]}
    if w is not None:
        g["w"], g["h"] = w, h
    return g


def P(conn, pin, label, net, x, y):
    return {"connector": conn, "pin": pin, "label": label, "net": net, "x": x, "y": y, "side": "left"}


def X(label, net, x, y, pages=("1",)):
    return {"label": label, "net": net, "x": x, "y": y, "pages": list(pages), "side": "left"}


def page(gates=(), ports=(), xrefs=(), nets=None):
    pg = ev.empty_page("PKG", "1")
    pg.update(gates=list(gates), ports=list(ports), cross_refs=list(xrefs), nets=nets or {})
    return pg


def net(segs=(), junctions=None):
    return {"pins": [], "segments": [list(s) for s in segs], "junctions": junctions}


def xref_page(assign: dict, nets=None) -> dict:
    """Endpointy-cross_refy w stałych miejscach (x = 100, 200, ...), z podanym netem."""
    return page(xrefs=[X(lbl, n, 100 * (i + 1), 100) for i, (lbl, n) in enumerate(assign.items())], nets=nets)


def counts(gold, cand, scope=ev.SCOPE_FULL):
    return ev.evaluate_page(gold, cand, scope)


def score(gold, cand, scope=ev.SCOPE_FULL):
    return ev.finalize(ev.evaluate_page(gold, cand, scope))


# --- niezależna wyrocznia ------------------------------------------------------------------


def page_endpoints(pg, skip_gates=()) -> dict:
    """id -> net dla endpointów strony (tożsamość jak we wzorcu, bez dopasowywania)."""
    out = {}
    for gi, g in enumerate(pg["gates"]):
        if gi in skip_gates:
            continue
        for p in g["pins"]:
            out[ev.pin_id(g, p["num"])] = ev.net_of(p)
    for p in pg.get("ports") or []:
        out[f"PORT:{p['connector']}{p['pin']}"] = ev.net_of(p)
    for x in pg.get("cross_refs") or []:
        out[f"XREF:{x['label']}"] = ev.net_of(x)
    return out


def oracle(gold_ids: dict, cand_ids: dict, extra_nets=()) -> dict:
    """Brute force: pary i endpointy. cand_ids: dopasowane (tożsamość wzorca); extra_nets:
    nety endpointów kandydata bez odpowiednika."""
    cand_items = dict(cand_ids)
    for i, n in enumerate(extra_nets):
        cand_items[("EXTRA", i)] = n

    def same(d):
        return {frozenset((a, b)) for a, b in combinations(d, 2) if d[a] is not None and d[a] == d[b]}

    gp, cp = same(gold_ids), same(cand_items)
    ok, jac = 0, 0.0
    for e, gn in gold_ids.items():
        if e not in cand_ids:
            continue
        sg = {f for f in gold_ids if f != e and gn is not None and gold_ids[f] == gn}
        cn = cand_ids[e]
        sc = {f for f in cand_items if f != e and cn is not None and cand_items[f] == cn}
        ok += sg == sc
        jac += len(sg & sc) / len(sg | sc) if sg | sc else 1.0
    tp = len(gp & cp)
    p = tp / len(cp) if cp else 0.0
    r = tp / len(gp) if gp else 0.0
    return {"pair_P": p, "pair_R": r, "pair_F1": 2 * p * r / (p + r) if p + r else 0.0,
            "ep_acc": ok / len(gold_ids), "ep_jacc": jac / len(gold_ids)}


def assert_oracle(m: dict, o: dict):
    for k, v in o.items():
        assert m[k] == A(v), f"{k}: {m[k]} != {v}"


def _pt_seg(px, py, s):
    x1, y1, x2, y2 = s
    dx, dy = x2 - x1, y2 - y1
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((px - x1) * dx + (py - y1) * dy) / L2))
    return math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))


def covered(cells, segs, tol=3.0) -> int:
    return sum(1 for x, y in cells if any(_pt_seg(x, y, s) <= tol for s in segs))


# --- pary i endpointy: dokładne wartości ---------------------------------------------------


def test_pairs_split_and_merge_exact():
    gold = xref_page({"a": "N1", "b": "N1", "c": "N1", "d": "N2", "e": "N2"})
    cand = xref_page({"a": "M1", "b": "M1", "c": "M2", "d": "M2", "e": "M2"})
    c = counts(gold, cand)
    assert c["pair"] == {"tp": 2, "npred": 4, "ngold": 4}
    assert c["pair_cond"] == {"tp": 2, "npred": 4, "ngold": 4}
    m = ev.finalize(c)
    assert (m["pair_P"], m["pair_R"], m["pair_F1"]) == (A(0.5), A(0.5), A(0.5))


def test_ep_split_and_merge_exact():
    gold = xref_page({"a": "N1", "b": "N1", "c": "N1", "d": "N2", "e": "N2"})
    cand = xref_page({"a": "M1", "b": "M1", "c": "M2", "d": "M2", "e": "M2"})
    c = counts(gold, cand)
    # a: {b} vs {b,c} J=1/2; b: J=1/2; c: {d,e} vs {a,b} J=0; d: {c,e} vs {e} J=1/2; e: J=1/2
    assert c["ep"]["ok"] == 0 and c["ep"]["n"] == 5
    assert c["ep"]["jacc"] == A(2.0)
    m = ev.finalize(c)
    assert m["ep_acc"] == 0.0 and m["ep_jacc"] == A(0.4)


def test_pairs_combined_split_merge_exact():
    gold = xref_page({"a": "N1", "b": "N1", "c": "N1", "d": "N1", "e": "N2", "f": "N2"})
    cand = xref_page({"a": "X", "b": "X", "c": "Y", "d": "Y", "e": "Y", "f": "Y"})
    c = counts(gold, cand)
    assert c["pair"] == {"tp": 3, "npred": 7, "ngold": 7}
    assert ev.finalize(c)["pair_F1"] == A(3 / 7)


def test_pairs_unmatched_endpoints_cost_precision_and_recall():
    gold = page(gates=[G("M1", "A", 100, 100, [(1, "N", 80, 90), (2, "N", 80, 110)]),
                       G("M2", "A", 500, 100, [(1, "N", 480, 90), (2, "N", 480, 110)])])
    cand = page(gates=[G("M1", "A", 100, 100, [(1, "N", 80, 90), (2, "N", 80, 110)]),
                       G("M9", "A", 900, 900, [(1, "N", 880, 890), (2, "N", 880, 910)])])
    c = counts(gold, cand)
    assert c["gate"]["tp"] == 1 and c["gate"]["npred"] == 2 and c["gate"]["ngold"] == 2
    assert c["pair"] == {"tp": 1, "npred": 6, "ngold": 6}
    assert c["pair_cond"] == {"tp": 1, "npred": 1, "ngold": 1}
    # ep: M1.1 gold {M1.2, M2.1, M2.2} vs cand {M1.2, X, X}: J = 1/5; tak samo M1.2; M2.* brak
    assert c["ep"] == {"ok": 0, "jacc": A(0.4), "n": 4}


def test_extra_and_duplicate_pin_numbers_are_candidate_only():
    gold = page(gates=[G("M1", "A", 100, 100, [(1, "N", 80, 90), (2, "N", 80, 110)])])
    cand = page(gates=[G("M1", "A", 100, 100, [(1, "N", 80, 90), (2, "N", 80, 110), (7, "N", 120, 100)])])
    assert counts(gold, cand)["pair"] == {"tp": 1, "npred": 3, "ngold": 1}
    dup = page(gates=[G("M1", "A", 100, 100, [(1, "N", 80, 90), (1, "N", 80, 90), (2, "N", 80, 110)])])
    c = counts(gold, dup)
    assert (c["pin"]["found"], c["pin"]["npred"], c["pin"]["ngold"]) == (2, 3, 2)
    assert c["pair"] == {"tp": 1, "npred": 3, "ngold": 1}
    assert c["ep"]["ok"] == 0


def test_unmatched_candidate_ports_and_xrefs_are_false_positives():
    gold = page(ports=[P("A", 1, "+L", "N", 100, 100)], xrefs=[X("-K", "N", 900, 100)])
    cand = page(ports=[P("A", 1, "+L", "N", 100, 100), P("A", 2, "+Z", "N", 100, 600)],
                xrefs=[X("-K", "N", 900, 100), X("-Q", "N", 900, 600)])
    c = counts(gold, cand)
    assert c["pair"] == {"tp": 1, "npred": 6, "ngold": 1}
    assert c["ep"]["ok"] == 0


def test_pairs_giant_net_and_singletons_micro():
    gold = xref_page({"a": "N1", "b": "N1", "c": "N1", "d": "N2", "e": "N2"})
    c = counts(gold, xref_page({k: "Z" for k in "abcde"}))
    assert c["pair"] == {"tp": 4, "npred": 10, "ngold": 4}
    m = ev.finalize(c)
    assert (m["pair_P"], m["pair_R"], m["pair_F1"]) == (A(0.4), A(1.0), A(2 * 0.4 / 1.4))
    # a,b,c: {4 inne} vs {2}: J=2/4; d,e: J=1/4
    assert m["ep_acc"] == 0.0 and m["ep_jacc"] == A((3 * 0.5 + 2 * 0.25) / 5)
    c = counts(gold, xref_page({k: f"S{k}" for k in "abcde"}))
    assert c["pair"] == {"tp": 0, "npred": 0, "ngold": 4}
    m = ev.finalize(c)
    assert (m["pair_P"], m["pair_R"], m["pair_F1"], m["ep_acc"], m["ep_jacc"]) == (0.0, 0.0, 0.0, 0.0, 0.0)


def test_empty_gold_nets_are_singletons():
    gold = xref_page({"a": "N", "b": "N", "c": ""})
    cand = xref_page({"a": "N", "b": "N", "c": "N"})
    assert counts(gold, cand)["pair"] == {"tp": 1, "npred": 3, "ngold": 1}
    gold = xref_page({"a": "", "b": ""})
    c = counts(gold, xref_page({"a": "N", "b": "N"}))
    assert c["pair"] == {"tp": 0, "npred": 1, "ngold": 0}
    assert c["ep"]["ok"] == 0
    c = counts(gold, xref_page({"a": "", "b": "Q"}))
    assert c["ep"] == {"ok": 2, "jacc": A(2.0), "n": 2}  # singleton poprawny, gdy singleton u kandydata


def test_ep_unmatched_gold_singleton_is_wrong():
    gold = xref_page({"a": "N"})
    assert counts(gold, page())["ep"] == {"ok": 0, "jacc": 0.0, "n": 1}
    assert counts(gold, xref_page({"a": "Q"}))["ep"] == {"ok": 1, "jacc": A(1.0), "n": 1}


def test_ep_candidate_only_member_is_wrong():
    gold = xref_page({"a": "N", "b": "N"})
    cand = page(xrefs=[X("a", "N", 100, 100), X("b", "N", 200, 100), X("zz", "N", 2000, 900)])
    c = counts(gold, cand)
    assert c["ep"] == {"ok": 0, "jacc": A(1.0), "n": 2}  # każdy: {b} vs {b, X}: J = 1/2


def _largest_vs_small_nets():
    nets = {}
    for i in range(10):
        nets[f"a{i}"] = "N10"
    for i in range(5):
        nets[f"b{i}"] = "N5"
    for k in range(10):
        nets[f"c{k}a"] = nets[f"c{k}b"] = f"T{k}"
    gold = xref_page(nets)
    # L: poprawne 3 największe nety (25 % z 12), pozostałe 2-pinowe rozbite na singletony
    lnets = {k: (v if v in ("N10", "N5", "T0") else f"S_{k}") for k, v in nets.items()}
    # T: poprawne wszystkie 2-pinowe, N10 rozbity na dwie połówki, N5 na singletony
    tnets = {k: (v if v.startswith("T") else (f"H{int(k[1:]) // 5}" if v == "N10" else f"S_{k}"))
             for k, v in nets.items()}
    return gold, xref_page(lnets), xref_page(tnets)


def test_ep_ranks_small_net_fixes_above_largest_nets():
    gold, cl, ct = _largest_vs_small_nets()
    ml, mt = score(gold, cl), score(gold, ct)
    assert ml["ep_acc"] == A(17 / 35) and ml["ep_jacc"] == A(17 / 35)
    assert mt["ep_acc"] == A(20 / 35) and mt["ep_jacc"] == A((20 + 10 * 4 / 9) / 35)
    assert ml["pair_F1"] == A(112 / 121) and mt["pair_F1"] == A(60 / 95)
    assert mt["ep_acc"] > ml["ep_acc"] and ml["pair_F1"] > mt["pair_F1"]


# --- dokładności etykiet ------------------------------------------------------------------


def test_label_ref_letter_connector_pages_accuracy_exact():
    gates = [G(f"M{i}", "ABCD"[i], 100 + 200 * i, 100) for i in range(4)]
    ports = [P("A", 10 + i, f"+S{i}", f"S{i}", 50, 300 + 100 * i) for i in range(4)]
    xrefs = [X(f"-T{i}", f"T{i}", 2000, 300 + 100 * i, ["1", "2"]) for i in range(4)]
    gold = page(gates, ports, xrefs)
    cand = copy.deepcopy(gold)
    cand["gates"][0]["ref"] = "M99"
    cand["gates"][1]["gate"] = "X"
    cand["gates"][2]["gate"] = None
    cand["ports"][0]["label"] = "+BAD"
    cand["ports"][1]["connector"] = "B"
    cand["ports"][2]["pin"] = 99
    cand["cross_refs"][0]["label"] = "-BAD"
    cand["cross_refs"][1]["pages"] = ["2", "1"]  # ten sam zbiór
    cand["cross_refs"][2]["pages"] = ["3"]
    m = score(gold, cand)
    assert m["gate_F1"] == 1.0 and m["port_F1"] == 1.0 and m["xref_F1"] == 1.0
    assert m["gate_ref_acc"] == A(0.75) and m["gate_letter_acc"] == A(0.5)
    assert m["port_label_acc"] == A(0.75) and m["port_connpin_acc"] == A(0.5)
    assert m["xref_label_acc"] == A(0.75) and m["xref_pages_acc"] == A(0.75)


# --- dopasowanie położeń -------------------------------------------------------------------


def test_auto_box_matches_viewer():
    g = G("M1", "A", 0, 0, [(i, "N", 0, 0, "left") for i in range(5)] + [(9, "N", 0, 0, "right")], w=None)
    assert ev.auto_box(g) == (80.0, 130.0)
    assert ev.auto_box(G("M1", "A", 0, 0, [], w=None)) == (80.0, 90.0)


@pytest.mark.parametrize("rot,box", [(0, (90.0, 70.0, 110.0, 130.0)), (90, (70.0, 90.0, 130.0, 110.0)),
                                     (180, (90.0, 70.0, 110.0, 130.0)), (270, (70.0, 90.0, 130.0, 110.0))])
def test_rotation_swaps_box(rot, box):
    assert ev.gate_box(G("M1", "A", 100, 100, [], w=20, h=60, rotation=rot)) == box


def test_rotated_270_gate_matches_only_with_swap():
    gold = page([G("M1", "A", 500, 500, w=20, h=100, rotation=270)])
    cand = page([G("M1", "A", 500, 500, w=100, h=20, rotation=0)])
    assert counts(gold, cand)["gate"]["tp"] == 1


@pytest.mark.parametrize("dx,matched", [(16, True), (26, True), (27, False)])
def test_gate_without_wh_uses_auto_box_iou(dx, matched):
    # auto 80x90: IoU = (80-dx)/(80+dx) -> próg 0.5 przy dx = 26.67
    gold = page([G("M1", "A", 500, 500, w=None)])
    cand = page([G("M1", "A", 500 + dx, 500, w=None)])
    assert counts(gold, cand)["gate"]["tp"] == (1 if matched else 0)


@pytest.mark.parametrize("dx,matched", [(13, True), (14, False)])
def test_gate_with_wh_iou_threshold(dx, matched):
    # 40x40: IoU(13) = 27/53 = 0.509, IoU(14) = 26/54 = 0.481
    gold = page([G("M1", "A", 500, 500)])
    cand = page([G("M1", "A", 500 + dx, 500)])
    assert counts(gold, cand)["gate"]["tp"] == (1 if matched else 0)


@pytest.mark.parametrize("dy,matched", [(19, True), (21, False)])
def test_port_and_xref_tolerance(dy, matched):
    gold = page(ports=[P("A", 1, "+L", "L", 100, 100)], xrefs=[X("-K", "K", 900, 100)])
    cand = page(ports=[P("A", 1, "+L", "L", 100, 100 + dy)], xrefs=[X("-K", "K", 900, 100 + dy)])
    c = counts(gold, cand)
    assert c["port"]["tp"] == c["xref"]["tp"] == (1 if matched else 0)


def test_pin_precision_recall_and_error_exact():
    gold = page([G("M1", "A", 100, 100, [(1, "N1", 80, 90), (2, "N2", 80, 110), (3, "N3", 120, 100)])])
    cand = page([G("M1", "A", 100, 100, [(n, "Q", 80, 90) for n in range(1, 17)])])
    c = counts(gold, cand)
    assert (c["pin"]["found"], c["pin"]["npred"], c["pin"]["ngold"]) == (3, 16, 3)
    m = ev.finalize(c)
    assert m["pin_P"] == A(3 / 16) and m["pin_R"] == 1.0
    assert m["pin_err_median"] == A(20.0)  # błędy 0, 20, sqrt(1700)


# --- druty ---------------------------------------------------------------------------------


def test_sample_counts_exact():
    assert len(ev.sample_segments([(0, 0, 20, 0)])) == 5  # pozioma, 4 kroki
    assert len(ev.sample_segments([(0, 0, 0, 10)])) == 3  # pionowa
    assert len(ev.sample_segments([(0, 0, 3, 4)])) == 2  # ukośna, długość 5
    assert len(ev.sample_segments([(5, 5, 5, 5)])) == 1  # zerowa długość
    assert len(ev.sample_segments([(0, 0, 21, 0)])) == 6  # ceil(4.2) = 5 kroków


def test_wire_cells_dedup_and_merge_exact():
    base = (0, 0, 100, 0)
    assert len(ev.wire_cells([base])) == 21
    assert len(ev.wire_cells([base] * 10)) == 21  # powtórzenia
    assert len(ev.wire_cells([base, (100, 0, 0, 0)])) == 21  # odwrócony duplikat
    assert len(ev.wire_cells([(0, 0, 100, 0), (52, 0, 152, 0)])) == 32  # scalone 0..152
    assert len(ev.wire_cells([(0, 0, 10, 0), (10, 0, 20, 0)])) == 5  # stykające się
    assert len(ev.wire_cells([(0, 0, 12, 0), (12, 0, 24, 0)])) == 6  # scalone 0..24 (osobno: 7)
    assert len(ev.wire_cells([(0, 0, 100, 0), (50, 0, 50, 0)])) == 21  # punkt na odcinku
    assert len(ev.wire_cells([(0, 0, 100, 0), (50, -50, 50, 50)])) == 41  # wspólna próbka skrzyżowania
    assert len(ev.wire_cells([(0, 0, 30, 40)] * 3)) == 11  # ukośne duplikaty
    assert len(ev.wire_cells([(0, 0, 0, 0), (0, 0, 0, 0)])) == 1


def test_wire_duplicates_do_not_inflate_precision():
    gold = page(nets={"N": net([(0, 0, 100, 0), (200, 0, 300, 0)])})
    cand = page(nets={"N": net([(0, 0, 100, 0)] * 10)})
    c = counts(gold, cand)
    assert c["wire"] == {"gold_cov": 21, "gold_n": 42, "cand_cov": 21, "cand_n": 21}
    assert c["wire_geom"] == {"gold_cov": 21, "gold_n": 42, "cand_cov": 21, "cand_n": 21}


def test_wire_mixed_segments_exact():
    segs = [(0, 0, 20, 0), (100, 0, 100, 10), (200, 0, 203, 4), (300, 300, 300, 300)]
    gold = page(nets={"N": net(segs)})
    c = counts(gold, copy.deepcopy(gold))
    assert c["wire"] == {"gold_cov": 11, "gold_n": 11, "cand_cov": 11, "cand_n": 11}


@pytest.mark.parametrize("off,cov", [(2.9, 21), (3.1, 0)])
def test_wire_tolerance_inside_outside(off, cov):
    gold = page(nets={"N": net([(0, 0, 100, 0)])})
    cand = page(nets={"Q": net([(0, off, 100, off)])})  # bez endpointów: mapowanie geometrią
    assert counts(gold, cand)["wire_geom"] == {"gold_cov": cov, "gold_n": 21, "cand_cov": cov, "cand_n": 21}
    assert counts(gold, cand)["wire"] == {"gold_cov": cov, "gold_n": 21, "cand_cov": cov, "cand_n": 21}


def test_wire_partial_exact():
    gold = page(nets={"N": net([(0, 0, 100, 0)])})
    cand = page(nets={"N": net([(0, 0, 50, 0)])})
    c = counts(gold, cand)
    assert c["wire"] == {"gold_cov": 11, "gold_n": 21, "cand_cov": 11, "cand_n": 11}
    m = ev.finalize(c)
    assert m["wire_P"] == 1.0 and m["wire_R"] == A(11 / 21) and m["wire_F1"] == A(2 * (11 / 21) / (1 + 11 / 21))


def test_wire_precision_uses_candidate_coverage():
    gold = page(nets={"N": net([(0, 0, 100, 0)])})
    cand = page(nets={"N": net([(0, 1, 100, 1), (0, -1, 100, -1)])})
    c = counts(gold, cand)
    assert c["wire"] == {"gold_cov": 21, "gold_n": 21, "cand_cov": 42, "cand_n": 42}
    assert ev.finalize(c)["wire_P"] == 1.0


def test_wire_grid_has_low_f1():
    gold = page(nets={"N": net([(0, 500, 1000, 500)])})
    cand = page(nets={"G": net([(0, y, 1000, y) for y in range(0, 1001, 4)])})
    m = score(gold, cand)
    assert m["wire_R"] == 1.0 and m["wire_P"] < 0.02 and m["wire_F1"] < 0.04


def test_empty_named_net_segments_ignored():
    gold = page(nets={"": net([(0, 0, 100, 0)]), "N": net([(0, 50, 100, 50)])})
    c = counts(gold, page(nets={"N": net([(0, 50, 100, 50)])}))
    assert c["wire"] == {"gold_cov": 21, "gold_n": 21, "cand_cov": 21, "cand_n": 21}


def _two_net_page(seg_a, seg_b, names=("A", "B")):
    return xref_page({"a1": names[0], "a2": names[0], "b1": names[1], "b2": names[1]},
                     nets={names[0]: net([seg_a]), names[1]: net([seg_b])})


def test_wire_net_aware_swapped_segments_exact():
    sa, sb = (100, 300, 200, 300), (100, 600, 200, 600)
    gold = _two_net_page(sa, sb)
    c = counts(gold, _two_net_page(sb, sa))  # nety po endpointach A->A, B->B, ale druty zamienione
    assert c["wire"] == {"gold_cov": 0, "gold_n": 42, "cand_cov": 0, "cand_n": 42}
    assert c["wire_geom"] == {"gold_cov": 42, "gold_n": 42, "cand_cov": 42, "cand_n": 42}
    m = ev.finalize(c)
    assert m["wire_F1"] == 0.0 and m["wire_F1_geom"] == 1.0
    # nazwy netów kandydata inne, ale te same endpointy -> pełne 1.0
    assert ev.finalize(counts(gold, _two_net_page(sa, sb, names=("X", "Y"))))["wire_F1"] == 1.0


def test_wire_net_without_endpoints_mapped_by_geometry():
    sa, sb = (100, 300, 200, 300), (100, 600, 200, 600)
    gold = xref_page({"a1": "A", "a2": "A"}, nets={"A": net([sa]), "B": net([sb])})
    cand = xref_page({"a1": "A", "a2": "A"}, nets={"A": net([sa]), "Q": net([sb])})
    assert counts(gold, cand)["wire"] == {"gold_cov": 42, "gold_n": 42, "cand_cov": 42, "cand_n": 42}


def test_wire_one_net_for_everything_is_low():
    sa, sb = (100, 300, 200, 300), (100, 600, 200, 600)
    gold = _two_net_page(sa, sb)
    cand = xref_page({"a1": "A", "a2": "A", "b1": "B", "b2": "B"}, nets={"W": net([sa, sb])})
    c = counts(gold, cand)
    # W nie ma endpointów, a oba nety wzorca są zajęte przez A, B kandydata -> W bez mapy
    assert c["wire"] == {"gold_cov": 0, "gold_n": 42, "cand_cov": 0, "cand_n": 42}


# --- junctions ----------------------------------------------------------------------------


def test_derived_junctions_viewer_rule():
    split_t = page(nets={"N": net([(0, 0, 10, 0), (10, 0, 20, 0), (10, 0, 10, 10)])})
    assert ev.junctions_of(split_t) == [(10.0, 0.0)]
    unsplit_t = page(nets={"N": net([(0, 0, 20, 0), (10, 0, 10, 10)])})  # viewer: bez kropki
    assert ev.junctions_of(unsplit_t) == []
    crossing = page(nets={"N": net([(0, 0, 20, 0), (10, -10, 10, 10)])})
    assert ev.junctions_of(crossing) == []
    corner = page(nets={"N": net([(0, 0, 10, 0), (10, 0, 10, 10)])})
    assert ev.junctions_of(corner) == []
    two_nets = page(nets={"N": net([(0, 0, 10, 0), (10, 0, 20, 0)]), "M": net([(10, 0, 10, 10)])})
    assert ev.junctions_of(two_nets) == []
    dup = page(nets={"N": net([(0, 0, 10, 0), (10, 0, 0, 0), (0, 0, 10, 0)])})
    assert ev.junctions_of(dup) == []  # duplikaty odcinka nie tworzą kropki
    near = page(nets={"N": net([(0, 0, 10, 0), (10, 0, 20, 0), (10.4, 0, 10.4, 10)])})
    assert ev.junctions_of(near) == []  # dokładne współrzędne, bez zaokrąglania
    stored = page(nets={"N": net([(0, 0, 10, 0), (10, 0, 20, 0), (10, 0, 10, 10)],
                                 junctions=[[10, 0], [50, 50]])})
    assert sorted(ev.junctions_of(stored)) == [(10.0, 0.0), (50.0, 50.0)]
    assert ev.junctions_of(page(nets={"": net([(0, 0, 10, 0), (10, 0, 20, 0), (10, 0, 10, 10)])})) == []


@pytest.mark.parametrize("dx,tp", [(3, 1), (6, 0)])
def test_junction_tolerance(dx, tp):
    gold = page(nets={"N": net([(0, 0, 200, 0)], junctions=[[100, 0]])})
    cand = page(nets={"N": net([(0, 0, 200, 0)], junctions=[[100 + dx, 0]])})
    assert counts(gold, cand)["junc"] == {"tp": tp, "npred": 1, "ngold": 1}


def test_explicit_junctions_equal_derived():
    gold = page(nets={"N": net([(0, 0, 10, 0), (10, 0, 20, 0), (10, 0, 10, 10)])})
    cand = copy.deepcopy(gold)
    cand["nets"]["N"]["junctions"] = [[10, 0]]
    m = score(gold, cand)
    assert m["junc_P"] == 1.0 and m["junc_R"] == 1.0


# --- micro vs macro, układy katalogów, integralność ----------------------------------------


def _write(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(yaml.safe_dump(data, allow_unicode=True, sort_keys=False), encoding="utf-8")


def test_micro_average_differs_from_macro(tmp_path):
    gdir, cdir = tmp_path / "gold", tmp_path / "cand"
    p1 = page([G("M1", "A", 100, 100)])
    p2 = page([G("M1", "A", 100, 100), G("M2", "A", 300, 100), G("M3", "A", 500, 100)])
    _write(gdir / "PKG" / "1.sch.yaml", p1)
    _write(gdir / "PKG" / "2.sch.yaml", p2)
    _write(gdir / "manifest.yaml", {"pages": [
        {"package": "PKG", "page": "1", "scope": "gates_only"},
        {"package": "PKG", "page": "2", "scope": "gates_only"}]})
    _write(cdir / "PKG" / "1.sch.yaml", p1)
    _write(cdir / "PKG" / "2.sch.yaml", page())
    res = ev.evaluate(gdir, cdir, warn=lambda m: None)
    assert res["pages"]["PKG/1"]["metrics"]["gate_F1"] == 1.0
    assert res["pages"]["PKG/2"]["metrics"]["gate_F1"] == 0.0
    # micro: tp=1, npred=1, ngold=4 -> P=1, R=0.25, F1=0.4 (macro dałoby 0.5)
    assert res["total"]["gate_F1"] == A(0.4)
    assert len(res["integrity"]["modified"]) == 2  # wpisy bez sha256


def test_data_layout_with_pages_subdir(tmp_path):
    for f in (GOLD / PKG).glob("*.sch.yaml"):
        (tmp_path / PKG / "pages").mkdir(parents=True, exist_ok=True)
        shutil.copy(f, tmp_path / PKG / "pages" / f.name)
    res = ev.evaluate(GOLD, tmp_path, warn=lambda m: None)
    assert res["candidate_pages_found"] == 5
    assert res["headline"] == {"ep_acc": 1.0, "pair_F1": 1.0, "gate_F1": 1.0, "wire_F1": 1.0}


def test_cli_no_candidate_pages_is_error(tmp_path, capsys):
    assert ev.main(["--gold", str(GOLD), "--candidate", str(tmp_path)]) == 2
    assert "nie ma żadnej strony" in capsys.readouterr().err


@pytest.mark.parametrize("victim", [f"{PKG}/2-60.sch.yaml", f"{PKG}/package.yaml"])
def test_cli_integrity_modified_file(tmp_path, victim, capsys):
    gdir = tmp_path / "gold"
    shutil.copytree(GOLD, gdir)
    with open(gdir / victim, "a", encoding="utf-8") as f:
        f.write("\n# zmiana\n")
    assert ev.main(["--gold", str(gdir), "--candidate", str(GOLD)]) == 3
    assert victim in capsys.readouterr().err
    assert ev.main(["--gold", str(gdir), "--candidate", str(GOLD), "--allow-modified"]) == 0


def test_cli_integrity_missing_sha(tmp_path, capsys):
    gdir = tmp_path / "gold"
    shutil.copytree(GOLD, gdir)
    mf = yaml.safe_load((gdir / "manifest.yaml").read_text(encoding="utf-8"))
    del mf["pages"][0]["sha256"]
    _write(gdir / "manifest.yaml", mf)
    assert ev.main(["--gold", str(gdir), "--candidate", str(GOLD)]) == 3
    assert "nie ma sha256" in capsys.readouterr().err
    assert ev.main(["--gold", str(gdir), "--candidate", str(GOLD), "--allow-modified"]) == 0


def test_cli_integrity_missing_page_file(tmp_path, capsys):
    gdir = tmp_path / "gold"
    shutil.copytree(GOLD, gdir)
    (gdir / PKG / "2-61.sch.yaml").unlink()
    assert ev.main(["--gold", str(gdir), "--candidate", str(GOLD), "--allow-modified"]) == 3
    assert "brak pliku wzorca" in capsys.readouterr().err
    res = ev.evaluate(gdir, GOLD, warn=lambda m: None)  # API: bez wyjątku, strona pominięta
    assert len(res["pages"]) == 4 and res["integrity"]["fatal"]


# --- wzorzec vs wzorzec i perturbacje ------------------------------------------------------


@pytest.fixture(scope="module")
def gold_page() -> dict:
    return yaml.safe_load((GOLD / PKG / f"{PAGE}.sch.yaml").read_text(encoding="utf-8"))


def assert_only(m: dict, lowered: set[str]):
    """Klucze z `lowered` < 1.0, wszystkie inne określone ilorazy == 1.0."""
    for k, v in m.items():
        if k == "pin_err_median":
            continue
        if k in lowered:
            assert v is not None and v < 1.0, f"{k} powinno spaść, jest {v}"
        elif v is not None:
            assert v == A(1.0), f"{k} nie powinno się zmienić, jest {v}"


def rename_net(pg, old, new):
    for g in pg["gates"]:
        for p in g["pins"]:
            if p.get("net") == old:
                p["net"] = new
    for x in (pg.get("ports") or []) + (pg.get("cross_refs") or []):
        if x.get("net") == old:
            x["net"] = new


def test_gold_vs_itself_all_dirs():
    res = ev.evaluate(GOLD, GOLD, warn=lambda m: pytest.fail(m))
    assert res["integrity"] == {"fatal": [], "modified": []} and res["candidate_pages_found"] == 5
    for name, p in list(res["pages"].items()) + [("TOTAL", {"metrics": res["total"]})]:
        assert_only(p["metrics"], set())
        assert p["metrics"]["pin_err_median"] == 0.0, name
    assert res["headline"] == {"ep_acc": 1.0, "pair_F1": 1.0, "gate_F1": 1.0, "wire_F1": 1.0}
    m63 = res["pages"]["P-R3-2/2-63"]["metrics"]
    assert "pair_F1" not in m63 and "wire_F1" not in m63 and "ep_acc" not in m63


def test_a_delete_gate(gold_page):
    cand = copy.deepcopy(gold_page)
    del cand["gates"][0]
    m = score(gold_page, cand)
    n = len(gold_page["gates"])
    assert m["gate_P"] == 1.0 and m["gate_R"] == A((n - 1) / n) and m["gate_F1"] == A(2 * (n - 1) / (2 * n - 1))
    o = oracle(page_endpoints(gold_page), page_endpoints(gold_page, skip_gates={0}))
    assert_oracle(m, o)
    assert m["pair_P"] == 1.0 and m["pair_F1_cond"] == 1.0
    assert_only(m, {"gate_R", "gate_F1", "pair_R", "pair_F1", "ep_acc", "ep_jacc"})


def test_b_move_gate_40px(gold_page):
    cand = copy.deepcopy(gold_page)
    cand["gates"][0]["x"] += 40
    m = score(gold_page, cand)
    n = len(gold_page["gates"])
    assert m["gate_P"] == A((n - 1) / n) and m["gate_R"] == A((n - 1) / n)
    extra = [ev.net_of(p) for p in gold_page["gates"][0]["pins"]]
    o = oracle(page_endpoints(gold_page), page_endpoints(gold_page, skip_gates={0}), extra)
    assert_oracle(m, o)
    assert_only(m, {"gate_P", "gate_R", "gate_F1", "pair_P", "pair_R", "pair_F1", "ep_acc", "ep_jacc"})


def test_c_split_net(gold_page):
    cand = copy.deepcopy(gold_page)
    sizes = Counter(n for n in page_endpoints(gold_page).values() if n)
    pin = next(p for g in cand["gates"] for p in g["pins"] if sizes[ev.net_of(p)] >= 2)
    pin["net"] = "NET_FRESH_SPLIT"
    m = score(gold_page, cand)
    assert_oracle(m, oracle(page_endpoints(gold_page), page_endpoints(cand)))
    assert_only(m, {"pair_R", "pair_F1", "pair_R_cond", "pair_F1_cond", "ep_acc", "ep_jacc"})


def test_d_merge_two_nets(gold_page):
    cand = copy.deepcopy(gold_page)
    big = [n for n, k in Counter(n for n in page_endpoints(gold_page).values() if n).most_common() if k >= 2]
    rename_net(cand, big[1], big[0])
    m = score(gold_page, cand)
    assert_oracle(m, oracle(page_endpoints(gold_page), page_endpoints(cand)))
    # druty zostają: net kandydata big[1] (już bez endpointów) mapuje się geometrią na big[1]
    assert_only(m, {"pair_P", "pair_F1", "pair_P_cond", "pair_F1_cond", "ep_acc", "ep_jacc"})


def test_e_delete_wire_segment(gold_page):
    cand = copy.deepcopy(gold_page)
    before = sorted(ev.junctions_of(gold_page))
    best = None
    for name, n in cand["nets"].items():
        for i, s in enumerate(n.get("segments") or []):
            trial = copy.deepcopy(cand)
            del trial["nets"][name]["segments"][i]
            if sorted(ev.junctions_of(trial)) != before:
                continue  # usunięcie zmieniłoby kropki — chcemy czysto „brak drutu”
            length = math.hypot(s[2] - s[0], s[3] - s[1])
            if best is None or length > best[0]:
                best = (length, name, i)
    _, name, i = best
    del cand["nets"][name]["segments"][i]
    # wyrocznia: próbki wzorca netu `name` pokryte przez pozostałe odcinki TEGO netu
    gold_n = sum(len(ev.wire_cells([tuple(map(float, s)) for s in n["segments"]]))
                 for k, n in gold_page["nets"].items() if n.get("segments"))
    cells = ev.wire_cells([tuple(map(float, s)) for s in gold_page["nets"][name]["segments"]])
    lost = len(cells) - covered(cells, cand["nets"][name]["segments"])
    all_gold = [tuple(map(float, s)) for n in gold_page["nets"].values() for s in n.get("segments") or []]
    all_cand = [tuple(map(float, s)) for n in cand["nets"].values() for s in n.get("segments") or []]
    geom_cells = ev.wire_cells(all_gold)
    geom_r = covered(geom_cells, all_cand) / len(geom_cells)
    m = score(gold_page, cand)
    assert m["wire_P"] == 1.0 and m["wire_R"] == A((gold_n - lost) / gold_n)
    assert m["wire_P_geom"] == 1.0 and m["wire_R_geom"] == A(geom_r)
    assert lost > 0
    assert_only(m, {"wire_R", "wire_F1"} | ({"wire_R_geom", "wire_F1_geom"} if geom_r < 1 else set()))


def test_f_rename_all_nets(gold_page):
    cand = copy.deepcopy(gold_page)
    names = sorted({n for n in page_endpoints(gold_page).values() if n} | {k for k in gold_page["nets"] if k.strip()})
    mapping = {n: f"RENAMED_{k}" for k, n in enumerate(names)}
    for old, new in mapping.items():
        rename_net(cand, old, new)
    cand["nets"] = {mapping.get(k, k): v for k, v in cand["nets"].items()}
    assert_only(score(gold_page, cand), set())


def test_g_empty_candidate(gold_page):
    m = score(gold_page, ev.empty_page(PKG, PAGE))
    for k in ("ep_acc", "ep_jacc", "gate_P", "gate_R", "gate_F1", "pair_P", "pair_R", "pair_F1",
              "wire_P", "wire_R", "wire_F1", "junc_P", "junc_R", "port_F1", "xref_F1"):
        assert m[k] == 0.0, k
    assert m["gate_ref_acc"] is None and m["pin_R"] is None


def test_giant_net_on_gold(gold_page):
    cand = copy.deepcopy(gold_page)
    for g in cand["gates"]:
        for p in g["pins"]:
            p["net"] = "Z"
    for x in cand["ports"] + cand["cross_refs"]:
        x["net"] = "Z"
    m = score(gold_page, cand)
    assert_oracle(m, oracle(page_endpoints(gold_page), page_endpoints(cand)))
    assert m["pair_R"] == 1.0 and m["ep_acc"] == 0.0


def test_all_singletons_on_gold(gold_page):
    cand = copy.deepcopy(gold_page)
    k = 0
    for g in cand["gates"]:
        for p in g["pins"]:
            p["net"], k = f"S{k}", k + 1
    for x in cand["ports"] + cand["cross_refs"]:
        x["net"], k = f"S{k}", k + 1
    m = score(gold_page, cand)
    assert_oracle(m, oracle(page_endpoints(gold_page), page_endpoints(cand)))
    assert (m["pair_P"], m["pair_R"], m["pair_F1"]) == (0.0, 0.0, 0.0)


def test_two_gates_only_headline_low(gold_page):
    cand = page(gates=copy.deepcopy(gold_page["gates"][:2]))
    m = score(gold_page, cand)
    n = len(gold_page["gates"])
    assert_oracle(m, oracle(page_endpoints(gold_page), page_endpoints(page(gates=gold_page["gates"][:2]))))
    assert m["gate_F1"] == A(2 * (2 / n) / (1 + 2 / n))
    assert m["wire_F1"] == 0.0 and m["ep_acc"] < 0.1 and m["pair_F1"] < 0.1


def test_wire_mapping_endpoints_strictly_dominate_geometry():
    # gold: n1{A,B} drut y=0, n2{C,D} drut y=100. Kandydat zgubił C, D; B bez netu; A w c1
    # narysowanym na y=100; drut y=0 w pływającym c2. Wspólny endpoint A wiąże c1 z n1
    # mocniej niż jakakolwiek suma geometrii -> druty w złych netach.
    g = page(xrefs=[X("A", "n1", 0, 0), X("B", "n1", 200, 0), X("C", "n2", 0, 100), X("D", "n2", 200, 100)],
             nets={"n1": net([(0, 0, 200, 0)]), "n2": net([(0, 100, 200, 100)])})
    bad = page(xrefs=[X("A", "c1", 0, 0), X("B", "", 200, 0)],
               nets={"c1": net([(0, 100, 200, 100)]), "c2": net([(0, 0, 200, 0)])})
    assert counts(g, bad)["wire"] == {"gold_cov": 0, "gold_n": 82, "cand_cov": 0, "cand_n": 82}
    good = page(xrefs=[X("A", "c1", 0, 0), X("B", "", 200, 0)],
                nets={"c1": net([(0, 0, 200, 0)]), "c2": net([(0, 100, 200, 100)])})
    assert counts(g, good)["wire"] == {"gold_cov": 82, "gold_n": 82, "cand_cov": 82, "cand_n": 82}


@pytest.mark.parametrize("exact,halves", [("a", "z"), ("z", "a")])
def test_wire_mapping_tie_does_not_depend_on_names(exact, halves):
    g = page(nets={"n1": net([(0, 0, 200, 0)])})
    # obie kandydatki mają po 41 próbek <= 3 px od wzorca (remis po stronie kandydata);
    # połówki pokrywają jednak tylko x 0..100 wzorca
    c = page(nets={exact: net([(0, 0, 200, 0)]), halves: net([(0, 2, 100, 2), (0, -2, 95, -2)])})
    assert len(ev.wire_cells([(0, 2, 100, 2), (0, -2, 95, -2)])) == 41
    # dokładna kopia wygrywa symetryczną geometrią (próbki wzorca najbliżej jej odcinków)
    assert counts(g, c)["wire"] == {"gold_cov": 41, "gold_n": 41, "cand_cov": 41, "cand_n": 82}


def _rename_nets(pg, seed):
    rnd = random.Random(seed)
    pg = copy.deepcopy(pg)
    new = {n: f"z{rnd.randrange(10 ** 9)}_{i}" for i, n in enumerate(pg["nets"]) if ev.norm_str(n)}
    items = list(pg["nets"].items())
    rnd.shuffle(items)
    pg["nets"] = {new.get(n, n): v for n, v in items}
    for o in [p for g in pg["gates"] for p in g["pins"]] + pg["ports"] + pg["cross_refs"]:
        if o.get("net") in new:
            o["net"] = new[o["net"]]
    rnd.shuffle(pg["gates"])
    rnd.shuffle(pg["ports"])
    rnd.shuffle(pg["cross_refs"])
    return pg


@pytest.mark.parametrize("name", ["2-58", "2-60"])
def test_renaming_candidate_nets_changes_nothing(name):
    gold = yaml.safe_load((GOLD / PKG / f"{name}.sch.yaml").read_text(encoding="utf-8"))
    cand = copy.deepcopy(gold)
    names = [k for k, n in cand["nets"].items() if n.get("segments")]
    segs = [cand["nets"][k]["segments"] for k in names]
    for k, s in zip(names[:6], segs[1:7]):  # część drutów przesunięta do sąsiednich netów
        cand["nets"][k]["segments"] = s
    cand["nets"]["FLOAT"] = net([(100, 100, 300, 100)] + segs[0][:2])
    cand["gates"][0]["pins"][0]["net"] = "SPLIT"
    ref = counts(gold, cand)
    for seed in range(3):
        assert counts(gold, _rename_nets(cand, seed)) == ref


def test_net_names_are_stripped_everywhere(gold_page):
    cand = copy.deepcopy(gold_page)
    cand["nets"] = {f"{k} ": v for k, v in cand["nets"].items()}
    for o in [p for g in cand["gates"] for p in g["pins"]] + cand["ports"] + cand["cross_refs"]:
        if ev.norm_str(o.get("net")):
            o["net"] = f" {o['net']} "
    assert_only(score(gold_page, cand), set())
    # dwa klucze równe po strip = jeden net (także dla kropek)
    pg = page(nets={"N": net([(0, 0, 10, 0), (10, 0, 20, 0)]), "N ": net([(10, 0, 10, 10)])})
    assert ev.junctions_of(pg) == [(10.0, 0.0)]


def test_collinear_merge_diagonals_and_gaps_exact():
    assert len(ev.wire_cells([(0, 0, 100, 100), (50, 50, 150, 150)])) == 44  # scalone 0..150
    assert len(ev.wire_cells([(0, 0, 100, 100), (150, 150, 50, 50)])) == 44  # odwrócony
    assert len(ev.wire_cells([(0, 0, 100, 100), (0, 1, 100, 101)])) == 60  # równoległe, osobno
    assert len(ev.wire_cells([(0, 0, 30, 40), (36, 48, 66, 88)])) == 22  # przerwa 10 px na ukos
    assert len(ev.wire_cells([(0, 0, 12, 0), (16, 0, 28, 0)])) == 8  # przerwa 4 px: osobno (scalone: 7)
    assert len(ev.wire_cells([(0, 0, 12, 0), (42, 0, 54, 0)])) == 8  # przerwa 30 px (scalone: 12)
    assert len(ev.wire_cells([(0, 0, 0, 12), (0, 16, 0, 28)])) == 8  # pionowo, przerwa 4 px


def test_ep_missing_endpoint_with_empty_or_disconnected_gold_net_is_wrong():
    gold = xref_page({"a": "", "b": "N", "c": "N"})
    cand = page(xrefs=[X("b", "N", 200, 100), X("c", "N", 300, 100)])
    assert counts(gold, cand)["ep"] == {"ok": 2, "jacc": A(2.0), "n": 3}
    g = page([G("M1", "A", 100, 100, [(1, "N", 80, 90), (2, "N", 80, 110)])])
    g["gates"][0]["pins"].append({"num": 3, "net": "", "px": 120, "py": 100, "side": "right",
                                  "disconnected": True})
    c = page([G("M1", "A", 100, 100, [(1, "N", 80, 90), (2, "N", 80, 110)])])
    assert counts(g, c)["ep"] == {"ok": 2, "jacc": A(2.0), "n": 3}


def test_tiny_chunks_give_identical_counts(gold_page, monkeypatch):
    cand = copy.deepcopy(gold_page)
    names = [k for k, n in cand["nets"].items() if n.get("segments")]
    cand["nets"][names[0]]["segments"] = cand["nets"][names[0]]["segments"] + cand["nets"][names[1]]["segments"]
    cand["nets"][names[1]]["segments"] = []
    cand["nets"]["EXTRA"] = net([(10, 10, 400, 300), (10, 10, 400, 300), (50, 900, 50, 1200)])
    ref = counts(gold_page, cand)
    monkeypatch.setattr(ev, "_SAMPLE_CHUNK", 7)
    monkeypatch.setattr(ev, "_CHUNK_ELEMS", 13)
    assert counts(gold_page, cand) == ref
    assert len(ev.wire_cells([(0, 0, 100, 0)] * 3 + [(0, 0, 30, 40)])) == 21 + 10


def test_one_net_w_and_shuffled_wires_low(gold_page):
    w = copy.deepcopy(gold_page)
    w["nets"] = {"W": net([s for n in gold_page["nets"].values() for s in n.get("segments") or []])}
    mw = score(gold_page, w)
    assert mw["wire_F1_geom"] == 1.0 and mw["wire_F1"] < 0.1
    sh = copy.deepcopy(gold_page)
    names = [k for k, n in sh["nets"].items() if n.get("segments")]
    segs = [sh["nets"][k]["segments"] for k in names]
    for k, s in zip(names, segs[1:] + segs[:1]):
        sh["nets"][k]["segments"] = s
    ms = score(gold_page, sh)
    assert ms["wire_F1_geom"] == 1.0 and ms["wire_F1"] < 0.1
    assert ms["ep_acc"] == 1.0 and ms["pair_F1"] == 1.0  # endpointy nietknięte
