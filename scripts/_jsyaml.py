"""YAML jak w viewerze: wczytywanie i zapis zgodne z js-yaml 4 (`shared/src/parse.ts`).

  load(text)       — PyYAML SafeLoader z resolverami js-yaml (DEFAULT_SCHEMA = YAML 1.2 core
                     + timestamp + merge): `yes`/`no`/`on`/`off` to napisy, `012` = 12,
                     `1e3` = liczba, bez sześćdziesiątkowych liczb i bez `=` (value).
  dump(obj)        — bajt w bajt to, co daje `serializePage` viewera: js-yaml `dump` z opcjami
                     {indent: 2, lineWidth: 120, noRefs: true, quotingType: '"',
                     forceQuotes: false, sortKeys: false} (flowLevel -1: wszystko blokowo,
                     puste `[]` / `{}`). Port writeNode / writeBlockMapping /
                     writeBlockSequence / writeScalar / chooseScalarStyle / foldString
                     z node_modules/js-yaml/lib/dumper.js (4.1.1).
  splice(old_text, new_doc)
                   — zapis z minimalnym diffem: sekcje najwyższego poziomu, których wartość
                     się nie zmieniła, zostają bajt w bajt (także w stylu innego writera,
                     np. gen-stubs); zmienione / nowe sekcje są w stylu viewera. Wynik jest
                     sprawdzany: wczytany musi być równy `new_doc`, inaczej pełny `dump`.

Liczby jak w JS: całkowita liczba zmiennoprzecinkowa (545.0) to `545`, -0.0 to `-0.0`,
wykładnik jak w Number.prototype.toString. Klucze map jak w obiekcie JS: klucze-indeksy
("0", "12") najpierw, rosnąco, potem reszta w kolejności wstawienia.
Ograniczenie: długość linii w stylu folded liczona w punktach kodowych (JS: jednostki UTF-16)
— różnica tylko dla znaków spoza BMP w napisach dłuższych niż ~100 znaków.
"""
from __future__ import annotations

import datetime as _dt
import math
import re
from typing import Any

import yaml

# --------------------------------------------------------------------------- wczytywanie

_INT_RE = re.compile(
    r"^(?:[-+]?0b(?=[01_]*[01])[01_]*(?<!_)"
    r"|[-+]?0x(?=[0-9a-fA-F_]*[0-9a-fA-F])[0-9a-fA-F_]*(?<!_)"
    r"|[-+]?0o(?=[0-7_]*[0-7])[0-7_]*(?<!_)"
    r"|[-+]?(?:0|0[0-9][0-9_]*|[1-9][0-9_]*)(?<!_))\Z")
_FLOAT_RE = re.compile(
    r"^(?:[-+]?(?:[0-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?"
    r"|\.[0-9_]+(?:[eE][-+]?[0-9]+)?"
    r"|[-+]?\.(?:inf|Inf|INF)"
    r"|\.(?:nan|NaN|NAN))(?<!_)\Z")  # resolveYamlFloat: ostatni znak nie `_`
_NULL_RE = re.compile(r"^(?:~|null|Null|NULL|)\Z")
_BOOL_RE = re.compile(r"^(?:true|True|TRUE|false|False|FALSE)\Z")
_TS_RE = re.compile(
    r"^(?:[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]"
    r"|[0-9][0-9][0-9][0-9]-[0-9][0-9]?-[0-9][0-9]?(?:[Tt]|[ \t]+)[0-9][0-9]?:[0-9][0-9]:[0-9][0-9]"
    r"(?:\.[0-9]*)?(?:[ \t]*(?:Z|[-+][0-9][0-9]?(?::[0-9][0-9])?))?)\Z")
_MERGE_RE = re.compile(r"^<<\Z")


class Loader(yaml.SafeLoader):
    def construct_mapping(self, node, deep=False):
        """Jak js-yaml: powtórzony klucz mapy (także 1 i '1' — w JS to ten sam klucz) = błąd."""
        if isinstance(node, yaml.MappingNode):
            seen = set()
            for kn, _ in node.value:
                if kn.tag == "tag:yaml.org,2002:merge":
                    continue
                k = _key_str(self.construct_object(kn, deep=True))
                if k in seen:
                    raise yaml.constructor.ConstructorError(
                        "while constructing a mapping", node.start_mark,
                        f"duplicated mapping key {k!r}", kn.start_mark)
                seen.add(k)
        return super().construct_mapping(node, deep=deep)


Loader.yaml_implicit_resolvers = {}
for _tag, _re, _first in (
        ("tag:yaml.org,2002:null", _NULL_RE, ["~", "n", "N", ""]),
        ("tag:yaml.org,2002:bool", _BOOL_RE, list("tTfF")),
        ("tag:yaml.org,2002:int", _INT_RE, list("-+0123456789")),
        ("tag:yaml.org,2002:float", _FLOAT_RE, list("-+0123456789.")),
        ("tag:yaml.org,2002:timestamp", _TS_RE, list("0123456789")),
        ("tag:yaml.org,2002:merge", _MERGE_RE, ["<"])):
    Loader.add_implicit_resolver(_tag, _re, _first)


def _construct_int(loader, node):
    v = loader.construct_scalar(node).replace("_", "")
    sign = -1 if v[0] == "-" else 1
    if v[0] in "+-":
        v = v[1:]
    for p, base in (("0b", 2), ("0x", 16), ("0o", 8)):
        if v.startswith(p):
            return sign * int(v[2:], base)
    return sign * int(v, 10)


def _construct_float(loader, node):
    v = loader.construct_scalar(node).replace("_", "").lower()
    sign = -1.0 if v[0] == "-" else 1.0
    if v[0] in "+-":
        v = v[1:]
    if v == ".inf":
        return sign * math.inf
    if v == ".nan":
        return math.nan
    return sign * float(v)


Loader.add_constructor("tag:yaml.org,2002:int", _construct_int)
Loader.add_constructor("tag:yaml.org,2002:float", _construct_float)


def load(text: str) -> Any:
    return yaml.load(text, Loader=Loader)


# --------------------------------------------------------------------------- zapis

INDENT = 2
LINE_WIDTH = 120

_ESC = {0x00: "\\0", 0x07: "\\a", 0x08: "\\b", 0x09: "\\t", 0x0A: "\\n", 0x0B: "\\v",
        0x0C: "\\f", 0x0D: "\\r", 0x1B: "\\e", 0x22: '\\"', 0x5C: "\\\\", 0x85: "\\N",
        0xA0: "\\_", 0x2028: "\\L", 0x2029: "\\P"}
_DEPRECATED_BOOLS = {"y", "Y", "yes", "Yes", "YES", "on", "On", "ON",
                     "n", "N", "no", "No", "NO", "off", "Off", "OFF"}
_BASE60 = re.compile(r"^[-+]?[0-9_]+(?::[0-9_]+)+(?:\.[0-9_]*)?\Z")
_FIRST_UNSAFE = set(map(ord, "-?:,[]{}#&*!|=>'\"%@`"))


def _printable(c: int) -> bool:
    return (0x20 <= c <= 0x7E or (0xA1 <= c <= 0xD7FF and c not in (0x2028, 0x2029))
            or (0xE000 <= c <= 0xFFFD and c != 0xFEFF) or 0x10000 <= c <= 0x10FFFF)


def _ws(c) -> bool:
    return c in (0x20, 0x09)


def _ns_or_ws(c) -> bool:
    return c is not None and _printable(c) and c not in (0xFEFF, 0x0D, 0x0A)


def _plain_safe(c: int, prev, inblock: bool) -> bool:
    c_ns_ws = _ns_or_ws(c)
    c_ns = c_ns_ws and not _ws(c)
    base = c_ns_ws if inblock else (c_ns_ws and c not in (0x2C, 0x5B, 0x5D, 0x7B, 0x7D))
    return ((base and c != 0x23 and not (prev == 0x3A and not c_ns))
            or (_ns_or_ws(prev) and not _ws(prev) and c == 0x23)
            or (prev == 0x3A and c_ns))


def _plain_first(c: int) -> bool:
    return _printable(c) and c != 0xFEFF and not _ws(c) and c not in _FIRST_UNSAFE


def _plain_last(c: int) -> bool:
    return not _ws(c) and c != 0x3A


def _ambiguous(s: str) -> bool:
    """testImplicitResolving: null, bool, int, float, timestamp, merge."""
    return bool(s in ("~", "null", "Null", "NULL") or _BOOL_RE.match(s) or _INT_RE.match(s)
                or _FLOAT_RE.match(s) or _TS_RE.match(s) or s == "<<")


PLAIN, LITERAL, FOLDED, DOUBLE = 1, 3, 4, 5


def _choose_style(s: str, single_line_only: bool, line_width: int, inblock: bool) -> int:
    plain = _plain_first(ord(s[0])) and _plain_last(ord(s[-1]))
    prev = None
    has_lb = has_fold = False
    prev_lb = -1
    i = 0
    if single_line_only:
        for ch in s:
            c = ord(ch)
            if not _printable(c):
                return DOUBLE
            plain = plain and _plain_safe(c, prev, inblock)
            prev = c
    else:
        for i, ch in enumerate(s):
            c = ord(ch)
            if c == 0x0A:
                has_lb = True
                has_fold = has_fold or (i - prev_lb - 1 > line_width and s[prev_lb + 1] != " ")
                prev_lb = i
            elif not _printable(c):
                return DOUBLE
            plain = plain and _plain_safe(c, prev, inblock)
            prev = c
        i = len(s)
        has_fold = has_fold or (i - prev_lb - 1 > line_width and
                                (s[prev_lb + 1] if prev_lb + 1 < len(s) else None) != " ")
    if not has_lb and not has_fold:
        return PLAIN if plain and not _ambiguous(s) else DOUBLE
    return FOLDED if has_fold else LITERAL


def _block_header(s: str) -> str:
    ind = str(INDENT) if re.match(r"^\n* ", s) else ""
    clip = s[-1] == "\n"
    keep = clip and ((len(s) >= 2 and s[-2] == "\n") or s == "\n")
    return ind + ("+" if keep else ("" if clip else "-")) + "\n"


def _drop_ending_nl(s: str) -> str:
    return s[:-1] if s.endswith("\n") else s


def _indent_string(s: str, spaces: int) -> str:
    ind = " " * spaces
    out = []
    for line in s.splitlines(keepends=True):
        if line and line != "\n":
            out.append(ind)
        out.append(line)
    return "".join(out)


def _fold_line(line: str, width: int) -> str:
    if line == "" or line[0] == " ":
        return line
    start = curr = 0
    result = ""
    for m in re.finditer(r" [^ ]", line):
        nxt = m.start()
        if nxt - start > width:
            end = curr if curr > start else nxt
            result += "\n" + line[start:end]
            start = end + 1
        curr = nxt
    result += "\n"
    if len(line) - start > width and curr > start:
        result += line[start:curr] + "\n" + line[curr + 1:]
    else:
        result += line[start:]
    return result[1:]


def _fold_string(s: str, width: int) -> str:
    nl = s.find("\n")
    nl = nl if nl != -1 else len(s)
    result = _fold_line(s[:nl], width)
    prev_more = s[:1] in ("\n", " ")
    for m in re.compile(r"(\n+)([^\n]*)").finditer(s, nl):
        prefix, line = m.group(1), m.group(2)
        more = line[:1] == " "
        result += prefix + ("\n" if (not prev_more and not more and line != "") else "") + \
            _fold_line(line, width)
        prev_more = more
    return result


def _escape(s: str) -> str:
    out = []
    for ch in s:
        c = ord(ch)
        e = _ESC.get(c)
        if e is None and _printable(c):
            out.append(ch)
        elif e is not None:
            out.append(e)
        elif c <= 0xFF:
            out.append(f"\\x{c:02X}")
        elif c <= 0xFFFF:
            out.append(f"\\u{c:04X}")
        else:
            out.append(f"\\U{c:08X}")
    return "".join(out)


def _scalar(s: str, level: int, iskey: bool, inblock: bool) -> str:
    if s == "":
        return '""'
    if s in _DEPRECATED_BOOLS or _BASE60.match(s):
        return '"' + s + '"'
    indent = INDENT * max(1, level)
    line_width = max(min(LINE_WIDTH, 40), LINE_WIDTH - indent)
    style = _choose_style(s, iskey, line_width, inblock)
    if style == PLAIN:
        return s
    if style == LITERAL:
        return "|" + _block_header(s) + _drop_ending_nl(_indent_string(s, indent))
    if style == FOLDED:
        return ">" + _block_header(s) + _drop_ending_nl(_indent_string(_fold_string(s, line_width), indent))
    return '"' + _escape(s) + '"'


def js_number(v: float | int) -> str:
    """Liczba tak, jak zapisze ją js-yaml (int: toString(10); float: representYamlFloat)."""
    if isinstance(v, int):
        return str(v)
    if math.isnan(v):
        return ".nan"
    if math.isinf(v):
        return ".inf" if v > 0 else "-.inf"
    if v == 0 and math.copysign(1.0, v) < 0:
        return "-0.0"
    s = _js_to_string(v)
    return re.sub(r"^([-+]?[0-9]+)e", r"\1.e", s) if not v.is_integer() else s


def _js_to_string(v: float) -> str:
    """Number.prototype.toString(10) dla skończonej liczby."""
    if v == 0:
        return "0"
    sign = "-" if v < 0 else ""
    r = repr(abs(v))  # najkrótsza reprezentacja — te same cyfry co w JS
    m = re.match(r"^(\d+)(?:\.(\d+))?(?:e([-+]\d+))?\Z", r)
    ip, fp, ex = m.group(1), m.group(2) or "", int(m.group(3) or 0)
    digits = (ip + fp).lstrip("0")
    # wykładnik dziesiętny n: wartość = 0.digits * 10^n
    n = len(ip) + ex if ip.strip("0") else ex - (len(fp) - len(fp.lstrip("0")))
    digits = digits.rstrip("0") or "0"
    k = len(digits)
    if k <= n <= 21:
        return sign + digits + "0" * (n - k)
    if 0 < n <= 21:
        return sign + digits[:n] + "." + digits[n:]
    if -6 < n <= 0:
        return sign + "0." + "0" * (-n) + digits
    e = n - 1
    es = f"e+{e}" if e >= 0 else f"e-{-e}"
    return sign + (digits if k == 1 else digits[0] + "." + digits[1:]) + es


def _iso(v) -> str:
    if isinstance(v, _dt.datetime):
        if v.tzinfo is not None:
            v = v.astimezone(_dt.timezone.utc).replace(tzinfo=None)
    else:
        v = _dt.datetime(v.year, v.month, v.day)
    return v.strftime("%Y-%m-%dT%H:%M:%S.") + f"{v.microsecond // 1000:03d}Z"


_INDEX_KEY = re.compile(r"^(?:0|[1-9][0-9]*)\Z")


def _key_str(k) -> str:
    if isinstance(k, str):
        return k
    if isinstance(k, bool):
        return "true" if k else "false"
    if k is None:
        return "null"
    if isinstance(k, (int, float)):
        return _js_to_string(float(k)) if isinstance(k, float) else str(k)
    raise TypeError(f"klucz nieobsługiwany w zapisie: {k!r}")


def js_keys(d: dict) -> list:
    """Kolejność Object.keys: klucze-indeksy rosnąco, potem reszta w kolejności wstawienia."""
    ks = [(_key_str(k), k) for k in d]
    idx = sorted((p for p in ks if _INDEX_KEY.match(p[0]) and int(p[0]) < 2**32 - 1),
                 key=lambda p: int(p[0]))
    rest = [p for p in ks if not (_INDEX_KEY.match(p[0]) and int(p[0]) < 2**32 - 1)]
    return idx + rest


def _nl(level: int) -> str:
    return "\n" + " " * (INDENT * level)


def _node(v: Any, level: int, compact: bool, iskey: bool = False) -> str:
    if v is None:
        return "null"
    if isinstance(v, bool):
        return "true" if v else "false"
    if isinstance(v, (int, float)):
        return js_number(v)
    if isinstance(v, (_dt.date, _dt.datetime)):
        return _iso(v)
    if isinstance(v, str):
        return _scalar(v, level, iskey, True)
    if isinstance(v, dict):
        if not v:
            return "{}"
        out = ""
        for ks, k in js_keys(v):
            pair = _nl(level) if (not compact or out) else ""
            kd = _node(ks, level + 1, True, iskey=True)
            if len(kd) > 1024:
                raise ValueError("klucz > 1024 znaków — nieobsługiwany")
            vd = _node(v[k], level + 1, False)
            out += pair + kd + (":" if vd.startswith("\n") else ": ") + vd
        return out
    if isinstance(v, (list, tuple)):
        if not v:
            return "[]"
        out = ""
        for item in v:
            d = _node(item, level + 1, True)
            out += (_nl(level) if (not compact or out) else "") + ("-" if d.startswith("\n") else "- ") + d
        return out
    raise TypeError(f"typ nieobsługiwany w zapisie: {type(v).__name__}")


def dump(doc: Any) -> str:
    """js-yaml dump(doc, opcje serializePage) — bajt w bajt."""
    return _node(doc, 0, True) + "\n"


class RoundTripError(ValueError):
    """Tekst do zapisu nie wczytuje się z powrotem jako ten sam dokument."""


def check_reload(text: str, doc: Any) -> str:
    """`text`, jeśli wczytany daje `doc` (jak w JS); inaczej RoundTripError — nic nie zapisujemy."""
    try:
        ok = same(load(text), doc)
    except yaml.YAMLError as e:
        raise RoundTripError(f"zapisany YAML się nie wczytuje: {e}") from None
    if not ok:
        raise RoundTripError("zapisany YAML wczytuje się jako inny dokument — nie zapisuję")
    return text


def dump_checked(doc: Any) -> str:
    """`dump` + sprawdzenie, że wynik wczytuje się z powrotem jako `doc`."""
    return check_reload(dump(doc), doc)


# --------------------------------------------------------------------------- minimalny diff

def same(a: Any, b: Any) -> bool:
    """Równość wartości jak po wczytaniu w JS (bool ≠ liczba, 1 == 1.0, NaN == NaN)."""
    if isinstance(a, bool) or isinstance(b, bool):
        return type(a) is type(b) and a == b
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return a == b or (a != a and b != b)
    if isinstance(a, dict) and isinstance(b, dict):
        ka, kb = js_keys(a), js_keys(b)
        return [k for k, _ in ka] == [k for k, _ in kb] and \
            all(same(a[x], b[y]) for (_, x), (_, y) in zip(ka, kb))
    if isinstance(a, (list, tuple)) and isinstance(b, (list, tuple)):
        return len(a) == len(b) and all(same(x, y) for x, y in zip(a, b))
    return type(a) is type(b) and a == b


def _top_blocks(text: str) -> tuple[str, list[tuple[str, str]]] | None:
    """Podział na prefiks i sekcje najwyższego poziomu [(klucz, tekst sekcji)]. None, gdy
    tekst nie ma postaci „mapa blokowa z kluczami w kolumnie 0”."""
    lines = text.splitlines(keepends=True)
    prefix, blocks, cur = "", [], None
    for ln in lines:
        top = ln[:1] not in ("", " ", "\t", "-", "#", "\n", "\r") and not ln.startswith(("---", "..."))
        if top:
            if cur is not None:
                blocks.append(cur)
            cur = [ln]
        elif cur is None:
            prefix += ln
        else:
            cur.append(ln)
    if cur is not None:
        blocks.append(cur)
    out = []
    for b in blocks:
        t = "".join(b)
        try:
            d = load(t)
        except yaml.YAMLError:
            return None
        if not isinstance(d, dict) or len(d) != 1:
            return None
        out.append((_key_str(next(iter(d))), t))
    return prefix, out


def splice(old_text: str, new_doc: dict) -> str:
    """Tekst `new_doc` z minimalnym diffem względem `old_text` (zob. docstring modułu)."""
    full = dump_checked(new_doc)
    if old_text == dump(load(old_text)):
        return full  # plik już w stylu viewera — pełny zapis = minimalny diff
    parsed = _top_blocks(old_text)
    if parsed is None:
        return full
    prefix, blocks = parsed
    old = load(old_text)
    if not isinstance(old, dict):
        return full
    old_by_key = {_key_str(k): v for k, v in old.items()}
    text_by_key = dict(blocks)
    if len(text_by_key) != len(blocks) or set(text_by_key) != set(old_by_key):
        return full
    parts = [prefix]
    for ks, k in js_keys(new_doc):
        v = new_doc[k]
        if ks in text_by_key and same(old_by_key[ks], v):
            t = text_by_key[ks]
            parts.append(t if t.endswith("\n") else t + "\n")
        else:
            parts.append(dump({ks: v}))
    out = "".join(parts)
    try:
        ok = same(load(out), new_doc)
    except yaml.YAMLError:
        ok = False
    return out if ok else full
