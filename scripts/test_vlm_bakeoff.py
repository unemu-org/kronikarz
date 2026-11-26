"""Testy budowania wycinków i oceny `vlm-bakeoff.py` (bez wywołań modeli).

PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with pillow \
    pytest -p no:cacheprovider scripts/test_vlm_bakeoff.py
"""

import importlib.util
import json
import sys
from pathlib import Path

import pytest
from PIL import Image

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("vlm_bakeoff", HERE / "vlm-bakeoff.py")
vb = importlib.util.module_from_spec(spec)
sys.modules["vlm_bakeoff"] = vb
spec.loader.exec_module(vb)


# --- normalizacja ---

@pytest.mark.parametrize("raw,exp", [
    (" -BLR ", "-BLR"), ("−BLR", "-BLR"), ("–CZYTRW", "-CZYTRW"),
    ("+WRØ", "+WR0"), ("+ŁRØ", "+ŁR0"), ("M 54", "M54"), (None, ""),
])
def test_norm_text(raw, exp):
    assert vb.norm_text(raw) == exp


def test_norm_text_keeps_letter_o_distinct_from_zero():
    assert vb.norm_text("M6O") != vb.norm_text("M60")
    assert vb.norm_type("O4") != vb.norm_type("04")


def test_norm_type_int_from_yaml():
    assert vb.norm_type(8) == "08"
    assert vb.norm_type("170") == "170"
    assert vb.norm_type("H11") == "H11"


@pytest.mark.parametrize("raw,exp", [("B03", "B3"), ("B3", "B3"), (("B", 3), "B3"), ("a 50", "A50"), ("B∅3", "B∅3")])
def test_norm_conn(raw, exp):
    assert vb.norm_conn(raw) == exp


def test_norm_label_slash_glyph_only_inside():
    for raw in ("-W/R", "-W#R", "-W+R", "-W∤R", "-W|R"):
        assert vb.norm_label(raw) == "-W/R"
    assert vb.norm_label("+RPA") == "+RPA"  # wiodący znak bez zmian
    assert vb.norm_label("-CNBØ-3") == "-CNB0-3"  # '-' w środku nie jest glifem ∤


@pytest.mark.parametrize("raw,exp", [("2,3,4,5", [2, 3, 4, 5]), ("2.3.4.5", [2, 3, 4, 5]), (["7", "8"], [7, 8]),
                                     ([5, 4], [4, 5]), ("", []), (None, [])])
def test_norm_pages(raw, exp):
    assert vb.norm_pages(raw) == exp


# --- parsowanie odpowiedzi ---

def test_parse_json_text_variants():
    assert vb.parse_json_text('{"a": 1}') == {"a": 1}
    assert vb.parse_json_text('```json\n{"a": {"b": 2}}\n```') == {"a": {"b": 2}}
    assert vb.parse_json_text('<think>x {no}</think> sure: {"a": 3} done') == {"a": 3}
    assert vb.parse_json_text("brak") is None
    assert vb.parse_json_text('{"a": ') is None


def test_to_pred_gate_strings_to_ints():
    p = vb.to_pred("gate", {"symbol": "&", "type": "1Ø", "ref": "M65", "pins_left": ["10", "11", 9],
                            "pins_right": ["8"], "pins_top": []})
    assert p == {"symbol": "&", "type": "10", "ref": "M65", "pins": {"left": [10, 11, 9], "right": [8], "top": []}}


def test_to_pred_none_is_all_wrong():
    p = vb.to_pred("port", None)
    assert p == {"conn": None, "label": None}


def test_ocr_to_obj():
    assert vb.ocr_to_obj("port", "A50 -BLR") == {"connector": "A50", "label": "-BLR"}
    assert vb.ocr_to_obj("xref", "+RPA 2,3") == {"label": "+RPA", "sheets": [2, 3]}
    o = vb.ocr_to_obj("gate", "& 10 M65")
    assert (o["symbol"], o["type"], o["ref"]) == ("&", "10", "M65")


# --- geometria wycinków ---

def test_gate_bbox_margins_and_pins():
    g = {"x": 100, "y": 200, "w": 56, "h": 80, "pins": [{"side": "left", "py": 175}, {"side": "right", "py": 175}]}
    x0, y0, x1, y1 = vb.gate_bbox(g)
    assert (x0, x1) == (100 - 28 - vb.GATE_MX, 100 + 28 + vb.GATE_MX)
    assert y0 == 200 - 40 - vb.GATE_MT
    assert y1 == 200 + 40 + vb.GATE_MB


def test_gate_bbox_extends_to_pin_outside_box():
    g = {"x": 100, "y": 200, "w": 56, "h": 80, "pins": [{"side": "left", "py": 150}, {"side": "left", "py": 260}]}
    _, y0, _, y1 = vb.gate_bbox(g)
    assert y0 == 150 - vb.GATE_PIN_ABOVE
    assert y1 == 260 + vb.GATE_MB


def test_port_and_xref_bbox_direction():
    left = vb.port_bbox({"x": 150, "y": 300, "side": "left"})
    right = vb.port_bbox({"x": 1600, "y": 300, "side": "right"})
    assert left[0] == 150 - vb.PORT_OUT and left[2] == 150 + vb.PORT_IN
    assert right[0] == 1600 - vb.PORT_IN and right[2] == 1600 + vb.PORT_OUT
    xr = vb.xref_bbox({"x": 1530, "y": 400, "side": "right"})
    xl = vb.xref_bbox({"x": 246, "y": 400, "side": "left"})
    assert xr[0] == 1530 - vb.XREF_BACK and xr[2] == 1530 + vb.XREF_FWD
    assert xl[0] == 246 - vb.XREF_LEFT_BACK and xl[2] == 246 + vb.XREF_LEFT_FWD
    assert xr[1] == 400 - vb.XREF_UP and xr[3] == 400 + vb.XREF_DOWN


def test_gate_truth_sorts_pins_by_position():
    g = {"ref": "M65", "pins": [{"num": 9, "side": "left", "px": 1, "py": 520}, {"num": 10, "side": "left", "px": 1, "py": 460},
                                {"num": 11, "side": "left", "px": 1, "py": 490}, {"num": 8, "side": "right", "px": 2, "py": 460}]}
    t = vb.gate_truth(g, {"M65": {"ic": "10"}})
    assert t == {"symbol": "&", "type": "10", "ref": "M65", "pins": {"left": [10, 11, 9], "right": [8], "top": []}}


def test_gate_truth_int_ic_and_unknown_symbol():
    t = vb.gate_truth({"ref": "M64", "pins": []}, {"M64": {"ic": 8}})
    assert t["type"] == "08" and t["symbol"] == "&"
    t = vb.gate_truth({"ref": "M52", "pins": []}, {"M52": {"ic": "51"}})
    assert t["symbol"] is None  # 51: symbol nieoceniany


def _mini_gold(tmp_path):
    pkg = tmp_path / vb.PACKAGE
    pkg.mkdir()
    (pkg / "package.yaml").write_text(
        "package:\n  pages:\n    - {id: 2-58, sheet: 1}\n    - {id: 2-59, sheet: 2}\n    - {id: 2-60, sheet: 7}\n"
        "components:\n  M1: {ic: '04'}\n")
    page = {
        "gates": [{"ref": "M1", "gate": "A", "x": 60, "y": 60, "w": 40, "h": 60,
                   "pins": [{"num": 1, "side": "left", "px": 40, "py": 45}, {"num": 2, "side": "right", "px": 80, "py": 45}]}],
        "ports": [{"connector": "B", "pin": 3, "label": "-W/R", "x": 20, "y": 150, "side": "left"}],
        "cross_refs": [{"label": "+RPA", "pages": ["3", "2"], "x": 150, "y": 150, "side": "right"}],
    }
    import yaml
    (pkg / "2-58.sch.yaml").write_text(yaml.safe_dump(page))
    return tmp_path


def test_build_items_and_render(tmp_path):
    gold = _mini_gold(tmp_path)
    items = vb.build_items(gold, pages=["2-58"])
    assert [it.id for it in items] == ["2-58_G_M1A", "2-58_P_B3", "2-58_X_00_+RPA"]
    gate, port, xref = items
    assert gate.truth["pins"] == {"left": [1], "right": [2], "top": []}
    assert port.truth == {"conn": "B3", "label": "-W/R"}
    assert xref.truth == {"label": "+RPA", "pages": [2, 3]}
    scan = Image.new("L", (200, 200), 255)
    scan.putpixel((20, 150), 0)
    im = vb.render_crop(scan, port, 2)
    x0, y0, x1, y1 = port.bbox
    pad = vb.MARK_PAD * 2
    assert im.size == ((x1 - x0) * 2 + 2 * pad, (y1 - y0) * 2)
    my = (port.mark_y - y0) * 2
    assert im.getpixel((2, my))[0] > 200 and im.getpixel((2, my))[1] < 50  # czerwony znacznik w marginesie
    # piksel skanu (20,150) po skali i przesunięciu jest czarny
    assert im.getpixel(((20 - x0) * 2 + pad, (150 - y0) * 2))[0] < 100
    g = vb.render_crop(scan, gate, 1)
    assert g.mode == "L" and g.size == (gate.bbox[2] - gate.bbox[0], gate.bbox[3] - gate.bbox[1])


def test_render_crop_outside_scan_is_white():
    it = vb.Item("x", "2-58", "gate", (-10, -10, 10, 10), None, {})
    im = vb.render_crop(Image.new("L", (50, 50), 0), it, 1)
    assert im.getpixel((0, 0)) == 255 and im.getpixel((15, 15)) == 0


def test_overrides_apply(monkeypatch, tmp_path):
    gold = _mini_gold(tmp_path)
    monkeypatch.setitem(vb.TRUTH_OVERRIDES, "2-58_P_B3", {"label": "", "why": "t"})
    monkeypatch.setitem(vb.TRUTH_OVERRIDES, "2-58_G_M1A", {"type": "00", "why": "t"})
    items = {it.id: it for it in vb.build_items(gold, pages=["2-58"])}
    assert items["2-58_P_B3"].truth["label"] == ""
    assert items["2-58_G_M1A"].truth["type"] == "00" and items["2-58_G_M1A"].truth["symbol"] == "&"


def test_real_gold_items_unique_and_overrides_exist():
    items = vb.build_items()
    ids = {it.id for it in items}
    assert len(ids) == len(items)
    missing = [k for k in vb.TRUTH_OVERRIDES if k not in ids]
    assert not missing, missing


# --- ocena i flagi ---

def test_field_ok_and_unscored():
    t = {"symbol": None, "type": "51", "ref": "M52", "pins": {"left": [1], "right": [], "top": []}}
    p = {"symbol": "&", "type": "51", "ref": "M52", "pins": {"left": [1], "right": [], "top": []}}
    assert vb.field_ok("gate", "symbol", p, t) is None
    assert vb.field_ok("gate", "pins", p, t) is True
    p2 = dict(p, pins={"left": [1], "right": [], "top": [2]})
    assert vb.field_ok("gate", "pins", p2, t) is False


def test_score_run_groups():
    items = {
        "a": vb.Item("a", "2-58", "port", (0, 0, 1, 1), 0, {"conn": "B3", "label": "-X"}),
        "b": vb.Item("b", "2-60", "port", (0, 0, 1, 1), 0, {"conn": "A1", "label": ""}),
    }
    recs = [{"id": "a", "pred": {"conn": "B3", "label": "-Y"}}, {"id": "b", "pred": {"conn": "A1", "label": ""}}]
    acc = vb.score_run(recs, items)
    assert acc[("tune", "port", "conn")] == [1, 1]
    assert acc[("tune", "port", "label")] == [0, 1]
    assert acc[("held", "port", "label")] == [1, 1]
    assert acc[("all", "port", "conn")] == [2, 2]


def test_oov_flags():
    vocab = {"04": {1, 2, 3, 4}, "10": {1, 2, 9, 10, 11, 8}}
    ok = vb.oov_flags("gate", {"symbol": "1", "type": "04", "ref": "M5", "pins": {"left": [1], "right": [2], "top": []}}, vocab, 12)
    assert not any(ok.values())
    bad = vb.oov_flags("gate", {"symbol": "?", "type": "O4", "ref": "H5", "pins": {"left": [1], "right": [1], "top": []}}, vocab, 12)
    assert bad == {"symbol": True, "type": True, "ref": True, "pins": True}
    assert vb.oov_flags("gate", {"symbol": "1", "type": "04", "ref": "M5", "pins": {"left": [9], "right": [], "top": []}}, vocab, 12)["pins"]
    assert vb.oov_flags("port", {"conn": "E3", "label": "X"}, vocab, 12) == {"conn": True, "label": True}
    assert vb.oov_flags("port", {"conn": "B3", "label": ""}, vocab, 12) == {"conn": False, "label": False}
    assert vb.oov_flags("xref", {"label": "+A", "pages": [13]}, vocab, 12) == {"label": False, "pages": True}


def test_char_confusions():
    assert vb.char_confusions("H11", "M11") == [("H", "M")]
    assert vb.char_confusions("M60", "M6O") == [("0", "O")]
    assert vb.char_confusions("-RA", "-RAA") == [("-RA", "-RAA")]


def test_ic_vocab_has_types_and_pins():
    v = vb.load_ic_vocab()
    assert {"04", "170", "175", "11", "51"} <= set(v)
    assert v["04"] >= {1, 2, 13, 12}
    assert vb.resolve_type("H11", v) == "11"  # polski prefiks H (jak resolveIcKey)
    assert vb.resolve_type("M11", v) is None and vb.resolve_type("O4", v) is None


def test_cache_key_depends_on_inputs():
    k = vb.cache_key("m", {"e": 1}, b"png", "p")
    assert k != vb.cache_key("m", {"e": 2}, b"png", "p")
    assert k != vb.cache_key("m", {"e": 1}, b"png2", "p")
    assert k != vb.cache_key("m", {"e": 1}, b"png", "p2")
    assert k == vb.cache_key("m", {"e": 1}, b"png", "p")


def _patch_gold(monkeypatch, gold):
    real = vb.build_items
    monkeypatch.setattr(vb, "build_items",
                        lambda gold_dir=gold, pages=("2-58",), overrides=True: real(gold, pages=pages,
                                                                                       overrides=overrides))


def test_match_sheet_by_position(monkeypatch, tmp_path):
    gold = _mini_gold(tmp_path)
    _patch_gold(monkeypatch, gold)
    obj = {"gates": [{"x": 60, "y": 60, "symbol": "1", "type": "04", "ref": "M1", "pins_left": [1], "pins_right": [2],
                      "pins_top": []}],
           "ports": [], "cross_refs": [{"x": 170, "y": 160, "label": "+RPA", "sheets": [2, 3]}]}
    recs = {r["id"]: r for r in vb.match_sheet("2-58", obj, "m")}
    assert recs["2-58_G_M1A"]["pred"]["ref"] == "M1"
    assert recs["2-58_P_B3"]["error"] == "unmatched"
    assert recs["2-58_X_00_+RPA"]["pred"]["label"] == "+RPA"  # blisko położenia wzorca
    json.dumps(list(recs.values()))


def _two_xref_gold(tmp_path):
    import yaml
    pkg = tmp_path / vb.PACKAGE
    pkg.mkdir()
    (pkg / "package.yaml").write_text("components: {}\n")
    page = {"gates": [], "ports": [], "cross_refs": [
        {"label": "+RA", "pages": ["1"], "x": 300, "y": 200, "side": "right"},
        {"label": "+RB", "pages": ["1"], "x": 300, "y": 228, "side": "right"}]}
    (pkg / "2-58.sch.yaml").write_text(yaml.safe_dump(page))
    return tmp_path


def test_match_sheet_follows_crop_pred_not_truth(monkeypatch, tmp_path):
    """Dwa cross-refy 28 px od siebie, oba odczyty całoarkuszowe w połowie drogi (położenie nie
    rozstrzyga). Dopasowanie idzie za odczytem wycinkowym, a zmiana prawdy nic nie zmienia."""
    gold = _two_xref_gold(tmp_path)
    _patch_gold(monkeypatch, gold)
    obj = {"gates": [], "ports": [], "cross_refs": [
        {"x": 300, "y": 214, "label": "+RB", "sheets": [1]},
        {"x": 300, "y": 214, "label": "+QA", "sheets": [1]}]}
    ref = {"2-58_X_00_+RA": {"label": "+QA", "pages": [1]}, "2-58_X_01_+RB": {"label": "+RB", "pages": [1]}}
    recs = {r["id"]: r for r in vb.match_sheet("2-58", obj, "m", ref)}
    assert recs["2-58_X_00_+RA"]["pred"]["label"] == "+QA"
    assert recs["2-58_X_01_+RB"]["pred"]["label"] == "+RB"
    # prawda zamieniona — wynik dopasowania ten sam (prawda nie bierze udziału)
    monkeypatch.setitem(vb.TRUTH_OVERRIDES, "2-58_X_00_+RA", {"label": "+RB", "why": "t"})
    monkeypatch.setitem(vb.TRUTH_OVERRIDES, "2-58_X_01_+RB", {"label": "+QA", "why": "t"})
    recs2 = {r["id"]: r for r in vb.match_sheet("2-58", obj, "m", ref)}
    assert {k: v["pred"] for k, v in recs2.items()} == {k: v["pred"] for k, v in recs.items()}


def test_match_sheet_unscored_field_not_mismatch(monkeypatch, tmp_path):
    """Symbol bramki 51 (truth None) nie liczy się jako niezgodność przy dopasowaniu (14)."""
    import yaml
    pkg = tmp_path / vb.PACKAGE
    pkg.mkdir()
    (pkg / "package.yaml").write_text("components:\n  M52: {ic: '51'}\n")
    page = {"gates": [{"ref": "M52", "gate": "A", "x": 100, "y": 100, "w": 80, "h": 130, "pins": []}],
            "ports": [], "cross_refs": []}
    (pkg / "2-58.sch.yaml").write_text(yaml.safe_dump(page))
    _patch_gold(monkeypatch, tmp_path)
    g = {"symbol": "&", "type": "51", "ref": "M52", "pins_left": [], "pins_right": [], "pins_top": []}
    ref = {"2-58_G_M52A": {"symbol": "1", "type": "51", "ref": "M52", "pins": {"left": [], "right": [], "top": []}}}
    # odległość 590 px → koszt 5,9; z liczeniem symbolu byłoby 6,9 > próg 6
    obj = {"gates": [dict(g, x=100, y=100 + 590)], "ports": [], "cross_refs": []}
    recs = vb.match_sheet("2-58", obj, "m", ref)
    assert recs[0]["error"] is None and recs[0]["pred"]["symbol"] == "&"


# --- rekordy spoza wzorca (10), items.json w score (13) ---

def test_known_records_skips_unknown_with_warning(capsys):
    items = {"a": vb.Item("a", "2-58", "port", (0, 0, 1, 1), 0, {"conn": "B3", "label": ""})}
    recs = [{"id": "a", "page": "2-58"}, {"id": "zzz", "page": "2-99"}]
    out = vb.known_records("run", recs, items)
    assert [r["id"] for r in out] == ["a"]
    assert "zzz" in capsys.readouterr().err


def test_cmd_score_tolerates_unknown_ids_and_writes_items(tmp_path, monkeypatch):
    (tmp_path / "g").mkdir()
    gold = _mini_gold(tmp_path / "g")
    _patch_gold(monkeypatch, gold)
    out = tmp_path / "out"
    (out / "runs").mkdir(parents=True)
    recs = [{"id": "2-58_P_B3", "page": "2-58", "kind": "port", "model": "x", "pred": {"conn": "B3", "label": "-W/R"},
             "latency": 1.0},
            {"id": "2-99_P_X1", "page": "2-99", "kind": "port", "model": "x", "pred": {"conn": "X1", "label": ""}}]
    (out / "runs" / "r.jsonl").write_text("\n".join(json.dumps(r) for r in recs))
    vb.main(["score", "--out", str(out)])
    md = (out / "score.md").read_text()
    assert "100.0% (1/1)" in md
    items = json.loads((out / "items.json").read_text())
    assert {i["id"] for i in items} == {"2-58_G_M1A", "2-58_P_B3", "2-58_X_00_+RPA"}


# --- liczba arkuszy z pakietu (11) ---

def test_package_sheet_count_and_oov_pages(tmp_path):
    gold = _mini_gold(tmp_path)
    assert vb.package_sheet_count(gold) == 7
    assert vb.package_sheet_count() == 12  # prawdziwy P-R3-2
    assert vb.oov_flags("xref", {"label": "+A", "pages": [7]}, {}, 7)["pages"] is False
    assert vb.oov_flags("xref", {"label": "+A", "pages": [8]}, {}, 7)["pages"] is True


# --- klucz cache MLX (12) ---

def test_mlx_cache_id_includes_path_hash_and_legacy(tmp_path):
    a = vb.MlxAdapter(str(tmp_path / "m1" / "Qwen-X"))  # leniwe: bez ładowania modelu
    b = vb.MlxAdapter(str(tmp_path / "m2" / "Qwen-X"))
    assert a.name == b.name == "mlx:Qwen-X"
    assert a.cache_id != b.cache_id and a.cache_id.startswith("mlx:Qwen-X#")
    hf = vb.MlxAdapter("/x/hub/models--mlx-community--Qwen3.6-35B-A3B-4bit/snapshots/abc123")
    assert hf.name == "mlx:Qwen3.6-35B-A3B-4bit"
    assert hf.legacy_cache_ids() == ["mlx:abc123", "mlx:Qwen3.6-35B-A3B-4bit"]
    o = vb.OcrAdapter(str(tmp_path / "PaddleOCR"))
    assert o.name == "ocr:PaddleOCR" and o.cache_id.startswith("ocr:PaddleOCR#")


def test_cache_get_migrates_legacy_key(tmp_path):
    a = vb.MlxAdapter("/x/hub/models--mlx-community--Q/snapshots/abc123")
    keys = vb.cache_keys(a, a.params(), b"png", "prompt")
    assert len(keys) == 3 and len(set(keys)) == 3
    assert keys[1] == vb.cache_key("mlx:abc123", a.params(), b"png", "prompt")  # wpis sprzed zmiany
    (tmp_path / f"{keys[1]}.json").write_text(json.dumps({"text": "{}", "error": None}))
    assert vb.cache_get(tmp_path, keys) == {"text": "{}", "error": None}
    assert (tmp_path / f"{keys[0]}.json").exists()  # skopiowany pod nowy klucz
    assert vb.cache_get(tmp_path, [keys[0] + "x"]) is None


def test_raw_to_obj_ocr_reparses_text():
    raw = {"text": "A50 -BLR", "obj": {"connector": "stale", "label": "stale"}}
    assert vb.raw_to_obj("ocr:P", "port", raw) == {"connector": "A50", "label": "-BLR"}
    assert vb.raw_to_obj("mlx:Q", "port", {"text": '{"connector": "A50", "label": ""}'}) == {"connector": "A50",
                                                                                            "label": ""}
