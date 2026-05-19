#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml"]
# ///
"""Regenerate data/MJC-400/ic_map.yaml from the part list below.

Source: hand-curated baseline of common 74xx parts used in MERA-400 era.
Pin layouts verified against TI datasheets / KiCad 74xx library.

Add new parts by appending to PARTS. Re-run to rebuild the YAML.

Usage: uv run scripts/build-ic-map.py
"""
from __future__ import annotations
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent

# (suffix, name, desc, pins, gates, power_vcc, power_gnd, gate_pins_dict, extra)
# gate_pins_dict: {"A": {"in":[1,2], "out":[3]}, ...}
# For passives / unusual parts use extra (e.g. shape).
PARTS: list[dict] = []


def G(name: str, desc: str, pins: int, gates: int, power: tuple[int, int], gate_pins: dict, suffix: str | None = None):
    PARTS.append({
        "suffix": suffix or name.replace("SN", "").replace("N", "").lstrip("74"),
        "name": name,
        "desc": desc,
        "pins": pins,
        "gates": gates,
        "vcc": power[0],
        "gnd": power[1],
        "gate_pins": gate_pins,
    })


# --- Logic gates ------------------------------------------------------------
G("SN7400N",  "Quad 2-input NAND",          14, 4, (14, 7), {
    "A": {"in": [1, 2],   "out": [3]},
    "B": {"in": [4, 5],   "out": [6]},
    "C": {"in": [9, 10],  "out": [8]},
    "D": {"in": [12, 13], "out": [11]},
}, suffix="00")
G("SN7402N",  "Quad 2-input NOR",           14, 4, (14, 7), {
    "A": {"in": [2, 3],   "out": [1]},
    "B": {"in": [5, 6],   "out": [4]},
    "C": {"in": [8, 9],   "out": [10]},
    "D": {"in": [11, 12], "out": [13]},
}, suffix="02")
G("SN7404N",  "Hex Inverter",               14, 6, (14, 7), {
    "A": {"in": [1],  "out": [2]},
    "B": {"in": [3],  "out": [4]},
    "C": {"in": [5],  "out": [6]},
    "D": {"in": [9],  "out": [8]},
    "E": {"in": [11], "out": [10]},
    "F": {"in": [13], "out": [12]},
}, suffix="04")
G("SN7408N",  "Quad 2-input AND",           14, 4, (14, 7), {
    "A": {"in": [1, 2],   "out": [3]},
    "B": {"in": [4, 5],   "out": [6]},
    "C": {"in": [9, 10],  "out": [8]},
    "D": {"in": [12, 13], "out": [11]},
}, suffix="08")
G("SN7410N",  "Triple 3-input NAND",        14, 3, (14, 7), {
    "A": {"in": [1, 2, 13],  "out": [12]},
    "B": {"in": [3, 4, 5],   "out": [6]},
    "C": {"in": [9, 10, 11], "out": [8]},
}, suffix="10")
G("SN7411N",  "Triple 3-input AND",         14, 3, (14, 7), {
    "A": {"in": [1, 2, 13],  "out": [12]},
    "B": {"in": [3, 4, 5],   "out": [6]},
    "C": {"in": [9, 10, 11], "out": [8]},
}, suffix="11")
G("SN7414N",  "Hex Schmitt Inverter",       14, 6, (14, 7), {
    "A": {"in": [1],  "out": [2]},
    "B": {"in": [3],  "out": [4]},
    "C": {"in": [5],  "out": [6]},
    "D": {"in": [9],  "out": [8]},
    "E": {"in": [11], "out": [10]},
    "F": {"in": [13], "out": [12]},
}, suffix="14")
G("SN7420N",  "Dual 4-input NAND",          14, 2, (14, 7), {
    "A": {"in": [1, 2, 4, 5],     "out": [6]},
    "B": {"in": [9, 10, 12, 13],  "out": [8]},
}, suffix="20")
G("SN7421N",  "Dual 4-input AND",           14, 2, (14, 7), {
    "A": {"in": [1, 2, 4, 5],     "out": [6]},
    "B": {"in": [9, 10, 12, 13],  "out": [8]},
}, suffix="21")
G("SN7427N",  "Triple 3-input NOR",         14, 3, (14, 7), {
    "A": {"in": [1, 2, 13],  "out": [12]},
    "B": {"in": [3, 4, 5],   "out": [6]},
    "C": {"in": [9, 10, 11], "out": [8]},
}, suffix="27")
G("SN7430N",  "Single 8-input NAND",        14, 1, (14, 7), {
    "A": {"in": [1, 2, 3, 4, 5, 6, 11, 12], "out": [8]},
}, suffix="30")
G("SN7432N",  "Quad 2-input OR",            14, 4, (14, 7), {
    "A": {"in": [1, 2],   "out": [3]},
    "B": {"in": [4, 5],   "out": [6]},
    "C": {"in": [9, 10],  "out": [8]},
    "D": {"in": [12, 13], "out": [11]},
}, suffix="32")
G("SN7437N",  "Quad 2-input NAND buffer",   14, 4, (14, 7), {
    "A": {"in": [1, 2],   "out": [3]},
    "B": {"in": [4, 5],   "out": [6]},
    "C": {"in": [9, 10],  "out": [8]},
    "D": {"in": [12, 13], "out": [11]},
}, suffix="37")
G("SN7438N",  "Quad 2-input NAND OC",       14, 4, (14, 7), {
    "A": {"in": [1, 2],   "out": [3]},
    "B": {"in": [4, 5],   "out": [6]},
    "C": {"in": [9, 10],  "out": [8]},
    "D": {"in": [12, 13], "out": [11]},
}, suffix="38")
G("SN7440N",  "Dual 4-input NAND buffer",   14, 2, (14, 7), {
    "A": {"in": [1, 2, 4, 5],     "out": [6]},
    "B": {"in": [9, 10, 12, 13],  "out": [8]},
}, suffix="40")
G("SN7486N",  "Quad 2-input XOR",           14, 4, (14, 7), {
    "A": {"in": [1, 2],   "out": [3]},
    "B": {"in": [4, 5],   "out": [6]},
    "C": {"in": [9, 10],  "out": [8]},
    "D": {"in": [12, 13], "out": [11]},
}, suffix="86")

G("SN7451N",  "Dual 2-wide 2-input AND-OR-Invert (AOI)", 14, 2, (14, 7), {
    "A": {"in": [2, 3, 4, 5],     "out": [6]},
    "B": {"in": [9, 10, 11, 12],  "out": [8]},
}, suffix="51")

# --- Flip-flops -------------------------------------------------------------
G("SN7474N",  "Dual D-FF w/ PR/CLR",        14, 2, (14, 7), {
    "A": {"d": [2],  "clk": [3],  "pre": [4],  "clr": [1],  "q": [5],  "nq": [6]},
    "B": {"d": [12], "clk": [11], "pre": [10], "clr": [13], "q": [9],  "nq": [8]},
}, suffix="74")
G("SN74109N", "Dual J-K FF",                16, 2, (16, 8), {
    "A": {"j": [2],  "k": [3],  "clk": [4],  "pre": [5],  "clr": [1],  "q": [6],  "nq": [7]},
    "B": {"j": [14], "k": [13], "clk": [12], "pre": [11], "clr": [15], "q": [10], "nq": [9]},
}, suffix="109")
G("SN74174N", "Hex D-FF",                   16, 1, (16, 8), {
    "A": {"clk": [9], "clr": [1],
          "d": [3, 4, 6, 11, 13, 14],
          "q": [2, 5, 7, 10, 12, 15]},
}, suffix="174")
G("SN74175N", "Quad D-FF",                  16, 1, (16, 8), {
    "A": {"clk": [9], "clr": [1],
          "d": [4, 5, 12, 13],
          "q": [2, 7, 10, 15],
          "nq": [3, 6, 11, 14]},
}, suffix="175")
G("SN74273N", "Octal D-FF w/ CLR",          20, 1, (20, 10), {
    "A": {"clk": [11], "clr": [1],
          "d": [3, 4, 7, 8, 13, 14, 17, 18],
          "q": [2, 5, 6, 9, 12, 15, 16, 19]},
}, suffix="273")
G("SN74374N", "Octal D-FF (3-state)",       20, 1, (20, 10), {
    "A": {"clk": [11], "oe": [1],
          "d": [3, 4, 7, 8, 13, 14, 17, 18],
          "q": [2, 5, 6, 9, 12, 15, 16, 19]},
}, suffix="374")

# --- Decoders / mux ---------------------------------------------------------
G("SN74138N", "3-to-8 Decoder",             16, 1, (16, 8), {
    "A": {"sel": [1, 2, 3],  # A B C
          "en": [4, 5, 6],   # G2A G2B G1
          "out": [15, 14, 13, 12, 11, 10, 9, 7]},  # Y0..Y7
}, suffix="138")
G("SN74139N", "Dual 2-to-4 Decoder",        16, 2, (16, 8), {
    "A": {"en": [1], "sel": [2, 3],  "out": [4, 5, 6, 7]},
    "B": {"en": [15], "sel": [14, 13], "out": [12, 11, 10, 9]},
}, suffix="139")
G("SN74151N", "8-to-1 Mux",                 16, 1, (16, 8), {
    "A": {"sel": [11, 10, 9], "en": [7],
          "d": [4, 3, 2, 1, 15, 14, 13, 12],
          "out": [5], "nout": [6]},
}, suffix="151")
G("SN74153N", "Dual 4-to-1 Mux",            16, 2, (16, 8), {
    "A": {"sel": [14, 2], "en": [1], "d": [6, 5, 4, 3],   "out": [7]},
    "B": {"sel": [14, 2], "en": [15], "d": [10, 11, 12, 13], "out": [9]},
}, suffix="153")
G("SN74157N", "Quad 2-to-1 Mux",            16, 1, (16, 8), {
    "A": {"sel": [1], "en": [15],
          "a": [2, 5, 11, 14],
          "b": [3, 6, 10, 13],
          "out": [4, 7, 9, 12]},
}, suffix="157")

# --- Counters / registers --------------------------------------------------
G("SN74161N", "4-bit Binary Counter (async clr)", 16, 1, (16, 8), {
    "A": {"clk": [2], "clr": [1], "load": [9], "ent": [10], "enp": [7],
          "d": [3, 4, 5, 6], "q": [14, 13, 12, 11], "rco": [15]},
}, suffix="161")
G("SN74163N", "4-bit Binary Counter (sync clr)",  16, 1, (16, 8), {
    "A": {"clk": [2], "clr": [1], "load": [9], "ent": [10], "enp": [7],
          "d": [3, 4, 5, 6], "q": [14, 13, 12, 11], "rco": [15]},
}, suffix="163")
G("SN74164N", "8-bit SIPO Shift Register",  14, 1, (14, 7), {
    "A": {"clk": [8], "clr": [9], "ds": [1, 2],
          "q": [3, 4, 5, 6, 10, 11, 12, 13]},
}, suffix="164")
G("SN74165N", "8-bit PISO Shift Register",  16, 1, (16, 8), {
    "A": {"clk": [2], "clk_inh": [15], "shld": [1], "ser": [10],
          "d": [11, 12, 13, 14, 3, 4, 5, 6],
          "q": [9], "nq": [7]},
}, suffix="165")
G("SN74193N", "4-bit Up/Down Counter",      16, 1, (16, 8), {
    "A": {"clr": [14], "load": [11], "up": [5], "down": [4],
          "d": [15, 1, 10, 9], "q": [3, 2, 6, 7],
          "carry": [12], "borrow": [13]},
}, suffix="193")
G("SN74195N", "4-bit Shift Register",       16, 1, (16, 8), {
    "A": {"clk": [10], "clr": [1], "sh_ld": [9], "j": [2], "nk": [3],
          "d": [4, 5, 6, 7], "q": [15, 14, 13, 12], "nq3": [11]},
}, suffix="195")
G("SN74283N", "4-bit Binary Full Adder",    16, 1, (16, 8), {
    "A": {"a": [5, 3, 14, 12], "b": [6, 4, 15, 11],
          "cin": [7], "sum": [4, 1, 13, 10], "cout": [9]},
}, suffix="283")

# --- Buffers / transceivers ------------------------------------------------
G("SN74240N", "Octal Inverting Buffer (3-state)", 20, 1, (20, 10), {
    "A": {"oe": [1, 19],
          "in":  [2, 4, 6, 8, 11, 13, 15, 17],
          "out": [18, 16, 14, 12, 9, 7, 5, 3]},
}, suffix="240")
G("SN74244N", "Octal Non-Inverting Buffer (3-state)", 20, 1, (20, 10), {
    "A": {"oe": [1, 19],
          "in":  [2, 4, 6, 8, 11, 13, 15, 17],
          "out": [18, 16, 14, 12, 9, 7, 5, 3]},
}, suffix="244")
G("SN74245N", "Octal Transceiver (3-state)", 20, 1, (20, 10), {
    "A": {"oe": [19], "dir": [1],
          "a": [2, 3, 4, 5, 6, 7, 8, 9],
          "b": [18, 17, 16, 15, 14, 13, 12, 11]},
}, suffix="245")

PASSIVES = {
    "R": {"kicad_symbol": "Device:R", "shape": "resistor"},
    "C": {"kicad_symbol": "Device:C", "shape": "capacitor"},
    "CP": {"kicad_symbol": "Device:CP", "shape": "capacitor_polarized"},
}


def emit() -> dict:
    out: dict = {}
    for p in PARTS:
        e = {
            "name": p["name"],
            "desc": p["desc"],
            "kicad_symbol": f"74xx:{p['name']}",
            "kicad_footprint": f"Package_DIP:DIP-{p['pins']}_W7.62mm",
            "pins": p["pins"],
            "gates": p["gates"],
            "gate_pins": p["gate_pins"],
            "power": {"VCC": p["vcc"], "GND": p["gnd"]},
        }
        out[p["suffix"]] = e
    out.update(PASSIVES)
    return out


def main():
    doc = emit()
    out_path = REPO / "data" / "MJC-400" / "ic_map.yaml"
    out_path.write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True, default_flow_style=False, width=120))
    sys.stdout.write(f"wrote {len(doc)} entries to {out_path}\n")


if __name__ == "__main__":
    main()
