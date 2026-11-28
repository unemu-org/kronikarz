#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["opencv-python-headless", "numpy", "pyyaml", "pillow"]
# ///
# Krok text potrzebuje też mlx-vlm (ciężkie, tylko macOS arm64) — NIE jest w zależnościach
# skryptu, żeby gates / wires nie budowały jego środowiska. Dokłada je wywołujący:
# `uv run --with mlx-vlm==0.8.1 scripts/auto.py … --step text|next` (robią to serwer /auto
# i `just auto` dla STEP=text|next).
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
  --step     gates (①, scripts/cv-gates.py), text (②, lokalny VLM na wycinkach bramek,
             scripts/_vlm.py), wires (③, scripts/cv-wires.py tryb (a) na BIEŻĄCYCH bramkach
             strony), next (na każdej stronie nextRunnableStep); labels / nets — jeszcze nie
             zaimplementowane (exit 3)
  --force    przepuść krok zatwierdzony (wraca do 'auto'; późniejsze 'approved' → 'stale')
  --draft    bez wymogu zatwierdzonego poprzedniego kroku (próby)
  --dry-run  policz i wypisz podsumowanie; nic nie zapisuje (ani strony, ani snapshotu)
  --json     wynik jako JSON na stdout (dla serwera); postęp kroku ② zawsze na stderr
  --model    text: mlx:<katalog modelu> (domyślnie $KRONIKARZ_VLM albo Qwen3.8-27B 4-bit
             z /Volumes/Dane/llm); inny adapter = model płatny → odmowa (exit 2), z
             --allow-paid exit 3 (hak `paid_model_refusal`, adapter niepodłączony); katalog
             spoza /Volumes/Dane/llm = odmowa (exit 2). Wymaga mlx-vlm: uv run --with
             mlx-vlm==0.8.1 (brak = exit 1 z podpowiedzią)
  --gate-timeout  text: limit czasu odpowiedzi modelu na jedną bramkę [s] (domyślnie 120)

Exit: 0 ok; 1 błąd; 2 odmowa (warunki canRun, ③ ruszyłby nety po kroku ⑤ bez --force, płatny
model bez zgody); 3 krok niezaimplementowany. Przy kilku stronach wygrywa najpoważniejszy:
1 > 3 > 2 > 0. Strona, na której `--step next` nie ma nic do zrobienia (wszystkie kroki
zatwierdzone), to 0. Błąd modelu na pojedynczej bramce nie jest błędem strony (bramka zostaje
bez zmian, `errors` w licznikach, wpis w `steps.text.uncertain`).

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
  text   czyta bramki, których aspekt tekstu (ref, gate, value, label_left, label_right, piny)
         jest CAŁY pusty albo jest wynikiem tego kroku (text_src 'auto', każdy pin src 'auto',
         nety pinów puste albo 'auto' z niezatwierdzonego ⑤); resztę zostawia. Wycinek jak
         w bake-offie (ramka + GATE_MX/MT/MB, pionowo piny z cv_pins kroku ①), skala 2,
         prompt v3; samokorekta: typ przez resolve_ic_key, litera z numerów pinów (ic_map
         gate_pins, jednoznacznie; remis rozstrzyga rejestr pakietu na tej stronie), ref
         w rejestrze z tą literą na tej stronie. Niezgodność = odczyt zostaje, bramka trafia
         do `steps.text.uncertain`. Piny na bokach ramki, w kolejności odczytu: w miejscach
         cv_pins z kroku ①, gdy jest ich na boku dokładnie tyle, inaczej równo. Pisze ref,
         gate, pins (src: auto) i text_src: auto; ramki, netów i drutów nie rusza.
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
import copy
import hashlib
import importlib.util
import io
import json
import math
import os
import re
import sys
import tempfile
import time
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent))
_old_dwb, sys.dont_write_bytecode = sys.dont_write_bytecode, True  # bez scripts/__pycache__
import _jsyaml  # noqa: E402
import _safe_write  # noqa: E402
import _steps  # noqa: E402
import _vlm  # noqa: E402
sys.dont_write_bytecode = _old_dwb

EXIT_OK, EXIT_ERROR, EXIT_REFUSED, EXIT_NOT_IMPLEMENTED = 0, 1, 2, 3
_SEVERITY = {EXIT_ERROR: 3, EXIT_NOT_IMPLEMENTED: 2, EXIT_REFUSED: 1, EXIT_OK: 0}

IMPLEMENTED = ("gates", "text", "wires")
NOT_IMPLEMENTED = ("labels", "nets")

# Krok ② (kr-9p8.27): zwycięzca bake-offu kr-9p8.4 — prompt v3, skala 2, lokalny Qwen3.8-27B 4-bit.
TEXT_PROMPT = "v3"
TEXT_SCALE = 2
GATE_TIMEOUT_S = 120.0  # na jeden wycinek (zwykle 4–20 s; max_tokens=300 i tak ogranicza)
# role z ic_map.gate_pins, które są wyjściami (prawa strona bramki); a/b (245) — dwukierunkowe
OUT_ROLES = frozenset({"out", "nout", "q", "nq", "rco", "carry", "borrow"})
BIDIR_ROLES = frozenset({"a", "b"})

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


# --------------------------------------------------------------------------- krok ② text

def text_target(page: dict, g: Any) -> str | None:
    """Czy krok ② czyta tę bramkę: 'fill' — aspekt tekstu cały pusty (aspectEmpty, także
    bramka ludzka); 'replace' — to wynik tego kroku (text_src 'auto', każdy pin src 'auto',
    a nety pinów puste albo 'auto' z kroku ⑤, który nie jest zatwierdzony); None — zostaje."""
    if not _has_box(g):
        return None
    if _steps.aspect_empty("gate", g, "text_src"):
        return "fill"
    if _steps.element_src(g, "text_src") != "auto":
        return None
    for p in _steps.list_of(g.get("pins")):
        if not isinstance(p, dict) or _steps.element_src(p, "src") != "auto":
            return None
        if not _aspect_replaceable(page, "pin", p, "net_src", "nets"):
            return None
    return "replace"


def resolve_ic_key(ic: Any, ic_map: dict) -> str | None:
    """resolveIcKey z shared/src/parse.ts: prefiksy rodzin (SN/UCY/MCY/MH/CDB/HCF), 74xx
    (z LS/HCT/…), sufiks obudowy N/D, jedna cyfra → '0N', polskie H (H11 → 11)."""
    keys = {str(k) for k in ic_map}
    raw = _steps._js_str(ic).strip()
    if raw in keys:
        return raw
    s = raw.upper()
    s = re.sub(r"^(SN|UCY|MCY|MH|CDB|HCF)", "", s)
    s = re.sub(r"^74(LS|HCT|HC|ALS|AS|H|S|F)?", "", s)
    s = re.sub(r"[ND]$", "", s)
    if s in keys:
        return s
    if len(s) == 1 and "0" + s in keys:
        return "0" + s
    if raw.upper().startswith("H") and raw[1:] in keys:
        return raw[1:]
    return None


def ic_letters(ic_map: dict, key: str | None) -> dict[str, dict[str, set[int]]]:
    """Litera → {'in', 'out', 'bidir'} (zbiory numerów pinów) z ic_map[key].gate_pins."""
    entry = next((v for k, v in ic_map.items() if str(k) == key), None) if key else None
    gp = entry.get("gate_pins") if isinstance(entry, dict) else None
    out: dict[str, dict[str, set[int]]] = {}
    for letter, roles in (gp.items() if isinstance(gp, dict) else []):
        r = {"in": set(), "out": set(), "bidir": set()}
        for role, lst in (roles.items() if isinstance(roles, dict) else []):
            kind = "out" if role in OUT_ROLES else "bidir" if role in BIDIR_ROLES else "in"
            for n in (lst if isinstance(lst, list) else [lst]):
                if _steps._is_num(n):
                    r[kind].add(int(n))
        out[str(letter)] = r
    return out


def _all(r: dict) -> set[int]:
    return r["in"] | r["out"] | r["bidir"]


def _reg_page(comp: dict, letter: str) -> str | None:
    gates = comp.get("gates") if isinstance(comp, dict) else None
    ent = gates.get(letter) if isinstance(gates, dict) else None
    if not isinstance(ent, dict):
        return None
    return _steps._js_str(ent.get("page")) if ent.get("page") is not None else ""


def check_text(pred: dict, pid: str, components: dict, ic_map: dict | None) -> dict:
    """Samokorekta odczytu bramki z ic_map i rejestrem pakietu. Odczyt (ref, piny) zostaje,
    jaki jest; litera wynika z numerów pinów. Zwraca {ref, gate, pins, ic, type_read, why},
    `why` = lista „KOD: opis” (pusta = pewna)."""
    why: list[str] = []
    ref = pred.get("ref") or ""
    typ = pred.get("type") or ""
    sym = pred.get("symbol") or ""
    pins = {s: list((pred.get("pins") or {}).get(s) or []) for s in ("left", "right", "top")}
    comp = components.get(ref) if ref and isinstance(components, dict) else None
    if not ref:
        why.append("REF_EMPTY: nie odczytano ref")
    elif not isinstance(comp, dict):
        why.append(f"REF_UNKNOWN: {ref} nie ma w rejestrze pakietu (components)")
        comp = None
    key = reg_key = read_key = None
    if not ic_map:
        why.append("IC_MAP_MISSING: brak ic_map.yaml modułu — litery nie da się wyznaczyć")
    else:
        read_key = resolve_ic_key(typ, ic_map) if typ else None
        reg_ic = comp.get("ic") if comp else None
        reg_key = resolve_ic_key(reg_ic, ic_map) if not _steps._blank(reg_ic) else None
        if not typ:
            why.append("TYPE_EMPTY: nie odczytano typu")
        elif read_key is None:
            why.append(f"TYPE_UNKNOWN: typ „{typ}” spoza ic_map")
        if comp and not _steps._blank(reg_ic) and reg_key is None:
            why.append(f"REGISTRY_TYPE_UNKNOWN: typ {ref} z rejestru „{_steps._js_str(reg_ic)}” spoza ic_map")
        if read_key and reg_key and read_key != reg_key:
            why.append(f"TYPE_MISMATCH: nadruk {typ} ≠ rejestr {_steps._js_str(comp.get('ic'))}")
        key = reg_key or read_key
    exp_sym = _vlm.SYMBOL_BY_TYPE.get(key or "")
    if sym and exp_sym and sym != exp_sym:
        why.append(f"SYMBOL_MISMATCH: symbol „{sym}”, typ {key} ma „{exp_sym}”")
    allp = pins["left"] + pins["right"] + pins["top"]
    if len(set(allp)) != len(allp):
        why.append("PIN_DUPLICATE: powtórzony numer pinu")
    if not allp:
        why.append("NO_PINS: nie odczytano pinów")
    letters = ic_letters(ic_map, key) if ic_map and key else {}
    letter = None
    if allp and key and not letters:
        why.append(f"NO_GATE_PINS: ic_map[{key}] nie ma gate_pins — litera nieznana")
    elif allp and letters:
        got = set(allp)
        cands = [L for L, r in letters.items() if got <= _all(r)]
        if len(cands) > 1 and comp:
            here = [L for L in cands if _reg_page(comp, L) == pid]
            if len(here) == 1:
                cands = here
        if len(cands) == 1:
            letter = cands[0]
        elif not cands:
            known = set().union(*(_all(r) for r in letters.values()))
            bad = sorted(got - known)
            why.append("PINS_NOT_IN_IC_MAP: " + (f"piny {bad} spoza {key}" if bad else
                                                 f"piny z kilku bramek {key}"))
            best = sorted(((len(got & _all(r)), L) for L, r in letters.items()), reverse=True)
            if best and best[0][0] > 0 and (len(best) == 1 or best[1][0] < best[0][0]):
                letter = best[0][1]
        else:
            why.append(f"LETTER_AMBIGUOUS: piny pasują do bramek {', '.join(sorted(cands))}")
    if letter:
        r = letters[letter]
        missing = sorted(_all(r) - set(allp))
        if missing:
            why.append(f"PINS_MISSING: bramka {letter} typu {key} ma jeszcze piny {missing}")
        wrong = [p for p in pins["left"] + pins["top"] if p in r["out"]] + \
                [p for p in pins["right"] if p in r["in"]]
        if wrong:
            why.append(f"PIN_SIDE: piny {wrong} po złej stronie (wejścia z lewej / u góry, wyjścia z prawej)")
        if comp:
            pg = _reg_page(comp, letter)
            if pg is None:
                why.append(f"LETTER_NOT_IN_REGISTRY: {ref} nie ma bramki {letter} w rejestrze")
            elif pg != pid:
                why.append(f"LETTER_WRONG_PAGE: {ref}{letter} w rejestrze na stronie {pg or '—'}")
    return {"ref": ref, "gate": letter, "pins": pins, "ic": key, "type_read": typ, "why": why}


def _js_round(v: float) -> int:
    return int(math.floor(float(v) + 0.5))


def place_pins(rect, pins: dict, cv_pins: list) -> tuple[list[dict], int]:
    """Piny na bokach ramki w kolejności odczytu (lewy / prawy z góry na dół, górny od lewej):
    w miejscach kandydatów `cv_pins` kroku ①, gdy na boku jest ich dokładnie tyle, ilu
    odczytanych pinów; inaczej równo wzdłuż boku. Zwraca (piny, ile położonych z cv_pins)."""
    x0, y0, x1, y1 = rect
    out: list[dict] = []
    from_cv = 0
    for side in ("left", "right", "top"):
        nums = pins.get(side) or []
        if not nums:
            continue
        coord = "px" if side == "top" else "py"
        cand = sorted(float(c[coord]) for c in cv_pins
                      if isinstance(c, dict) and c.get("side") == side and _steps._is_num(c.get(coord)))
        lo, hi = (x0, x1) if side == "top" else (y0, y1)
        if len(cand) == len(nums):
            pos = cand
            from_cv += len(nums)
        else:
            pos = [lo + (i + 1) * (hi - lo) / (len(nums) + 1) for i in range(len(nums))]
        for num, v in zip(nums, pos):
            px, py = (v, y0) if side == "top" else (x0 if side == "left" else x1, v)
            out.append({"num": int(num), "side": side, "net": "", "px": _js_round(px),
                        "py": _js_round(py), "src": "auto"})
    return out, from_cv


def match_cv_pins(g: dict, entries: list) -> list[dict]:
    """cv_pins wykrytej w kroku ① ramki, która jest tą bramką (ta sama reguła co przy
    odrzucaniu duplikatów w ①: IoU >= 0,5 albo środek w środku; najlepszy IoU)."""
    r = gate_rect(g)
    rc = (float(g["x"]), float(g["y"]))
    best, best_iou = None, -1.0
    for e in entries:
        if not (isinstance(e, dict) and _has_box(e) and _steps._is_num(e.get("w"))
                and _steps._is_num(e.get("h"))):
            continue
        er = gate_rect(e)
        ec = (float(e["x"]), float(e["y"]))
        if duplicate_box(r, rc, er, ec):
            v = iou(r, er)
            if v > best_iou:
                best, best_iou = e, v
    pins = best.get("cv_pins") if best else None
    return [p for p in _steps.list_of(pins) if isinstance(p, dict)]


def _clean(v: Any) -> Any:
    """Surowa odpowiedź modelu do snapshotu: bez znaków sterujących (poza \\n), typy YAML."""
    if isinstance(v, str):
        return "".join(c for c in v if c == "\n" or c.isprintable())
    if isinstance(v, dict):
        return {_clean(str(k)): _clean(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [_clean(x) for x in v]
    if isinstance(v, float) and not math.isfinite(v):
        return None
    return v


def merge_text(page: dict, pid: str, reads: dict[int, dict], components: dict,
               ic_map: dict | None) -> tuple[list, dict, list, dict[int, dict]]:
    """Nowa lista `gates` po kroku ② + liczniki + lista niepewnych + wynik per bramka.
    `reads`: indeks bramki → {mode, pred, error, cv_pins} (mode z `text_target`). Nie mutuje
    `page`. Ramek, netów i drutów nie rusza; bramek spoza `reads` też nie."""
    gates = copy.deepcopy(_steps.list_of(page.get("gates")))
    counts = {"gates": sum(1 for g in gates if _has_box(g)), "targets": len(reads), "filled": 0,
              "replaced": 0, "kept_human": 0, "uncertain": 0, "errors": 0, "empty_reads": 0,
              "pins_from_cv": 0, "pins_even": 0}
    results: dict[int, dict] = {}
    for i, rec in sorted(reads.items()):
        g = gates[i]
        if rec.get("error"):
            counts["errors"] += 1
            results[i] = {"written": False, "why": [f"MODEL_ERROR: {rec['error']}"]}
            continue
        chk = check_text(rec.get("pred") or {}, pid, components, ic_map)
        pins, n_cv = place_pins(gate_rect(g), chk["pins"], rec.get("cv_pins") or [])
        if not chk["ref"] and chk["gate"] is None and not pins:
            counts["empty_reads"] += 1  # nic nie odczytano — aspekt zostaje pusty, bez text_src
            results[i] = {"written": False, "why": ["MODEL_EMPTY: odpowiedź bez ref i pinów"]}
            continue
        if rec["mode"] == "replace":
            for f in ("value", "label_left", "label_right"):
                g.pop(f, None)
        g["ref"] = chk["ref"]
        g["gate"] = chk["gate"]
        g["pins"] = pins
        g["text_src"] = "auto"
        counts["filled" if rec["mode"] == "fill" else "replaced"] += 1
        counts["pins_from_cv"] += n_cv
        counts["pins_even"] += len(pins) - n_cv
        results[i] = {"written": True, "why": list(chk["why"]), "ic": chk["ic"],
                      "type_read": chk["type_read"]}
    # ta sama bramka (ref + litera) dwa razy na stronie
    seen = Counter((g.get("ref"), g.get("gate")) for g in gates
                   if isinstance(g, dict) and not _steps._blank(g.get("ref")) and g.get("gate"))
    for i, res in results.items():
        g = gates[i]
        if res["written"] and g.get("gate") and seen[(g.get("ref"), g.get("gate"))] > 1:
            res["why"].append(f"DUPLICATE: {g['ref']}{g['gate']} jest na stronie więcej niż raz")
    counts["kept_human"] = sum(1 for i, g in enumerate(gates) if _has_box(g) and i not in reads)
    uncertain = []
    for i, res in sorted(results.items()):
        if res["why"]:
            g = gates[i]
            uncertain.append({"ref": g.get("ref") or "", "gate": g.get("gate"), "x": g["x"],
                              "y": g["y"], "why": res["why"]})
    counts["uncertain"] = len(uncertain)
    return gates, counts, uncertain, results




MLX_VLM_REQ = "mlx-vlm==0.8.1"


def model_refusal(spec: str, allow_paid: bool) -> tuple[int, str] | None:
    """Model kroku ②: płatny → `paid_model_refusal`; lokalny tylko z katalogu pod
    `_vlm.LLM_ROOT` (/Volumes/Dane/llm — modele nigdy z ~/.cache ani spoza tego dysku) → exit 2."""
    paid = paid_model_refusal(spec, allow_paid)
    if paid:
        return paid
    path = Path(spec.partition(":")[2]).expanduser()
    root = _vlm.LLM_ROOT
    try:
        inside = Path(os.path.normpath(path.absolute())).resolve().is_relative_to(root.resolve())
    except OSError:
        inside = False
    if not inside:
        return EXIT_REFUSED, f"model {path} spoza {root} — modele lokalne tylko z {root}"
    return None


def paid_model_refusal(spec: str, allow_paid: bool) -> tuple[int, str] | None:
    """Hak płatnego VLM (decyzja opiekuna: krok ② domyślnie lokalnie, bez kosztów). Model
    spoza `mlx:` bez --allow-paid → odmowa (exit 2); z --allow-paid → exit 3: adapter płatny
    nie jest podłączony. Podłączenie: adapter z scripts/vlm-bakeoff.py (klucz z .env), szacunek
    kosztu przed startem, jawne potwierdzenie i limit budżetu (także `paidStepRefusal`
    w server/index.js) — docs/auto-digitalizacja.md, „Uruchamianie”."""
    if spec.partition(":")[0] == "mlx":
        return None
    if not allow_paid:
        return EXIT_REFUSED, (f"model {spec} nie jest lokalny — krok text działa lokalnie (mlx:<katalog>); "
                              "płatny VLM tylko z jawnym --allow-paid i potwierdzeniem kosztu")
    return EXIT_NOT_IMPLEMENTED, (f"płatny VLM ({spec}) w kroku text: hak bez adaptera — "
                                  "podłącz adapter i szacunek kosztu (paid_model_refusal)")


def make_vlm(spec: str, tmp_dir: Path):
    """Adapter lokalnego VLM (`mlx:<katalog>`); model ładuje się przy pierwszym wycinku."""
    path = spec.partition(":")[2]
    if not Path(path).is_dir():
        raise AutoError(f"brak katalogu modelu {path} (modele tylko z {_vlm.LLM_ROOT})")
    return _vlm.MlxAdapter(path, tmp=tmp_dir / "crop.png")


def get_vlm(ctx: dict):
    """Jeden adapter (jeden załadowany model) na cały przebieg. Nieudane ładowanie też jest
    zapamiętane — przy --page all kolejne strony dostają ten sam błąd bez ponownej próby."""
    if ctx.get("vlm_error"):
        raise AutoError(ctx["vlm_error"])
    if ctx.get("vlm") is None:
        t0 = time.perf_counter()
        try:
            ad = make_vlm(ctx["vlm_spec"], ctx["tmp_dir"])
            if hasattr(ad, "load"):
                ad.load()
        except AutoError as e:
            ctx["vlm_error"] = str(e)
            raise
        except ImportError as e:
            ctx["vlm_error"] = (f"brak {MLX_VLM_REQ.split('==')[0]} ({e}) — krok text uruchamiaj przez "
                                f"`uv run --with {MLX_VLM_REQ} scripts/auto.py …` (serwer /auto i "
                                "`just auto STEP=text|next` robią to same)")
            raise AutoError(ctx["vlm_error"]) from e
        except Exception as e:  # noqa: BLE001 — zły katalog modelu, pamięć
            ctx["vlm_error"] = f"nie mogę załadować modelu {ctx['vlm_spec']}: {type(e).__name__}: {e}"
            raise AutoError(ctx["vlm_error"]) from e
        ctx["vlm"] = ad
        ctx["vlm_load_s"] = round(time.perf_counter() - t0, 2)
        progress(ctx, f"model {getattr(ad, 'name', ctx['vlm_spec'])} załadowany w {ctx['vlm_load_s']:.1f} s")
    return ctx["vlm"]


def progress(ctx: dict, msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


def registry(ctx: dict) -> tuple[dict, dict | None]:
    """Rejestr pakietu (`package.yaml` components) i ic_map.yaml modułu (obok project.yaml),
    wczytane raz na przebieg. Brak ic_map → None (każda bramka niepewna: IC_MAP_MISSING)."""
    if "registry" not in ctx:
        pkg_yaml = ctx["pkg_dir"] / "package.yaml"
        try:
            doc = load_yaml(pkg_yaml.read_text(encoding="utf-8"))
        except Exception as e:  # noqa: BLE001
            raise AutoError(f"nie mogę wczytać {pkg_yaml}: {e}") from e
        comps = doc.get("components") if isinstance(doc, dict) else None
        comps = {str(k): v for k, v in comps.items()} if isinstance(comps, dict) else {}
        icp = ctx["pkg_dir"].parent / "ic_map.yaml"
        ic_map = None
        if icp.is_file():
            try:
                ic_map = load_yaml(icp.read_text(encoding="utf-8"))
            except Exception as e:  # noqa: BLE001
                raise AutoError(f"nie mogę wczytać {icp}: {e}") from e
            ic_map = ic_map if isinstance(ic_map, dict) else None
        ctx["registry"] = (comps, ic_map)
    return ctx["registry"]


def gates_cv_entries(ctx: dict, pid: str, page: dict, scan: Path) -> tuple[list, str]:
    """Ramki kroku ① z kandydatami pinów (`cv_pins`): snapshot `gates-<steps.gates.run>.yaml`,
    a gdy go nie ma — świeża detekcja cv-gates na skanie (ta sama, deterministyczna)."""
    st = (page.get("steps") or {}).get("gates") if isinstance(page.get("steps"), dict) else None
    run = st.get("run") if isinstance(st, dict) else None
    if isinstance(run, str) and re.fullmatch(r"[0-9A-Za-z-]+", run):
        snap = snapshot_path(ctx["data"], ctx["pkg"], pid, "gates", run)
        if snap.is_file() and not snap.is_symlink():
            try:
                doc = load_yaml(snap.read_text(encoding="utf-8"))
                ents = _steps.list_of(doc.get("gates")) if isinstance(doc, dict) else []
                return [e for e in ents if isinstance(e, dict)], "snapshot"
            except Exception:  # noqa: BLE001 — zły snapshot: jak brak
                pass
    det = detect_gates(read_gray(scan))
    return det["entries"], "cv-gates"


def read_gate(ad, scan_im, g: dict, cv_pins: list, timeout_s: float) -> dict:
    """Wycinek bramki (geometria bake-offu, skala 2) → odpowiedź modelu (prompt v3)."""
    pys = [float(p["py"]) for p in cv_pins
           if p.get("side") in ("left", "right") and _steps._is_num(p.get("py"))]
    bbox = _vlm.gate_crop_box(gate_rect(g), pys)
    png = _vlm.png_bytes(_vlm.render_box(scan_im, bbox, None, TEXT_SCALE))
    prompt = _vlm.PROMPTS[TEXT_PROMPT]["gate"]
    t0 = time.perf_counter()
    try:
        raw = ad.ask(png, "gate", prompt, timeout_s=timeout_s)
    except Exception as e:  # noqa: BLE001 — błąd jednej bramki (także limit czasu) nie psuje strony
        raw = {"text": "", "error": f"{type(e).__name__}: {e}"}
    err = raw.get("error")
    obj = _vlm.parse_json_text(raw.get("text") or "") if not err else None
    if obj is None and not err:
        err = "odpowiedź bez obiektu JSON"
    return {"crop": list(bbox), "scale": TEXT_SCALE, "png_sha256": hashlib.sha256(png).hexdigest(),
            "raw": raw.get("text") or "", "obj": obj,
            "pred": _vlm.to_pred("gate", obj) if obj is not None else None,
            "error": err, "latency": raw.get("latency", time.perf_counter() - t0),
            "in_tok": raw.get("in_tok"), "out_tok": raw.get("out_tok"), "cv_pins": cv_pins}


def run_text(ctx: dict, pid: str, page: dict, scan: Path) -> tuple[list, dict, list, dict]:
    """Krok ② na stronie: odczyt bramek do przeczytania, scalenie. Zwraca (gates, counts,
    uncertain, det) — `det` do snapshotu."""
    from PIL import Image

    gates = _steps.list_of(page.get("gates"))
    targets = [(i, m) for i, g in enumerate(gates) if (m := text_target(page, g))]
    reads: dict[int, dict] = {}
    with Image.open(scan) as im0:
        w, h = im0.size
        scan_im = im0.convert("L") if targets else None
    cv_src = None
    t_model = 0.0
    if targets:
        entries, cv_src = gates_cv_entries(ctx, pid, page, scan)
        ad = get_vlm(ctx)
        for n, (i, mode) in enumerate(targets, 1):
            g = gates[i]
            rec = read_gate(ad, scan_im, g, match_cv_pins(g, entries), ctx["gate_timeout"])
            rec["mode"] = mode
            reads[i] = rec
            t_model += float(rec["latency"] or 0)
            p = rec.get("pred") or {}
            what = (f"BŁĄD {rec['error']}" if rec["error"] else
                    f"{p.get('ref') or '?'} typ {p.get('type') or '?'} piny "
                    f"{p.get('pins', {}).get('left')}/{p.get('pins', {}).get('right')}")
            progress(ctx, f"{ctx['pkg']} {pid} text [{n}/{len(targets)}] ({g['x']:.0f},{g['y']:.0f}) "
                          f"{what} — {float(rec['latency'] or 0):.1f} s")
    components, ic_map = registry(ctx)
    new_gates, counts, uncertain, results = merge_text(page, pid, reads, components, ic_map)
    counts["model_s"] = round(t_model, 1)
    counts["cv_pins"] = cv_src
    snap_gates = []
    for i, rec in sorted(reads.items()):
        g = new_gates[i]
        res = results[i]
        snap_gates.append({
            "index": i, "x": g["x"], "y": g["y"], "w": g.get("w"), "h": g.get("h"),
            "rotation": g.get("rotation") or 0, "mode": rec["mode"],
            "ref": g.get("ref") if res["written"] else None,
            "gate": g.get("gate") if res["written"] else None,
            "pins": g.get("pins") if res["written"] else None,
            "written": res["written"], "ic": res.get("ic"), "type_read": res.get("type_read"),
            "uncertain": res["why"],
            "vlm": _clean({k: rec[k] for k in ("crop", "scale", "png_sha256", "raw", "obj", "pred",
                                                "error", "latency", "in_tok", "out_tok", "cv_pins")}),
        })
    ad = ctx.get("vlm")
    det = {"shape": (h, w), "tool": "scripts/_vlm.py (mlx-vlm)", "gates": snap_gates,
           "params": {"model": ctx["vlm_spec"], "prompt": TEXT_PROMPT,
                      "prompt_sha256": hashlib.sha256(_vlm.PROMPTS[TEXT_PROMPT]["gate"].encode()).hexdigest(),
                      "scale": TEXT_SCALE, "gate_timeout_s": ctx["gate_timeout"],
                      **(ad.params() if ad is not None and hasattr(ad, "params") else {}),
                      "cv_pins": cv_src}}
    return new_gates, counts, uncertain, det


def set_step(page: dict, step: str, run: str, at: str, *, forced_approved: bool,
             changed: bool, label_ends_changed: bool = True,
             extra: dict | None = None) -> list[str]:
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
    page["steps"][step] = {"status": "auto", "run": run, "at": at, **(extra or {})}
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
    elif step == "text":
        # surowe odpowiedzi modelu + kadry (bez obrazów wycinków) + wynik samokorekty
        body = {"gates": _plain(det["gates"]), "power": [], "ports": [], "cross_refs": [],
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
        if step == "text":
            paid = model_refusal(ctx["vlm_spec"], ctx["allow_paid"])
            if paid:
                code, why = paid
                rep.update(status="refused" if code == EXIT_REFUSED else "not_implemented",
                           exit=code, reason=why)
                return rep
        if not scan.is_file():
            raise AutoError(f"brak skanu {scan}")
        at = ctx["at"]
        run = ctx["run"]
        before = _steps.step_fingerprint(page, step)
        ends_before = _steps.label_anchor_ends(page)
        was_approved = _steps.step_status(page, step) == "approved"
        extra = None
        if step == "gates":
            det = detect_gates(read_gray(scan))
            gates, counts = merge_gates(page, det["entries"])
            page["gates"] = gates
        elif step == "text":
            gates, counts, uncertain, det = run_text(ctx, pid, page, scan)
            page["gates"] = gates
            rep["uncertain"] = uncertain
            extra = {"uncertain": uncertain} if uncertain else None
        else:
            gray = read_gray(scan)
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
                         label_ends_changed=ends_changed, extra=extra)
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
        if r["step"] == "text":
            body = (f"text: bramek {c['gates']}, czytane {c['targets']} — wypełnione "
                    f"{c['filled']}, zastąpione auto {c['replaced']}, zostawione (tekst ludzki) "
                    f"{c['kept_human']}, niepewne {c['uncertain']}, błędy modelu "
                    f"{c['errors']}, puste odczyty {c['empty_reads']}; piny z cv_pins "
                    f"{c['pins_from_cv']}, równo {c['pins_even']}; model {c['model_s']:.0f} s")
            if r.get("uncertain"):
                body += "; niepewne: " + ", ".join(
                    f"{u['ref'] or '?'}{u['gate'] or ''}" for u in r["uncertain"][:12]) + \
                    (" …" if len(r["uncertain"]) > 12 else "")
        elif r["step"] == "gates":
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
    ap.add_argument("--model", default=None,
                    help="text: mlx:<katalog modelu> (domyślnie $KRONIKARZ_VLM albo Qwen3.8-27B 4-bit)")
    ap.add_argument("--allow-paid", action="store_true",
                    help="text: zgoda na model płatny (hak — adapter niepodłączony, exit 3)")
    ap.add_argument("--gate-timeout", type=float, default=GATE_TIMEOUT_S,
                    help="text: limit odpowiedzi modelu na jedną bramkę [s]")
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
    t0 = time.perf_counter()
    spec = a.model or os.environ.get("KRONIKARZ_VLM") or f"mlx:{_vlm.DEFAULT_MLX_MODEL}"
    with tempfile.TemporaryDirectory(prefix="kronikarz-auto-") as tmp:
        ctx = {"data": data, "pkg": a.pkg, "pkg_dir": pkg_yaml.parent, "force": a.force,
               "draft": a.draft, "dry_run": a.dry_run, "at": now.strftime("%Y-%m-%dT%H:%M:%SZ"),
               "run": choose_run(data, a.pkg, [str(e["id"]) for e in entries], now),
               "vlm_spec": spec, "allow_paid": a.allow_paid, "gate_timeout": a.gate_timeout,
               "tmp_dir": Path(tmp), "vlm": None}
        for e in entries:
            res["pages"].append(run_page(ctx, e, a.step))
    if ctx["vlm"] is not None:
        res["vlm"] = {"model": spec, "load_s": ctx.get("vlm_load_s"), "prompt": TEXT_PROMPT,
                      "scale": TEXT_SCALE}
    res["time_s"] = round(time.perf_counter() - t0, 2)
    res["exit"] = max((r["exit"] for r in res["pages"]), key=_SEVERITY.__getitem__,
                      default=EXIT_OK)
    return emit(res)


if __name__ == "__main__":
    sys.exit(main())
