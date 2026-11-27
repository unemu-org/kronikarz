"""Testy scripts/_jsyaml.py: YAML bajt w bajt jak serializer viewera (js-yaml).

Porównanie z prawdziwym serializerem (`shared/src/parse.ts` → js-yaml) przez node — test
pomijany, gdy node albo node_modules są niedostępne. Strony z data/MJC-400 są tylko CZYTANE
(nic nie trafia do repo ani do data/).

Uruchomienie (nie zostawia __pycache__ ani .pytest_cache):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml \\
      pytest -p no:cacheprovider scripts/test_jsyaml.py
"""
from __future__ import annotations

import copy
import json
import math
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parent
sys.path.insert(0, str(_HERE))
import _jsyaml as J  # noqa: E402

PAGES = sorted((_REPO / "data" / "MJC-400").glob("*/pages/*.sch.yaml"))

# Własne trudne przypadki (napisy, liczby, klucze, zagnieżdżenia).
TRICKY = [
    {"kronikarz": "1", "page": "2-1", "a": ["yes", "No", "on", "OFF", "y", "n", "~", "null", "Null",
                                            "true", "False", "012", "0x1F", "0o17", "0b101", "1_000",
                                            "1e3", ".5", "1.", "-.inf", ".NaN", "1:30", "190:20:30",
                                            "2026-11-27", "2026-11-27T10:20:00Z", "<<", "=", "-BLR",
                                            "+5V", "?x", ":x", "x:", "a: b", "a:b", "a #b", "a#b",
                                            "#x", "x ", " x", "M1.A", "Ark.", "'q'", '"q"', "a,b",
                                            "[x]", "a[1]", "{x}", "@x", "`x", "%x", "&x", "*x", "!x",
                                            "|x", ">x", "ą ę ł", "tab\there", "nbsp x", " ",
                                            "x\u0085y", "\x07bell", "back\\slash", "1_", "012_",
                                            "1.5_", "0x1F_", "1__2", "_1", "1_0"]},
    {"nl": ["12:30\n", "1e3\n", "yes\n", "2026-11-27\n", "<<\n", "0\n", "~\n"]},
    {"multi": ["Schemat ideowy\npakietu P-R3-2", "a\n", "a\n\n", "\n", "\nlead", " lead\nx",
               "x\n y", "a\n\nb", "x " * 70, ("słowo " * 30).strip(), "a\n" + "b " * 80 + "c",
               "y" * 130, "  " + "z " * 70]},
    {"nums": [0, 1, -1, 545.0, 412.5, -0.25, 1e-7, 1.5e-7, 1e21, 1e16, 123456789.125, 0.1, 2.5e-6,
              1e-6, 3.0e20]},
    {"keys": {"12": 1, "b": 2, "0": 3, "a": 4, "007": 5, "1.5": 6, "-1": 7, "": 8, "yes": 9,
              "-BLR": 10, "a b": 11, "4294967295": 12, "4294967294": 13}},
    {"nest": [[1, 2, [3, []]], {"x": {}, "y": [], "z": [{"a": [{"b": None}]}]}, [[[]]], [{}]],
     "deep": {"a": {"b": {"c": {"d": ["Schemat\nideowy", {"e": "f\ng"}]}}}}},
]


def _node_serialize(tmp_path: Path, items: list[dict]) -> list[str]:
    node = shutil.which("node")
    if not node or not (_REPO / "shared" / "src" / "parse.ts").is_file():
        pytest.skip("brak node albo shared/src/parse.ts")
    inp = tmp_path / "in.json"
    out = tmp_path / "out.json"
    inp.write_text(json.dumps(items))
    script = tmp_path / "ser.mjs"
    script.write_text(
        "import fs from 'node:fs';\n"
        f"const {{ parsePage, serializePage }} = await import({json.dumps(str(_REPO / 'shared/src/parse.ts'))});\n"
        "const items = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));\n"
        "const out = items.map((it) => it.text !== undefined\n"
        "  ? serializePage(parsePage(it.text)) : serializePage(it.doc));\n"
        "fs.writeFileSync(process.argv[3], JSON.stringify(out));\n")
    r = subprocess.run([node, "--experimental-strip-types", "--no-warnings", str(script), str(inp), str(out)],
                       capture_output=True, text=True, cwd=_REPO)
    if r.returncode != 0:
        if "Cannot find" in r.stderr or "ERR_MODULE_NOT_FOUND" in r.stderr or "strip-types" in r.stderr:
            pytest.skip("node bez js-yaml / strip-types: " + r.stderr.strip()[:200])
        raise AssertionError(r.stderr)
    return json.loads(out.read_text())


def test_dump_matches_viewer_serializer_on_tricky_docs(tmp_path):
    expected = _node_serialize(tmp_path, [{"doc": d} for d in TRICKY])
    for d, exp in zip(TRICKY, expected):
        got = J.dump(d)
        assert got == exp, (next(iter(d)), _first_diff(got, exp))
        # i wczytanie tego tekstu daje to samo (jak js-yaml)
        assert J.same(J.load(got), json.loads(json.dumps(d)))


@pytest.mark.skipif(not PAGES, reason="brak data/MJC-400")
def test_load_dump_matches_viewer_serializer_on_real_pages(tmp_path):
    texts = [p.read_text(encoding="utf-8") for p in PAGES]
    expected = _node_serialize(tmp_path, [{"text": t} for t in texts])
    bad = [str(p.relative_to(_REPO)) for p, t, e in zip(PAGES, texts, expected) if J.dump(J.load(t)) != e]
    assert not bad, f"{len(bad)}/{len(PAGES)}: {bad[:5]}"


@pytest.mark.skipif(not PAGES, reason="brak data/MJC-400")
def test_noop_step_changes_only_steps_block_on_real_pages():
    for p in PAGES:
        old = p.read_text(encoding="utf-8")
        doc = J.load(old)
        new_doc = {}
        for k, v in doc.items():
            if k == "steps":
                continue
            new_doc[k] = copy.deepcopy(v)
            if k == "scan_size":
                new_doc["steps"] = {"gates": {"status": "auto", "run": "20261127T153000",
                                              "at": "2026-11-27T15:30:00Z"}}
        new = J.splice(old, new_doc)
        assert J.same(J.load(new), new_doc), p
        block = J.dump({"steps": new_doc["steps"]})
        assert block in new, p
        assert new.replace(block, "", 1) == old, (p, _first_diff(new.replace(block, "", 1), old))


def test_splice_falls_back_to_full_dump_when_needed():
    doc = {"kronikarz": "1", "page": "2-1", "gates": [], "nets": {}}
    assert J.splice(J.dump(doc), doc) == J.dump(doc)
    odd = "# nagłówek\nkronikarz: '1'\npage: 2-1\ngates: []\nnets: {}\n"
    assert J.splice(odd, doc) == odd  # nic się nie zmieniło — bajt w bajt
    doc2 = {**doc, "gates": [{"x": 1}]}
    out = J.splice(odd, doc2)
    assert out == "# nagłówek\nkronikarz: '1'\npage: 2-1\ngates:\n  - x: 1\nnets: {}\n"
    assert J.splice("- not\n- a map\n", doc) == J.dump(doc)


def test_loader_like_js_yaml():
    d = J.load("a: yes\nb: 012\nc: 1e3\nd: 0x1F\ne: 1:30\nf: =\ng: 0o17\nh: 1_000\ni: on\n"
               "j: .inf\nk: 0_1\nl: TRUE\nm: ~\n")
    assert d == {"a": "yes", "b": 12, "c": 1000.0, "d": 31, "e": "1:30", "f": "=", "g": 15,
                 "h": 1000, "i": "on", "j": math.inf, "k": 1.0, "l": True, "m": None}


def test_js_number():
    cases = [(0, "0"), (545.0, "545"), (-0.0, "-0.0"), (412.5, "412.5"), (1e-7, "1.e-7"),
             (1.5e-7, "1.5e-7"), (1e21, "1e+21"), (1e16, "10000000000000000"),
             (0.000001, "0.000001"), (2.5e-6, "0.0000025"), (math.inf, ".inf"),
             (-math.inf, "-.inf"), (123456789.125, "123456789.125"), (0.1, "0.1")]
    for v, s in cases:
        assert J.js_number(v) == s, (v, J.js_number(v))
    assert J.js_number(float("nan")) == ".nan"


def _first_diff(a: str, b: str) -> str:
    for i, (x, y) in enumerate(zip(a, b)):
        if x != y:
            return f"@{i}: {a[max(0, i - 40):i + 40]!r} vs {b[max(0, i - 40):i + 40]!r}"
    return f"długość {len(a)} vs {len(b)}"


def test_strings_ending_in_newline_or_underscore_roundtrip():
    # `$` w Pythonie pasuje przed końcowym \n — wszędzie \Z
    for v in ["12:30\n", "12:30", "1_", "012_", "1.5_", "0x1F_", "1e3\n", "yes\n", "0\n",
              "true\n", "~\n", "2026-11-27\n", "<<\n", "1__2", "_1"]:
        d = {"note": v, "list": [v]}
        assert J.load(J.dump(d)) == d, (v, J.dump(d))
        assert J.check_reload(J.dump(d), d)
    assert J.load("a: 1_\nb: 012_\nc: 1.5_\nd: 1_0\n") == {"a": "1_", "b": "012_", "c": "1.5_", "d": 10}
    assert J.dump({"k": "1_"}) == "k: 1_\n"  # js-yaml: nie liczba, bez cudzysłowu
    d = {"kronikarz": "1", "annotations": [{"text": "12:30\n"}]}
    assert J.load(J.splice("kronikarz: '1'\nannotations: []\n", d)) == d


def test_splice_full_fallback_is_reload_checked(monkeypatch):
    doc = {"kronikarz": "1", "a": [1]}
    monkeypatch.setattr(J, "dump", lambda d: "kronikarz: '1'\na: [2]\n")
    with pytest.raises(J.RoundTripError):
        J.splice("x: 1\n", doc)
    with pytest.raises(J.RoundTripError):
        J.dump_checked(doc)


def test_duplicate_keys_rejected_like_js_yaml():
    import yaml
    for text in ("a: 1\na: 2\n", "1: a\n'1': b\n", "n:\n  x: 1\n  x: 1\n", "1.0: a\n1: b\n"):
        with pytest.raises(yaml.YAMLError, match="duplicated mapping key"):
            J.load(text)
    assert J.load("a: &x {b: 1}\nc:\n  <<: *x\n  d: 2\n") == {"a": {"b": 1}, "c": {"b": 1, "d": 2}}
