"""Bezpieczny zapis zestawu plików dla skryptów generujących dane w data/.

`write_all(writes, force=..., dry_run=...)` — zasada „wszystko albo nic”:
  1. Najpierw sprawdza WSZYSTKIE ścieżki docelowe. Jeśli którakolwiek istnieje,
     a nie ma `force`, wypisuje listę na stderr i zwraca 1, nie zapisując nic.
  2. Z `force`: każdy istniejący plik jest najpierw kopiowany do
     `<plik>.<ISO-UTC>.bak` obok (ten sam wzór co `timestampedBackup` w
     server/index.js: `new Date().toISOString()` z `:` i `.` zamienionymi na `-`,
     np. `ic_map.yaml.2026-11-27T10-15-30-123Z.bak`; `*.bak` jest w .gitignore).
     Wszystkie kopie powstają przed pierwszym zapisem.
  3. Zapis atomowy: plik tymczasowy w tym samym katalogu + `os.replace`
     (+ fsync katalogu, best effort).
  4. Symlink (także wiszący) na ścieżce docelowej → zawsze odmowa, również z
     `force` (nie zapisujemy „przez” dowiązanie w nieznane miejsce).
  5. Błąd w trakcie kopii / zapisu → zamiast tracebacku raport na stderr: co
     zapisano, czego NIE, oraz stempel kopii do przywrócenia (`*.<stamp>.bak`).
  6. `dry_run`: tylko wypisuje plan (utworzy / nadpisze / odmowa) i zwraca kod,
     jaki dałby prawdziwy przebieg; niczego nie tworzy (także katalogów).
"""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path


def iso_stamp(now: datetime | None = None) -> str:
    """`2026-11-27T10-15-30-123Z` — jak `isoStamp()` w server/index.js."""
    now = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    return now.strftime("%Y-%m-%dT%H-%M-%S-") + f"{now.microsecond // 1000:03d}Z"


def backup_path(path: Path, stamp: str) -> Path:
    return path.with_name(f"{path.name}.{stamp}.bak")


def atomic_write_text(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
        if path.exists():
            shutil.copymode(path, tmp)
        else:
            umask = os.umask(0)
            os.umask(umask)
            os.chmod(tmp, 0o666 & ~umask)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise
    _fsync_dir(path.parent)


def _fsync_dir(d: Path) -> None:
    """fsync katalogu po os.replace (best effort — nie wszędzie się da)."""
    try:
        fd = os.open(d, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    except OSError:
        return
    try:
        os.fsync(fd)
    except OSError:
        pass
    finally:
        os.close(fd)


def _present(p: Path) -> bool:
    """Istnieje — także jako symlink (również wiszący)."""
    return p.exists() or p.is_symlink()


def write_all(writes: dict[Path, str], *, force: bool = False, dry_run: bool = False,
              out=None, err=None) -> int:
    """Zapisuje `writes` (ścieżka → treść). Zwraca kod wyjścia (0 / 1)."""
    out = sys.stdout if out is None else out
    err = sys.stderr if err is None else err
    items = [(Path(p), text) for p, text in writes.items()]
    paths = [p for p, _ in items]
    links = [p for p in paths if p.is_symlink()]
    existing = [p for p in paths if _present(p)]
    refused = bool(links) or (bool(existing) and not force)

    if dry_run:
        for p in paths:
            if p in links:
                out.write(f"odmowa (dowiązanie symboliczne): {p}\n")
            elif p not in existing:
                out.write(f"utworzy: {p}\n")
            elif force:
                out.write(f"nadpisze (kopia .bak): {p}\n")
            else:
                out.write(f"odmowa (istnieje, brak --force): {p}\n")
        out.write("(dry-run: nic nie zapisano)\n")
        return 1 if refused else 0

    if links:
        err.write("odmowa: cel jest dowiązaniem symbolicznym (nie zapisuję przez symlink, "
                  "także z --force):\n")
        for p in links:
            err.write(f"  {p}\n")
        err.write("nic nie zapisano.\n")
        return 1

    if refused:
        err.write("odmowa: pliki istnieją (użyj --force, by nadpisać):\n")
        for p in existing:
            err.write(f"  {p}\n")
        err.write("nic nie zapisano.\n")
        return 1

    stamp = iso_stamp()
    for p in existing:
        bak = backup_path(p, stamp)
        if _present(bak):
            err.write(f"błąd: kopia już istnieje: {bak}\n")
            return 1

    made: list[Path] = []
    try:
        for p in existing:
            bak = backup_path(p, stamp)
            shutil.copy2(p, bak)
            made.append(bak)
            out.write(f"kopia: {bak}\n")
    except Exception as e:  # noqa: BLE001 — raport zamiast tracebacku
        err.write(f"błąd przy tworzeniu kopii: {e}\n")
        err.write("nic nie nadpisano.\n")
        if made:
            err.write("utworzone kopie (można usunąć):\n")
            for b in made:
                err.write(f"  {b}\n")
        return 1

    written: list[Path] = []
    try:
        for p, text in items:
            atomic_write_text(p, text)
            written.append(p)
    except Exception as e:  # noqa: BLE001 — raport zamiast tracebacku
        err.write(f"błąd zapisu: {e}\n")
        err.write("zapisane:\n")
        for w in written:
            err.write(f"  {w}\n")
        err.write("NIE zapisane:\n")
        for w in paths[len(written):]:
            err.write(f"  {w}\n")
        if made:
            err.write(f"przywróć z *.{stamp}.bak (kopie sprzed nadpisania):\n")
            for b in made:
                err.write(f"  {b}\n")
        return 1
    return 0
