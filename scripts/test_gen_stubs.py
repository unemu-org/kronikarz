"""Testy ochrony zapisu w scripts/gen-stubs.py, scripts/build-ic-map.py i scripts/_safe_write.py.

Wszystko na katalogach tymczasowych z własnymi, sztucznymi fixture'ami — prawdziwe
data/MJC-400 nigdy nie jest dotykane (autouse fixture przestawia domyślny ROOT
na nieistniejący katalog w tmp, więc przypadkowe wywołanie bez --root się wyłoży).

Uruchomienie (nie zostawia __pycache__ ani .pytest_cache):
  PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with pillow \\
      pytest -p no:cacheprovider scripts/test_gen_stubs.py scripts/test_build_ic_map.py
"""
from __future__ import annotations

import hashlib
import importlib.util
import io
import re
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

import pytest
import yaml
from PIL import Image

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import _safe_write as sw  # noqa: E402


def _load(name: str, file: str):
    spec = importlib.util.spec_from_file_location(name, HERE / file)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


gs = _load("gen_stubs", "gen-stubs.py")

BAK_RE = re.compile(r"^(?P<name>.+)\.\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.bak$")


@pytest.fixture(autouse=True)
def _never_default_root(monkeypatch, tmp_path):
    """Siatka bezpieczeństwa: domyślny --root wskazuje w próżnię, nie na data/."""
    assert gs.ROOT == gs.REPO / "data/MJC-400"
    monkeypatch.setattr(gs, "ROOT", tmp_path / "NIE-UZYWAC")


def snapshot(root: Path) -> dict[str, str]:
    """Ścieżka względna → sha256 dla wszystkich plików pod root."""
    return {
        str(p.relative_to(root)): hashlib.sha256(p.read_bytes()).hexdigest()
        for p in sorted(root.rglob("*")) if p.is_file()
    }


def make_tree(root: Path) -> Path:
    """Dwa sztuczne pakiety ze skanami (małe JPG) + katalog bez skanów."""
    for pkg, pages in {"AAA": ["1-1", "1-2"], "BBB": ["1-1"]}.items():
        scans = root / pkg / "scans"
        scans.mkdir(parents=True)
        for i, page in enumerate(pages):
            Image.new("L", (40 + i, 30), 255).save(scans / f"{page}.jpg")
    (root / "CCC").mkdir()
    return root


def run(root: Path, *extra: str) -> int:
    return gs.main(["--root", str(root), *extra])


# --------------------------------------------------------------------------- gen-stubs

def test_fresh_empty_dir_works_without_force(tmp_path):
    root = tmp_path / "mod"
    root.mkdir()
    assert run(root) == 0
    assert sorted(snapshot(root)) == ["ic_map.yaml", "project.yaml"]
    proj = yaml.safe_load((root / "project.yaml").read_text())
    assert proj["kronikarz"] == "1" and proj["packages"] == [] and proj["backplane"] == []


def test_fresh_tree_creates_everything(tmp_path):
    root = make_tree(tmp_path / "mod")
    assert run(root) == 0
    files = set(snapshot(root))
    assert {"ic_map.yaml", "project.yaml", "AAA/package.yaml", "BBB/package.yaml",
            "AAA/pages/1-1.sch.yaml", "AAA/pages/1-2.sch.yaml", "BBB/pages/1-1.sch.yaml"} <= files
    assert not any(f.endswith(".bak") or f.endswith(".tmp") for f in files)
    sch = yaml.safe_load((root / "AAA/pages/1-2.sch.yaml").read_text())
    assert sch["scan_size"] == [41, 30] and sch["package"] == "AAA"
    assert not (root / "CCC/package.yaml").exists()


def test_rerun_without_force_refuses_and_changes_nothing(tmp_path, capsys):
    root = make_tree(tmp_path / "mod")
    assert run(root) == 0
    (root / "project.yaml").write_text("kronikarz: \"1\"\nbackplane: [ręcznie]\n")
    before = snapshot(root)
    capsys.readouterr()
    assert run(root) == 1
    assert snapshot(root) == before
    err = capsys.readouterr().err
    assert "odmowa" in err and "--force" in err
    for name in ("project.yaml", "ic_map.yaml", "AAA/package.yaml", "BBB/package.yaml"):
        assert str(root / name) in err


def test_all_or_nothing_one_existing_blocks_all_writes(tmp_path, capsys):
    root = make_tree(tmp_path / "mod")
    (root / "BBB/package.yaml").write_text("components: {X1: ręcznie}\n")
    before = snapshot(root)
    assert run(root) == 1
    assert snapshot(root) == before  # ani ic_map.yaml, ani project.yaml, ani strony
    assert not (root / "AAA/pages").exists()  # nawet katalogi nie powstały
    err = capsys.readouterr().err
    assert str(root / "BBB/package.yaml") in err
    assert str(root / "project.yaml") not in err  # lista = tylko istniejące


def test_force_overwrites_and_makes_timestamped_bak(tmp_path):
    root = make_tree(tmp_path / "mod")
    old = "kronikarz: \"1\"\nbackplane: [ręcznie]\n"
    (root / "project.yaml").write_text(old)
    assert run(root, "--force") == 0
    new = (root / "project.yaml").read_text()
    assert new != old and yaml.safe_load(new)["backplane"] == []
    baks = sorted(root.glob("project.yaml.*.bak"))
    assert len(baks) == 1 and BAK_RE.match(baks[0].name)
    assert baks[0].read_text() == old
    # nowe pliki nie dostają kopii
    assert not list(root.glob("ic_map.yaml.*.bak"))
    assert not list(root.rglob("*.tmp"))


def test_existing_page_stub_never_overwritten_even_with_force(tmp_path):
    root = make_tree(tmp_path / "mod")
    page = root / "AAA/pages/1-1.sch.yaml"
    page.parent.mkdir()
    page.write_text("gates: [ręcznie narysowane]\n")
    h = hashlib.sha256(page.read_bytes()).hexdigest()
    assert run(root) == 0  # strona nie blokuje (jest pomijana, jak dotąd)
    assert run(root, "--force") == 0
    assert hashlib.sha256(page.read_bytes()).hexdigest() == h
    assert not list(page.parent.glob("1-1.sch.yaml.*.bak"))
    pkg = yaml.safe_load((root / "AAA/package.yaml").read_text())
    assert [p["id"] for p in pkg["package"]["pages"]] == ["1-1", "1-2"]


def test_dry_run_writes_nothing(tmp_path, capsys):
    root = make_tree(tmp_path / "mod")
    before = snapshot(root)
    assert run(root, "--dry-run") == 0
    assert snapshot(root) == before and not (root / "AAA/pages").exists()
    out = capsys.readouterr().out
    assert f"utworzy: {root / 'project.yaml'}" in out

    (root / "project.yaml").write_text("x: 1\n")
    before = snapshot(root)
    assert run(root, "--dry-run") == 1  # prawdziwy przebieg by odmówił
    assert "odmowa" in capsys.readouterr().out
    assert run(root, "--dry-run", "--force") == 0
    assert "nadpisze" in capsys.readouterr().out
    assert snapshot(root) == before


def test_missing_root_errors(tmp_path):
    assert run(tmp_path / "brak") == 1
    assert not (tmp_path / "brak").exists()


# --------------------------------------------------------------------------- _safe_write

def test_iso_stamp_matches_server_format():
    # server/index.js: new Date().toISOString().replace(/[:.]/g, '-')
    dt = datetime(2026, 1, 2, 3, 4, 5, 678901, tzinfo=timezone.utc)
    assert sw.iso_stamp(dt) == "2026-01-02T03-04-05-678Z"
    assert sw.backup_path(Path("/x/ic_map.yaml"), "S").name == "ic_map.yaml.S.bak"


def test_write_all_refuses_then_force_backs_up(tmp_path):
    a, b = tmp_path / "a.yaml", tmp_path / "sub" / "b.yaml"
    a.write_text("stare\n")
    err = io.StringIO()
    assert sw.write_all({a: "nowe\n", b: "b\n"}, err=err, out=io.StringIO()) == 1
    assert a.read_text() == "stare\n" and not b.parent.exists()
    assert str(a) in err.getvalue() and str(b) not in err.getvalue()

    assert sw.write_all({a: "nowe\n", b: "b\n"}, force=True, out=io.StringIO()) == 0
    assert a.read_text() == "nowe\n" and b.read_text() == "b\n"
    (bak,) = tmp_path.glob("a.yaml.*.bak")
    assert bak.read_text() == "stare\n"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["a.yaml", bak.name, "sub"]


def test_write_all_backup_collision_writes_nothing(tmp_path, monkeypatch):
    a = tmp_path / "a.yaml"
    a.write_text("stare\n")
    monkeypatch.setattr(sw, "iso_stamp", lambda: "STALY")
    sw.backup_path(a, "STALY").write_text("wcześniejsza kopia\n")
    assert sw.write_all({a: "nowe\n"}, force=True, out=io.StringIO(), err=io.StringIO()) == 1
    assert a.read_text() == "stare\n"
    assert sw.backup_path(a, "STALY").read_text() == "wcześniejsza kopia\n"


def test_atomic_write_preserves_mode(tmp_path):
    a = tmp_path / "a.yaml"
    a.write_text("x\n")
    a.chmod(0o640)
    sw.atomic_write_text(a, "y\n")
    assert a.read_text() == "y\n" and (a.stat().st_mode & 0o777) == 0o640


def _fail_on_call(n: int, real, exc=None):
    exc = exc or OSError("dysk pełny (symulacja)")
    calls = {"n": 0}

    def wrapper(*a, **kw):
        calls["n"] += 1
        if calls["n"] == n:
            raise exc
        return real(*a, **kw)
    return wrapper


def test_mid_write_failure_reports_and_keeps_baks(tmp_path, monkeypatch):
    a, b, c = (tmp_path / n for n in ("a.yaml", "b.yaml", "c.yaml"))
    a.write_text("stare a\n")
    b.write_text("stare b\n")
    monkeypatch.setattr(sw, "iso_stamp", lambda: "STEMPEL")
    monkeypatch.setattr(sw, "atomic_write_text", _fail_on_call(2, sw.atomic_write_text))
    err = io.StringIO()
    rc = sw.write_all({a: "nowe a\n", b: "nowe b\n", c: "nowe c\n"}, force=True,
                      out=io.StringIO(), err=err)
    assert rc == 1
    e = err.getvalue()
    assert "błąd zapisu: dysk pełny (symulacja)" in e
    head, tail = e.split("NIE zapisane:")
    done = head.split("zapisane:")[1]
    not_done = tail.split("przywróć")[0]
    assert str(a) in done and str(b) not in done
    assert str(b) in not_done and str(c) in not_done and str(a) not in not_done
    assert "przywróć z *.STEMPEL.bak" in e
    assert a.read_text() == "nowe a\n" and b.read_text() == "stare b\n" and not c.exists()
    assert sw.backup_path(a, "STEMPEL").read_text() == "stare a\n"
    assert sw.backup_path(b, "STEMPEL").read_text() == "stare b\n"
    assert not list(tmp_path.glob("*.tmp")) and not list(tmp_path.glob(".*.tmp"))


def test_mid_write_failure_through_gen_stubs(tmp_path, monkeypatch, capsys):
    root = make_tree(tmp_path / "mod")
    (root / "project.yaml").write_text("backplane: [ręcznie]\n")
    monkeypatch.setattr(sw, "atomic_write_text", _fail_on_call(2, sw.atomic_write_text))
    assert run(root, "--force") == 1  # raport, bez tracebacku
    e = capsys.readouterr().err
    assert "błąd zapisu" in e and "NIE zapisane:" in e and "przywróć z *." in e
    (bak,) = root.glob("project.yaml.*.bak")
    assert bak.read_text() == "backplane: [ręcznie]\n"


def test_backup_failure_overwrites_nothing(tmp_path, monkeypatch):
    a, b = tmp_path / "a.yaml", tmp_path / "b.yaml"
    a.write_text("stare a\n")
    b.write_text("stare b\n")
    monkeypatch.setattr(sw.shutil, "copy2", _fail_on_call(2, sw.shutil.copy2))
    err = io.StringIO()
    assert sw.write_all({a: "x\n", b: "y\n"}, force=True, out=io.StringIO(), err=err) == 1
    assert "błąd przy tworzeniu kopii" in err.getvalue() and "nic nie nadpisano" in err.getvalue()
    assert a.read_text() == "stare a\n" and b.read_text() == "stare b\n"


@pytest.mark.parametrize("broken", [False, True])
@pytest.mark.parametrize("force", [False, True])
def test_symlink_target_always_refused(tmp_path, broken, force):
    real = tmp_path / "gdzie-indziej.yaml"
    if not broken:
        real.write_text("cel linku\n")
    link = tmp_path / "a.yaml"
    link.symlink_to(real)
    other = tmp_path / "b.yaml"
    err = io.StringIO()
    rc = sw.write_all({link: "x\n", other: "y\n"}, force=force, out=io.StringIO(), err=err)
    assert rc == 1
    assert "dowiązaniem symbolicznym" in err.getvalue() and str(link) in err.getvalue()
    assert link.is_symlink() and not other.exists()
    if broken:
        assert not real.exists()
    else:
        assert real.read_text() == "cel linku\n"
    assert not list(tmp_path.glob("*.bak"))
    out = io.StringIO()
    assert sw.write_all({link: "x\n"}, force=force, dry_run=True, out=out) == 1
    assert "odmowa (dowiązanie symboliczne)" in out.getvalue()


def test_fsync_dir_best_effort(tmp_path):
    sw._fsync_dir(tmp_path)  # działa
    sw._fsync_dir(tmp_path / "brak")  # nie rzuca


def test_cli_subprocess_from_other_cwd(tmp_path):
    """Import _safe_write działa przy uruchomieniu skryptu z innego katalogu."""
    root = make_tree(tmp_path / "mod")
    cwd = tmp_path / "gdzies"
    cwd.mkdir()
    cmd = [sys.executable, str(HERE / "gen-stubs.py"), "--root", str(root)]
    r = subprocess.run([*cmd, "--dry-run"], cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert "utworzy:" in r.stdout and not (root / "project.yaml").exists()
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 0, r.stderr
    assert (root / "project.yaml").exists()
    r = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True)
    assert r.returncode == 1 and "odmowa" in r.stderr and "Traceback" not in r.stderr
