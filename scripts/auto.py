#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["opencv-python-headless", "numpy", "pyyaml"]
# ///
"""Pipeline etapowy (kr-9p8.21): jeden krok automatycznej digitalizacji na stronach pakietu.

Jedno wejście dla CLI i (później, kr-9p8.19) serwera. Projekt: docs/auto-digitalizacja.md,
„Pipeline etapowy z punktem kontroli”; format: specyfikacje-kronikarza/format-spec.md v1.2,
„Pipeline etapowy: pochodzenie elementów i stan kroków”; reguły: scripts/_steps.py
(port shared/src/steps.ts).

Usage:
  uv run scripts/auto.py --data <DATA_ROOT> --pkg P-R3-2 --page 2-58|all
                         --step gates|wires|next [--force] [--draft] [--dry-run] [--json]

  DATA_ROOT  katalog danych (KRONIKARZ_DATA, np. ./data); pakiet = <DATA_ROOT>/<moduł>/<pkg>/
             package.yaml, strony i skany ze ścieżek w package.yaml
  --step     gates (①, scripts/cv-gates.py), wires (③, scripts/cv-wires.py tryb (a) na
             BIEŻĄCYCH bramkach strony), next (na każdej stronie nextRunnableStep);
             text / labels / nets — jeszcze nie zaimplementowane (exit 3)
  --force    przepuść krok zatwierdzony (wraca do 'auto'; późniejsze 'approved' → 'stale')
  --draft    bez wymogu zatwierdzonego poprzedniego kroku (próby)
  --dry-run  policz i wypisz podsumowanie; nic nie zapisuje (ani strony, ani snapshotu)
  --json     wynik jako JSON na stdout (dla serwera)

Exit: 0 ok; 1 błąd; 2 odmowa (warunki canRun albo ③ ruszyłby nety po kroku ⑤ bez --force);
3 krok niezaimplementowany. Przy kilku stronach wygrywa najpoważniejszy: 1 > 3 > 2 > 0. Strona,
na której `--step next` nie ma nic do zrobienia (wszystkie kroki zatwierdzone), to 0.

Zapis strony:
  1. strona przeczytana jeszcze raz — jeśli zmieniła się od wczytania (viewer, drugi przebieg),
     błąd (exit 1), nie zapisuje nic (także snapshotu); to samo sprawdzenie jeszcze raz tuż
     przed zapisem strony (po snapshocie) — wtedy świeży snapshot jest usuwany. Tekst strony
     i snapshotu musi się wczytać z powrotem jako ten sam dokument, inaczej exit 1 bez zapisu;
     powtórzony klucz mapy w pliku strony (jak w js-yaml) = exit 1;
  2. niezmienny snapshot surowego wyniku narzędzia: <DATA_ROOT>/.auto/<pkg>/<strona>/
     <krok>-<run>.yaml (tworzony wyłącznie, nigdy nie nadpisywany; run = czas UTC
     20261127T153000, wspólny dla wsadu, przy kolizji sufiks -2, -3…; dowiązanie symboliczne
     na ścieżce .auto = odmowa);
  3. strona przez _safe_write.write_all(force=True): kopia <plik>.<ISO>.bak + zapis atomowy;
     dowiązanie symboliczne = odmowa (exit 1). Styl YAML jak w viewerze (scripts/_jsyaml.py):
     sekcje, których treść się nie zmieniła, zostają bajt w bajt.

Reguły scalania (szczegóły w docs, „Uruchomienie” pipeline'u etapowego):
  gates  usuwa bramkę tylko, gdy jej ramka jest 'auto', `note` pusta, a każdy inny aspekt na
         niej (tekst, piny, nety pinów) jest pusty albo 'auto' z kroku, który nie jest
         zatwierdzony ('approved' / 'stale'); resztę zostawia. Wykrytą ramkę o IoU >= 0,5
         z bramką, która zostaje — albo której środek leży w niej / ona w jej środku — odrzuca
         (ramki bez w/h: autoBox viewera, osobno dla każdego wymiaru). Nowa bramka: ref "", gate null, pins [], src: auto
         (bez text_src — tekst to krok ②). Nie rusza niczego poza `gates` i `steps`.
  wires  usuwa odcinki / kropki 'auto' (auto_segments / auto_junctions po wartości) i pola
         auto_*; net, który przez to opustoszał i nic go nie używa, znika. Wykryte odcinki
         przycina do części nie pokrytej przez odcinki, które zostają (<= WIRE_TOL px), resztkę
         krótszą niż WIRE_MIN_PIECE odrzuca (odcinki netu o pustej nazwie się nie liczą —
         viewer ich nie rysuje). Kropkę przy zostającej kropce odrzuca. Każda składowa spójna
         z cv-wires = nowy net NET_AUTO_<n> (wolny numer) z auto_segments / auto_junctions;
         nazwy i piny netów to krok ⑤ — `pin.net`, porty, odsyłacze i nety ludzkie zostają
         nietknięte. Jeśli odcinki 'auto' do usunięcia leżą w necie spoza NET_AUTO_* albo
         w necie, którego używa końcówka (pin / port / odsyłacz / zasilanie) — praca kroku ⑤ —
         odmowa (exit 2) bez --force; z --force przebiega i raportuje te nety.
"""
from __future__ import annotations

import argparse
import importlib.util
import io
import json
import math
import os
import sys
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
_old_dwb, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # bez scripts/__pycache__
import _jsyaml  # noqa: E402
import _safe_write  # noqa: E402
import _steps  # noqa: E402
sys.dont_write_bytecode = _old_dwb

EXIT_OK, EXIT_ERROR, EXIT_REFUSED, EXIT_NOT_IMPLEMENTED = 0, 1, 2, 3
_SEVERITY = {EXIT_ERROR: 3, EXIT_NOT_IMPLEMENTED: 2, EXIT_REFUSED: 1, EXIT_OK: 0}

IMPLEMENTED = ("gates", "wires")
NOT_IMPLEMENTED = ("text", "labels", "nets")

IOU_DROP = 0.5        # wykryta ramka o takim IoU z bramką, która zostaje = odrzucona
WIRE_TOL = 3.0        # px: wykryty odcinek leży na zostającym, gdy w poprzek <= tyle
WIRE_MIN_PIECE = 8.0  # px: krótsza resztka po przycięciu = odrzucona
AUTO_NET_PREFIX = "NET_AUTO_"
_PROTECTED = ("approved", "stale")  # stany kroku, których wyniku 'auto' krok ① nie kasuje


class AutoError(Exception):
    """Błąd przebiegu (exit 1) z komunikatem dla człowieka."""


# --------------------------------------------------------------------------- YAML

def load_yaml(text: str) -> Any:
    """Wczytanie jak w viewerze (js-yaml: YAML 1.2 core + timestamp)."""
    return _jsyaml.load(text)


def dump_yaml(doc: Any) -> str:
    """Zapis bajt w bajt jak serializePage viewera; tekst, który nie wczytuje się z powrotem
    jako `doc`, to błąd (_jsyaml.RoundTripError) — nic nie zapisujemy."""
    return _jsyaml.dump_checked(doc)


def _plain(v: Any) -> Any:
    """Parametry narzędzi → typy YAML (krotki, numpy)."""
    if isinstance(v, dict):
        return {str(k): _plain(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_plain(x) for x in v]
    if hasattr(v, "item") and not isinstance(v, (str, bytes)):
        v = v.item()
    return v


# --------------------------------------------------------------------------- narzędzia CV

_TOOLS: dict[str, Any] = {}


def _tool(name: str):
    """scripts/<name>.py (nazwa z myślnikiem — ładowana z pliku, raz, bez __pycache__)."""
    if name not in _TOOLS:
        spec = importlib.util.spec_from_file_location(name.replace("-", "_"),
                                                      Path(__file__).with_name(f"{name}.py"))
        mod = importlib.util.module_from_spec(spec)
        old, sys.dont_write_bytecode = sys.dont_write_bytecode, True
        try:
            spec.loader.exec_module(mod)
        finally:
            sys.dont_write_bytecode = old
        _TOOLS[name] = mod
    return _TOOLS[name]


def read_gray(scan: Path):
    import cv2
    gray = cv2.imread(str(scan), cv2.IMREAD_GRAYSCALE)
    if gray is None:
        raise AutoError(f"nie mogę wczytać skanu {scan}")
    return gray


def detect_gates(gray) -> dict:
    """Krok ①: cv-gates.py. Zwraca {'entries': [...], 'params': {...}, 'shape': (h, w)}."""
    cvg = _tool("cv-gates")
    res = cvg.detect(gray)
    return {"entries": cvg.to_gate_entries(res), "params": res["params"], "shape": gray.shape,
            "tool": "cv-gates.py"}


def detect_wires(gray, gates: list[dict]) -> dict:
    """Krok ③: cv-wires.py tryb (a) — bieżące bramki strony maskowane (z pinami, jeśli są)."""
    cvw = _tool("cv-wires")
    cg = cvw.clean_gates(gates)
    res = cvw.digitize(gray, cg)
    cvw.assign_pins(cg, res["nets"], res["params"])  # tylko do snapshotu (krok ⑤ ma nety)
    return {"nets": res["nets"], "params": res["params"], "shape": gray.shape, "gates": cg,
            "doc": cvw.to_yaml_doc(res, "", "", cg, gray.shape), "tool": "cv-wires.py"}


# --------------------------------------------------------------------------- geometria

def gate_rect(g: dict) -> tuple[float, float, float, float]:
    """(x0, y0, x1, y1) ramki bramki: środek + w/h; brakujący wymiar z autoBox viewera
    (gateBox: `g.w ?? auto.w`, osobno dla w i h — 0 zostaje 0); 90/270 = zamiana."""
    pins = _steps.list_of(g.get("pins"))
    nl = sum(1 for p in pins if isinstance(p, dict) and p.get("side") == "left")
    nr = sum(1 for p in pins if isinstance(p, dict) and p.get("side") == "right")
    w = float(g["w"]) if _steps._is_num(g.get("w")) else 80.0
    h = float(g["h"]) if _steps._is_num(g.get("h")) else float(max(90, 22 * max(nl, nr, 1) + 20))
    rot = g.get("rotation")
    if _steps._is_num(rot) and rot % 180 == 90:
        w, h = h, w
    x, y = float(g["x"]), float(g["y"])
    return (x - w / 2, y - h / 2, x + w / 2, y + h / 2)


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def _inside(pt, r) -> bool:
    return r[0] <= pt[0] <= r[2] and r[1] <= pt[1] <= r[3]


def duplicate_box(r, rc, k, kc) -> bool:
    """Wykryta ramka `r` (środek `rc`) to ta sama bramka co zostająca `k` (środek `kc`):
    IoU >= IOU_DROP albo środek jednej leży w drugiej. Sam IoU nie wystarcza dla ramek
    ludzkich bez w/h — autoBox viewera (80 × 90+) bywa dużo mniejszy od narysowanej ramki."""
    return iou(r, k) >= IOU_DROP or _inside(rc, k) or _inside(kc, r)


def _has_box(g: dict) -> bool:
    return isinstance(g, dict) and _steps._is_num(g.get("x")) and _steps._is_num(g.get("y"))


def _orient(s) -> str | None:
    x0, y0, x1, y1 = s
    if abs(y1 - y0) <= WIRE_TOL and abs(x1 - x0) > abs(y1 - y0):
        return "h"
    if abs(x1 - x0) <= WIRE_TOL and abs(y1 - y0) > abs(x1 - x0):
        return "v"
    return None


def clip_segment(seg, keep_segs) -> list[list[int]]:
    """Części odcinka H/V, których nie pokrywa żaden zostający odcinek (równoległy, w poprzek
    <= WIRE_TOL). Resztki < WIRE_MIN_PIECE odrzucone. Odcinek ukośny: cały albo nic (nic, gdy
    oba końce leżą na zostających odcinkach)."""
    o = _orient(seg)
    x0, y0, x1, y1 = (float(v) for v in seg)
    if o is None:
        covered = any(_dist_pt_seg((x0, y0), k) <= WIRE_TOL and _dist_pt_seg((x1, y1), k) <= WIRE_TOL
                      for k in keep_segs)
        return [] if covered else [[int(round(v)) for v in seg]]
    a0, a1 = (x0, x1) if o == "h" else (y0, y1)
    flip = a0 > a1
    lo, hi = min(a0, a1), max(a0, a1)
    c = (y0 + y1) / 2 if o == "h" else (x0 + x1) / 2
    cuts = []
    for k in keep_segs:
        if _orient(k) != o:
            continue
        kx0, ky0, kx1, ky1 = (float(v) for v in k)
        kc0, kc1 = (ky0, ky1) if o == "h" else (kx0, kx1)
        if abs(kc0 - c) > WIRE_TOL or abs(kc1 - c) > WIRE_TOL:
            continue
        ka, kb = (kx0, kx1) if o == "h" else (ky0, ky1)
        ka, kb = min(ka, kb), max(ka, kb)
        if kb > lo and ka < hi:
            cuts.append((max(ka, lo), min(kb, hi)))
    if not cuts:
        return [[int(round(v)) for v in seg]]
    cuts.sort()
    free, cur = [], lo
    for ca, cb in cuts:
        if ca > cur:
            free.append((cur, ca))
        cur = max(cur, cb)
    if cur < hi:
        free.append((cur, hi))
    out = []
    for fa, fb in free:
        if fb - fa < WIRE_MIN_PIECE:
            continue
        if flip:
            fa, fb = fb, fa
        a, b = int(round(fa)), int(round(fb))
        ci = int(round(c))
        out.append([a, ci, b, ci] if o == "h" else [ci, a, ci, b])
    return out


def _dist_pt_seg(p, s) -> float:
    x, y = p
    x0, y0, x1, y1 = (float(v) for v in s)
    dx, dy = x1 - x0, y1 - y0
    L2 = dx * dx + dy * dy
    t = 0.0 if L2 == 0 else max(0.0, min(1.0, ((x - x0) * dx + (y - y0) * dy) / L2))
    return math.hypot(x - (x0 + t * dx), y - (y0 + t * dy))


# --------------------------------------------------------------------------- scalanie

def _aspect_replaceable(page: dict, kind: str, el: dict, field: str, step: str) -> bool:
    """Aspekt innego kroku na usuwanej bramce: pusty albo 'auto' z niezatwierdzonego kroku."""
    if _steps.aspect_empty(kind, el, field):
        return True
    return _steps.element_src(el, field) == "auto" and _steps.step_status(page, step) not in _PROTECTED


def gate_removable(page: dict, g: Any) -> bool:
    """Bramka, którą krok ① zastępuje: ramka 'auto', note pusta, a tekst, piny i nety pinów
    puste albo 'auto' z kroku, który nie jest zatwierdzony."""
    if not isinstance(g, dict) or _steps.element_src(g, "src") != "auto":
        return False
    if not _steps._blank(g.get("note")):
        return False
    if _steps.aspect_empty("gate", g, "text_src"):
        return True
    if not _aspect_replaceable(page, "gate", {k: v for k, v in g.items() if k != "pins"},
                               "text_src", "text"):
        return False
    for p in _steps.list_of(g.get("pins")):
        if not isinstance(p, dict):
            return False
        if not _aspect_replaceable(page, "pin", p, "src", "text"):
            return False
        if not _aspect_replaceable(page, "pin", p, "net_src", "nets"):
            return False
    return True


def new_gate(entry: dict) -> dict:
    """Bramka z kroku ①: sama ramka (tekst pusty — krok ②)."""
    return {"ref": "", "gate": None, "x": entry["x"], "y": entry["y"], "w": entry["w"],
            "h": entry["h"], "rotation": entry.get("rotation") or 0, "pins": [],
            "verified": False, "note": None, "src": "auto"}


def merge_gates(page: dict, entries: list[dict]) -> tuple[list, dict]:
    """Nowa lista `gates` strony + liczniki. Nie mutuje `page`."""
    old = _steps.list_of(page.get("gates"))
    kept, removed = [], 0
    for g in old:
        if gate_removable(page, g):
            removed += 1
        else:
            kept.append(g)
    kept_boxes = [(gate_rect(g), (float(g["x"]), float(g["y"]))) for g in kept if _has_box(g)]
    added, dropped = [], 0
    for e in entries:
        r = (e["x"] - e["w"] / 2, e["y"] - e["h"] / 2, e["x"] + e["w"] / 2, e["y"] + e["h"] / 2)
        if any(duplicate_box(r, (e["x"], e["y"]), k, kc) for k, kc in kept_boxes):
            dropped += 1
            continue
        added.append(new_gate(e))
    kept_human = sum(1 for g in kept if _steps.element_src(g, "src") != "auto")
    counts = {"detected": len(entries), "removed_auto": removed, "added_auto": len(added),
              "kept": len(kept), "kept_human": kept_human, "kept_auto": len(kept) - kept_human,
              "dropped_overlap": dropped}
    return kept + added, counts


def _endpoint_nets(page: dict) -> set[str]:
    used = set()
    for g in _steps.list_of(page.get("gates")):
        for p in _steps.list_of(g.get("pins") if isinstance(g, dict) else None):
            if isinstance(p, dict) and isinstance(p.get("net"), str):
                used.add(p["net"])
    for key in ("ports", "cross_refs", "power"):
        for e in _steps.list_of(page.get(key)):
            if isinstance(e, dict) and isinstance(e.get("net"), str):
                used.add(e["net"])
    return used


def merge_wires(page: dict, cv_nets: list[dict]) -> tuple[dict, dict]:
    """Nowa mapa `nets` strony + liczniki. Nie mutuje `page`."""
    import copy
    nets_in = page.get("nets")
    nets: dict = copy.deepcopy(nets_in) if isinstance(nets_in, dict) else {}
    used = _endpoint_nets(page)
    rm_s = rm_j = rm_n = 0
    protected: dict[str, int] = {}
    for name in list(nets):
        n = nets[name]
        if not isinstance(n, dict):
            continue
        had_auto = "auto_segments" in n or "auto_junctions" in n
        sm, jm = _steps.auto_segment_mask(n), _steps.auto_junction_mask(n)
        if (any(sm) or any(jm)) and (not str(name).startswith(AUTO_NET_PREFIX) or name in used):
            protected[str(name)] = sum(sm) + sum(jm)  # nazwany / z końcówkami = krok ⑤
        if any(sm):
            n["segments"] = [s for s, a in zip(n["segments"], sm) if not a]
            rm_s += sum(sm)
        if any(jm):
            n["junctions"] = [j for j, a in zip(n["junctions"], jm) if not a] or None
            rm_j += sum(jm)
        n.pop("auto_segments", None)
        n.pop("auto_junctions", None)
        if (had_auto and not _steps.list_of(n.get("segments")) and not _steps.list_of(n.get("junctions"))
                and name not in used and not n.get("cross") and not _steps.list_of(n.get("pins"))):
            del nets[name]
            rm_n += 1
    # net o pustej nazwie: viewer go nie rysuje (śmieci) — nie przycina wykrytych drutów
    keep_segs = [s for name, n in nets.items() if isinstance(n, dict) and str(name).strip()
                 for s in _steps.list_of(n.get("segments")) if _steps.is_segment(s)]
    keep_juncs = [j for n in nets.values() if isinstance(n, dict)
                  for j in _steps.list_of(n.get("junctions")) if _steps.is_junction(j)]
    add_s = add_j = add_n = dropped = clipped = 0
    k = 1
    for cn in cv_nets:
        segs = []
        for p in cn["pieces"]:
            parts = clip_segment(p, keep_segs)
            if not parts:
                dropped += 1
            elif len(parts) != 1 or [int(v) for v in p] != parts[0]:
                clipped += 1
            segs += parts
        if not segs:
            continue
        ends = {(s[0], s[1]) for s in segs} | {(s[2], s[3]) for s in segs}
        juncs = []
        for jx, jy in cn["junctions"]:
            j = [int(jx), int(jy)]
            if any(math.hypot(j[0] - q[0], j[1] - q[1]) <= WIRE_TOL for q in keep_juncs):
                continue
            if (j[0], j[1]) in ends or any(_dist_pt_seg(j, s) <= 0.5 for s in segs):
                juncs.append(j)
        while f"{AUTO_NET_PREFIX}{k}" in nets:
            k += 1
        nets[f"{AUTO_NET_PREFIX}{k}"] = {
            "pins": [], "segments": segs, "junctions": juncs or None,
            "auto_segments": [list(s) for s in segs],
            **({"auto_junctions": [list(j) for j in juncs]} if juncs else {}),
        }
        add_s += len(segs)
        add_j += len(juncs)
        add_n += 1
    counts = {"detected_segments": sum(len(n["pieces"]) for n in cv_nets),
              "detected_nets": len(cv_nets),
              "removed_auto_segments": rm_s, "removed_auto_junctions": rm_j, "removed_nets": rm_n,
              "kept_segments": len(keep_segs), "kept_junctions": len(keep_juncs),
              "added_auto_segments": add_s, "added_auto_junctions": add_j, "added_nets": add_n,
              "dropped_overlap": dropped, "clipped_overlap": clipped,
              "step5_nets": protected}
    return nets, counts


def set_step(page: dict, step: str, run: str, at: str, *, forced_approved: bool,
             changed: bool, label_ends_changed: bool = True) -> list[str]:
    """steps[step] = {status: auto, run, at}; gdy krok był zatwierdzony (--force) albo
    zmieniła się jego treść, zatwierdzone kroki z `_steps.stale_targets` → 'stale' (zwykle
    każdy późniejszy; wires: nets, a labels tylko gdy `label_ends_changed` — wolne końce
    przy portach / odsyłaczach / zasilaniu). Zwraca kroki oznaczone 'stale'."""
    if not isinstance(page.get("steps"), dict):
        # brak (albo zła wartość — i tak znaczy 'todo') — sekcja zaraz po scan_size
        items = [(k, v) for k, v in page.items() if k != "steps"]
        page.clear()
        placed = False
        for kk, v in items:
            page[kk] = v
            if kk == "scan_size":
                page["steps"], placed = {}, True
        if not placed:
            page["steps"] = {}
    targets = _steps.stale_targets(step, label_ends_changed)
    stale = _steps.mark_stale(page, targets, at) if (forced_approved or changed) else []
    page["steps"][step] = {"status": "auto", "run": run, "at": at}
    return stale


# --------------------------------------------------------------------------- dane

def find_package(data: Path, pkg: str) -> Path:
    """<DATA_ROOT>/<moduł>/<pkg>/package.yaml, gdzie <moduł> ma project.yaml (data/gold ma
    zamrożone package.yaml i nie jest modułem)."""
    hits = [p for p in sorted(data.glob(f"*/{pkg}/package.yaml"))
            if (p.parent.parent / "project.yaml").is_file()]
    if not hits:
        raise AutoError(f"nie ma pakietu {pkg} w {data} (szukam <moduł>/{pkg}/package.yaml "
                        "obok <moduł>/project.yaml)")
    if len(hits) > 1:
        raise AutoError(f"pakiet {pkg} jest w kilku miejscach: " + ", ".join(map(str, hits)))
    return hits[0]


def package_pages(pkg_yaml: Path) -> list[dict]:
    doc = load_yaml(pkg_yaml.read_text(encoding="utf-8"))
    pages = ((doc or {}).get("package") or {}).get("pages") if isinstance(doc, dict) else None
    if not isinstance(pages, list):
        raise AutoError(f"{pkg_yaml}: brak package.pages")
    return [p for p in pages if isinstance(p, dict) and p.get("id") is not None]


def utc_now() -> datetime:
    return datetime.now(timezone.utc).replace(microsecond=0)


def run_id(now: datetime) -> str:
    return now.strftime("%Y%m%dT%H%M%S")


def snapshot_path(data: Path, pkg: str, page: str, step: str, run: str) -> Path:
    return data / ".auto" / pkg / page / f"{step}-{run}.yaml"


def write_snapshot(path: Path, text: str, data: Path | None = None) -> None:
    """Tworzy plik wyłącznie (O_EXCL) — istniejący snapshot nigdy nie jest nadpisany.
    Dowiązanie symboliczne na ścieżce poniżej `data` (.auto, pakiet, strona, plik) = odmowa."""
    base = data if data is not None else path.parent
    rel = path.relative_to(base) if data is not None else Path(path.name)
    cur = base
    for part in rel.parts:
        cur = cur / part
        if cur.is_symlink():
            raise AutoError(f"dowiązanie symboliczne na ścieżce snapshotu (nie zapisuję): {cur}")
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.is_symlink():
        raise AutoError(f"snapshot jest dowiązaniem symbolicznym: {path}")
    try:
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
    except FileExistsError:
        raise AutoError(f"snapshot już istnieje (nie nadpisuję): {path}") from None
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write(text)
            f.flush()
            os.fsync(f.fileno())
    except BaseException:
        path.unlink(missing_ok=True)  # nie zostawiamy uciętego snapshotu
        raise


# --------------------------------------------------------------------------- przebieg strony

def snapshot_doc(page: dict, step: str, run: str, at: str, det: dict, scan: Path) -> dict:
    h, w = det["shape"][:2]
    head = {"kronikarz": "1", "page": page.get("page"), "package": page.get("package"),
            "scan_size": [int(w), int(h)],
            "auto_run": {"step": step, "run": run, "at": at, "tool": det["tool"],
                         "scan": scan.name, "params": _plain(det["params"])}}
    if step == "gates":
        body = {"gates": _plain(det["entries"]), "power": [], "ports": [], "cross_refs": [],
                "nets": {}}
    else:
        doc = det["doc"]
        nets = {}
        for n, (name, d) in zip(det["nets"], doc["nets"].items()):
            nets[name] = {**d, "cv_free": [[int(x), int(y)] for x, y in n["free"]]}
        body = {"gates": _plain(doc["gates"]), "power": [], "ports": [], "cross_refs": [],
                "nets": _plain(nets)}
    return {**head, **body, "annotations": [], "decorations": []}


def run_page(ctx: dict, entry: dict, step_arg: str) -> dict:
    """Jeden krok na jednej stronie. Zwraca raport strony (status, liczniki, kod wyjścia)."""
    t0 = time.perf_counter()
    pid = str(entry["id"])
    rep: dict[str, Any] = {"page": pid, "step": step_arg, "status": "error", "exit": EXIT_ERROR}
    try:
        pkg_dir: Path = ctx["pkg_dir"]
        page_path = pkg_dir / str(entry.get("file") or f"pages/{pid}.sch.yaml")
        scan = pkg_dir / str(entry.get("scan") or f"scans/{pid}.jpg")
        rep["file"] = str(page_path)
        if not page_path.is_file():
            raise AutoError(f"brak pliku strony {page_path}")
        orig_bytes = page_path.read_bytes()
        orig_text = orig_bytes.decode("utf-8")
        page = load_yaml(orig_text)
        if not isinstance(page, dict) or page.get("kronikarz") != "1":
            raise AutoError(f"{page_path}: to nie jest strona kronikarza (kronikarz: \"1\")")
        if page_path.is_symlink():  # _safe_write i tak odmówi — przed snapshotem i detekcją
            raise AutoError(f"strona jest dowiązaniem symbolicznym (nie zapisuję przez nie): {page_path}")
        step = step_arg
        if step_arg == "next":
            step = _steps.next_runnable_step(page)
            if step is None:
                rep.update(step=None, status="nothing", exit=EXIT_OK,
                           reason="wszystkie kroki zatwierdzone")
                return rep
            rep["step"] = step
        if step in NOT_IMPLEMENTED:
            rep.update(status="not_implemented", exit=EXIT_NOT_IMPLEMENTED,
                       reason=f"krok {step} nie jest jeszcze zaimplementowany")
            return rep
        ok, why = _steps.can_run(page, step, force=ctx["force"], draft=ctx["draft"])
        if not ok:
            rep.update(status="refused", exit=EXIT_REFUSED, reason=why)
            return rep
        if not scan.is_file():
            raise AutoError(f"brak skanu {scan}")
        gray = read_gray(scan)
        at = ctx["at"]
        run = ctx["run"]
        before = _steps.step_fingerprint(page, step)
        ends_before = _steps.label_anchor_ends(page)
        was_approved = _steps.step_status(page, step) == "approved"
        if step == "gates":
            det = detect_gates(gray)
            gates, counts = merge_gates(page, det["entries"])
            page["gates"] = gates
        else:
            det = detect_wires(gray, [g for g in _steps.list_of(page.get("gates"))
                                      if isinstance(g, dict) and _has_box(g)])
            nets, counts = merge_wires(page, det["nets"])
            if counts["step5_nets"] and not ctx["force"]:
                prot = counts["step5_nets"]
                rep.update(status="refused", exit=EXIT_REFUSED, counts=counts, reason=(
                    f"ponowny krok wires usunąłby {sum(prot.values())} odcinków/kropek auto "
                    f"z {len(prot)} netów po kroku ⑤ (nazwanych albo z końcówkami): "
                    + ", ".join(sorted(prot)[:10]) + (" …" if len(prot) > 10 else "")
                    + " — popraw je w viewerze albo użyj --force"))
                return rep
            page["nets"] = nets
        changed = _steps.step_fingerprint(page, step) != before
        ends_changed = _steps.ends_changed(ends_before, _steps.label_anchor_ends(page))
        stale = set_step(page, step, run, at, forced_approved=was_approved, changed=changed,
                         label_ends_changed=ends_changed)
        snap = snapshot_path(ctx["data"], ctx["pkg"], pid, step, run)
        rep.update(counts=counts, run=run, stale=stale, changed=changed, snapshot=str(snap))
        new_text = _jsyaml.splice(orig_text, page)  # sprawdzony: wczytuje się jako `page`
        snap_text = dump_yaml(snapshot_doc(page, step, run, at, det, scan))
        if ctx["dry_run"]:
            rep.update(status="dry_run", exit=EXIT_OK, written=False)
            return rep
        changed_msg = (f"strona zmieniła się w trakcie przebiegu (viewer? drugi przebieg?) — "
                       f"nic nie zapisano, uruchom krok jeszcze raz: {page_path}")
        if page_path.read_bytes() != orig_bytes:
            raise AutoError(changed_msg)
        write_snapshot(snap, snap_text, ctx["data"])
        # ostatnie sprawdzenie tuż przed zapisem strony; snapshot bez strony = usunięty
        if page_path.read_bytes() != orig_bytes:
            snap.unlink(missing_ok=True)
            raise AutoError(changed_msg)
        out, err = io.StringIO(), io.StringIO()
        code = _safe_write.write_all({page_path: new_text}, force=True, out=out, err=err)
        rep["backup"] = [ln[len("kopia: "):] for ln in out.getvalue().splitlines()
                         if ln.startswith("kopia: ")]
        if code != 0:
            snap.unlink(missing_ok=True)
            raise AutoError("zapis strony nie powiódł się (snapshot usunięty): "
                            + err.getvalue().strip())
        rep.update(status="ok", exit=EXIT_OK, written=True)
        return rep
    except AutoError as e:
        rep.update(status="error", exit=EXIT_ERROR, reason=str(e))
        return rep
    except Exception as e:  # noqa: BLE001 — raport strony zamiast tracebacku całego wsadu
        rep.update(status="error", exit=EXIT_ERROR, reason=f"{type(e).__name__}: {e}")
        return rep
    finally:
        rep["time_s"] = round(time.perf_counter() - t0, 2)


def choose_run(data: Path, pkg: str, pages: list[str], now: datetime) -> str:
    """Run id wspólny dla wsadu (czas UTC); sufiks -2, -3…, gdy któryś snapshot już jest."""
    base, n = run_id(now), 1
    run = base
    while any(snapshot_path(data, pkg, p, st, run).exists() or
              snapshot_path(data, pkg, p, st, run).is_symlink()
              for p in pages for st in IMPLEMENTED):
        n += 1
        run = f"{base}-{n}"
    return run


def format_page(pkg: str, r: dict) -> str:
    head = f"{pkg} {r['page']}"
    if r["status"] in ("ok", "dry_run"):
        c = r["counts"]
        if r["step"] == "gates":
            body = (f"gates: wykryte {c['detected']}, usunięte auto {c['removed_auto']}, "
                    f"dodane auto {c['added_auto']}, zostawione {c['kept']} (ludzkie "
                    f"{c['kept_human']}, auto chronione {c['kept_auto']}), odrzucone (na "
                    f"zostających) {c['dropped_overlap']}")
        else:
            body = (f"wires: wykryte {c['detected_segments']} odc. w {c['detected_nets']} sk.; "
                    f"usunięte auto {c['removed_auto_segments']} odc. / "
                    f"{c['removed_auto_junctions']} kropek / {c['removed_nets']} netów; "
                    f"dodane auto {c['added_auto_segments']} odc. / {c['added_auto_junctions']} "
                    f"kropek / {c['added_nets']} netów; zostawione {c['kept_segments']} odc. / "
                    f"{c['kept_junctions']} kropek; na zostających: odrzucone "
                    f"{c['dropped_overlap']}, przycięte {c['clipped_overlap']}")
            if c.get("step5_nets"):
                body += ("; --force: usunięte auto z netów po kroku ⑤: "
                         + ", ".join(sorted(c["step5_nets"])))
        tail = f"; {r['time_s']:.2f} s; run {r['run']}"
        if r.get("stale"):
            tail += f"; stale: {', '.join(r['stale'])}"
        if r["status"] == "dry_run":
            tail += " (dry-run: nic nie zapisano)"
        return f"{head} {body}{tail}"
    label = {"refused": "ODMOWA", "not_implemented": "NIEZAIMPLEMENTOWANE", "error": "BŁĄD",
             "nothing": "nic do zrobienia"}[r["status"]]
    step = f" {r['step']}" if r.get("step") else ""
    return f"{head}{step}: {label} — {r.get('reason', '')}"


class _Parser(argparse.ArgumentParser):
    def error(self, message):  # exit 2 jest zajęty przez odmowę (canRun)
        self.print_usage(sys.stderr)
        self.exit(EXIT_ERROR, f"{self.prog}: błąd: {message}\n")


def main(argv=None) -> int:
    ap = _Parser(prog="auto.py", description=__doc__.split("\n")[0])
    ap.add_argument("--data", required=True, help="katalog danych (KRONIKARZ_DATA)")
    ap.add_argument("--pkg", required=True)
    ap.add_argument("--page", required=True, help="id strony z package.yaml albo 'all'")
    ap.add_argument("--step", required=True, choices=("next",) + _steps.STEP_ORDER)
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--draft", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--json", action="store_true")
    a = ap.parse_args(argv)
    if a.step == "next" and a.force:
        ap.error("--force z --step next jest niejednoznaczne — podaj krok")

    def emit(res: dict) -> int:
        if a.json:
            print(json.dumps(res, ensure_ascii=False, indent=1))
        else:
            for r in res["pages"]:
                print(format_page(a.pkg, r), file=sys.stdout if r["exit"] == 0 else sys.stderr)
            if res.get("reason"):
                print(res["reason"], file=sys.stderr)
        return res["exit"]

    res: dict[str, Any] = {"package": a.pkg, "page": a.page, "step": a.step, "force": a.force,
                           "draft": a.draft, "dry_run": a.dry_run, "pages": []}
    if a.step in NOT_IMPLEMENTED:
        res.update(exit=EXIT_NOT_IMPLEMENTED,
                   reason=f"krok {a.step} nie jest jeszcze zaimplementowany "
                          f"(są: {', '.join(IMPLEMENTED)})")
        return emit(res)
    try:
        data = Path(a.data)
        if not data.is_dir():
            raise AutoError(f"nie ma katalogu danych {data}")
        pkg_yaml = find_package(data, a.pkg)
        entries = package_pages(pkg_yaml)
        if a.page != "all":
            entries = [e for e in entries if str(e["id"]) == a.page]
            if not entries:
                raise AutoError(f"strony {a.page} nie ma w {pkg_yaml}")
    except AutoError as e:
        res.update(exit=EXIT_ERROR, reason=f"błąd: {e}")
        return emit(res)
    now = utc_now()
    ctx = {"data": data, "pkg": a.pkg, "pkg_dir": pkg_yaml.parent, "force": a.force,
           "draft": a.draft, "dry_run": a.dry_run, "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
           "run": choose_run(data, a.pkg, [str(e["id"]) for e in entries], now)}
    for e in entries:
        res["pages"].append(run_page(ctx, e, a.step))
    res["exit"] = max((r["exit"] for r in res["pages"]), key=_SEVERITY.__getitem__,
                      default=EXIT_OK)
    return emit(res)


if __name__ == "__main__":
    sys.exit(main())
