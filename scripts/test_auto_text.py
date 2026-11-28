"""Testy kroku ② `text` w scripts/auto.py (kr-9p8.27): które bramki czyta, samokorekta z ic_map
i rejestrem pakietu, położenie pinów, scalanie, stan kroku, snapshot, dry-run, kody wyjścia,
hak płatnego modelu. Model jest podmieniony (FakeVlm) — testy nie ładują prawdziwego modelu.
Własne fixture'y (bez treści z data/), skany syntetyczne.

Uruchomienie (nie zostawia __pycache__ ani .pytest_cache):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy \\
      --with opencv-python-headless --with pillow pytest -p no:cacheprovider \\
      scripts/test_auto_text.py
"""
from __future__ import annotations

import copy
import importlib.util
import json
import sys
import time
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
import _steps as S  # noqa: E402
import _vlm  # noqa: E402

IC_MAP = {
    "00": {"gate_pins": {"A": {"in": [1, 2], "out": [3]}, "B": {"in": [4, 5], "out": [6]}}},
    "04": {"gate_pins": {"A": {"in": [1], "out": [2]}, "B": {"in": [3], "out": [4]},
                         "C": {"in": [5], "out": [6]}}},
    # dwie bramki z tymi samymi wejściami — litera tylko z rejestru albo z wyjścia
    "X2": {"gate_pins": {"A": {"in": [1, 2], "out": [3]}, "B": {"in": [1, 2], "out": [4]}}},
    "175": {"gate_pins": {"A": {"clk": [9], "clr": [1], "d": [4, 5], "q": [2, 7], "nq": [3, 6]}}},
    "R": {"kicad_symbol": "Device:R"},
}
COMPONENTS = {
    "M1": {"ic": "04", "gates": {"A": {"page": "2-1"}, "B": {"page": "2-1"}, "C": {"page": "2-2"}}},
    "M2": {"ic": 0, "gates": {"A": {"page": "2-1"}}},  # ic z YAML jako liczba (0 → "0" → "00")
    "M3": {"ic": "X2", "gates": {"A": {"page": "2-2"}, "B": {"page": "2-1"}}},
    "M4": {"ic": "175", "gates": {"A": {"page": "2-1"}}},
}


def pred(ref="M1", typ="04", sym="1", left=(3,), right=(4,), top=()):
    return {"symbol": sym, "type": typ, "ref": ref,
            "pins": {"left": list(left), "right": list(right), "top": list(top)}}


def page_doc(**over):
    p = {"kronikarz": "1", "page": "2-1", "package": "P-T", "scan_size": [600, 400],
         "gates": [], "power": [], "ports": [], "cross_refs": [], "nets": {},
         "annotations": [], "decorations": []}
    p.update(over)
    return p


def box_gate(x, y, w=60, h=90, **over):
    g = {"ref": "", "gate": None, "x": x, "y": y, "w": w, "h": h, "rotation": 0, "pins": [],
         "verified": False, "note": None, "src": "auto"}
    g.update(over)
    return g


def auto_pin(num, side, px, py, **over):
    p = {"num": num, "side": side, "net": "", "px": px, "py": py, "src": "auto"}
    p.update(over)
    return p


# --------------------------------------------------------------------------- które bramki

def test_text_target_rules():
    page = page_doc()
    assert auto.text_target(page, box_gate(100, 100)) == "fill"
    # ludzka ramka bez tekstu też (pusty aspekt)
    assert auto.text_target(page, {k: v for k, v in box_gate(100, 100).items() if k != "src"}) == "fill"
    assert auto.text_target(page, box_gate(100, 100, ref="M5")) is None  # częściowo wpisany
    assert auto.text_target(page, box_gate(100, 100, label_left="9")) is None
    assert auto.text_target(page, {"ref": "", "pins": []}) is None  # bez ramki
    g = box_gate(100, 100, ref="M1", gate="B", text_src="auto", pins=[auto_pin(3, "left", 70, 100)])
    assert auto.text_target(page, g) == "replace"
    h = copy.deepcopy(g)
    del h["pins"][0]["src"]  # pin poprawiony przez człowieka
    assert auto.text_target(page, h) is None
    h = copy.deepcopy(g)
    h["text_src"] = "edited"
    assert auto.text_target(page, h) is None
    h = copy.deepcopy(g)
    h["pins"][0]["net"] = "N1"  # net ludzki (bez net_src)
    assert auto.text_target(page, h) is None
    h["pins"][0]["net_src"] = "auto"  # net z niezatwierdzonego ⑤ — zastępowalny
    assert auto.text_target(page_doc(steps={"nets": {"status": "auto"}}), h) == "replace"
    for st in ("approved", "stale"):
        assert auto.text_target(page_doc(steps={"nets": {"status": st}}), h) is None


# --------------------------------------------------------------------------- samokorekta

@pytest.mark.parametrize("raw,exp", [
    ("04", "04"), ("H11", None), (8, None), (0, "00"), ("UCY7404N", "04"), ("SN74LS00N", "00"),
    ("MH7400", "00"), ("4", "04"), ("74175", "175"), ("xyz", None), ("", None),
])
def test_resolve_ic_key_like_shared(raw, exp):
    assert auto.resolve_ic_key(raw, IC_MAP) == exp
    assert auto.resolve_ic_key("H11", {"11": {}}) == "11"
    assert auto.resolve_ic_key(8, {"08": {}}) == "08"


def test_check_text_consistent_gate_is_certain():
    c = auto.check_text(pred(), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "B" and c["ref"] == "M1" and c["ic"] == "04" and c["why"] == []
    # liczba z YAML w rejestrze (0 → 00), symbol &
    c = auto.check_text(pred("M2", "00", "&", (1, 2), (3,)), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "A" and c["why"] == []
    # blok 175: jedna bramka A, piny wielu ról
    c = auto.check_text(pred("M4", "175", "R", (4, 5, 9, 1), (2, 3, 7, 6)), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "A" and c["why"] == []


def test_check_text_letter_inference_registry_tie_break():
    # piny 1, 2 pasują do A i B typu X2; w rejestrze na 2-1 jest tylko M3 B
    c = auto.check_text(pred("M3", "X2", "", (1, 2), ()), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "B"
    assert [w.split(":")[0] for w in c["why"]] == ["PINS_MISSING"]  # wyjście 4 nieodczytane
    # wyjście rozstrzyga samo
    assert auto.check_text(pred("M3", "X2", "", (1, 2), (3,)), "2-2", COMPONENTS, IC_MAP)["gate"] == "A"
    # bez wpisu w rejestrze — niejednoznaczne, litera pusta
    c = auto.check_text(pred("M9", "X2", "", (1, 2), ()), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] is None
    assert {w.split(":")[0] for w in c["why"]} == {"REF_UNKNOWN", "LETTER_AMBIGUOUS"}


def codes(c):
    return sorted(w.split(":")[0] for w in c["why"])


def test_check_text_invalid_pins_and_mismatches_are_uncertain():
    # pin spoza typu: litera z najlepszego pokrycia (B), ale niepewna
    c = auto.check_text(pred(left=(3,), right=(99,)), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "B" and codes(c) == ["PINS_MISSING", "PINS_NOT_IN_IC_MAP"]
    assert "[99]" in c["why"][0]
    # piny z dwóch bramek, remis — bez litery
    c = auto.check_text(pred(left=(3,), right=(6,)), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] is None and codes(c) == ["PINS_NOT_IN_IC_MAP"]
    # typ z nadruku ≠ rejestr: odczyt zostaje, litera wg rejestru (04)
    c = auto.check_text(pred(typ="00", sym="&"), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "B" and codes(c) == ["SYMBOL_MISMATCH", "TYPE_MISMATCH"]
    assert c["type_read"] == "00"
    c = auto.check_text(pred(typ="74LS"), "2-1", COMPONENTS, IC_MAP)
    assert "TYPE_UNKNOWN" in codes(c) and c["gate"] == "B"
    # ref spoza rejestru: litera z odczytanego typu
    c = auto.check_text(pred(ref="M77"), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "B" and codes(c) == ["REF_UNKNOWN"]
    # bramka w rejestrze na innej stronie / brak litery w rejestrze
    c = auto.check_text(pred(left=(5,), right=(6,)), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "C" and codes(c) == ["LETTER_WRONG_PAGE"]
    c = auto.check_text(pred("M2", "00", "&", (4, 5), (6,)), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] == "B" and codes(c) == ["LETTER_NOT_IN_REGISTRY"]
    # strona pinów: wyjście z lewej
    c = auto.check_text(pred(left=(4,), right=(3,)), "2-1", COMPONENTS, IC_MAP)
    assert codes(c) == ["PIN_SIDE"]
    # brak pinów / ref / ic_map
    c = auto.check_text(pred(ref="", left=(), right=()), "2-1", COMPONENTS, IC_MAP)
    assert c["gate"] is None and codes(c) == ["NO_PINS", "REF_EMPTY"]
    c = auto.check_text(pred(), "2-1", COMPONENTS, None)
    assert c["gate"] is None and codes(c) == ["IC_MAP_MISSING"]
    c = auto.check_text(pred(left=(3, 3)), "2-1", COMPONENTS, IC_MAP)
    assert "PIN_DUPLICATE" in codes(c)


# --------------------------------------------------------------------------- piny

def test_place_pins_even_and_from_cv():
    rect = (0, 0, 60, 90)
    pins, n = auto.place_pins(rect, {"left": [1, 2], "right": [3], "top": [9]}, [])
    assert n == 0
    assert pins == [auto_pin(1, "left", 0, 30), auto_pin(2, "left", 0, 60),
                    auto_pin(3, "right", 60, 45), auto_pin(9, "top", 30, 0)]
    cv = [{"side": "left", "px": 0, "py": 70}, {"side": "left", "px": 0, "py": 20},
          {"side": "right", "px": 60, "py": 10}, {"side": "right", "px": 60, "py": 80}]
    pins, n = auto.place_pins(rect, {"left": [1, 2], "right": [3], "top": []}, cv)
    assert n == 2  # lewy: dokładnie 2 kandydatów → ich miejsca, z góry na dół
    assert [(p["num"], p["px"], p["py"]) for p in pins] == [(1, 0, 20), (2, 0, 70), (3, 60, 45)]
    # zaokrąglenie jak Math.round (połówki w górę)
    pins, _ = auto.place_pins((0.5, 0, 60.5, 3), {"left": [1, 2]}, [])
    assert [(p["px"], p["py"]) for p in pins] == [(1, 1), (1, 2)]


def test_match_cv_pins_by_overlap():
    entries = [{"x": 100, "y": 100, "w": 60, "h": 90, "cv_pins": [{"side": "left", "px": 70, "py": 90}]},
               {"x": 300, "y": 100, "w": 60, "h": 90, "cv_pins": [{"side": "right", "px": 330, "py": 99}]}]
    assert auto.match_cv_pins(box_gate(104, 101), entries) == entries[0]["cv_pins"]
    assert auto.match_cv_pins(box_gate(300, 100), entries) == entries[1]["cv_pins"]
    assert auto.match_cv_pins(box_gate(200, 300), entries) == []


# --------------------------------------------------------------------------- scalanie

def test_merge_text_fill_keep_replace_error_empty():
    gates = [
        box_gate(100, 100),                                                   # 0 pusta → fill
        box_gate(200, 100, ref="M9", gate="A"),                               # 1 ludzka → zostaje
        box_gate(300, 100, ref="M1", gate="C", text_src="auto", label_left="5",
                 pins=[auto_pin(5, "left", 270, 100)]),                       # 2 auto → replace
        box_gate(400, 100),                                                   # 3 błąd modelu
        box_gate(500, 100),                                                   # 4 pusta odpowiedź
    ]
    page = page_doc(gates=gates)
    before = copy.deepcopy(page)
    reads = {0: {"mode": "fill", "pred": pred(), "error": None, "cv_pins": []},
             2: {"mode": "replace", "pred": pred(left=(1,), right=(2,)), "error": None, "cv_pins": []},
             3: {"mode": "fill", "pred": None, "error": "VlmTimeout: brak odpowiedzi", "cv_pins": []},
             4: {"mode": "fill", "pred": pred(ref="", left=(), right=()), "error": None, "cv_pins": []}}
    new, c, unc, res = auto.merge_text(page, "2-1", reads, COMPONENTS, IC_MAP)
    assert page == before  # wejście nietknięte
    assert c == {"gates": 5, "targets": 4, "filled": 1, "replaced": 1, "kept_human": 1,
                 "uncertain": 2, "errors": 1, "empty_reads": 1, "pins_from_cv": 0, "pins_even": 4}
    g0 = new[0]
    assert (g0["ref"], g0["gate"], g0["text_src"]) == ("M1", "B", "auto")
    assert g0["pins"] == [auto_pin(3, "left", 70, 100), auto_pin(4, "right", 130, 100)]
    for k in ("x", "y", "w", "h", "rotation", "src", "verified", "note"):  # ramka nietknięta
        assert g0[k] == gates[0][k], k
    assert new[1] == gates[1]
    assert (new[2]["gate"], [p["num"] for p in new[2]["pins"]]) == ("A", [1, 2])
    assert "label_left" not in new[2]  # zastąpiony cały aspekt auto
    assert new[3] == gates[3] and new[4] == gates[4]  # bez text_src: aspekt dalej pusty
    assert S.aspect_empty("gate", new[4], "text_src")
    assert [(u["x"], u["why"][0].split(":")[0]) for u in unc] == [(400, "MODEL_ERROR"), (500, "MODEL_EMPTY")]
    assert res[0]["written"] and res[0]["why"] == []


def test_merge_text_duplicate_ref_letter_on_page():
    page = page_doc(gates=[box_gate(100, 100, ref="M1", gate="B", text_src="edited",
                                    pins=[{"num": 3, "side": "left", "net": "", "px": 70, "py": 100}]),
                           box_gate(300, 100)])
    reads = {1: {"mode": "fill", "pred": pred(), "error": None, "cv_pins": []}}
    _new, c, unc, _ = auto.merge_text(page, "2-1", reads, COMPONENTS, IC_MAP)
    assert c["uncertain"] == 1 and unc[0]["why"][0].startswith("DUPLICATE: M1B")
    assert (unc[0]["ref"], unc[0]["gate"], unc[0]["x"], unc[0]["y"]) == ("M1", "B", 300, 100)


def test_text_fingerprint_counts_text_and_pins_not_src():
    p = page_doc(gates=[box_gate(100, 100, ref="M1", gate="B", pins=[auto_pin(3, "left", 70, 100)])])
    a = S.step_fingerprint(p, "text")
    q = copy.deepcopy(p)
    q["gates"][0]["text_src"] = "auto"
    q["gates"][0]["pins"][0].pop("src")
    q["gates"][0]["verified"] = True
    assert S.step_fingerprint(q, "text") == a
    q["gates"][0]["x"] += 5  # pin względem środka bramki się przesunął
    assert S.step_fingerprint(q, "text") != a
    q = copy.deepcopy(p)
    q["gates"][0]["pins"][0]["num"] = 4
    assert S.step_fingerprint(q, "text") != a
    assert S.step_fingerprint(page_doc(gates=[{"x": 1, "ref": None}]), "text") == \
        S.step_fingerprint(page_doc(gates=[{"x": 1}]), "text")


def test_deadline_interrupts_long_call():
    t0 = time.perf_counter()
    with pytest.raises(_vlm.VlmTimeout):
        with _vlm.deadline(0.05):
            while True:
                time.sleep(0.001)
    assert time.perf_counter() - t0 < 1
    with _vlm.deadline(None):
        pass


# --------------------------------------------------------------------------- CLI

PKG_YAML = """kronikarz: "1"
package:
  id: P-T
  pages:
    - {id: "2-1", file: pages/2-1.sch.yaml, scan: scans/2-1.jpg, sheet: 1}
    - {id: "2-2", file: pages/2-2.sch.yaml, scan: scans/2-2.jpg, sheet: 2}
components:
  M1:
    ic: "04"
    gates: {A: {page: "2-1"}, B: {page: "2-1"}, C: {page: "2-2"}}
  M2:
    ic: "00"
    gates: {A: {page: "2-1"}, B: {page: "2-2"}}
"""


class FakeVlm:
    name = "mlx:fake"

    def __init__(self, answers):
        self.answers = list(answers)
        self.calls = []
        self.loads = 0

    def load(self):
        self.loads += 1

    def params(self):
        return {"max_tokens": 300, "temperature": 0.0, "thinking": False}

    def ask(self, png, kind, prompt, timeout_s=None):
        self.calls.append({"png": png, "kind": kind, "prompt": prompt, "timeout_s": timeout_s})
        a = self.answers.pop(0) if self.answers else {}
        if isinstance(a, Exception):
            raise a
        text = a if isinstance(a, str) else "```json\n" + json.dumps(a) + "\n```"
        return {"text": text, "latency": 0.25, "in_tok": 100, "out_tok": 30, "peak_gb": None, "error": None}


def answer(ref="M1", typ="04", left=(3,), right=(4,), sym="1"):
    return {"symbol": sym, "type": typ, "ref": ref, "pins_left": list(left),
            "pins_right": list(right), "pins_top": []}


@pytest.fixture
def data(tmp_path):
    root = tmp_path / "data"
    pkg = root / "MOD" / "P-T"
    (pkg / "pages").mkdir(parents=True)
    (pkg / "scans").mkdir()
    (root / "MOD" / "project.yaml").write_text('kronikarz: "1"\n')
    (root / "MOD" / "ic_map.yaml").write_text(auto.dump_yaml(IC_MAP))
    (pkg / "package.yaml").write_text(PKG_YAML)
    for pid in ("2-1", "2-2"):
        page = page_doc(page=pid, gates=[box_gate(100, 100), box_gate(300, 100)],
                        steps={"gates": {"status": "approved", "run": "R0"}},
                        nets={"N1": {"pins": [], "segments": [[10, 300, 90, 300]], "junctions": None}})
        (pkg / "pages" / f"{pid}.sch.yaml").write_text(auto.dump_yaml(page))
        img = np.full((400, 600), 255, np.uint8)
        img[60:140, 70:73] = 0  # coś do wycięcia
        cv2.imwrite(str(pkg / "scans" / f"{pid}.jpg"), img)
    return root


@pytest.fixture
def vlm(monkeypatch):
    holder = {"fake": FakeVlm([]), "made": 0}

    def make(spec, tmp_dir):
        holder["made"] += 1
        holder["spec"] = spec
        return holder["fake"]

    monkeypatch.setattr(auto, "make_vlm", make)
    det_calls = []

    def detect(gray):
        det_calls.append(gray.shape)
        return {"entries": [], "params": {}, "shape": gray.shape, "tool": "cv-gates.py"}

    monkeypatch.setattr(auto, "detect_gates", detect)
    holder["detect"] = det_calls
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


def test_cli_text_writes_text_pins_snapshot_and_uncertain(data, vlm, capsys):
    vlm["fake"].answers = [answer(), answer(ref="M2", typ="00", left=(1, 2), right=(3,), sym="R")]
    before = read_page(data)
    assert run(data, "--page", "2-1", "--step", "text", "--json") == 0
    out = capsys.readouterr()
    res = json.loads(out.out)
    assert res["exit"] == 0 and res["vlm"]["prompt"] == "v3" and res["vlm"]["scale"] == 2
    assert res["time_s"] >= 0
    r = res["pages"][0]
    assert r["counts"] == {"gates": 2, "targets": 2, "filled": 2, "replaced": 0, "kept_human": 0,
                           "uncertain": 1, "errors": 0, "empty_reads": 0, "pins_from_cv": 0,
                           "pins_even": 5, "model_s": 0.5, "cv_pins": "cv-gates"}
    assert "text [1/2]" in out.err and "text [2/2]" in out.err  # postęp na stderr
    p = read_page(data)
    g0, g1 = p["gates"]
    assert (g0["ref"], g0["gate"], g0["text_src"], g0["src"]) == ("M1", "B", "auto", "auto")
    assert all(pin["src"] == "auto" and pin["net"] == "" for pin in g0["pins"] + g1["pins"])
    assert (g1["ref"], g1["gate"]) == ("M2", "A")
    for k in ("x", "y", "w", "h"):
        assert g0[k] == before["gates"][0][k]
    assert p["nets"] == before["nets"]  # druty i nety nietknięte
    st = p["steps"]["text"]
    assert st["status"] == "auto" and st["run"] == r["run"]
    assert st["uncertain"] == [{"ref": "M2", "gate": "A", "x": 300, "y": 100,
                                "why": ["SYMBOL_MISMATCH: symbol „R”, typ 00 ma „&”"]}]
    assert p["steps"]["gates"] == before["steps"]["gates"]
    # snapshot: surowe odpowiedzi + kadry, bez obrazów
    snaps = sorted((data / ".auto").rglob("*"))
    files = [s for s in snaps if s.is_file()]
    assert [f.name for f in files] == [f"text-{r['run']}.yaml"]
    sd = auto.load_yaml(files[0].read_text())
    assert sd["auto_run"]["step"] == "text" and sd["auto_run"]["params"]["prompt"] == "v3"
    assert sd["auto_run"]["params"]["temperature"] == 0 and sd["auto_run"]["params"]["thinking"] is False
    sg = sd["gates"][0]
    assert sg["ref"] == "M1" and sg["written"] is True and sg["uncertain"] == []
    assert sg["vlm"]["raw"].startswith("```json") and sg["vlm"]["obj"]["ref"] == "M1"
    assert sg["vlm"]["crop"] == [34, 45, 166, 149] and sg["vlm"]["scale"] == 2  # 60×90 + 36/10/4
    # wycinek ×2 i prompt v3 jak w bake-offie
    call = vlm["fake"].calls[0]
    assert call["prompt"] == _vlm.PROMPTS["v3"]["gate"] and call["timeout_s"] == auto.GATE_TIMEOUT_S
    from PIL import Image
    import io
    assert Image.open(io.BytesIO(call["png"])).size == (2 * 132, 2 * 104)


def test_cli_text_requires_approved_gates_and_dry_run_writes_nothing(data, vlm):
    p = read_page(data)
    p["steps"]["gates"]["status"] = "auto"
    write_page(data, p)
    t0 = tree(data)
    assert run(data, "--page", "2-1", "--step", "text") == 2
    assert tree(data) == t0 and vlm["made"] == 0  # odmowa przed ładowaniem modelu
    b0 = page_path(data).read_bytes()
    vlm["fake"].answers = [answer(), answer()]
    assert run(data, "--page", "2-1", "--step", "text", "--draft", "--dry-run") == 0
    assert tree(data) == t0 and page_path(data).read_bytes() == b0
    assert not (data / ".auto").exists()
    assert len(vlm["fake"].calls) == 2


def test_cli_text_model_loaded_once_for_all_pages(data, vlm, capsys):
    vlm["fake"].answers = [answer(), answer(left=(1,), right=(2,)),
                           answer(left=(5,), right=(6,)), answer(ref="M2", typ="00", left=(4, 5), right=(6,), sym="&")]
    assert run(data, "--page", "all", "--step", "text", "--json") == 0
    res = json.loads(capsys.readouterr().out)
    assert vlm["made"] == 1 and vlm["fake"].loads == 1 and len(vlm["fake"].calls) == 4
    assert [r["counts"]["uncertain"] for r in res["pages"]] == [0, 0]
    assert [g["gate"] for g in read_page(data, "2-2")["gates"]] == ["C", "B"]


def test_cli_text_rerun_keeps_human_replaces_auto_and_force_marks_stale(data, vlm):
    vlm["fake"].answers = [answer(), answer(left=(1,), right=(2,))]
    assert run(data, "--page", "2-1", "--step", "text") == 0
    p = read_page(data)
    # człowiek poprawia drugą bramkę (tekst edited), zatwierdza ② i ③
    p["gates"][1]["ref"] = "M2"
    p["gates"][1]["gate"] = "A"
    del p["gates"][1]["text_src"]
    p["steps"]["text"]["status"] = "approved"
    p["steps"]["wires"] = {"status": "approved"}
    write_page(data, p)
    b0 = page_path(data).read_bytes()
    assert run(data, "--page", "2-1", "--step", "text") == 2  # zatwierdzony bez --force
    assert page_path(data).read_bytes() == b0
    vlm["fake"].answers = [answer(left=(5,), right=(6,))]
    assert run(data, "--page", "2-1", "--step", "text", "--force") == 0
    q = read_page(data)
    assert len(vlm["fake"].calls) == 3  # tylko bramka auto przeczytana jeszcze raz
    assert (q["gates"][0]["gate"], q["gates"][1]["ref"], q["gates"][1]["gate"]) == ("C", "M2", "A")
    assert q["gates"][1] == p["gates"][1]
    assert q["steps"]["text"]["status"] == "auto" and q["steps"]["wires"]["status"] == "stale"
    assert q["steps"]["text"]["uncertain"][0]["why"][0].startswith("LETTER_WRONG_PAGE")


def test_cli_text_uses_cv_pins_from_gates_snapshot(data, vlm):
    snap = data / ".auto" / "P-T" / "2-1" / "gates-R0.yaml"
    snap.parent.mkdir(parents=True)
    snap.write_text(auto.dump_yaml(page_doc(gates=[
        {"x": 100, "y": 100, "w": 60, "h": 90, "cv_pins": [
            {"side": "left", "px": 70, "py": 50}, {"side": "right", "px": 130, "py": 146}]}])))
    vlm["fake"].answers = [answer(), {}]
    assert run(data, "--page", "2-1", "--step", "text") == 0
    p = read_page(data)
    assert [(q["px"], q["py"]) for q in p["gates"][0]["pins"]] == [(70, 50), (130, 146)]
    assert vlm["detect"] == []  # snapshot zamiast świeżej detekcji
    # piny z cv_pins poszerzają kadr w pionie (py − 22 … py + 4)
    assert auto.load_yaml(sorted(snap.parent.glob("text-*.yaml"))[0].read_text())["gates"][0]["vlm"]["crop"] == \
        [34, 28, 166, 150]


def test_cli_text_model_errors(data, vlm, monkeypatch, capsys):
    vlm["fake"].answers = [_vlm.VlmTimeout("brak odpowiedzi modelu w 1 s"), "nie wiem"]
    assert run(data, "--page", "2-1", "--step", "text", "--json", "--gate-timeout", "1") == 0
    res = json.loads(capsys.readouterr().out)
    c = res["pages"][0]["counts"]
    assert (c["errors"], c["filled"], c["uncertain"]) == (2, 0, 2)
    p = read_page(data)
    assert all(S.aspect_empty("gate", g, "text_src") and "text_src" not in g for g in p["gates"])
    assert [u["why"][0].split(":")[0] for u in p["steps"]["text"]["uncertain"]] == ["MODEL_ERROR"] * 2
    assert vlm["fake"].calls[0]["timeout_s"] == 1.0

    # model nie daje się załadować → błąd strony, nic nie zapisane
    def boom():
        raise ImportError("No module named 'mlx_vlm'")

    vlm["fake"].load = boom
    p = read_page(data)
    p["steps"]["text"]["status"] = "todo"
    write_page(data, p)
    t0, b0 = tree(data), page_path(data).read_bytes()
    assert run(data, "--page", "2-1", "--step", "text") == 1
    assert tree(data) == t0 and page_path(data).read_bytes() == b0
    err = capsys.readouterr().err
    assert "brak mlx-vlm" in err and "uv run --with mlx-vlm==0.8.1" in err


def test_cli_text_failed_load_not_retried_per_page(data, vlm, capsys):
    loads = []

    def boom():
        loads.append(1)
        raise RuntimeError("za mało pamięci")

    vlm["fake"].load = boom
    t0 = tree(data)
    assert run(data, "--page", "all", "--step", "text", "--json") == 1
    res = json.loads(capsys.readouterr().out)
    assert [r["exit"] for r in res["pages"]] == [1, 1]
    assert all("za mało pamięci" in r["reason"] for r in res["pages"])
    assert loads == [1] and vlm["made"] == 1  # jedna próba na przebieg
    assert tree(data) == t0


def test_cli_text_paid_model_hook(data, vlm, capsys):
    t0 = tree(data)
    assert run(data, "--page", "2-1", "--step", "text", "--model", "anthropic:claude-opus-5-5") == 2
    assert "nie jest lokalny" in capsys.readouterr().err
    assert run(data, "--page", "2-1", "--step", "text", "--model", "openai:x", "--allow-paid") == 3
    assert tree(data) == t0 and vlm["made"] == 0


def test_cli_text_model_dir_must_be_under_llm_root(data, monkeypatch, capsys):
    monkeypatch.setattr(auto, "detect_gates", lambda gray: {"entries": [], "params": {},
                                                            "shape": gray.shape, "tool": "x"})
    t0 = tree(data)
    for spec in (f"mlx:{data / 'brak'}", f"mlx:{_vlm.LLM_ROOT}/../elsewhere", "mlx:~/.cache/huggingface/x"):
        assert run(data, "--page", "2-1", "--step", "text", "--model", spec) == 2, spec
        assert "spoza /Volumes/Dane/llm" in capsys.readouterr().err
    monkeypatch.setenv("KRONIKARZ_VLM", f"mlx:{data / 'brak'}")
    assert run(data, "--page", "2-1", "--step", "text") == 2
    assert tree(data) == t0
    monkeypatch.delenv("KRONIKARZ_VLM")
    # pod LLM_ROOT, ale bez katalogu → błąd (1)
    assert run(data, "--page", "2-1", "--step", "text", "--model",
               f"mlx:{_vlm.LLM_ROOT}/models/__nie_ma_takiego__") == 1
    assert "brak katalogu modelu" in capsys.readouterr().err


def test_cli_text_page_without_targets_does_not_load_model(data, vlm):
    p = read_page(data)
    for g in p["gates"]:
        g["ref"] = "M1"  # ludzki tekst
    write_page(data, p)
    assert run(data, "--page", "2-1", "--step", "text") == 0
    assert vlm["made"] == 0
    q = read_page(data)
    assert q["gates"] == p["gates"] and q["steps"]["text"]["status"] == "auto"
    assert "uncertain" not in q["steps"]["text"]
