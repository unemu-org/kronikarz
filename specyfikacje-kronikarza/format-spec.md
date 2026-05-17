# Kronikarz — Format plików
## Specyfikacja kompletna v1.0

Kronikarz to narzędzie do digitalizacji i rekonstrukcji schematów
elektronicznych ze skanów dokumentacji technicznej. Format plików
zaprojektowany pod workflow: AI generuje YAML ze skanu → człowiek
weryfikuje i koryguje w viewerze → eksporter generuje KiCad.

---

## Filozofia formatu

- **Jednostką jest bramka (gate)**, nie IC — jeden fizyczny układ M5
  może mieć bramki rozrzucone po wielu stronach i pakietach
- **Pakiet jest samodzielną jednostką** — można pracować nad jednym
  pakietem bez ładowania całego projektu
- **Pozycje w pikselach skanu** — AI czyta obraz i podaje współrzędne;
  brak abstrakcyjnej siatki
- **Cztery typy plików**: `project.yaml` + `package.yaml` +
  `*.sch.yaml` + `ic_map.yaml`
- **Format minimalny** — tylko to co potrzeba do weryfikacji i eksportu
- **Null jako placeholder** — pole może być `null` jeśli nie zmapowane

---

## Struktura katalogów

```
MJC-400/
├── project.yaml                  # manifest projektu + backplane
├── ic_map.yaml                   # globalna tablica sufiks → KiCad
│
├── P-X3-2/
│   ├── package.yaml              # manifest pakietu + rejestr IC
│   ├── scans/
│   │   ├── pcb-front.jpg         # zdjęcie płytki od frontu
│   │   ├── pcb-back.jpg          # zdjęcie płytki od tyłu
│   │   ├── 2-1.jpg               # skan strony schematu
│   │   ├── 2-5.jpg
│   │   └── ...
│   └── pages/
│       ├── 2-1.sch.yaml
│       ├── 2-5.sch.yaml
│       └── ...
│
├── P-M3-2/
│   ├── package.yaml
│   ├── scans/
│   └── pages/
│
└── P-D3-2/
    ├── package.yaml
    ├── scans/
    └── pages/
```

---

## `project.yaml`

Zna tylko pakiety i połączenia backplane. Nie zna bramek ani stron.

```yaml
kronikarz: "1"                    # wersja formatu

project:
  name: "MJC-400"
  desc: "Modul Jednostki Centralnej"
  doc: "12-006368-01-8A"          # numer dokumentacji z tytulowki
  status: wip                     # raw | wip | done | verified

packages:
  - id: P-X3-2
    name: "Pakiet sterowania X"
    file: P-X3-2/package.yaml
    status: wip
  - id: P-M3-2
    name: "Pakiet magistrali M"
    file: P-M3-2/package.yaml
    status: raw
  - id: P-D3-2
    name: "Pakiet D"
    file: P-D3-2/package.yaml
    status: raw

# Polaczenia miedzy pakietami przez backplane
# connector_pin = oznaczenie zlacza z dokumentacji DTR (A23, B21...)
backplane:
  - signal: "+K1"
    from: { package: P-X3-2, connector_pin: A23 }
    to:   { package: P-M3-2, connector_pin: B15 }
  - signal: "-WP"
    from: { package: P-X3-2, connector_pin: B21 }
    to:   { package: P-D3-2, connector_pin: C7  }
  - signal: "+WA"
    from: { package: P-X3-2, connector_pin: A25 }
    to:   { package: P-M3-2, connector_pin: A8  }
```

---

## `package.yaml`

Zna strony i IC swojego pakietu. Nie zna bramek na poszczególnych stronach.

```yaml
kronikarz: "1"

package:
  id: P-X3-2
  name: "Pakiet sterowania X"
  doc: "12-006368-01-8A"
  status: wip

  pcb:
    front: scans/pcb-front.jpg
    back:  scans/pcb-back.jpg

  pages:
    - id: "2-1"
      file: pages/2-1.sch.yaml
      scan: scans/2-1.jpg
      title: "Schemat ideowy pakietu P-X3-2"
      status: wip
    - id: "2-5"
      file: pages/2-5.sch.yaml
      scan: scans/2-5.jpg
      title: "Schemat ideowy pakietu P-X3-2"
      status: raw
    - id: "2-15"
      file: pages/2-15.sch.yaml
      scan: scans/2-15.jpg
      title: "Schemat ideowy pakietu P-X3-2"
      status: raw

# Rejestr IC — wszystkie uklady fizycznie na tej plytce
# gates: litera → strona gdzie jest ta bramka
# null = nieuzywana bramka
components:
  M5:
    ic: "04"                      # sufiks → ic_map.yaml → SN7404N
    gates:
      A: { page: "2-1" }
      B: { page: "2-1" }
      C: { page: "2-5" }
      D: { page: "2-5" }
      E: { page: "2-15" }
      F: null                     # nieuzywana bramka

  M8:
    ic: "00"
    gates:
      A: { page: "2-1" }
      B: { page: "2-1" }
      C: { page: "2-1" }
      D: { page: "2-5" }

  M34:
    ic: "175"
    gates:
      A: { page: "2-1" }         # 74175 traktowany jako jeden gate

  M93:
    ic: "H06"
    gates:
      A: { page: "2-15" }
      B: { page: "2-15" }

  # Elementy pasywne — nie maja bramek
  R1:
    ic: null
    type: resistor
    value: "1k"
    pages: ["2-1"]

  C1:
    ic: null
    type: capacitor
    value: "0.25u"
    polarized: false
    pages: ["2-1"]
```

---

## `*.sch.yaml`

Zna bramki na tej stronie, ich piny i nety.

```yaml
kronikarz: "1"
page: "2-1"
package: P-X3-2

# Wymiary skanu w pikselach — do normalizacji wspolrzednych
scan_size: [1654, 1169]

gates:

  # Inwerter — jedna bramka z jednym wejsciem i jednym wyjsciem
  - ref: M5
    gate: A                       # musi istniec w package.yaml
    x: 340                        # srodek prostokata na skanie [px]
    y: 120
    rotation: 0                   # 0 | 90 | 180 | 270
    pins:
      - num: 1                    # numer pinu z ic_map
        side: left                # left | right | top | bottom
        net: NET_BUS_13
        px: 310                   # xy koncowki pinu na skanie
        py: 120
      - num: 2
        side: right
        net: "-K1"
        px: 370
        py: 120
        cross:                    # net wychodzi poza strone
          page: "A23"             # oznaczenie jak na schemacie
          label: "-K1"
    label_left: "13"              # cyfra widoczna po lewej pudelka
    label_right: "12"
    verified: false
    note: null

  - ref: M5
    gate: B
    x: 340
    y: 180
    rotation: 0
    pins:
      - num: 3
        side: left
        net: NET_BUS_9
        px: 310
        py: 180
      - num: 4
        side: right
        net: "-WP"
        px: 370
        py: 180
        cross:
          page: "B21"
          label: "-WP"
    label_left: "9"
    label_right: "8"
    verified: false
    note: null

  # Bramka z dwoma wejsciami (NAND)
  - ref: M8
    gate: A
    x: 520
    y: 95
    rotation: 0
    pins:
      - num: 1
        side: left
        net: NET_ADDR_3
        px: 490
        py: 88
      - num: 2
        side: left
        net: NET_ADDR_4
        px: 490
        py: 102
      - num: 3
        side: right
        net: NET_OUT_M8A
        px: 550
        py: 95
    label_left: "4"
    label_right: "6"
    verified: false
    note: null

  # Flip-flop jako jeden blok (74175)
  - ref: M34
    gate: A
    x: 680
    y: 200
    rotation: 0
    pins:
      - num: 9
        side: left
        net: NET_CLK
        px: 630
        py: 178
      - num: 1
        side: left
        net: GND
        px: 630
        py: 188
      - num: 4
        side: left
        net: NET_D0
        px: 630
        py: 198
      - num: 5
        side: left
        net: NET_D1
        px: 630
        py: 208
      - num: 2
        side: right
        net: NET_Q0
        px: 730
        py: 190
      - num: 3
        side: right
        net: NET_NQ0
        px: 730
        py: 200
    label_left: "A"
    label_right: "R"
    verified: false
    note: null

  # Element pasywny — rezystor
  - ref: R1
    gate: null                    # elementy pasywne nie maja bramek
    x: 150
    y: 80
    rotation: 90                  # pionowy
    value: "1k"
    pins:
      - num: 1
        side: top
        net: VCC
        px: 150
        py: 60
      - num: 2
        side: bottom
        net: NET_BIAS
        px: 150
        py: 100
    verified: false
    note: null

# Symbole zasilania
power:
  - type: VCC
    x: 100
    y: 40
    net: VCC
  - type: GND
    x: 400
    y: 950
    net: GND

# Nety — polaczenia na tej stronie
nets:
  NET_BUS_13:
    pins:
      - M5.A.1                    # format: REF.GATE.PIN_NUM
      - M8.A.1
      - M8.B.1
    # Lista segmentow [x1,y1,x2,y2] w pikselach skanu
    # null = nie zmapowane — viewer rysuje przerywane linie
    segments:
      - [310, 120, 200, 120]
      - [200, 120, 200, 160]
      - [200, 160, 310, 160]
    junctions:                    # kropki polaczen T/X [x,y]
      - [200, 120]
      - [200, 160]

  NET_BUS_9:
    pins:
      - M5.B.3
      - M8.C.1
    segments: null
    junctions: null

  "-K1":
    pins:
      - M5.A.2
    segments:
      - [370, 120, 500, 120]
    junctions: []
    cross:
      page: "A23"
      label: "-K1"

  VCC:
    pins:
      - R1.1
    segments: null
    junctions: null

  GND:
    pins:
      - M34.A.1
    segments: null
    junctions: null

annotations:
  - text: "Schemat ideowy pakietu P-X3-2"
    x: 1200
    y: 1050
  - text: "2-1"
    x: 50
    y: 1100
```

---

## `ic_map.yaml`

Globalny slownik sufiksow. Wspoldzielony przez wszystkie pakiety i projekty.

```yaml
# sufiks z schematu → dane KiCad + geometria bramek

"00":
  name: "SN7400N"
  desc: "Quad 2-input NAND"
  kicad_symbol: "74xx:SN7400N"
  kicad_footprint: "Package_DIP:DIP-14_W7.62mm"
  pins: 14
  gates: 4
  gate_pins:
    A: { in: [1, 2],   out: [3]  }
    B: { in: [4, 5],   out: [6]  }
    C: { in: [9, 10],  out: [8]  }
    D: { in: [12, 13], out: [11] }
  power: { VCC: 14, GND: 7 }

"04":
  name: "SN7404N"
  desc: "Hex Inverter"
  kicad_symbol: "74xx:SN7404N"
  kicad_footprint: "Package_DIP:DIP-14_W7.62mm"
  pins: 14
  gates: 6
  gate_pins:
    A: { in: [1],  out: [2]  }
    B: { in: [3],  out: [4]  }
    C: { in: [5],  out: [6]  }
    D: { in: [9],  out: [8]  }
    E: { in: [11], out: [10] }
    F: { in: [13], out: [12] }
  power: { VCC: 14, GND: 7 }

"08":
  name: "SN7408N"
  desc: "Quad 2-input AND"
  kicad_symbol: "74xx:SN7408N"
  kicad_footprint: "Package_DIP:DIP-14_W7.62mm"
  pins: 14
  gates: 4
  gate_pins:
    A: { in: [1, 2],   out: [3]  }
    B: { in: [4, 5],   out: [6]  }
    C: { in: [9, 10],  out: [8]  }
    D: { in: [12, 13], out: [11] }
  power: { VCC: 14, GND: 7 }

"10":
  name: "SN7410N"
  desc: "Triple 3-input NAND"
  kicad_symbol: "74xx:SN7410N"
  kicad_footprint: "Package_DIP:DIP-14_W7.62mm"
  pins: 14
  gates: 3
  gate_pins:
    A: { in: [1, 2, 13],  out: [12] }
    B: { in: [3, 4, 5],   out: [6]  }
    C: { in: [9, 10, 11], out: [8]  }
  power: { VCC: 14, GND: 7 }

"20":
  name: "SN7420N"
  desc: "Dual 4-input NAND"
  kicad_symbol: "74xx:SN7420N"
  kicad_footprint: "Package_DIP:DIP-14_W7.62mm"
  pins: 14
  gates: 2
  gate_pins:
    A: { in: [1, 2, 4, 5],    out: [6] }
    B: { in: [9, 10, 12, 13], out: [8] }
  power: { VCC: 14, GND: 7 }

"30":
  name: "SN7430N"
  desc: "8-input NAND"
  kicad_symbol: "74xx:SN7430N"
  kicad_footprint: "Package_DIP:DIP-14_W7.62mm"
  pins: 14
  gates: 1
  gate_pins:
    A: { in: [1,2,3,4,5,6,11,12], out: [8] }
  power: { VCC: 14, GND: 7 }

"74":
  name: "SN7474N"
  desc: "Dual D Flip-Flop"
  kicad_symbol: "74xx:SN7474N"
  kicad_footprint: "Package_DIP:DIP-14_W7.62mm"
  pins: 14
  gates: 2
  gate_pins:
    A: { clk: [3], d: [2], q: [5], nq: [6], pre: [4], clr: [1] }
    B: { clk: [11], d: [12], q: [9], nq: [8], pre: [10], clr: [13] }
  power: { VCC: 14, GND: 7 }

"175":
  name: "SN74175N"
  desc: "Quad D Flip-Flop"
  kicad_symbol: "74xx:SN74175N"
  kicad_footprint: "Package_DIP:DIP-16_W7.62mm"
  pins: 16
  gates: 1
  gate_pins:
    A:
      clk: [9]
      clr: [1]
      d:   [4, 5, 12, 13]
      q:   [2, 7, 10, 15]
      nq:  [3, 6, 11, 14]
  power: { VCC: 16, GND: 8 }

"H06":
  name: "SN74H106N"
  desc: "Dual JK Flip-Flop"
  kicad_symbol: "74xx:SN74H106N"
  kicad_footprint: "Package_DIP:DIP-14_W7.62mm"
  pins: 14
  gates: 2
  gate_pins:
    A: { j: [8], k: [11], clk: [9], pre: [13], clr: [1], q: [10], nq: [12] }
    B: { j: [3], k: [4],  clk: [5], pre: [2],  clr: [6], q: [7],  nq: [14] }
  power: { VCC: 14, GND: 0 }

"E5":
  name: "SN74AS805N"
  desc: "Octal Buffer 3-state"
  kicad_symbol: "74xx:SN74AS805N"
  kicad_footprint: "Package_DIP:DIP-20_W7.62mm"
  pins: 20
  gates: 1
  shape: triangle
  power: { VCC: 20, GND: 10 }

# Elementy pasywne
"R":
  kicad_symbol: "Device:R"
  kicad_footprint: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal"
  shape: resistor

"CP":
  kicad_symbol: "Device:CP"
  kicad_footprint: "Capacitor_THT:CP_Radial_D8.0mm_P3.50mm"
  shape: capacitor_polarized

"C":
  kicad_symbol: "Device:C"
  kicad_footprint: "Capacitor_THT:C_Disc_D5.0mm_W2.5mm_P5.00mm"
  shape: capacitor
```

---

## Zasady formatu

### Hierarchia i odpowiedzialnosci

```
project.yaml    zna: pakiety, backplane signals
package.yaml    zna: strony, IC tego pakietu
*.sch.yaml      zna: bramki tej strony, nety, sciezki
ic_map.yaml     zna: geometrie i dane KiCad kazdego IC
```

Kazdy poziom jest samodzielny — Kronikarz moze otworzyc sam
`package.yaml` bez `project.yaml` i dzialac dla tego pakietu.

### Identyfikator pinu w necie

Format: `REF.GATE.PIN_NUM`

```
M5.A.1      IC M5, bramka A, pin numer 1
M34.A.9     IC M34, bramka A (jedyna), pin 9
R1.1        rezystor R1, pin 1
```

### Nazwy netow

```
NET_XXX     siec wewnetrzna, nazwana przez digitalizatora
"-K1"       etykieta z oryginalu (zachowujemy zawsze)
"+WP"       sygnal aktywny wysoki
VCC / GND   zasilanie
```

Zawsze zachowujemy oryginalne etykiety z dokumentacji DTR.

### Cross-page na poziomie strony

```yaml
cross:
  page: "A23"     # oznaczenie zlacza jak na schemacie
  label: "-K1"    # etykieta sygnalu
```

### Statusy

```
raw         plik istnieje, nic nie zmapowane
wip         w trakcie
done        zmapowane, niezweryfikowane
verified    zmapowane i zweryfikowane przez czlowieka
```

### Co format obsluguje

| Feature | Poziom | Status |
|---------|--------|--------|
| Bramki IC z pinami | sch.yaml | tak |
| Elementy pasywne R/C | sch.yaml | tak |
| Symbole zasilania | sch.yaml | tak |
| Cross-page connections | sch.yaml | tak |
| Geometria sciezek (segmenty) | sch.yaml | tak, opcjonalna |
| Junction doty | sch.yaml | tak, opcjonalne |
| Rotacja elementow | sch.yaml | tak |
| Weryfikacja (verified, note) | sch.yaml | tak |
| Rejestr IC pakietu | package.yaml | tak |
| Zdjecia PCB | package.yaml | tak |
| Polaczenia backplane | project.yaml | tak |
| BOM per pakiet | eksporter | wkrotce |
| Eksport KiCad .kicad_sch | eksporter | wkrotce |
| Bus | — | poza zakresem |