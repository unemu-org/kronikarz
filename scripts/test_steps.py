"""Testy scripts/_steps.py — te same przypadki co shared/src/steps.test.ts (część potrzebna
writerowi: stan kroków, canRun / next / stale, pustość aspektów, druty po wartości).

Uruchomienie (nie zostawia __pycache__ ani .pytest_cache):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml \\
      pytest -p no:cacheprovider scripts/test_steps.py
"""
from __future__ import annotations

import copy
import math
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import _steps as S  # noqa: E402

# Własny fixture (jak FIXTURE w steps.test.ts, bez danych z data/).
PAGE = {
    "kronikarz": "1", "page": "2-1", "package": "P-T", "scan_size": [1000, 800],
    "steps": {
        "gates": {"status": "approved", "run": "r1", "at": "2026-11-27T10:00:00Z"},
        "text": {"status": "approved", "run": "r2"},
        "wires": {"status": "approved"},
        "labels": {"status": "auto", "run": "r4"},
    },
    "gates": [], "power": [], "nets": {}, "annotations": [],
}


def page():
    return copy.deepcopy(PAGE)


def test_step_status_missing_or_bad_is_todo():
    p = page()
    assert S.STEP_ORDER == ("gates", "text", "wires", "labels", "nets")
    assert S.step_status(p, "gates") == "approved"
    assert S.step_status(p, "labels") == "auto"
    assert S.step_status(p, "nets") == "todo"
    assert S.step_status({}, "gates") == "todo"
    assert S.step_status({"steps": {"gates": {"status": "bogus"}}}, "gates") == "todo"
    assert S.step_status({"steps": ["gates"]}, "gates") == "todo"
    assert S.step_status({"steps": {"gates": "approved"}}, "gates") == "todo"


def test_element_src():
    assert S.element_src({"src": "auto"}) == "auto"
    assert S.element_src({"text_src": "auto"}, "text_src") == "auto"
    assert S.element_src({}) == "edited"
    assert S.element_src({"src": "edited"}) == "edited"
    assert S.element_src({"src": "AUTO"}) == "edited"


def test_mark_stale_after_only_later_approved():
    p = page()
    assert S.mark_stale_after(p, "gates", "T") == ["text", "wires"]
    assert p["steps"]["gates"]["status"] == "approved"
    assert p["steps"]["text"] == {"status": "stale", "run": "r2", "at": "T"}
    assert p["steps"]["labels"]["status"] == "auto"
    assert S.mark_stale_after(p, "gates") == []
    q = page()
    del q["steps"]
    assert S.mark_stale_after(q, "gates") == []


def test_can_run():
    p = page()
    assert S.can_run({}, "gates") == (True, "")
    assert S.can_run({}, "text")[0] is False
    assert S.can_run({}, "text", draft=True)[0] is True
    assert S.can_run(p, "gates")[0] is False
    assert "--force" in S.can_run(p, "gates")[1]
    assert S.can_run(p, "gates", force=True)[0] is True
    assert S.can_run(p, "labels")[0] is True  # wires approved, labels auto
    assert S.can_run(p, "nets")[0] is False  # labels tylko auto
    p["steps"]["wires"]["status"] = "stale"
    assert S.can_run(p, "labels")[0] is False
    assert S.can_run(p, "nope")[0] is False


def test_next_runnable_step():
    p = page()
    assert S.next_runnable_step({}) == "gates"
    assert S.next_runnable_step(p) == "labels"
    p["steps"]["labels"]["status"] = "approved"
    assert S.next_runnable_step(p) == "nets"
    p["steps"]["nets"] = {"status": "approved"}
    assert S.next_runnable_step(p) is None
    p["steps"]["text"]["status"] = "stale"
    assert S.next_runnable_step(p) == "text"


def test_aspect_empty_whole_aspect_only():
    g = {"ref": "", "gate": None, "x": 1, "y": 2, "rotation": 0, "pins": []}
    assert S.aspect_empty("gate", g, "text_src") is True
    assert S.aspect_empty("gate", g, "src") is False
    assert S.aspect_empty("gate", {**g, "ref": "  "}, "text_src") is True
    assert S.aspect_empty("gate", {**g, "ref": "M5"}, "text_src") is False
    assert S.aspect_empty("gate", {**g, "value": "1k"}, "text_src") is False
    assert S.aspect_empty("gate", {**g, "pins": [{"num": 1}]}, "text_src") is False
    assert S.aspect_empty("gate", {}, "src") is True
    assert S.aspect_empty("gate", {"x": True, "y": None}, "src") is True  # bool to nie liczba
    assert S.aspect_empty("gate", {"x": math.inf}, "src") is True
    assert S.aspect_empty("pin", {"num": 1, "side": "left", "net": ""}, "net_src") is True
    assert S.aspect_empty("pin", {"num": 1, "side": "left", "net": "",
                                  "cross": {"page": "2", "label": "X"}}, "net_src") is False
    assert S.aspect_empty("pin", {"num": 1, "side": "left", "net": "N"}, "net_src") is False
    assert S.aspect_empty("pin", {"net": ""}, "src") is True
    assert S.aspect_empty("pin", {"num": 3}, "src") is False
    assert S.aspect_empty("port", {"connector": "", "label": "", "net": "", "x": 1, "y": 2}, "src") is True
    assert S.aspect_empty("port", {"connector": "A", "label": "", "net": ""}, "src") is False
    assert S.aspect_empty("port", {"connector": "", "pin": 5, "label": ""}, "src") is False
    assert S.aspect_empty("cross_ref", {"label": "", "pages": [], "net": ""}, "src") is True
    assert S.aspect_empty("cross_ref", {"label": "", "pages": ["3"]}, "src") is False
    assert S.aspect_empty("cross_ref", {"net": None}, "net_src") is True
    assert S.aspect_empty("power", {"type": "", "net": "VCC"}, "src") is True
    assert S.aspect_empty("power", {"type": "VCC", "net": "VCC"}, "net_src") is False
    assert S.aspect_empty("port", {"label": ""}, "text_src") is False  # aspekt nie istnieje


def test_segment_key_direction_and_bad_entries():
    assert S.segment_key([10, 5, 0, 5]) == S.segment_key([0, 5, 10, 5])
    assert S.segment_key([0, 0, 0, 9]) == S.segment_key([0, 9, 0, 0])
    assert S.segment_key([1, 2, 3, 4]) == S.segment_key([1.0, 2.0, 3.0, 4.0])
    assert S.segment_key([1, 2]) != S.segment_key([1, 2, 3, 4])
    assert S.is_segment([1, 2, 3, 4]) and not S.is_segment([1, 2, 3, True])
    assert not S.is_segment([1, 2, 3, math.inf]) and not S.is_segment("abcd")
    assert S.is_junction([1, 2]) and not S.is_junction([1, 2, 3])


def test_auto_masks_by_value_with_multiplicity():
    n = {"segments": [[0, 0, 10, 0], [10, 0, 0, 0], [10, 0, 10, 9]],
         "auto_segments": [[0, 0, 10, 0]],
         "junctions": [[10, 0], [10, 0]], "auto_junctions": [[10, 0], [10, 0], [5, 5]]}
    assert S.auto_segment_mask(n) == [True, False, False]  # jeden wpis = jeden odcinek
    assert S.auto_junction_mask(n) == [True, True]
    n["auto_segments"].append([10, 0, 0, 0])
    assert S.auto_segment_mask(n) == [True, True, False]


def test_auto_masks_bad_entries_skipped():
    for bad in ({"a": 1}, [5], [[1, 2]], "x", True, [[1, 2, 3, math.inf]], None):
        n = {"segments": [[0, 0, 1, 1]], "junctions": [[0, 0]],
             "auto_segments": bad, "auto_junctions": bad}
        assert S.auto_segment_mask(n) == [False], bad
        assert S.auto_junction_mask(n) == [False], bad
    n = {"segments": [[0, 0, 1, 1], [1, 2], "q"], "junctions": "zz",
         "auto_segments": [[1, 1, 0, 0], [1, 2]]}
    assert S.auto_segment_mask(n) == [True, False, False]
    assert S.auto_junction_mask(n) == []


def test_step_fingerprint_gates_and_wires():
    p = page()
    p["gates"] = [{"x": 1, "y": 2, "w": 3, "h": 4}]
    a = S.step_fingerprint(p, "gates")
    p["gates"][0]["verified"] = True
    p["gates"][0]["src"] = "auto"
    assert S.step_fingerprint(p, "gates") == a  # verified / src to nie treść
    p["gates"][0]["x"] = 5
    assert S.step_fingerprint(p, "gates") != a
    p["nets"] = {"A": {"segments": [[0, 0, 5, 0]], "junctions": None}}
    w = S.step_fingerprint(p, "wires")
    p["nets"] = {"B": {"segments": [[5, 0, 0, 0]], "junctions": None, "auto_segments": [[0, 0, 5, 0]]}}
    assert S.step_fingerprint(p, "wires") == w  # nazwa netu i kierunek bez znaczenia


def test_numbers_normalised_like_js():
    # JSON.stringify w steps.ts: 545.0 == 545, -0 == 0
    assert S.segment_key([545.0, -0.0, 600, 0]) == S.segment_key([545, 0, 600, 0])
    assert repr(S.segment_key([0, -0.0, 5, 0])) == repr(S.segment_key([0, 0, 5, 0]))
    assert S.junction_key([-0.0, 1.0]) == S.junction_key([0, 1])
    a = {"gates": [{"x": 545.0, "y": -0.0, "w": 60, "h": None}]}
    b = {"gates": [{"x": 545, "y": 0, "w": 60.0}]}
    assert S.step_fingerprint(a, "gates") == S.step_fingerprint(b, "gates")
    # rotation ?? 0: brak = 0, ale "0" (napis) to co innego
    assert S.step_fingerprint({"gates": [{"x": 1, "rotation": 0}]}, "gates") == \
        S.step_fingerprint({"gates": [{"x": 1}]}, "gates")
    assert S.step_fingerprint({"gates": [{"x": 1, "rotation": "0"}]}, "gates") != \
        S.step_fingerprint({"gates": [{"x": 1}]}, "gates")
    w1 = {"nets": {"A": {"segments": [[0.0, -0.0, 5.0, 0]], "junctions": [[-0.0, 0]]}}}
    w2 = {"nets": {"A": {"segments": [[5, 0, 0, 0]], "junctions": [[0, 0]]}}}
    assert S.step_fingerprint(w1, "wires") == S.step_fingerprint(w2, "wires")
