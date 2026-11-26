"""Testy ochrony zapisu w scripts/build-ic-map.py (tylko katalogi tymczasowe).

Uruchomienie: zob. scripts/test_gen_stubs.py.
"""
from __future__ import annotations

import hashlib
import importlib.util
import re
import subprocess
import sys
from pathlib import Path

import pytest
import yaml

HERE = Path(__file__).resolve().parent
_spec = importlib.util.spec_from_file_location("build_ic_map", HERE / "build-ic-map.py")
bim = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bim)

BAK_RE = re.compile(r"^ic_map\.yaml\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$")
OLD = "00:\n  name: ręcznie poprawiony\n"


@pytest.fixture(autouse=True)
def _never_default_root(monkeypatch, tmp_path):
    """Siatka bezpieczeństwa: domyślny --root wskazuje w próżnię, nie na data/."""
    assert bim.ROOT == bim.REPO / "data" / "MJC-400"
    monkeypatch.setattr(bim, "ROOT", tmp_path / "NIE-UZYWAC")


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def run(root: Path, *extra: str) -> int:
    return bim.main(["--root", str(root), *extra])


def test_fresh_dir_writes_without_force(tmp_path):
    assert run(tmp_path) == 0
    out = tmp_path / "ic_map.yaml"
    assert out.read_text() == bim.render(bim.emit())
    doc = yaml.safe_load(out.read_text())
    assert doc["00"]["name"] == "SN7400N" and doc["CP"]["shape"] == "capacitor_polarized"
    assert [p.name for p in tmp_path.iterdir()] == ["ic_map.yaml"]


def test_refuses_without_force_byte_identical(tmp_path, capsys):
    out = tmp_path / "ic_map.yaml"
    out.write_text(OLD)
    h = sha(out)
    assert run(tmp_path) == 1
    assert sha(out) == h
    assert [p.name for p in tmp_path.iterdir()] == ["ic_map.yaml"]
    err = capsys.readouterr().err
    assert "odmowa" in err and str(out) in err


def test_force_overwrites_with_bak(tmp_path):
    out = tmp_path / "ic_map.yaml"
    out.write_text(OLD)
    assert run(tmp_path, "--force") == 0
    assert out.read_text() == bim.render(bim.emit())
    (bak,) = tmp_path.glob("ic_map.yaml.*.bak")
    assert BAK_RE.match(bak.name) and bak.read_text() == OLD
    assert sorted(p.name for p in tmp_path.iterdir()) == sorted(["ic_map.yaml", bak.name])


def test_dry_run_writes_nothing(tmp_path, capsys):
    assert run(tmp_path, "--dry-run") == 0
    assert list(tmp_path.iterdir()) == []
    assert "utworzy" in capsys.readouterr().out
    out = tmp_path / "ic_map.yaml"
    out.write_text(OLD)
    assert run(tmp_path, "--dry-run") == 1
    assert run(tmp_path, "--dry-run", "--force") == 0
    assert out.read_text() == OLD and len(list(tmp_path.iterdir())) == 1


def test_missing_root_errors(tmp_path, capsys):
    assert run(tmp_path / "brak") == 1
    assert not (tmp_path / "brak").exists()
    assert "brak katalogu" in capsys.readouterr().err


def test_cli_subprocess_from_other_cwd(tmp_path):
    """Import _safe_write działa przy uruchomieniu skryptu z innego katalogu."""
    root = tmp_path / "mod"
    root.mkdir()
    cwd = tmp_path / "gdzies"
    cwd.mkdir()
    cmd = [sys.executable, str(HERE / "build-ic-map.py"), "--root", str(root)]
    r = subprocess.run([*cmd, "--dry-run"], cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "utworzy:" in r.stdout and list(root.iterdir()) == []
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 1 and "odmowa" in r.stderr and "Traceback" not in r.stderr
