# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml", "numpy", "scipy"]
# ///
"""Ocena zdigitalizowanych stron (`*.sch.yaml`) względem zamrożonego zestawu wzorcowego.

Porównuje kandydata (wynik pipeline'u CV/VLM) z wzorcem (data/gold/, zob. manifest.yaml)
i wypisuje metryki per strona oraz sumarycznie (micro-average: liczniki sumowane po
stronach, dopiero potem ilorazy).

Usage:
  uv run scripts/eval-digitize.py --gold data/gold --candidate <dir> [--json out.json]
                                  [--allow-modified]

<dir> w układzie wzorca (<pakiet>/<strona>.sch.yaml) albo danych (<pakiet>/pages/<strona>.sch.yaml),
więc `--candidate data/MJC-400` też działa. Brak strony = strona pusta (metryki 0 tam, gdzie
wzorzec coś zawiera); brak JAKIEJKOLWIEK strony = błąd (exit 2).
Integralność wzorca (sprawdzana PRZED oceną): brak pliku z manifestu = exit 3; w trybie
manifestu każdy plik musi mieć sha256 — brak sha256 albo niezgodność = exit 3, chyba że
--allow-modified.

Endpointy: piny REF.GATE.NUM (REF.NUM bez litery), porty PORT:<conn><pin>, cross_refy XREF:<label>.
Bramki kandydata dopasowane do wzorca dają swoim pinom (po `num`) tożsamość z WZORCA; porty
i cross_refy dopasowane pozycyjnie też. Endpoint kandydata bez odpowiednika (piny bramek spoza
dopasowania, nadmiarowe / powtórzone numery pinów, porty, cross_refy) ma własną tożsamość.
Net endpointu to pole `.net` (pusta nazwa albo `disconnected` = singleton); nazwy netów nie
muszą się zgadzać. `net.pins[]` jest ignorowane (legacy).

Metryki (położenia w pikselach skanu):
  ep          LICZBA NAGŁÓWKOWA (scope=full). Dla każdego endpointu wzorca: zbiór pozostałych
              endpointów jego netu we wzorcu vs u kandydata (tożsamości wzorca; endpointy
              kandydata bez odpowiednika to błędni członkowie). ep_acc = odsetek endpointów
              z identycznym zbiorem („pin w pełni poprawnie połączony”; singleton poprawny, gdy
              singleton u kandydata; endpoint nieodnaleziony = błędny). ep_jacc = średni Jaccard
              tych zbiorów (oba puste = 1).
  pary        (scope=full) dla każdej nieuporządkowanej pary endpointów z sumy obu zbiorów:
              „ten sam net?”. P/R/F1 klasy pozytywnej. Uwaga: waży nety kwadratem rozmiaru,
              dlatego nagłówkiem jest ep_acc. pF1cond: to samo tylko na endpointach dopasowanych.
  bramki      dopasowanie 1:1 (Hungarian) przy IoU >= 0.5. Brak w/h -> domyślny rozmiar viewera
              (viewer/src/layers/box.ts autoBox: w=80, h=max(90, 22*max(piny_lewe, piny_prawe, 1)+20));
              dla rotation 90/270 w/h zamienione. P/R/F1 + dokładność ref i litery wśród dopasowanych.
  piny        w dopasowanych bramkach po `num`: recall, precision, mediana błędu położenia (px).
  druty       (scope=full) geometria znormalizowana per net (nazwy netów strip, jak `net_of`):
              nakładające się/stykające współliniowe odcinki (H, V, ukośne) scalone, przerwa
              zostaje przerwą; próbki co 5 px, deduplikowane po komórkach siatki 1 px (per net),
              więc powtórzone / nakładające się odcinki liczą się raz. Nety kandydata mapowane
              1:1 na nety wzorca (Hungarian): ściśle najpierw liczba wspólnych endpointów, potem
              (rozstrzygająco, i dla netów bez endpointów) symetryczna geometria — próbki
              kandydata, których najbliższy odcinek wzorca (<= 3 px) należy do danego netu, plus
              próbki wzorca, których najbliższy odcinek kandydata należy do danego netu.
              wire_P: próbka kandydata poprawna, gdy <= 3 px od odcinka ZMAPOWANEGO netu wzorca;
              wire_R: próbka wzorca pokryta, gdy <= 3 px od odcinka netu kandydata zmapowanego
              na jej net. wF1geom (diagnostyka): to samo bez netów (dowolny odcinek).
              Odcinki netów o pustej nazwie są pomijane (viewer ich nie rysuje).
  junctions   (scope=full) zapisane `junctions` ∪ kropki wyliczone regułą viewera (NetLayer.tsx,
              auto-junctions): punkt, w którym spotykają się >= 3 końce odcinków TEGO SAMEGO
              netu, przy DOKŁADNIE tych samych współrzędnych (bez zaokrąglania, jak w viewerze);
              jedyna różnica: identyczne (też odwrócone) odcinki liczą się raz.
              T-złącze z końcem odcinka w środku innego odcinka NIE dostaje kropki — kandydat
              musi podzielić odcinek albo zapisać junction. Celowo pomijamy gwiazdę zastępczą
              (przerywane linie do środka ciężkości), którą viewer rysuje dla netów z
              `segments: null` — to nie jest geometria. P/R przy tolerancji 5 px.
  porty       dopasowanie pozycyjne <= 20 px; P/R/F1, dokładność etykiety i connector+pin.
  cross_refy  dopasowanie pozycyjne <= 20 px; P/R/F1, dokładność etykiety i zbioru `pages`.

`-` w tabeli = nieokreślone (nic do znalezienia i nic nie zgłoszono; dokładność przy zerze
dopasowań).
"""
from __future__ import annotations

import argparse
import hashlib
import json
import math
import statistics
import sys
from collections import Counter, defaultdict
from pathlib import Path

import numpy as np
import yaml
from scipy.optimize import linear_sum_assignment

GATE_IOU_MIN = 0.5
GATE_W = 80  # = viewer/src/layers/box.ts
GATE_H_PER_PIN = 22
GATE_MIN_H = 90
WIRE_STEP = 5.0
WIRE_TOL = 3.0
JUNCTION_TOL = 5.0
PORT_TOL = 20.0
XREF_TOL = 20.0

SCOPE_FULL = "full"
SCOPE_GATES = "gates_only"

_BIG = 1e6  # koszt pary niedopuszczalnej; > suma wszystkich kosztów dopuszczalnych
_CHUNK_ELEMS = 262_144  # punkty x odcinki na jeden blok obliczeń odległości (pamięć)
_SAMPLE_CHUNK = 262_144  # próbek na blok przy próbkowaniu odcinków


# --- wczytywanie i integralność ------------------------------------------------------------


def load_yaml(path: Path):
    with open(path, encoding="utf-8") as f:
        # libyaml (CSafeLoader), gdy dostępny: duzi kandydaci ładują się szybciej i chudziej
        return yaml.load(f, Loader=getattr(yaml, "CSafeLoader", yaml.SafeLoader))


def empty_page(package: str = "", page: str = "") -> dict:
    return {"kronikarz": "1", "page": page, "package": package, "gates": [], "ports": [],
            "cross_refs": [], "nets": {}, "power": [], "annotations": []}


def sha256_file(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load_manifest(gold_dir: Path) -> tuple[list[dict], list[dict] | None]:
    """(strony, pliki do sprawdzenia). Bez manifestu: skan katalogu, pliki = None."""
    mf = gold_dir / "manifest.yaml"
    if mf.exists():
        data = load_yaml(mf) or {}
        pages, files = [], []
        for e in data.get("pages") or []:
            f = e.get("file") or f"{e['package']}/{e['page']}.sch.yaml"
            pages.append({"package": str(e["package"]), "page": str(e["page"]), "file": f,
                          "scope": e.get("scope") or SCOPE_FULL})
            files.append({"file": f, "sha256": e.get("sha256")})
        for pkg, e in (data.get("packages") or {}).items():
            files.append({"file": (e or {}).get("file") or f"{pkg}/package.yaml",
                          "sha256": (e or {}).get("sha256")})
        return pages, files
    pages = [{"package": p.parent.name, "page": p.name[: -len(".sch.yaml")],
              "file": str(p.relative_to(gold_dir)), "scope": SCOPE_FULL}
             for p in sorted(gold_dir.glob("*/*.sch.yaml"))]
    return pages, None


def check_integrity(gold_dir: Path, files: list[dict] | None) -> dict:
    """{'fatal': [...], 'modified': [...]}: fatal = brak pliku; modified = brak/niezgodne sha256."""
    fatal, modified = [], []
    for f in files or []:
        path = gold_dir / f["file"]
        if not path.exists():
            fatal.append(f"brak pliku wzorca {f['file']}")
        elif not f.get("sha256"):
            modified.append(f"wpis {f['file']} w manifeście nie ma sha256")
        elif sha256_file(path) != f["sha256"]:
            modified.append(f"wzorzec {f['file']} różni się od sha256 w manifeście (edytowany?)")
    return {"fatal": fatal, "modified": modified}


def find_candidate(cand_dir: Path, pkg: str, page: str) -> Path | None:
    for p in (cand_dir / pkg / f"{page}.sch.yaml", cand_dir / pkg / "pages" / f"{page}.sch.yaml"):
        if p.exists():
            return p
    return None


# --- pomocnicze ----------------------------------------------------------------------------


def norm_str(v) -> str | None:
    if v is None:
        return None
    s = str(v).strip()
    return s or None


def net_of(obj: dict) -> str | None:
    if obj.get("disconnected"):
        return None
    return norm_str(obj.get("net"))


def num(v, default=0.0) -> float:
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def auto_box(g: dict) -> tuple[float, float]:
    """Domyślny rozmiar bramki — kopia autoBox z viewer/src/layers/box.ts."""
    pins = g.get("pins") or []
    left = sum(1 for p in pins if p.get("side") == "left")
    right = sum(1 for p in pins if p.get("side") == "right")
    return float(GATE_W), float(max(GATE_MIN_H, max(left, right, 1) * GATE_H_PER_PIN + 20))


def gate_box(g: dict) -> tuple[float, float, float, float]:
    """Prostokąt bramki w układzie skanu. w/h są w układzie lokalnym (Konva Group
    obracany o rotation), więc dla 90/270 zamieniamy je miejscami."""
    aw, ah = auto_box(g)
    w = float(g.get("w") or aw)
    h = float(g.get("h") or ah)
    if int(num(g.get("rotation"))) % 180 == 90:
        w, h = h, w
    x, y = num(g.get("x")), num(g.get("y"))
    return (x - w / 2, y - h / 2, x + w / 2, y + h / 2)


def iou(a, b) -> float:
    ix = max(0.0, min(a[2], b[2]) - max(a[0], b[0]))
    iy = max(0.0, min(a[3], b[3]) - max(a[1], b[1]))
    inter = ix * iy
    if inter <= 0:
        return 0.0
    ua = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / ua if ua > 0 else 0.0


def assign(cost: np.ndarray) -> list[tuple[int, int]]:
    """Hungarian; zwraca tylko pary o koszcie dopuszczalnym (< _BIG)."""
    if cost.size == 0:
        return []
    rows, cols = linear_sum_assignment(cost)
    return [(int(r), int(c)) for r, c in zip(rows, cols) if cost[r, c] < _BIG]


def match_gates(gold: list[dict], cand: list[dict]) -> list[tuple[int, int]]:
    cost = np.full((len(gold), len(cand)), _BIG)
    cboxes = [gate_box(c) for c in cand]
    for i, g in enumerate(gold):
        gb = gate_box(g)
        for j, cb in enumerate(cboxes):
            v = iou(gb, cb)
            if v >= GATE_IOU_MIN:
                cost[i, j] = 1.0 - v
    return assign(cost)


def match_points(gold: list[tuple[float, float]], cand: list[tuple[float, float]], tol: float):
    if not gold or not cand:
        return []
    g = np.asarray(gold, dtype=float)
    c = np.asarray(cand, dtype=float)
    d = np.hypot(g[:, None, 0] - c[None, :, 0], g[:, None, 1] - c[None, :, 1])
    cost = np.where(d <= tol, d / max(tol, 1e-9), _BIG)
    return assign(cost)


def pin_id(gate: dict, pnum) -> str:
    letter = norm_str(gate.get("gate"))
    ref = str(gate.get("ref"))
    return f"{ref}.{letter}.{pnum}" if letter else f"{ref}.{pnum}"


# --- geometria drutów ----------------------------------------------------------------------

Seg = tuple[float, float, float, float]


def named_nets(page: dict) -> dict[str, dict]:
    """Nety strony pod nazwą znormalizowaną jak `net_of` (strip; pusta nazwa pominięta — viewer
    jej nie rysuje). Nety o nazwach równych po normalizacji są łączone.
    Wynik: nazwa -> {"segments": [Seg], "junctions": [(x, y)]}."""
    out: dict[str, dict] = {}
    for name, net in (page.get("nets") or {}).items():
        key = norm_str(name)
        if key is None:
            continue
        dst = out.setdefault(key, {"segments": [], "junctions": []})
        net = net or {}
        dst["segments"].extend(tuple(float(v) for v in s) for s in net.get("segments") or []
                               if s is not None and len(s) == 4)
        dst["junctions"].extend((float(j[0]), float(j[1])) for j in net.get("junctions") or []
                                if j is not None and len(j) >= 2)
    return out


def net_segments(page: dict) -> dict[str, list[Seg]]:
    """Odcinki per net (nazwy znormalizowane), tylko nety z odcinkami."""
    return {n: v["segments"] for n, v in named_nets(page).items() if v["segments"]}


def merge_segments(segs: list[Seg]) -> list[Seg]:
    """Normalizacja: scala nakładające się/stykające współliniowe odcinki (H, V i ukośne —
    ukośne grupowane po nachyleniu i wyrazie wolnym), usuwa duplikaty punktów. Kolejność końców
    bez znaczenia. Odcinki rozdzielone choćby małą przerwą zostają osobno."""
    lines: dict[tuple, list] = defaultdict(list)  # klucz prostej -> [(s, e, koniec_s, koniec_e)]
    points: dict[tuple, None] = {}
    for x1, y1, x2, y2 in segs:
        if x1 == x2 and y1 == y2:
            points[(x1, y1)] = None
        elif y1 == y2:
            lines[("H", y1)].append((min(x1, x2), max(x1, x2), None, None))
        elif x1 == x2:
            lines[("V", x1)].append((min(y1, y2), max(y1, y2), None, None))
        else:
            a, b = sorted([(x1, y1), (x2, y2)])  # a.x < b.x
            m = (b[1] - a[1]) / (b[0] - a[0])
            key = ("D", round(m, 9), round(a[1] - m * a[0], 6))
            lines[key].append((a[0], b[0], a, b))

    out: list[Seg] = []
    for key in sorted(lines, key=str):
        merged: list[list] = []
        for s, e, ps, pe in sorted(lines[key], key=lambda t: (t[0], t[1])):
            if merged and s <= merged[-1][1]:
                if e > merged[-1][1]:
                    merged[-1][1], merged[-1][3] = e, pe
            else:
                merged.append([s, e, ps, pe])
        for s, e, ps, pe in merged:
            if key[0] == "H":
                out.append((s, key[1], e, key[1]))
            elif key[0] == "V":
                out.append((key[1], s, key[1], e))
            else:
                out.append((ps[0], ps[1], pe[0], pe[1]))
    out.extend((x, y, x, y) for x, y in points)
    return out


def _sample_chunks(segs, step: float = WIRE_STEP):
    """Generator bloków próbek (po ~_CHUNK_ELEMS), żeby tymczasowe tablice nie rosły z kandydatem."""
    s = np.asarray(segs, dtype=float).reshape(-1, 4)
    if len(s) == 0:
        return
    length = np.hypot(s[:, 2] - s[:, 0], s[:, 3] - s[:, 1])
    k = np.maximum(1, np.ceil(length / step)).astype(np.int64)
    n = np.where(length == 0, 1, k + 1)  # liczba próbek odcinka
    ends = np.cumsum(n)
    lo = 0
    while lo < len(s):
        hi = max(lo + 1, int(np.searchsorted(ends, ends[lo] - n[lo] + _SAMPLE_CHUNK, side="right")))
        nn, kk, ss = n[lo:hi], k[lo:hi], s[lo:hi]
        seg = np.repeat(np.arange(hi - lo), nn)
        t = (np.arange(int(nn.sum())) - np.repeat(np.cumsum(nn) - nn, nn)) / kk[seg]
        yield np.stack([ss[seg, 0] + t * (ss[seg, 2] - ss[seg, 0]),
                        ss[seg, 1] + t * (ss[seg, 3] - ss[seg, 1])], axis=1)
        lo = hi


def sample_segments(segs, step: float = WIRE_STEP) -> np.ndarray:
    """Próbki co `step` px (z oboma końcami); odcinek zerowej długości = 1 próbka."""
    parts = list(_sample_chunks(segs, step))
    return np.concatenate(parts) if parts else np.zeros((0, 2))


def wire_cells(segs) -> np.ndarray:
    """Próbki znormalizowanej geometrii, unikalne po komórce siatki 1 px (pierwsza próbka
    komórki zachowuje dokładne współrzędne). Deduplikacja blokami: w bloku np.unique, między
    blokami zbiór już widzianych komórek."""
    merged = merge_segments(list(segs))
    if not merged:
        return np.zeros((0, 2))
    s = np.asarray(merged, dtype=float)
    x0 = int(np.floor(min(s[:, 0].min(), s[:, 2].min()))) - 1
    y0 = int(np.floor(min(s[:, 1].min(), s[:, 3].min()))) - 1
    w = int(np.ceil(max(s[:, 0].max(), s[:, 2].max()))) - x0 + 2
    h = int(np.ceil(max(s[:, 1].max(), s[:, 3].max()))) - y0 + 2
    grid = np.zeros(w * h, dtype=bool) if w * h <= 64_000_000 else None  # zajęte komórki
    seen = np.zeros(0, dtype=np.int64)  # fallback dla gigantycznych współrzędnych
    out = []
    for pts in _sample_chunks(merged):
        rx = np.round(pts[:, 0]).astype(np.int64) - x0
        ry = np.round(pts[:, 1]).astype(np.int64) - y0
        key = ry * w + rx
        _, idx = np.unique(key, return_index=True)
        idx = np.sort(idx)
        if grid is not None:
            idx = idx[~grid[key[idx]]]
            grid[key[idx]] = True
        else:
            idx = idx[~np.isin(key[idx], seen)]
            seen = np.union1d(seen, key[idx])
        out.append(pts[idx])
    return np.concatenate(out) if out else np.zeros((0, 2))


def min_dist_to_segments(pts: np.ndarray, segs, return_index: bool = False):
    """Dla każdego punktu: odległość do najbliższego odcinka (inf gdy brak odcinków).
    Bloki dobierane do liczby odcinków, żeby pamięć nie rosła z rozmiarem kandydata."""
    n = len(pts)
    idx_out = np.full(n, -1, dtype=np.int64)
    if n == 0 or not len(segs):
        out = np.full(n, np.inf)
        return (out, idx_out) if return_index else out
    s = np.asarray(segs, dtype=float)
    a, b = s[:, :2], s[:, 2:]
    d = b - a
    dd = (d * d).sum(axis=1)
    safe = np.where(dd > 0, dd, 1.0)
    out = np.empty(n)
    chunk = max(1, _CHUNK_ELEMS // len(s))
    for k in range(0, n, chunk):
        p = pts[k:k + chunk]
        px = p[:, 0:1] - a[None, :, 0]
        py = p[:, 1:2] - a[None, :, 1]
        t = np.clip(np.where(dd > 0, (px * d[None, :, 0] + py * d[None, :, 1]) / safe, 0.0), 0.0, 1.0)
        dist = np.hypot(px - t * d[None, :, 0], py - t * d[None, :, 1])
        j = dist.argmin(axis=1)
        out[k:k + chunk] = dist[np.arange(len(p)), j]
        idx_out[k:k + chunk] = j
    return (out, idx_out) if return_index else out


def junctions_of(page: dict) -> list[tuple[float, float]]:
    """Zapisane junctions ∪ auto-kropki viewera (>= 3 końce odcinków jednego netu w DOKŁADNIE
    tym samym punkcie). Gwiazda zastępcza dla `segments: null` celowo pominięta."""
    seen: set[tuple[float, float]] = set()
    out: list[tuple[float, float]] = []

    def add(x, y):
        k = (float(x), float(y))
        if k not in seen:
            seen.add(k)
            out.append(k)

    for net in named_nets(page).values():
        for x, y in net["junctions"]:
            add(x, y)
        # identyczne odcinki (też odwrócone) liczą się raz — duplikat nie robi kropki
        uniq: dict = {}
        for s in net["segments"]:
            a, b = (s[0], s[1]), (s[2], s[3])
            uniq[(min(a, b), max(a, b))] = None
        ends: Counter = Counter()
        for a, b in uniq:
            ends[a] += 1
            ends[b] += 1
        for (x, y), n in ends.items():
            if n >= 3:
                add(x, y)
    return out


def _near_counts(owners: list, n_rows: int, segs_by_label: list, n_labels: int) -> np.ndarray:
    """counts[wiersz, etykieta] = liczba próbek wiersza, których najbliższy odcinek (<= WIRE_TOL)
    ma tę etykietę. owners: [(wiersz, próbki)], segs_by_label: [(etykieta, odcinki)].
    Bloki po ~_SAMPLE_CHUNK próbek: jedno wywołanie odległości na blok, stała pamięć."""
    counts = np.zeros((n_rows, n_labels))
    labels = np.array([lab for lab, segs in segs_by_label for _ in segs], dtype=np.int64)
    all_segs = [s for _, segs in segs_by_label for s in segs]
    owners = [(r, cells) for r, cells in owners if len(cells)]
    pos = 0
    while all_segs and pos < len(owners):
        block, size = [], 0
        while pos < len(owners) and (not block or size + len(owners[pos][1]) <= _SAMPLE_CHUNK):
            block.append(owners[pos])
            size += len(owners[pos][1])
            pos += 1
        pts = np.concatenate([cells for _, cells in block])
        own = np.concatenate([np.full(len(cells), r, dtype=np.int64) for r, cells in block])
        dist, j = min_dist_to_segments(pts, all_segs, return_index=True)
        near = dist <= WIRE_TOL
        pair, cnt = np.unique(own[near] * n_labels + labels[j[near]], return_counts=True)
        counts[pair // n_labels, pair % n_labels] += cnt
    return counts


def map_nets(gold_members: dict, cand_members: dict, gold_ns: dict, cand_ns: dict,
             gold_cells: dict, cand_cells: dict) -> dict:
    """Mapowanie 1:1 net kandydata -> net wzorca (Hungarian na sumie wyników).
    Klucz główny (ściśle leksykograficznie): liczba wspólnych endpointów. Drugorzędny, symetryczny:
    próbki kandydata, których najbliższy odcinek wzorca (<= WIRE_TOL) należy do netu wzorca,
    + próbki wzorca, których najbliższy odcinek kandydata należy do netu kandydata.
    Waga endpointu = suma wszystkich wyników geometrii + 1, więc żadna suma geometrii nie
    przeważy choćby jednego wspólnego endpointu."""
    gnames = sorted(set(gold_members) | set(gold_ns))
    cnames = sorted(set(cand_members) | set(cand_cells))
    if not gnames or not cnames:
        return {}
    gi = {n: i for i, n in enumerate(gnames)}
    ci_ = {n: i for i, n in enumerate(cnames)}
    ep = np.zeros((len(cnames), len(gnames)))
    for ci, c in enumerate(cnames):
        mem = cand_members.get(c)
        if mem:
            for g, gm in gold_members.items():
                ep[ci, gi[g]] = len(mem & gm)
    geo = _near_counts([(ci_[c], v) for c, v in cand_cells.items()], len(cnames),
                       [(gi[g], v) for g, v in gold_ns.items()], len(gnames))
    geo += _near_counts([(gi[g], v) for g, v in gold_cells.items()], len(gnames),
                        [(ci_[c], v) for c, v in cand_ns.items()], len(cnames)).T
    score = ep * (geo.sum() + 1) + geo
    # maksymalizacja sumy wyniku (koszt -score); pary z wynikiem 0 odrzucamy po przypisaniu
    rows, cols = linear_sum_assignment(-score)
    return {cnames[r]: gnames[c] for r, c in zip(rows, cols) if score[r, c] > 0}


def _pairs(n: int) -> int:
    return n * (n - 1) // 2


def same_net_pairs(nets) -> int:
    """Liczba nieuporządkowanych par w tym samym necie (None = singleton)."""
    return sum(_pairs(n) for n in Counter(v for v in nets if v is not None).values())


# --- liczniki per strona -------------------------------------------------------------------


def evaluate_page(gold: dict, cand: dict | None, scope: str = SCOPE_FULL) -> dict:
    """Zwraca liczniki (sumowalne) dla jednej strony. cand=None = strona pusta."""
    if cand is None:
        cand = empty_page()
    full = scope == SCOPE_FULL
    c: dict = {"scope": scope}

    # gold_ep[id wzorca] = net wzorca; cand_ep[id wzorca] = net kandydata (dopasowane);
    # cand_only = nety endpointów kandydata bez odpowiednika we wzorcu
    gold_ep: dict[str, str | None] = {}
    cand_ep: dict[str, str | None] = {}
    cand_only: list[str | None] = []

    def add_gold(key: str, net) -> str:
        # duplikat tożsamości we wzorcu (np. dwa cross_refy z tą samą etykietą) -> sufiks #n
        k, n = key, 1
        while k in gold_ep:
            n += 1
            k = f"{key}#{n}"
        gold_ep[k] = net
        return k

    # bramki
    gg = gold.get("gates") or []
    cg = cand.get("gates") or []
    gm = match_gates(gg, cg)
    c["gate"] = {
        "tp": len(gm), "npred": len(cg), "ngold": len(gg),
        "ref_ok": sum(1 for i, j in gm if norm_str(gg[i].get("ref")) == norm_str(cg[j].get("ref"))),
        "letter_ok": sum(1 for i, j in gm if norm_str(gg[i].get("gate")) == norm_str(cg[j].get("gate"))),
    }

    # piny (tożsamość z wzorca)
    pin_keys = {(gi, str(p.get("num"))): add_gold(pin_id(g, p.get("num")), net_of(p))
                for gi, g in enumerate(gg) for p in g.get("pins") or []}
    pin_found = pin_gold = pin_pred = 0
    pin_err: list[float] = []
    matched_cand = {j for _, j in gm}
    for j, g in enumerate(cg):
        if j not in matched_cand:
            cand_only.extend(net_of(p) for p in g.get("pins") or [])
    for i, j in gm:
        gpins = {str(p.get("num")): p for p in gg[i].get("pins") or []}
        cpins = cg[j].get("pins") or []
        pin_gold += len(gg[i].get("pins") or [])
        pin_pred += len(cpins)
        used: set[str] = set()
        for cp in cpins:
            k = str(cp.get("num"))
            gp = gpins.get(k)
            if gp is None or k in used:
                cand_only.append(net_of(cp))
                continue
            used.add(k)
            pin_found += 1
            pin_err.append(math.hypot(num(gp.get("px")) - num(cp.get("px")),
                                      num(gp.get("py")) - num(cp.get("py"))))
            cand_ep[pin_keys[(i, k)]] = net_of(cp)
    c["pin"] = {"found": pin_found, "ngold": pin_gold, "npred": pin_pred, "errors": pin_err}

    def match_side(gl: list[dict], cl: list[dict], tol: float, key):
        m = match_points([(num(p.get("x")), num(p.get("y"))) for p in gl],
                         [(num(p.get("x")), num(p.get("y"))) for p in cl], tol)
        keys = [add_gold(key(p), net_of(p)) for p in gl]
        mc = {j for _, j in m}
        for i, j in m:
            cand_ep[keys[i]] = net_of(cl[j])
        cand_only.extend(net_of(p) for j, p in enumerate(cl) if j not in mc)
        return m

    # porty
    gp = gold.get("ports") or []
    cp_ = cand.get("ports") or []
    pm = match_side(gp, cp_, PORT_TOL, lambda p: f"PORT:{p.get('connector')}{p.get('pin')}")
    c["port"] = {
        "tp": len(pm), "npred": len(cp_), "ngold": len(gp),
        "label_ok": sum(1 for i, j in pm if norm_str(gp[i].get("label")) == norm_str(cp_[j].get("label"))),
        "connpin_ok": sum(1 for i, j in pm
                          if norm_str(gp[i].get("connector")) == norm_str(cp_[j].get("connector"))
                          and norm_str(gp[i].get("pin")) == norm_str(cp_[j].get("pin"))),
    }

    # cross_refy
    gx = gold.get("cross_refs") or []
    cx = cand.get("cross_refs") or []
    xm = match_side(gx, cx, XREF_TOL, lambda x: f"XREF:{x.get('label')}")

    def pageset(x):
        return {s for s in (norm_str(v) for v in (x.get("pages") or [])) if s}

    c["xref"] = {
        "tp": len(xm), "npred": len(cx), "ngold": len(gx),
        "label_ok": sum(1 for i, j in xm if norm_str(gx[i].get("label")) == norm_str(cx[j].get("label"))),
        "pages_ok": sum(1 for i, j in xm if pageset(gx[i]) == pageset(cx[j])),
    }

    if not full:
        return c

    # członkowie netów (tożsamości wzorca; endpointy tylko-kandydata jako CAND:i)
    gold_members: dict[str, set] = defaultdict(set)
    for k, n in gold_ep.items():
        if n:
            gold_members[n].add(k)
    cand_members: dict[str, set] = defaultdict(set)  # tylko dopasowane (do mapowania netów)
    for k, n in cand_ep.items():
        if n:
            cand_members[n].add(k)
    cand_all: dict[str, set] = defaultdict(set)
    for n, mem in cand_members.items():
        cand_all[n] |= mem
    for i, n in enumerate(cand_only):
        if n:
            cand_all[n].add(f"CAND:{i}")

    # endpointy: zbiór współczłonków netu
    ep_ok, ep_j = 0, 0.0
    for k, gn in gold_ep.items():
        if k not in cand_ep:
            continue  # nieodnaleziony endpoint = błędny
        sg = gold_members[gn] - {k} if gn else set()
        cn = cand_ep[k]
        sc = cand_all[cn] - {k} if cn else set()
        ep_ok += sg == sc
        union = sg | sc
        ep_j += len(sg & sc) / len(union) if union else 1.0
    c["ep"] = {"ok": ep_ok, "jacc": ep_j, "n": len(gold_ep)}

    # pary endpointów: ten sam net? (tp powstaje tylko na endpointach dopasowanych)
    common = [k for k in cand_ep if k in gold_ep]
    tp = same_net_pairs((gold_ep[k], cand_ep[k]) if gold_ep[k] and cand_ep[k] else None for k in common)
    c["pair"] = {
        "tp": tp,
        "npred": same_net_pairs(list(cand_ep.values()) + cand_only),
        "ngold": same_net_pairs(gold_ep.values()),
    }
    c["pair_cond"] = {
        "tp": tp,
        "npred": same_net_pairs(cand_ep[k] for k in common),
        "ngold": same_net_pairs(gold_ep[k] for k in common),
    }

    # druty: geometria (bez netów) i z netami
    graw, craw = net_segments(gold), net_segments(cand)
    gall = merge_segments([s for v in graw.values() for s in v])
    call = merge_segments([s for v in craw.values() for s in v])
    gpts, cpts = wire_cells(gall), wire_cells(call)
    c["wire_geom"] = {
        "gold_cov": int((min_dist_to_segments(gpts, call) <= WIRE_TOL).sum()), "gold_n": len(gpts),
        "cand_cov": int((min_dist_to_segments(cpts, gall) <= WIRE_TOL).sum()), "cand_n": len(cpts),
    }
    gold_ns = {n: merge_segments(s) for n, s in graw.items()}
    cand_ns = {n: merge_segments(s) for n, s in craw.items()}
    gold_cells = {n: wire_cells(s) for n, s in gold_ns.items()}
    cand_cells = {n: wire_cells(s) for n, s in cand_ns.items()}
    mapping = map_nets(gold_members, cand_members, gold_ns, cand_ns, gold_cells, cand_cells)
    inverse = {g: cn for cn, g in mapping.items()}
    w = {"gold_cov": 0, "gold_n": 0, "cand_cov": 0, "cand_n": 0}
    for n, cells in cand_cells.items():
        w["cand_n"] += len(cells)
        g = mapping.get(n)
        if g in gold_ns:
            w["cand_cov"] += int((min_dist_to_segments(cells, gold_ns[g]) <= WIRE_TOL).sum())
    for n, cells in gold_cells.items():
        w["gold_n"] += len(cells)
        cn = inverse.get(n)
        if cn in cand_ns:
            w["gold_cov"] += int((min_dist_to_segments(cells, cand_ns[cn]) <= WIRE_TOL).sum())
    c["wire"] = w

    gj, cj = junctions_of(gold), junctions_of(cand)
    c["junc"] = {"tp": len(match_points(gj, cj, JUNCTION_TOL)), "npred": len(cj), "ngold": len(gj)}
    return c


# --- metryki z liczników -------------------------------------------------------------------


def prf(tp: int, npred: int, ngold: int):
    """(P, R, F1). Wszystko None, gdy nic do znalezienia i nic nie zgłoszono.
    Nic nie zgłoszono, a było co -> P=0; nic do znalezienia, a coś zgłoszono -> R=None, F1=0."""
    if ngold == 0 and npred == 0:
        return None, None, None
    p = tp / npred if npred else 0.0
    r = tp / ngold if ngold else None
    return p, r, f1(p, r)


def f1(p, r):
    if p is None and r is None:
        return None
    p, r = p or 0.0, r or 0.0
    return 2 * p * r / (p + r) if p + r > 0 else 0.0


def ratio(a, b):
    if a is None or not b:
        return None
    return a / b


def merge_counts(items: list[dict]) -> dict:
    """Sumuje liczniki stron (micro-average)."""
    out: dict = {}
    for c in items:
        for grp, vals in c.items():
            if grp == "scope":
                continue
            dst = out.setdefault(grp, {})
            for k, v in vals.items():
                if isinstance(v, list):
                    dst.setdefault(k, []).extend(v)
                else:
                    dst[k] = dst.get(k, 0) + v
    return out


def _wire(w: dict):
    wp = ratio(w["cand_cov"], w["cand_n"])
    wr = ratio(w["gold_cov"], w["gold_n"])
    if w["gold_n"] and not w["cand_n"]:
        wp = 0.0
    return wp, wr, (f1(wp, wr) if (w["gold_n"] or w["cand_n"]) else None)


def finalize(c: dict) -> dict:
    m: dict = {}
    g = c["gate"]
    m["gate_P"], m["gate_R"], m["gate_F1"] = prf(g["tp"], g["npred"], g["ngold"])
    m["gate_ref_acc"] = ratio(g["ref_ok"], g["tp"])
    m["gate_letter_acc"] = ratio(g["letter_ok"], g["tp"])
    p = c["pin"]
    m["pin_P"] = ratio(p["found"], p["npred"])
    m["pin_R"] = ratio(p["found"], p["ngold"])
    m["pin_err_median"] = statistics.median(p["errors"]) if p["errors"] else None
    for grp, extra in (("port", ("label_ok", "connpin_ok")), ("xref", ("label_ok", "pages_ok"))):
        v = c[grp]
        m[f"{grp}_P"], m[f"{grp}_R"], m[f"{grp}_F1"] = prf(v["tp"], v["npred"], v["ngold"])
        for k in extra:
            m[f"{grp}_{k.removesuffix('_ok')}_acc"] = ratio(v[k], v["tp"])
    if "pair" in c:
        e = c["ep"]
        m["ep_acc"] = ratio(e["ok"], e["n"])
        m["ep_jacc"] = ratio(e["jacc"], e["n"])
        v = c["pair"]
        m["pair_P"], m["pair_R"], m["pair_F1"] = prf(v["tp"], v["npred"], v["ngold"])
        v = c["pair_cond"]
        m["pair_P_cond"], m["pair_R_cond"], m["pair_F1_cond"] = prf(v["tp"], v["npred"], v["ngold"])
        m["wire_P"], m["wire_R"], m["wire_F1"] = _wire(c["wire"])
        m["wire_P_geom"], m["wire_R_geom"], m["wire_F1_geom"] = _wire(c["wire_geom"])
        j = c["junc"]
        m["junc_P"], m["junc_R"], m["junc_F1"] = prf(j["tp"], j["npred"], j["ngold"])
    return m


# --- całość --------------------------------------------------------------------------------


def evaluate(gold_dir: Path, cand_dir: Path, warn=None, integrity: dict | None = None) -> dict:
    """Ocena całego katalogu. `integrity`: wynik check_integrity, jeśli już policzony (main),
    żeby nie haszować plików wzorca drugi raz."""
    gold_dir, cand_dir = Path(gold_dir), Path(cand_dir)
    warn = warn or (lambda msg: print(f"WARN: {msg}", file=sys.stderr))
    entries, files = load_manifest(gold_dir)
    if integrity is None:
        integrity = check_integrity(gold_dir, files)
    pages: dict[str, dict] = {}
    all_counts = []
    for e in entries:
        gpath = gold_dir / e["file"]
        if not gpath.exists():
            warn(f"brak pliku wzorca {e['file']} — strona pominięta")
            continue
        gold = load_yaml(gpath) or empty_page(e["package"], e["page"])
        cpath = find_candidate(cand_dir, e["package"], e["page"])
        cand = load_yaml(cpath) if cpath else None
        if cpath is None:
            warn(f"brak strony kandydata {e['package']}/{e['page']} w {cand_dir} — liczona jako pusta")
        counts = evaluate_page(gold, cand, e["scope"])
        all_counts.append(counts)
        pages[f"{e['package']}/{e['page']}"] = {"scope": e["scope"], "missing": cpath is None,
                                                "metrics": finalize(counts), "counts": _jsonable(counts)}
    total_counts = merge_counts(all_counts)
    total = finalize(total_counts) if all_counts else {}
    headline = {k: total.get(k) for k in ("ep_acc", "pair_F1", "gate_F1", "wire_F1")}
    return {"pages": pages, "total": total, "total_counts": _jsonable(total_counts),
            "headline": headline, "integrity": integrity,
            "candidate_pages_found": sum(1 for p in pages.values() if not p["missing"])}


def _jsonable(c: dict) -> dict:
    out = {}
    for grp, vals in c.items():
        if isinstance(vals, dict):
            out[grp] = {k: (len(v) if isinstance(v, list) else v) for k, v in vals.items()}
        else:
            out[grp] = vals
    return out


# --- wydruk --------------------------------------------------------------------------------

COLUMNS = [
    # (nagłówek, klucz, format)
    ("epAcc", "ep_acc", "r"), ("epJac", "ep_jacc", "r"),
    ("gateP", "gate_P", "r"), ("gateR", "gate_R", "r"), ("gateF1", "gate_F1", "r"),
    ("ref", "gate_ref_acc", "r"), ("let", "gate_letter_acc", "r"),
    ("pinP", "pin_P", "r"), ("pinR", "pin_R", "r"), ("pinErr", "pin_err_median", "px"),
    ("pairP", "pair_P", "r"), ("pairR", "pair_R", "r"), ("pairF1", "pair_F1", "r"),
    ("pF1cond", "pair_F1_cond", "r"),
    ("wireP", "wire_P", "r"), ("wireR", "wire_R", "r"), ("wireF1", "wire_F1", "r"),
    ("wF1geom", "wire_F1_geom", "r"),
    ("juncP", "junc_P", "r"), ("juncR", "junc_R", "r"),
    ("portF1", "port_F1", "r"), ("pLbl", "port_label_acc", "r"), ("pConn", "port_connpin_acc", "r"),
    ("xrefF1", "xref_F1", "r"), ("xLbl", "xref_label_acc", "r"), ("xPgs", "xref_pages_acc", "r"),
]


def _fmt(v, kind) -> str:
    if v is None:
        return "-"
    return f"{v:.1f}" if kind == "px" else f"{v:.3f}"


def format_table(result: dict) -> str:
    rows = []
    for name, p in result["pages"].items():
        rows.append([name + (" (brak)" if p["missing"] else ""), p["scope"]]
                    + [_fmt(p["metrics"].get(k), f) for _, k, f in COLUMNS])
    rows.append(["TOTAL", "micro"] + [_fmt(result["total"].get(k), f) for _, k, f in COLUMNS])
    header = ["page", "scope"] + [h for h, _, _ in COLUMNS]
    widths = [max(len(header[i]), *(len(r[i]) for r in rows)) for i in range(len(header))]

    def line(cells):
        return "  ".join(v.ljust(widths[i]) if i < 2 else v.rjust(widths[i]) for i, v in enumerate(cells))

    sep = "  ".join("-" * w for w in widths)
    lines = [line(header), sep] + [line(r) for r in rows[:-1]] + [sep, line(rows[-1]), ""]
    lines.append("HEADLINE " + " ".join(f"{k}={_fmt(v, 'r')}" for k, v in result["headline"].items()))
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--gold", type=Path, default=Path("data/gold"), help="katalog wzorca (z manifest.yaml)")
    ap.add_argument("--candidate", type=Path, required=True,
                    help="katalog kandydata: <pakiet>/<strona>.sch.yaml lub <pakiet>/pages/<strona>.sch.yaml")
    ap.add_argument("--json", type=Path, help="zapisz pełny wynik (metryki + liczniki) do pliku JSON")
    ap.add_argument("--allow-modified", action="store_true",
                    help="nie przerywaj, gdy plik wzorca nie ma sha256 albo ma inne niż w manifeście")
    args = ap.parse_args(argv)
    if not (args.gold / "manifest.yaml").exists() and not any(args.gold.glob("*/*.sch.yaml")):
        print(f"ERROR: brak wzorca w {args.gold}", file=sys.stderr)
        return 2
    # integralność PRZED oceną
    _, files = load_manifest(args.gold)
    integ = check_integrity(args.gold, files)
    for msg in integ["fatal"]:
        print(f"ERROR: {msg}", file=sys.stderr)
    for msg in integ["modified"]:
        print(f"{'WARN' if args.allow_modified else 'ERROR'}: {msg}", file=sys.stderr)
    if integ["fatal"] or (integ["modified"] and not args.allow_modified):
        print("ERROR: wzorzec niezgodny z manifestem (--allow-modified pomija tylko sha256)", file=sys.stderr)
        return 3
    result = evaluate(args.gold, args.candidate, warn=lambda m: None, integrity=integ)
    if result["candidate_pages_found"] == 0:
        print(f"ERROR: w {args.candidate} nie ma żadnej strony wzorca "
              "(oczekiwano <pakiet>/<strona>.sch.yaml lub <pakiet>/pages/<strona>.sch.yaml)", file=sys.stderr)
        return 2
    for name, p in result["pages"].items():
        if p["missing"]:
            print(f"WARN: brak strony kandydata {name} — liczona jako pusta", file=sys.stderr)
    print(format_table(result))
    if args.json:
        args.json.write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
