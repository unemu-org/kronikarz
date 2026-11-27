"""Pipeline etapowy (format v1.2) — reguły kroków dla writerów w Pythonie.

Port tych funkcji z `shared/src/steps.ts`, które są potrzebne przy ZAPISIE wyniku kroku
(scripts/auto.py). Te same reguły co w TypeScripcie; zmiana tutaj = zmiana tam (i odwrotnie):

  STEP_ORDER, STEP_STATUSES      kolejność kroków i stany
  step_status(page, step)        stepStatus: brak sekcji / kroku / zła wartość = 'todo'
  element_src(el, field)         elementSrc: wszystko poza 'auto' (także brak pola) = 'edited'
  can_run(page, step, ...)       canRun: poprzedni 'approved' (chyba że draft); 'approved'
                                 tylko z force
  next_runnable_step(page)       nextRunnableStep (STEP=next)
  mark_stale_after(page, step)   markStaleAfter: każdy PÓŹNIEJSZY 'approved' → 'stale'
  aspect_empty(kind, el, field)  aspectEmpty: czy CAŁY aspekt elementu jest pusty
  is_segment / is_junction       4 / 2 skończone liczby (bool to nie liczba, jak w JS)
  segment_key / junction_key     odcinek bez względu na kierunek
  auto_segment_mask / auto_junction_mask
                                 dopasowanie `auto_segments` / `auto_junctions` po wartości,
                                 z krotnością
  step_fingerprint(page, step)   stepFingerprint dla kroków, które pisze Python (gates, wires)

Klucze w Pythonie to krotki liczb `float` (110 == 110.0, jak w JS), nie JSON — porównujemy
je tylko między sobą. Czyste funkcje, bez I/O.
"""
from __future__ import annotations

import math
from collections import Counter
from typing import Any

STEP_ORDER: tuple[str, ...] = ("gates", "text", "wires", "labels", "nets")
STEP_STATUSES: tuple[str, ...] = ("todo", "auto", "approved", "stale")
SRC_FIELDS: tuple[str, ...] = ("src", "text_src", "net_src")
ELEMENT_KINDS: tuple[str, ...] = ("gate", "pin", "port", "cross_ref", "power")


def _steps(page: Any) -> dict:
    st = page.get("steps") if isinstance(page, dict) else None
    return st if isinstance(st, dict) else {}


def step_status(page: Any, step: str) -> str:
    """Stan kroku; brak sekcji, kroku albo nieznana wartość = 'todo'."""
    entry = _steps(page).get(step)
    st = entry.get("status") if isinstance(entry, dict) else None
    return st if isinstance(st, str) and st in STEP_STATUSES else "todo"


def element_src(el: Any, field: str = "src") -> str:
    """Pochodzenie aspektu elementu; wszystko poza 'auto' (także brak pola) = 'edited'."""
    return "auto" if isinstance(el, dict) and el.get(field) == "auto" else "edited"


def mark_stale_after(page: dict, step: str, at: str | None = None) -> list[str]:
    """Po zmianie kroku `step` każdy PÓŹNIEJSZY zatwierdzony krok staje się 'stale' (sam
    `step` zostaje, jaki był). Zwraca kroki, które zmienił."""
    changed: list[str] = []
    steps = page.get("steps")
    if not isinstance(steps, dict):
        return changed
    for s in STEP_ORDER[STEP_ORDER.index(step) + 1 :]:
        st = steps.get(s)
        if isinstance(st, dict) and st.get("status") == "approved":
            st["status"] = "stale"
            if at is not None:
                st["at"] = at
            changed.append(s)
    return changed


def can_run(page: Any, step: str, *, force: bool = False, draft: bool = False) -> tuple[bool, str]:
    """(ok, powód): poprzedni 'approved' (chyba że draft); 'approved' tylko z force."""
    if step not in STEP_ORDER:
        return False, f"nieznany krok „{step}”"
    if step_status(page, step) == "approved" and not force:
        return False, f"krok {step} jest zatwierdzony — ponowny przebieg tylko z --force"
    i = STEP_ORDER.index(step)
    if i > 0 and not draft:
        prev = STEP_ORDER[i - 1]
        st = step_status(page, prev)
        if st != "approved":
            return False, (f"poprzedni krok {prev} nie jest zatwierdzony ({st}) — "
                           "zatwierdź go albo użyj --draft")
    return True, ""


def next_runnable_step(page: Any) -> str | None:
    """Pierwszy krok, który nie jest zatwierdzony i może przebiec bez force/draft."""
    for s in STEP_ORDER:
        if step_status(page, s) == "approved":
            continue
        return s if can_run(page, s)[0] else None
    return None


def _blank(v: Any) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "")


def _is_num(v: Any) -> bool:
    return isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)


def _nonempty_list(v: Any) -> bool:
    return isinstance(v, list) and len(v) > 0


def aspect_empty(kind: str, el: Any, field: str) -> bool:
    """Czy CAŁY aspekt elementu jest pusty (zob. aspectEmpty w steps.ts):
      gate  src      — brak x/y
      gate  text_src — ref, gate, value, label_left, label_right puste i brak pinów
      pin   src      — brak num i side
      port  src      — connector, pin, label puste
      cross_ref src  — label puste i brak pages
      power src      — type puste
      *     net_src  — net pusty (pin: także brak cross)
    """
    o = el if isinstance(el, dict) else {}
    if field == "net_src":
        return _blank(o.get("net")) and (kind != "pin" or _blank(o.get("cross")))
    if field == "text_src":
        if kind != "gate":
            return False
        return (all(_blank(o.get(f)) for f in ("ref", "gate", "value", "label_left", "label_right"))
                and not _nonempty_list(o.get("pins")))
    if kind == "gate":
        return not _is_num(o.get("x")) and not _is_num(o.get("y"))
    if kind == "pin":
        return not _is_num(o.get("num")) and _blank(o.get("side"))
    if kind == "port":
        return _blank(o.get("connector")) and not _is_num(o.get("pin")) and _blank(o.get("label"))
    if kind == "cross_ref":
        return _blank(o.get("label")) and not _nonempty_list(o.get("pages"))
    if kind == "power":
        return _blank(o.get("type"))
    raise ValueError(f"nieznany rodzaj elementu {kind!r}")


# --- druty ---

def _is_point(v: Any, n: int) -> bool:
    return isinstance(v, (list, tuple)) and len(v) == n and all(_is_num(x) for x in v)


def is_segment(v: Any) -> bool:
    """Poprawny odcinek [x1, y1, x2, y2] (4 skończone liczby)."""
    return _is_point(v, 4)


def is_junction(v: Any) -> bool:
    """Poprawna kropka [x, y]."""
    return _is_point(v, 2)


def list_of(v: Any) -> list:
    """Lista z pliku: nie-lista = pusta (zły plik nie może zablokować zapisu)."""
    return v if isinstance(v, list) else []


def _num(v: Any) -> Any:
    """Liczba jak w JS (JSON.stringify): 545.0 == 545, -0 == 0; reszta bez zmian."""
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        return float(v) + 0.0
    return v


def segment_key(s: Any) -> tuple:
    """Odcinek bez względu na kierunek; zły wpis = klucz, którego nie ma żaden poprawny."""
    if not is_segment(s):
        return ("bad", repr(s))
    x1, y1, x2, y2 = (_num(v) for v in s)
    return (x1, y1, x2, y2) if (x1 < x2 or (x1 == x2 and y1 <= y2)) else (x2, y2, x1, y1)


def junction_key(j: Any) -> tuple:
    return (_num(j[0]), _num(j[1])) if is_junction(j) else ("bad", repr(j))


def _mask(items: Any, autos: Any, valid, key) -> list[bool]:
    bag: Counter = Counter(key(a) for a in list_of(autos) if valid(a))
    out = []
    for it in list_of(items):
        k = key(it) if valid(it) else None
        if k is not None and bag[k] > 0:
            bag[k] -= 1
            out.append(True)
        else:
            out.append(False)
    return out


def auto_segment_mask(net: Any) -> list[bool]:
    """Odcinki netu, które są 'auto' (dopasowanie po wartości, z krotnością)."""
    n = net if isinstance(net, dict) else {}
    return _mask(n.get("segments"), n.get("auto_segments"), is_segment, segment_key)


def auto_junction_mask(net: Any) -> list[bool]:
    n = net if isinstance(net, dict) else {}
    return _mask(n.get("junctions"), n.get("auto_junctions"), is_junction, junction_key)


# --- odcisk treści kroku (tylko kroki pisane w Pythonie) ---

def _gate_box_key(g: dict) -> tuple:
    rot = g.get("rotation")
    return tuple(_num(v) for v in (g.get("x"), g.get("y"), g.get("w"), g.get("h"),
                                   0 if rot is None else rot))


def step_fingerprint(page: dict, step: str) -> list:
    """Multizbiór kluczy aspektów kroku (jak stepFingerprint w steps.ts), posortowany.
    Zaimplementowane: gates, wires."""
    out: list = []
    if step == "gates":
        for g in list_of(page.get("gates")):
            if isinstance(g, dict):
                out.append(repr(_gate_box_key(g)))
    elif step == "wires":
        nets = page.get("nets")
        for n in (nets.values() if isinstance(nets, dict) else []):
            n = n if isinstance(n, dict) else {}
            out += ["s" + repr(segment_key(s)) for s in list_of(n.get("segments"))]
            out += ["j" + repr(junction_key(j)) for j in list_of(n.get("junctions"))]
    else:
        raise ValueError(f"step_fingerprint: krok {step!r} nie jest zaimplementowany w Pythonie")
    return sorted(out)
