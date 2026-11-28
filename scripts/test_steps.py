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


def _labels_page():
    """Jak FIXTURE w steps.test.ts: port A50 (10,90) left, odsyłacz -X (900,100), zasilanie (50,20)."""
    return {
        "steps": {"labels": {"status": "approved"}, "nets": {"status": "approved"}},
        "power": [{"type": "VCC", "x": 50, "y": 20, "net": "VCC"}],
        "ports": [{"connector": "A", "pin": 50, "label": "-BLR", "net": "N1", "x": 10, "y": 90, "side": "left"}],
        "cross_refs": [{"net": "N2", "label": "-X", "pages": ["2"], "x": 900, "y": 100, "side": "right"}],
        "nets": {"N1": {"segments": [[10, 90, 70, 90]]},
                 "N2": {"segments": [[130, 100, 200, 100], [200, 100, 270, 100], [200, 100, 200, 150]]}},
    }


def test_label_anchor_ends_and_stale_targets_like_ts():
    p = _labels_page()
    assert S.label_anchor_ends(p) == []
    q = copy.deepcopy(p)
    q["nets"]["N2"]["segments"].append([800, 100, 900, 100])
    assert S.label_anchor_ends(q) == [(900.0, 100.0)]  # punkt kotwicy (odsyłacz)
    assert S.label_ends_changed(p, q)
    moved = copy.deepcopy(q)
    moved["nets"]["N2"]["segments"][3][2] = 905  # ≤ 8 px: bez zmiany
    assert not S.label_ends_changed(q, moved)
    moved["nets"]["N2"]["segments"][3][2] = 880  # > 8 px: zmiana
    assert S.label_ends_changed(q, moved)
    joined = copy.deepcopy(q)
    joined["nets"]["N2"]["segments"].append([900, 100, 900, 200])  # dwa końce tego samego netu
    assert S.label_anchor_ends(joined) == [(900.0, 100.0)] and not S.label_ends_changed(q, joined)
    other = copy.deepcopy(q)
    other["nets"]["X"] = {"segments": [[905, 104, 905, 300]]}  # koniec innego netu ≤ 8 px
    other["nets"]["N2"]["segments"][3][2] = 700
    assert not S.label_ends_changed(q, other)
    other["nets"]["X"]["segments"] = [[950, 100, 950, 300]]
    assert S.label_ends_changed(q, other)
    # Port: otwarty koniec (10 + 76, 90) — jak PortLayer / steps.ts; pin 50.0 jak 50 w JS.
    r = copy.deepcopy(p)
    r["ports"][0]["pin"] = 50.0
    r["nets"]["N1"]["segments"].append([86.0, 90.0, 86, 200])
    assert S.label_anchor_ends(r) == [(86.0, 90.0)]
    # Brak klucza pin: JS `${undefined}` = "undefined" → "Aundefined" (10 znaków): 10·16+12 = 172,
    # bw = 188 → x = 198 (jak w steps.test.ts); jawny null → "Anull": 5·16+12 = 92, bw = 108 → 118.
    no_pin = {k: v for k, v in r["ports"][0].items() if k != "pin"}
    assert S._port_open_end(no_pin) == (198.0, 90.0)
    assert S._port_open_end({**no_pin, "pin": None}) == (118.0, 90.0)
    no_pin_page = {"ports": [no_pin], "nets": {"Q": {"segments": [[198, 90, 300, 90]]}}}
    assert S.label_anchor_ends(no_pin_page) == [(198.0, 90.0)]
    assert S.stale_targets("wires", False) == ["nets"]
    assert S.stale_targets("wires", True) == ["labels", "nets"]
    assert S.stale_targets("text", False) == ["wires", "labels", "nets"]
    assert S.mark_stale(p, ["nets"], "T") == ["nets"]
    assert p["steps"]["labels"]["status"] == "approved" and p["steps"]["nets"] == {"status": "stale", "at": "T"}


# --- parzystość odcisku z steps.ts (node) ---

def _variants():
    base_pin = {"num": 3, "side": "left", "net": "", "px": 70, "py": 100}
    base = {"ref": "M1", "gate": "B", "x": 100, "y": 100, "w": 60, "h": 90, "rotation": 0}

    def page(pin_over=None, gate_over=None, drop=()):
        pin = {**base_pin, **(pin_over or {})}
        g = {**base, **(gate_over or {}), "pins": [pin]}
        for d in drop:
            (pin if d in base_pin else g).pop(d, None)
        return {"gates": [g], "nets": {}}

    return [
        page(), page({"src": "auto"}), page({"px": 70.0}), page({"px": None}), page(drop=("px",)),
        page({"px": "70"}), page({"px": 0}), page({"px": 71}), page({"num": 3.0}), page({"num": 4}),
        page({"side": None}), page(drop=("side",)), page({"disconnected": True}),
        page({"disconnected": False}), page(gate_over={"x": 101}), page(gate_over={"x": None}),
        page(gate_over={"ref": None}), page(drop=("ref",)), page(gate_over={"gate": None}),
        page(drop=("gate",)), page(gate_over={"value": "1k"}), page(gate_over={"label_left": None}),
        page(gate_over={"y": -0.0}), page(gate_over={"y": 0}), page(gate_over={"w": None}),
        page(drop=("w",)), page(gate_over={"rotation": None}),
    ]


def test_step_fingerprint_parity_with_steps_ts(tmp_path):
    """Te same strony → te same równości odcisków (gates, text) w Pythonie i w steps.ts."""
    import json
    import shutil
    import subprocess

    import pytest

    node = shutil.which("node")
    ts = Path(__file__).resolve().parent.parent / "shared" / "src" / "steps.ts"
    if not node or not ts.is_file():
        pytest.skip("brak node albo shared/src/steps.ts")
    pages = _variants()
    inp, out, js = tmp_path / "in.json", tmp_path / "out.json", tmp_path / "fp.mjs"
    inp.write_text(json.dumps(pages))
    js.write_text(
        "import fs from 'node:fs';\n"
        f"const {{ stepFingerprint }} = await import({json.dumps(str(ts))});\n"
        "const pages = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\n"
        "fs.writeFileSync(process.argv[3], JSON.stringify(pages.map((p) =>\n"
        "  ['gates', 'text'].map((s) => stepFingerprint(p, s)))));\n")
    r = subprocess.run([node, "--experimental-strip-types", "--no-warnings", str(js), str(inp), str(out)],
                       capture_output=True, text=True)
    if r.returncode != 0 and "strip-types" in r.stderr:
        pytest.skip("node bez --experimental-strip-types")
    assert r.returncode == 0, r.stderr
    ts_fp = json.loads(out.read_text())
    for si, step in enumerate(("gates", "text")):
        py = [S.step_fingerprint(json.loads(json.dumps(p)), step) for p in pages]
        for i in range(len(pages)):
            for j in range(i + 1, len(pages)):
                assert (py[i] == py[j]) == (ts_fp[i][si] == ts_fp[j][si]), (step, pages[i], pages[j])
    # null i brak px to to samo; 0 — co innego
    text = [S.step_fingerprint(p, "text") for p in pages]
    assert text[3] == text[4] != text[6]
