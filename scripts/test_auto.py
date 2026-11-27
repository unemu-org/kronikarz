"""Testy scripts/auto.py: reguły scalania kroków ① gates i ③ wires, stan kroków, snapshot,
dry-run, kody wyjścia. Własne fixture'y (bez treści z data/); skany syntetyczne.

Uruchomienie (nie zostawia __pycache__ ani .pytest_cache):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy \\
      --with opencv-python-headless pytest -p no:cacheprovider scripts/test_auto.py
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
_spec = importlib.util.spec_from_file_location("auto", _HERE / "auto.py")
auto = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(auto)
import _steps as S  # noqa: E402


# --------------------------------------------------------------------------- fixture'y

def page_doc(**over):
    p = {"kronikarz": "1", "page": "2-1", "package": "P-T", "scan_size": [600, 400],
         "gates": [], "power": [], "ports": [], "cross_refs": [], "nets": {},
         "annotations": [{"text": "yes", "x": 5, "y": 5}],
         "decorations": [{"kind": "line", "x1": 0, "y1": 0, "x2": 9, "y2": 0}]}
    p.update(over)
    return p


def box_gate(x, y, w=60, h=90, **over):
    g = {"ref": "", "gate": None, "x": x, "y": y, "w": w, "h": h, "rotation": 0, "pins": [],
         "verified": False, "note": None}
    g.update(over)
    return g


def det(x, y, w=60, h=90):
    return {"ref": "?", "gate": None, "x": x, "y": y, "w": w, "h": h, "rotation": 0, "pins": [],
            "verified": False, "cv_class": "gate", "cv_pins": []}


def cvnet(pieces, junctions=(), free=()):
    return {"pieces": [tuple(p) for p in pieces], "junctions": list(junctions),
            "free": list(free), "length": 0.0}


# --------------------------------------------------------------------------- ① gates

def test_gates_auto_removed_human_kept_overlap_dropped():
    page = page_doc(gates=[
        box_gate(100, 100, src="auto"),                       # auto, pusta → zastąpiona
        box_gate(300, 100, ref="M5", gate="A"),               # ludzka → zostaje
        box_gate(500, 100, src="auto", ref="M7"),             # auto ramka, ludzki tekst → zostaje
    ])
    entries = [det(102, 101), det(301, 99), det(200, 300)]
    gates, c = auto.merge_gates(page, entries)
    assert c == {"detected": 3, "removed_auto": 1, "added_auto": 2, "kept": 2, "kept_human": 1,
                 "kept_auto": 1, "dropped_overlap": 1}
    assert [g.get("ref") for g in gates] == ["M5", "M7", "", ""]
    assert [(g["x"], g["y"]) for g in gates[2:]] == [(102, 101), (200, 300)]
    new = gates[2]
    assert new == {"ref": "", "gate": None, "x": 102, "y": 101, "w": 60, "h": 90, "rotation": 0,
                   "pins": [], "verified": False, "note": None, "src": "auto"}
    assert "text_src" not in new and "cv_class" not in new and "cv_pins" not in new
    assert S.aspect_empty("gate", new, "text_src")  # krok ② może wypełnić tekst
    assert page["gates"][0]["src"] == "auto" and len(page["gates"]) == 3  # wejście nietknięte


def test_gates_overlap_threshold_iou_half():
    page = page_doc(gates=[box_gate(100, 100, w=100, h=100)])
    gates, c = auto.merge_gates(page, [det(130, 100, 100, 100)])  # IoU 7000/13000 = 0,54
    assert c["dropped_overlap"] == 1 and len(gates) == 1
    gates, c = auto.merge_gates(page, [det(140, 100, 100, 100)])  # IoU 0,43, ale środek w niej
    assert c["dropped_overlap"] == 1
    gates, c = auto.merge_gates(page, [det(160, 100, 100, 100)])  # IoU 0,25, środki na zewnątrz
    assert c["added_auto"] == 1


def test_gates_duplicate_when_centre_inside_human_gate_without_wh():
    # ludzka bramka bez w/h (autoBox 80 × 90), a na skanie ramka 60 × 300 (stos / 74170):
    # IoU 0,18, ale środek wykrytej leży w ludzkiej → ta sama bramka, odrzucona
    page = page_doc(gates=[{"ref": "M7", "gate": "A", "x": 100, "y": 100, "rotation": 0,
                            "pins": [], "verified": False, "note": None}])
    r = (70, -50, 130, 250)
    assert auto.iou(r, auto.gate_rect(page["gates"][0])) < 0.5
    gates, c = auto.merge_gates(page, [det(100, 100, 60, 300)])
    assert c["dropped_overlap"] == 1 and len(gates) == 1
    # środek ludzkiej w wykrytej (wykryta duża, przesunięta)
    gates, c = auto.merge_gates(page, [det(100, 180, 300, 300)])
    assert c["dropped_overlap"] == 1
    # sąsiednia bramka obok — dodana
    gates, c = auto.merge_gates(page, [det(220, 100, 60, 90)])
    assert c["added_auto"] == 1


def test_gate_rect_per_dimension_like_viewer():
    g = {"x": 100, "y": 100, "rotation": 0, "pins": [], "w": 40}
    assert auto.gate_rect(g) == (80, 55, 120, 145)  # h z autoBox, w własne
    assert auto.gate_rect({**g, "w": 0}) == (100, 55, 100, 145)  # 0 zostaje 0 (`??`)
    assert auto.gate_rect({**g, "w": None, "h": 30}) == (60, 85, 140, 115)
    assert auto.gate_rect({**g, "rotation": 90, "h": 30}) == (85, 80, 115, 120)
    pins = [{"side": "left"}] * 5
    assert auto.gate_rect({"x": 0, "y": 0, "pins": pins}) == (-40, -65, 40, 65)


def test_gates_overlap_uses_viewer_autobox_without_wh():
    page = page_doc(gates=[{"ref": "M1", "gate": "A", "x": 100, "y": 100, "rotation": 0,
                            "pins": [], "verified": True, "note": None}])  # 80 × 90
    gates, c = auto.merge_gates(page, [det(100, 100, 80, 90)])
    assert c["dropped_overlap"] == 1 and len(gates) == 1


def test_gates_text_bearing_auto_gate_rules():
    pins_auto = [{"num": 1, "side": "left", "net": "", "px": 70, "py": 100, "src": "auto"}]
    g_auto_text = box_gate(100, 100, src="auto", text_src="auto", ref="M1", gate="A",
                           pins=copy.deepcopy(pins_auto))
    # tekst i piny auto z niezatwierdzonego kroku ② → bramka zastąpiona
    page = page_doc(gates=[copy.deepcopy(g_auto_text)], steps={"text": {"status": "auto"}})
    assert auto.gate_removable(page, page["gates"][0])
    # krok ② zatwierdzony (albo stale) → tekst sprawdzony przez człowieka, bramka zostaje
    for st in ("approved", "stale"):
        page = page_doc(gates=[copy.deepcopy(g_auto_text)], steps={"text": {"status": st}})
        assert not auto.gate_removable(page, page["gates"][0]), st
    # pin ludzki (bez src) → zostaje
    g = copy.deepcopy(g_auto_text)
    del g["pins"][0]["src"]
    assert not auto.gate_removable(page_doc(), g)
    # net pinu ludzki → zostaje; net auto z niezatwierdzonego ⑤ → zastąpiona
    g = copy.deepcopy(g_auto_text)
    g["pins"][0]["net"] = "N1"
    assert not auto.gate_removable(page_doc(), g)
    g["pins"][0]["net_src"] = "auto"
    assert auto.gate_removable(page_doc(), g)
    # tekst ludzki (brak text_src) → zostaje, nawet bez pinów
    assert not auto.gate_removable(page_doc(), box_gate(1, 1, src="auto", ref="M5"))
    # notatka człowieka → zostaje
    assert not auto.gate_removable(page_doc(), box_gate(1, 1, src="auto", note="sprawdź"))
    # verified nie jest treścią → auto pusta bramka zastąpiona i tak
    assert auto.gate_removable(page_doc(), box_gate(1, 1, src="auto", verified=True))
    # ramka ludzka → nigdy
    assert not auto.gate_removable(page_doc(), box_gate(1, 1))
    assert not auto.gate_removable(page_doc(), box_gate(1, 1, src="edited"))


def test_gates_rerun_idempotent():
    page = page_doc()
    entries = [det(100, 100), det(300, 100)]
    page["gates"], _ = auto.merge_gates(page, entries)
    before = S.step_fingerprint(page, "gates")
    page["gates"], c = auto.merge_gates(page, entries)
    assert c["removed_auto"] == 2 and c["added_auto"] == 2 and c["dropped_overlap"] == 0
    assert S.step_fingerprint(page, "gates") == before


# --------------------------------------------------------------------------- ③ wires

def wired_page():
    return page_doc(
        gates=[box_gate(100, 100, ref="M1", gate="A",
                        pins=[{"num": 1, "side": "left", "net": "N1", "px": 70, "py": 100}])],
        nets={
            "N1": {"pins": [], "segments": [[10, 100, 70, 100], [70, 300, 10, 300]],
                   "junctions": [[10, 100]],
                   "auto_segments": [[10, 300, 70, 300]], "auto_junctions": [[10, 100]]},
            "NET_AUTO_1": {"pins": [], "segments": [[200, 200, 260, 200]], "junctions": None,
                           "auto_segments": [[200, 200, 260, 200]]},
            "H": {"pins": [], "segments": [[400, 50, 400, 150]], "junctions": None},
        })


def test_wires_auto_removed_by_value_human_kept():
    page = wired_page()
    nets, c = auto.merge_wires(page, [])
    assert nets["N1"]["segments"] == [[10, 100, 70, 100]]   # odwrócony auto odcinek usunięty
    assert nets["N1"]["junctions"] is None                  # jedyna kropka była auto
    assert "auto_segments" not in nets["N1"] and "auto_junctions" not in nets["N1"]
    assert "NET_AUTO_1" not in nets                         # opustoszały net auto znika
    assert nets["H"] == page["nets"]["H"]                   # ludzki nietknięty
    assert c["removed_auto_segments"] == 2 and c["removed_auto_junctions"] == 1
    assert c["removed_nets"] == 1 and c["kept_segments"] == 2
    assert "auto_segments" in page["nets"]["N1"]            # wejście nietknięte


def test_wires_emptied_net_kept_when_used_or_human():
    page = page_doc(
        ports=[{"connector": "A", "pin": 1, "label": "X", "net": "P", "x": 0, "y": 0, "side": "left"}],
        nets={"P": {"pins": [], "segments": [[0, 0, 9, 0]], "junctions": None,
                    "auto_segments": [[0, 0, 9, 0]]},
              "E": {"pins": [], "segments": [], "junctions": None}})
    nets, c = auto.merge_wires(page, [])
    assert nets["P"]["segments"] == [] and "E" in nets and c["removed_nets"] == 0


def test_wires_new_nets_named_and_listed_as_auto():
    page = wired_page()
    cv = [cvnet([(500, 300, 560, 300), (560, 300, 560, 360), (560, 300, 590, 300)],
                junctions=[(560, 300)], free=[(500, 300)]),
          cvnet([(300, 350, 380, 350)])]
    page["nets"]["NET_AUTO_2"] = {"pins": [], "segments": [[1, 1, 1, 50]], "junctions": None}
    nets, c = auto.merge_wires(page, cv)
    new = {k: v for k, v in nets.items() if "auto_segments" in v}
    # NET_AUTO_1 (stary auto) opustoszał i zniknął → numer wolny; ludzki NET_AUTO_2 zostaje
    assert list(new) == ["NET_AUTO_1", "NET_AUTO_3"]
    n1 = new["NET_AUTO_1"]
    assert n1["segments"] == [[500, 300, 560, 300], [560, 300, 560, 360], [560, 300, 590, 300]]
    assert n1["auto_segments"] == n1["segments"] and n1["auto_segments"] is not n1["segments"]
    assert n1["junctions"] == [[560, 300]] and n1["auto_junctions"] == [[560, 300]]
    assert new["NET_AUTO_3"]["junctions"] is None and "auto_junctions" not in new["NET_AUTO_3"]
    assert all(S.auto_segment_mask(n) == [True] * len(n["segments"]) for n in new.values())
    assert nets["NET_AUTO_2"] == page["nets"]["NET_AUTO_2"]
    assert "" not in nets
    assert page["gates"][0]["pins"][0]["net"] == "N1"  # piny nietknięte
    assert c["added_nets"] == 2 and c["added_auto_segments"] == 4 and c["added_auto_junctions"] == 1


def test_wires_detected_on_human_wire_dropped_or_clipped():
    page = page_doc(nets={"H": {"pins": [], "segments": [[100, 100, 200, 100], [300, 50, 300, 150]],
                                "junctions": [[300, 100]]}})
    cv = [cvnet([(101, 101, 199, 101)]),                       # cały na ludzkim → odrzucony
          cvnet([(150, 102, 260, 102), (260, 102, 260, 180)],  # częściowo → przycięty
                junctions=[]),
          cvnet([(300, 100, 380, 100), (299, 60, 299, 140)], junctions=[(300, 100)])]
    nets, c = auto.merge_wires(page, cv)
    assert c["dropped_overlap"] == 2 and c["clipped_overlap"] == 1
    a = nets["NET_AUTO_1"]["segments"]
    assert a == [[200, 102, 260, 102], [260, 102, 260, 180]]
    b = nets["NET_AUTO_2"]
    assert b["segments"] == [[300, 100, 380, 100]]
    assert b["junctions"] is None  # kropka już jest u człowieka
    assert len(nets) == 3


def test_wires_blank_named_net_does_not_clip():
    page = page_doc(nets={"": {"pins": [], "segments": [[0, 0, 100, 0]], "junctions": None}})
    nets, c = auto.merge_wires(page, [cvnet([(0, 1, 100, 1)])])
    assert c["dropped_overlap"] == 0 and nets["NET_AUTO_1"]["segments"] == [[0, 1, 100, 1]]
    assert nets[""] == page["nets"][""]  # sam net "" nietknięty


def test_wires_step5_nets_reported():
    page = page_doc(
        gates=[box_gate(100, 100, ref="M1", gate="A",
                        pins=[{"num": 1, "side": "left", "net": "NET_AUTO_2", "px": 70, "py": 100}])],
        nets={"-BLR": {"pins": [], "segments": [[0, 0, 50, 0]], "junctions": None,
                       "auto_segments": [[0, 0, 50, 0]]},
              "NET_AUTO_2": {"pins": [], "segments": [[0, 100, 70, 100]], "junctions": None,
                             "auto_segments": [[0, 100, 70, 100]]},
              "NET_AUTO_3": {"pins": [], "segments": [[0, 200, 70, 200]], "junctions": None,
                             "auto_segments": [[0, 200, 70, 200]]}})
    nets, c = auto.merge_wires(page, [])
    assert c["step5_nets"] == {"-BLR": 1, "NET_AUTO_2": 1}  # nazwany / z końcówką; _3 nie
    assert auto.merge_wires(wired_page(), [])[1]["step5_nets"] == {"N1": 2}


def test_clip_segment_rules():
    keep = [[0, 0, 100, 0]]
    assert auto.clip_segment((0, 2, 100, 2), keep) == []
    assert auto.clip_segment((0, 5, 100, 5), keep) == [[0, 5, 100, 5]]  # dalej niż WIRE_TOL
    assert auto.clip_segment((50, 1, 150, 1), keep) == [[100, 1, 150, 1]]
    assert auto.clip_segment((150, 1, 50, 1), keep) == [[150, 1, 100, 1]]  # kierunek zachowany
    assert auto.clip_segment((-20, 0, 105, 0), keep) == [[-20, 0, 0, 0]]  # resztka 5 px odpada
    assert auto.clip_segment((0, 0, 0, 80), keep) == [[0, 0, 0, 80]]  # prostopadły nietknięty


def test_wires_rerun_idempotent_and_human_moves_kept():
    page = page_doc()
    cv = [cvnet([(10, 10, 90, 10), (90, 10, 90, 90)]), cvnet([(200, 10, 200, 99)])]
    page["nets"], _ = auto.merge_wires(page, cv)
    fp = S.step_fingerprint(page, "wires")
    page["nets"], c = auto.merge_wires(page, cv)
    assert c["removed_auto_segments"] == 3 and c["added_auto_segments"] == 3
    assert S.step_fingerprint(page, "wires") == fp and set(page["nets"]) == {"NET_AUTO_1", "NET_AUTO_2"}
    # człowiek przesunął odcinek (wartość ≠ auto) → przebieg go zostawia, wykryty obok odrzucony
    page["nets"]["NET_AUTO_1"]["segments"][0] = [10, 12, 90, 12]
    page["nets"], c = auto.merge_wires(page, cv)
    assert c["kept_segments"] == 1 and c["dropped_overlap"] == 1
    human = [n for n in page["nets"].values() if "auto_segments" not in n]
    assert human and human[0]["segments"] == [[10, 12, 90, 12]]


# --------------------------------------------------------------------------- stan kroków

def test_set_step_inserts_after_scan_size_and_marks_stale():
    page = page_doc()
    assert auto.set_step(page, "gates", "R", "T", forced_approved=False, changed=True) == []
    assert list(page)[:5] == ["kronikarz", "page", "package", "scan_size", "steps"]
    assert page["steps"] == {"gates": {"status": "auto", "run": "R", "at": "T"}}
    page["steps"].update(gates={"status": "approved"}, text={"status": "approved"},
                         wires={"status": "approved"}, labels={"status": "auto"})
    assert auto.set_step(page, "gates", "R2", "T2", forced_approved=True, changed=False) == ["text", "wires"]
    assert page["steps"]["gates"] == {"status": "auto", "run": "R2", "at": "T2"}
    assert page["steps"]["text"]["status"] == "stale" and page["steps"]["labels"]["status"] == "auto"
    page["steps"]["wires"] = {"status": "approved"}
    assert auto.set_step(page, "text", "R3", "T3", forced_approved=False, changed=False) == []
    assert auto.set_step(page, "text", "R4", "T4", forced_approved=False, changed=True) == ["wires"]


# --------------------------------------------------------------------------- CLI

PKG_YAML = """kronikarz: "1"
package:
  id: P-T
  pages:
    - {id: "2-1", file: pages/2-1.sch.yaml, scan: scans/2-1.jpg, sheet: 1}
    - {id: "2-2", file: pages/2-2.sch.yaml, scan: scans/2-2.jpg, sheet: 2}
"""


@pytest.fixture
def data(tmp_path):
    root = tmp_path / "data"
    pkg = root / "MOD" / "P-T"
    (pkg / "pages").mkdir(parents=True)
    (pkg / "scans").mkdir()
    (root / "MOD" / "project.yaml").write_text('kronikarz: "1"\n')
    (pkg / "package.yaml").write_text(PKG_YAML)
    # zamrożona kopia jak data/gold — nie jest modułem (brak project.yaml), pomijana
    (root / "gold" / "P-T").mkdir(parents=True)
    (root / "gold" / "P-T" / "package.yaml").write_text(PKG_YAML)
    for pid in ("2-1", "2-2"):
        (pkg / "pages" / f"{pid}.sch.yaml").write_text(auto.dump_yaml(page_doc(page=pid)))
        cv2.imwrite(str(pkg / "scans" / f"{pid}.jpg"), np.full((400, 600), 255, np.uint8))
    return root


@pytest.fixture
def fake_cv(monkeypatch):
    calls = []

    def gates(gray):
        calls.append(("gates", gray.shape))
        return {"entries": [det(100, 100), det(300, 100)], "params": {"P": (1, 2)},
                "shape": gray.shape, "tool": "cv-gates.py"}

    def wires(gray, gs):
        calls.append(("wires", len(gs)))
        nets = [cvnet([(10, 300, 90, 300)], free=[(10, 300), (90, 300)])]
        doc = {"nets": {"CVNET_1": {"pins": [], "segments": [[10, 300, 90, 300]], "junctions": None}},
               "gates": [{k: g[k] for k in ("ref", "x", "y")} for g in gs]}
        return {"nets": nets, "params": {}, "shape": gray.shape, "gates": doc["gates"], "doc": doc,
                "tool": "cv-wires.py"}

    monkeypatch.setattr(auto, "detect_gates", gates)
    monkeypatch.setattr(auto, "detect_wires", wires)
    return calls


def page_path(root, pid="2-1"):
    return root / "MOD" / "P-T" / "pages" / f"{pid}.sch.yaml"


def read_page(root, pid="2-1"):
    return auto.load_yaml(page_path(root, pid).read_text())


def run(root, *args):
    return auto.main(["--data", str(root), "--pkg", "P-T", *args])


def tree(root):
    return sorted(str(p.relative_to(root)) for p in root.rglob("*"))


def test_cli_gates_then_wires_writes_page_snapshot_backup(data, fake_cv, capsys):
    before = page_path(data).read_text()
    assert run(data, "--page", "2-1", "--step", "gates") == 0
    p = read_page(data)
    assert [g["src"] for g in p["gates"]] == ["auto", "auto"]
    assert p["steps"]["gates"]["status"] == "auto"
    run_id = p["steps"]["gates"]["run"]
    assert len(run_id) == len("20261127T153000") and run_id[8] == "T"
    snap = data / ".auto" / "P-T" / "2-1" / f"gates-{run_id}.yaml"
    sd = auto.load_yaml(snap.read_text())
    assert sd["auto_run"]["step"] == "gates" and sd["gates"][0]["cv_class"] == "gate"
    assert sd["auto_run"]["params"] == {"P": [1, 2]}
    baks = list(page_path(data).parent.glob("2-1.sch.yaml.*.bak"))
    assert len(baks) == 1 and baks[0].read_text() == before
    # niczego poza gates/steps nie ruszono
    for k in ("annotations", "decorations", "ports", "cross_refs", "power", "nets"):
        assert p[k] == page_doc()[k], k
    assert p["annotations"][0]["text"] == "yes"  # napis YAML 1.1 przetrwał jako napis
    assert '"yes"' in page_path(data).read_text()
    # ③ bez zatwierdzonego ② → odmowa; z --draft przebiega na bieżących bramkach
    assert run(data, "--page", "2-1", "--step", "wires") == 2
    assert run(data, "--page", "2-1", "--step", "wires", "--draft") == 0
    assert fake_cv[-1] == ("wires", 2)
    p = read_page(data)
    assert list(p["nets"]) == ["NET_AUTO_1"]
    assert p["nets"]["NET_AUTO_1"]["auto_segments"] == [[10, 300, 90, 300]]
    assert p["steps"]["wires"]["status"] == "auto"
    wsnap = data / ".auto" / "P-T" / "2-1" / f"wires-{p['steps']['wires']['run']}.yaml"
    assert auto.load_yaml(wsnap.read_text())["nets"]["CVNET_1"]["cv_free"] == [[10, 300], [90, 300]]
    out = capsys.readouterr()
    assert "ODMOWA" in out.err and "dodane auto 2" in out.out


def test_cli_dry_run_writes_nothing(data, fake_cv, capsys):
    t0, b0 = tree(data), page_path(data).read_bytes()
    assert run(data, "--page", "all", "--step", "gates", "--dry-run") == 0
    assert tree(data) == t0 and page_path(data).read_bytes() == b0
    assert not (data / ".auto").exists()
    assert capsys.readouterr().out.count("dry-run") == 2


def test_cli_approved_needs_force_then_stale(data, fake_cv):
    p = page_doc(steps={"gates": {"status": "approved", "run": "old"},
                        "text": {"status": "approved"}, "wires": {"status": "approved"},
                        "labels": {"status": "auto"}},
                 gates=[box_gate(100, 100, src="auto", verified=True)])
    page_path(data).write_text(auto.dump_yaml(p))
    b0 = page_path(data).read_bytes()
    assert run(data, "--page", "2-1", "--step", "gates") == 2
    assert page_path(data).read_bytes() == b0 and not (data / ".auto").exists()
    assert run(data, "--page", "2-1", "--step", "gates", "--force") == 0
    q = read_page(data)
    assert q["steps"]["gates"]["status"] == "auto" and q["steps"]["gates"]["run"] != "old"
    assert q["steps"]["text"]["status"] == "stale" and q["steps"]["wires"]["status"] == "stale"
    assert q["steps"]["labels"]["status"] == "auto"
    assert len(q["gates"]) == 2  # stara auto zastąpiona, (100,100) wykryta ponownie


def test_cli_not_implemented_exit_3(data, fake_cv, capsys):
    t0 = tree(data)
    for step in ("text", "labels", "nets"):
        assert run(data, "--page", "2-1", "--step", step) == 3
    assert "nie jest jeszcze zaimplementowany" in capsys.readouterr().err
    # next → text (gates zatwierdzony) → 3, nic nie zapisane
    p = page_doc(steps={"gates": {"status": "approved"}})
    page_path(data).write_text(auto.dump_yaml(p))
    t0 = tree(data)
    assert run(data, "--page", "2-1", "--step", "next") == 3
    assert tree(data) == t0
    assert fake_cv == []


def test_cli_next_and_all_exit_precedence(data, fake_cv, capsys):
    done = {s: {"status": "approved"} for s in S.STEP_ORDER}
    page_path(data, "2-2").write_text(auto.dump_yaml(page_doc(page="2-2", steps=done)))
    assert run(data, "--page", "all", "--step", "next", "--json") == 0
    res = json.loads(capsys.readouterr().out)
    assert [(r["page"], r["status"], r["step"]) for r in res["pages"]] == \
        [("2-1", "ok", "gates"), ("2-2", "nothing", None)]
    # wires bez zatwierdzonego text → odmowa (2) na obu; gates: 2-2 bez skanu → błąd (1) wygrywa
    (data / "MOD" / "P-T" / "scans" / "2-2.jpg").unlink()
    page_path(data, "2-2").write_text(auto.dump_yaml(page_doc(page="2-2")))
    assert run(data, "--page", "all", "--step", "wires", "--json") == 2
    res = json.loads(capsys.readouterr().out)
    assert [r["exit"] for r in res["pages"]] == [2, 2]  # odmowa przed wczytaniem skanu
    assert run(data, "--page", "all", "--step", "gates", "--json") == 1
    res = json.loads(capsys.readouterr().out)
    assert [r["status"] for r in res["pages"]] == ["ok", "error"] and res["exit"] == 1
    assert "brak skanu" in res["pages"][1]["reason"]


def test_snapshot_never_overwritten(data, fake_cv, monkeypatch):
    from datetime import datetime, timezone
    now = datetime(2026, 11, 27, 15, 30, 0, tzinfo=timezone.utc)
    monkeypatch.setattr(auto, "utc_now", lambda: now)
    snap = data / ".auto" / "P-T" / "2-1" / "gates-20261127T153000.yaml"
    snap.parent.mkdir(parents=True)
    snap.write_text("stary\n")
    assert run(data, "--page", "2-1", "--step", "gates") == 0
    assert snap.read_text() == "stary\n"
    assert read_page(data)["steps"]["gates"]["run"] == "20261127T153000-2"
    assert (snap.parent / "gates-20261127T153000-2.yaml").is_file()
    # snapshot innego kroku z tym samym czasem też blokuje run id (jeden run na wsad)
    (snap.parent / "wires-20261127T153000-2.yaml").write_text("x\n")
    assert run(data, "--page", "2-1", "--step", "gates") == 0
    assert read_page(data)["steps"]["gates"]["run"] == "20261127T153000-3"
    with pytest.raises(auto.AutoError, match="nie nadpisuję"):
        auto.write_snapshot(snap, "a: 1\n")
    assert snap.read_text() == "stary\n"


def test_cli_errors_exit_1(data, fake_cv, capsys):
    assert run(data, "--page", "9-9", "--step", "gates") == 1
    assert auto.main(["--data", str(data), "--pkg", "NOPE", "--page", "all", "--step", "gates"]) == 1
    with pytest.raises(SystemExit) as e:  # błąd użycia: 1, nie 2 (2 = odmowa)
        run(data, "--page", "2-1", "--step", "bogus")
    assert e.value.code == 1
    with pytest.raises(SystemExit) as e:
        run(data, "--page", "2-1", "--step", "next", "--force")
    assert e.value.code == 1
    page_path(data).write_text("kronikarz: '2'\n")
    assert run(data, "--page", "2-1", "--step", "gates") == 1
    link = page_path(data, "2-2")
    target = link.with_name("real.yaml")
    link.rename(target)
    link.symlink_to(target)
    assert run(data, "--page", "2-2", "--step", "gates") == 1  # _safe_write: symlink = odmowa
    assert "dowiązaniem" in capsys.readouterr().err


def test_yaml_dump_quotes_yaml12_non_strings():
    doc = {"a": ["1e3", "012", "true", "null", "~", "", "2-58", "-BLR", "x"], "n": 1.5, "z": None}
    text = auto.dump_yaml(doc)
    assert auto.load_yaml(text) == doc
    for s in ('"1e3"', '"012"', '"true"', '"null"', '"~"', '""', '"-BLR"', '"n": 1.5'):
        assert s in text, s
    assert "2-58" in text and '"2-58"' not in text


def test_cli_wires_refuses_step5_nets_without_force(data, fake_cv, capsys):
    p = page_doc(nets={"-BLR": {"pins": [], "segments": [[10, 300, 90, 300]], "junctions": None,
                                "auto_segments": [[10, 300, 90, 300]]}},
                 ports=[{"connector": "A", "pin": 1, "label": "-BLR", "net": "-BLR", "x": 10,
                         "y": 300, "side": "left"}])
    page_path(data).write_text(auto.dump_yaml(p))
    t0, b0 = tree(data), page_path(data).read_bytes()
    assert run(data, "--page", "2-1", "--step", "wires", "--draft", "--json") == 2
    res = json.loads(capsys.readouterr().out)["pages"][0]
    assert res["status"] == "refused" and "-BLR" in res["reason"] and "--force" in res["reason"]
    assert res["counts"]["step5_nets"] == {"-BLR": 1}
    assert tree(data) == t0 and page_path(data).read_bytes() == b0
    assert run(data, "--page", "2-1", "--step", "wires", "--draft", "--force") == 0
    q = read_page(data)
    assert q["nets"]["-BLR"]["segments"] == [] and "NET_AUTO_1" in q["nets"]
    assert "netów po kroku ⑤: -BLR" in capsys.readouterr().out


def test_cli_lost_update_writes_nothing(data, monkeypatch):
    path = page_path(data)

    def gates(gray):  # w trakcie przebiegu ktoś (viewer) zapisuje stronę
        path.write_text(path.read_text() + "# zmiana\n")
        return {"entries": [det(100, 100)], "params": {}, "shape": gray.shape, "tool": "cv-gates.py"}

    monkeypatch.setattr(auto, "detect_gates", gates)
    assert run(data, "--page", "2-1", "--step", "gates") == 1
    assert path.read_text().endswith("# zmiana\n") and "steps" not in read_page(data)
    assert not (data / ".auto").exists()
    assert not list(path.parent.glob("*.bak"))


def test_snapshot_symlink_on_auto_path_refused(data, fake_cv, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (data / ".auto").symlink_to(elsewhere)
    b0 = page_path(data).read_bytes()
    assert run(data, "--page", "2-1", "--step", "gates") == 1
    assert page_path(data).read_bytes() == b0 and not list(elsewhere.rglob("*"))


def test_page_write_minimal_diff_keeps_foreign_style(data, fake_cv):
    # strona w stylu innego writera (flow, pojedyncze cudzysłowy): krok ① zmienia tylko
    # sekcje gates i steps, reszta bajt w bajt
    foreign = """kronikarz: '1'
page: 2-1
package: P-T
scan_size: [600, 400]
gates: []
power: []
nets: {}
annotations:
- {text: 'Schemat

    ideowy', x: 5, y: 5, fontSize: 40}
decorations:
- {kind: line, x1: 0, y1: 0, x2: 9, y2: 0}
"""
    page_path(data).write_text(foreign)
    assert run(data, "--page", "2-1", "--step", "gates") == 0
    new = page_path(data).read_text()
    assert new.startswith("kronikarz: '1'\npage: 2-1\npackage: P-T\nscan_size: [600, 400]\nsteps:\n")
    assert new.endswith(foreign[foreign.index("power:"):])
    assert "gates:\n  - ref: \"\"\n    gate: null\n" in new


# --------------------------------------------------------------------------- integracja z CV

def synthetic_scan():
    """Dwie bramki z drutami (jak w test_cv_gates.py: ramka 5 px, drut 3 px)."""
    img = np.full((500, 800), 255, np.uint8)

    def frame(x0, y0, x1, y1, t=5):
        img[y0:y0 + t, x0:x1 + 1] = 0
        img[y1 - t + 1:y1 + 1, x0:x1 + 1] = 0
        img[y0:y1 + 1, x0:x0 + t] = 0
        img[y0:y1 + 1, x1 - t + 1:x1 + 1] = 0

    def h(x0, x1, y):
        img[y - 1:y + 2, x0:x1 + 1] = 0

    def v(x, y0, y1):
        img[y0:y1 + 1, x - 1:x + 2] = 0

    frame(250, 150, 305, 240)
    frame(500, 150, 555, 240)
    h(150, 250, 175)
    h(150, 250, 215)
    h(305, 500, 195)    # wyjście bramki 1 → wejście bramki 2
    h(555, 680, 195)
    v(400, 195, 350)    # odgałęzienie z kropką
    cv2.circle(img, (400, 195), 7, 0, -1)
    h(400, 520, 350)
    return img


def test_cli_real_cv_on_synthetic_scan(data):
    cv2.imwrite(str(data / "MOD" / "P-T" / "scans" / "2-1.jpg"), synthetic_scan(),
                [cv2.IMWRITE_JPEG_QUALITY, 95])
    assert run(data, "--page", "2-1", "--step", "gates") == 0
    p = read_page(data)
    assert len(p["gates"]) == 2 and all(g["src"] == "auto" for g in p["gates"])
    assert run(data, "--page", "2-1", "--step", "wires", "--draft") == 0
    p = read_page(data)
    assert p["nets"] and all(k.startswith("NET_AUTO_") for k in p["nets"])
    for n in p["nets"].values():
        assert S.auto_segment_mask(n) == [True] * len(n["segments"])
    assert all(pin.get("net", "") == "" for g in p["gates"] for pin in g["pins"])
    fp = S.step_fingerprint(p, "wires")
    # ponowny przebieg obu kroków: ta sama treść, bez zmian w drutach
    assert run(data, "--page", "2-1", "--step", "wires", "--draft") == 0
    assert S.step_fingerprint(read_page(data), "wires") == fp
    g_fp = S.step_fingerprint(p, "gates")
    assert run(data, "--page", "2-1", "--step", "gates") == 0
    q = read_page(data)
    assert S.step_fingerprint(q, "gates") == g_fp and q["nets"] == p["nets"]


def test_cli_page_changed_after_snapshot_removes_snapshot(data, fake_cv, monkeypatch):
    path = page_path(data)
    orig = auto.write_snapshot

    def snap_then_edit(p, text, root=None):  # viewer zapisuje stronę między snapshotem a zapisem
        orig(p, text, root)
        path.write_text(path.read_text() + "# zmiana\n")

    monkeypatch.setattr(auto, "write_snapshot", snap_then_edit)
    assert run(data, "--page", "2-1", "--step", "gates") == 1
    assert path.read_text().endswith("# zmiana\n") and "steps" not in read_page(data)
    assert not list((data / ".auto").rglob("*.yaml"))  # świeży snapshot usunięty
    assert not list(path.parent.glob("*.bak"))


def test_cli_roundtrip_failure_writes_nothing(data, fake_cv, monkeypatch):
    t0, b0 = tree(data), page_path(data).read_bytes()
    real = auto._jsyaml.dump
    monkeypatch.setattr(auto._jsyaml, "dump", lambda d: real(d).replace("auto", "edited"))
    assert run(data, "--page", "2-1", "--step", "gates") == 1
    assert tree(data) == t0 and page_path(data).read_bytes() == b0


def test_cli_duplicate_key_in_page_exit_1(data, fake_cv, capsys):
    page_path(data).write_text(page_path(data).read_text() + "gates: []\n")
    b0 = page_path(data).read_bytes()
    assert run(data, "--page", "2-1", "--step", "gates") == 1
    assert "duplicated mapping key" in capsys.readouterr().err
    assert page_path(data).read_bytes() == b0 and not (data / ".auto").exists()
