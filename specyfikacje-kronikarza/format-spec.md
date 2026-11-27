# Kronikarz — Format plików
## Specyfikacja kompletna v1.1

Kronikarz to narzędzie do digitalizacji i rekonstrukcji schematów
elektronicznych ze skanów dokumentacji technicznej (głównie MERA-400).
Format plików zaprojektowany pod workflow: AI/CV generuje YAML ze skanu
→ człowiek weryfikuje i koryguje w viewerze → eksporter generuje KiCad.

Zmiany od v1.0:
- **Port** ma rozdzielone `connector` (litera) + `pin` (numer) zamiast łączonego stringa
- **Backplane signal** jest multi-drop: `endpoints: ConnectorRef[]` zamiast `from`/`to`
- **Port** i **cross_ref** są osobnymi bytami na poziomie strony (nie tylko polem w pinie)
- **Net** ma jawne `segments` i `junctions` jako geometrię wire'a
- Format walidacji + lista kodów błędów
- **Package** ma opcjonalne `board` (rodzina płyty) i `aliases` (dawne identyfikatory i inne zapisy nazwy)

---

## Filozofia formatu

- **Jednostką jest bramka (gate)**, nie IC — jeden fizyczny układ M5 może
  mieć bramki rozrzucone po wielu stronach i pakietach
- **Pakiet jest samodzielną jednostką** — można pracować nad jednym
  pakietem bez ładowania całego projektu
- **Pozycje w pikselach skanu** — AI czyta obraz i podaje współrzędne;
  brak abstrakcyjnej siatki
- **Cztery typy plików**: `project.yaml` + `package.yaml` + `*.sch.yaml`
  + `ic_map.yaml`
- **Format minimalny** — tylko to co potrzeba do weryfikacji i eksportu
- **`null` jako placeholder** — pole może być `null` jeśli nie zmapowane
- **Connectivity is source-of-truth on endpoints** — net to którego należy pin
  jest zapisany w `pin.net`/`port.net`/`cr.net`. Pole `net.pins[]` to legacy
  index i może być nieaktualizowany; validator liczy referencje z endpointów.

---

## Struktura katalogów

```
MJC-400/
├── project.yaml                  # manifest projektu + backplane
├── ic_map.yaml                   # globalna tablica sufiks → KiCad
│
├── P-R3-2/
│   ├── package.yaml              # manifest pakietu + rejestr IC
│   ├── scans/
│   │   ├── pcb-front.jpg         # zdjęcie płytki od frontu
│   │   ├── pcb-back.jpg          # zdjęcie płytki od tyłu
│   │   ├── 2-58.jpg              # skan strony schematu
│   │   └── ...
│   └── pages/
│       ├── 2-58.sch.yaml
│       └── ...
│
├── P-X3-2/
└── ...
```

---

## `project.yaml`

Zna pakiety i połączenia backplane. Nie zna bramek ani stron.

```yaml
kronikarz: "1"

project:
  name: "MJC-400"
  desc: "Modul Jednostki Centralnej"
  doc: "12-006368-01-8A"          # numer dokumentacji z tytulowki
  status: wip                     # raw | wip | done | verified

packages:
  - id: P-R3-2
    name: "Pakiet R"
    file: P-R3-2/package.yaml
    status: wip
  - id: P-X3-2
    name: "Pakiet X"
    file: P-X3-2/package.yaml
    status: raw

# Backplane signals: multi-drop, lista endpointow z dowolnych pakietow.
# Kazdy endpoint identyfikuje pin na konkretnym edge-connectorze pakietu.
backplane:
  - signal: "-BLR"
    endpoints:
      - { package: P-R3-2, connector: A, pin: 50 }
      - { package: P-R3-2, connector: C, pin: 41 }
      - { package: P-X3-2, connector: B, pin: 12 }
  - signal: "+LDC"
    endpoints:
      - { package: P-R3-2, connector: A, pin: 94 }
      - { package: P-M3-2, connector: A, pin: 8  }
```

Pole `connector` to litera edge-connectora pakietu (typowo A/B/C/D —
PCB ma od 1 do 4 edge-fingerów). Pole `pin` to numer styku na tym
konektorze.

---

## `package.yaml`

Zna strony i IC swojego pakietu. Nie zna bramek na poszczególnych stronach.

```yaml
kronikarz: "1"

package:
  id: P-R3-2
  name: "Pakiet R"
  board: P-R                      # opcjonalne: rodzina płyty
  # aliases: [...]                # opcjonalne: inne id / pisownie (patrz niżej)
  doc: "12-006368-01-8A"
  status: wip

  pcb:
    front: scans/pcb-front.jpg
    back:  scans/pcb-back.jpg

  pages:
    - id: "2-58"
      file: pages/2-58.sch.yaml
      scan: scans/2-58.jpg
      title: "Schemat ideowy pakietu P-R3-2"
      status: wip

# Rejestr IC — wszystkie uklady fizycznie na tej plytce.
# gates: litera → strona gdzie jest ta bramka, null = nieuzywana.
components:
  M5:
    ic: "04"                      # sufiks → ic_map.yaml → SN7404N
    gates:
      A: { page: "2-1" }
      B: { page: "2-1" }
      C: { page: "2-5" }
      F: null                     # nieuzywana bramka

  M52:
    ic: "51"
    gates:
      A: { page: "2-58" }
      B: { page: "2-58" }

  # Elementy pasywne — bez gates, z lista stron.
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

`package.id` to nazwa z ramki rysunku (tytuł arkusza), ze spacjami i `/`
zamienionymi na `-` (np. „SPP 32/16” → `SPP-32-16`). Pola opcjonalne:

- `board` — rodzina płyty, jak na wiki / na sprzęcie (np. `SM-POSE`, `P-K`,
  `TJ`, `I-SK`, `P-R`). Kilka pakietów (wersji) może mieć ten sam `board`.
- `aliases` — lista wcześniejszych id i innych pisowni nazwy spotykanych
  gdzie indziej (np. `[SM-POSET-1, SM.POSE-11]`). Tylko informacyjnie;
  referencje (`page.package`, backplane) używają zawsze `id`.

---

## `*.sch.yaml`

Zna bramki strony, jej piny, porty, cross-refy i nety.

```yaml
kronikarz: "1"
page: "2-58"
package: P-R3-2

# Wymiary skanu w pikselach — do normalizacji wspolrzednych
scan_size: [1654, 1169]

# === BRAMKI ===
gates:
  - ref: M55                      # musi istniec w package.yaml
    gate: A                       # litera bramki, lub null dla pasywnych
    x: 434                        # srodek prostokata na skanie [px]
    y: 435
    rotation: 0                   # 0 | 90 | 180 | 270
    w: 60                         # opcjonalne nadpisanie szerokosci pudla
    h: 50                         # opcjonalne nadpisanie wysokosci
    pins:
      - num: 9                    # numer pinu z ic_map.gate_pins
        side: left                # left | right | top | bottom
        net: NET_M55_A_9
        px: 409                   # xy koncowki pinu na skanie
        py: 436
      - num: 8
        side: right
        net: "-WA"
        px: 459
        py: 434
        cross:                    # net wychodzi poza strone (opcjonalny)
          page: "2-12"            # gdzie kontynuuje
          label: "-WA"
    label_left: "9"               # cyfra widoczna po lewej pudelka
    label_right: "8"
    verified: true
    note: null

  # Element pasywny — bez gate, z value
  - ref: R1
    gate: null
    x: 150
    y: 80
    rotation: 90
    value: "1k"
    pins:
      - { num: 1, side: top,    net: VCC,      px: 150, py: 60 }
      - { num: 2, side: bottom, net: NET_BIAS, px: 150, py: 100 }
    verified: false
    note: null

# === SYMBOLE ZASILANIA ===
power:
  - { type: VCC, x: 100, y: 40,  net: VCC }
  - { type: GND, x: 400, y: 950, net: GND }

# === PORTY (edge-connector backplane na tej stronie) ===
# Reprezentuja chevron `< A50 >` przy krawedzi schematu.
# connector + pin musza dopasowac do project.yaml backplane endpoint.
ports:
  - connector: A                  # litera edge-connectora
    pin: 50                       # numer styku
    label: "-BLR"                 # sygnal jak na schemacie
    net: "-BLR"                   # net w tej stronie
    x: 100                        # pozycja chevron tip na skanie
    y: 90
    side: left                    # ktora krawedz strony

  - { connector: C, pin: 41, label: "-BLR", net: "-BLR", x: 100, y: 130, side: left }

# === CROSS-REFS (sygnal kontynuuje na innych stronach pakietu) ===
# Wizualne tylko — strzalka z tekstem "-CZYTRW 2,3,4,5".
cross_refs:
  - net: "-CZYTRW"
    label: "-CZYTRW"
    pages: ["2-12", "2-15"]       # gdzie kontynuuje
    x: 1500
    y: 230
    side: right

# === NETY ===
# Kazdy net ma:
# - pins[]: lista pin-id stringow (legacy, opcjonalne — endpoint.net jest source-of-truth)
# - segments: lista [x1,y1,x2,y2] wire'ow w pikselach skanu (null → render dashed)
# - junctions: lista [x,y] dot-junctions T/X (null → tylko auto-junctions)
nets:
  "-BLR":
    pins: []
    segments:
      - [110, 90,  150, 90]
      - [150, 90,  150, 130]
      - [150, 130, 110, 130]
      - [150, 90,  500, 90]
    junctions:
      - [150, 90]

  NET_M55_A_9:
    pins: []
    segments: null                # null = nie zmapowane, viewer rysuje dashed
    junctions: null

# === ADNOTACJE (opcjonalne, tylko opis) ===
annotations:
  - text: "Schemat ideowy pakietu P-R3-2"
    x: 1200
    y: 1050
```

### Endpointy a nety

Source-of-truth dla connectivity:
- `pin.net` (per bramka)
- `port.net` (per port)
- `cross_ref.net` (per cross-ref)

Nety w `nets:` mogą mieć puste `pins: []` — to nie błąd. Validator
walidator wylicza obecne endpointy każdego netu skanując pin/port/cr.

### Geometria wire'a

Jeden net może mieć wiele segmentów (poziome + pionowe odcinki) oraz
junctions (kropki połączenia T/X). Viewer + edytor utrzymują:
- **wszystkie wire'y poziome lub pionowe** (brak skosów)
- **endpointy w pikselach skanu**
- **junction = punkt gdzie ≥3 końce segmentów się stykają**
  (viewer dodaje auto-junction renderingiem, manualne w `nets[name].junctions`)

---

## `ic_map.yaml`

Globalny słownik sufiksów. Współdzielony przez wszystkie pakiety i projekty.

```yaml
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

# Flip-flop z osobnymi grupami pinow
"74":
  name: "SN7474N"
  desc: "Dual D Flip-Flop"
  kicad_symbol: "74xx:SN7474N"
  pins: 14
  gates: 2
  gate_pins:
    A: { clk: [3],  d: [2],  q: [5], nq: [6], pre: [4],  clr: [1]  }
    B: { clk: [11], d: [12], q: [9], nq: [8], pre: [10], clr: [13] }
  power: { VCC: 14, GND: 7 }

# Bufor z `shape: triangle` — rysowany jako trojkat
"E5":
  name: "SN74AS805N"
  kicad_symbol: "74xx:SN74AS805N"
  pins: 20
  gates: 1
  shape: triangle
  power: { VCC: 20, GND: 10 }

# Elementy pasywne — bez gate_pins, identyfikowane przez shape
"R":
  kicad_symbol: "Device:R"
  kicad_footprint: "Resistor_THT:R_Axial_DIN0207_L6.3mm_D2.5mm_P10.16mm_Horizontal"
  shape: resistor

"C":
  kicad_symbol: "Device:C"
  shape: capacitor

"CP":
  kicad_symbol: "Device:CP"
  shape: capacitor_polarized
```

### Pola `gate_pins`

Kategorie pinów per litera bramki. Dla logiki kombinacyjnej:
- `in: [...]`  — wejścia
- `out: [...]` — wyjścia

Dla flip-flopów / liczników:
- `clk: [...]`, `clr: [...]`, `pre: [...]` — sterowanie
- `d`, `q`, `nq` (D-flop) / `j`, `k` (JK-flop)

Lista numerów pinów odpowiada fizycznym pinom IC.

### Normalizacja prefiksów

Sufiks w `comp.ic` może mieć prefiks producenta (`SN`, `UCY`, `MCY`,
`MH`, `CDB`, `HCF`, polski `H` jako `H11`). Walidator i viewer
normalizują (`resolveIcKey`) zanim szukają w `ic_map.yaml`.

Przykład: `comp.ic: "MH7400N"` → szukamy klucza `"00"`.

### `shape`

- `triangle` — bufor/inwerter rysowany jako trójkąt
- `resistor`, `capacitor`, `capacitor_polarized` — symbole pasywnych
- (brak) — domyślny prostokąt z label_left / label_right

---

## Zasady formatu

### Hierarchia i odpowiedzialnosci

```
project.yaml    zna: pakiety, backplane signals (multi-drop)
package.yaml    zna: strony, IC tego pakietu
*.sch.yaml      zna: bramki, porty, cross-refy, nety i sciezki strony
ic_map.yaml     zna: geometrie i dane KiCad kazdego IC
```

Każdy poziom jest samodzielny — Kronikarz może otworzyć sam
`package.yaml` bez `project.yaml`.

### Identyfikator pinu w necie (`pid`)

Format: `REF.GATE.PIN_NUM` (dla bramek IC) lub `REF.PIN_NUM` (dla pasywnych).

```
M5.A.1      IC M5, bramka A, pin numer 1
M34.A.9     IC M34, bramka A (jedyna), pin 9
R1.1        rezystor R1, pin 1
```

### Nazwy netów

```
NET_XXX     siec wewnetrzna, nazwana przez digitalizatora
"-K1"       etykieta z oryginalu (zachowujemy zawsze)
"+WP"       sygnal aktywny wysoki
VCC / GND   zasilanie
```

Zawsze zachowujemy oryginalne etykiety z dokumentacji DTR. Net z labelem
portu/cross_refa dziedziczy nazwę bez pytania user (label-priority merge).

### Cross-page (intra-package)

Sygnał kontynuuje na innych stronach **tego samego pakietu**. Dwa miejsca:

1. Na poziomie pinu (legacy, dla pojedynczego pinu wychodzącego):

```yaml
- num: 8
  side: right
  net: "-WA"
  cross:
    page: "2-12"
    label: "-WA"
```

2. Jako osobny `cross_refs` (preferowany — wizualnie strzałka z numerami stron):

```yaml
cross_refs:
  - net: "-CZYTRW"
    label: "-CZYTRW"
    pages: ["2-12", "2-15"]
    x: 1500
    y: 230
    side: right
```

### Cross-package (backplane)

Sygnał idzie między pakietami przez backplane. Realizacja:
- Każdy pakiet ma `ports[]` na krawędzi schematu (chevron `< A50 >`)
- Port ma `connector` (A/B/C/D) + `pin` (numer styku)
- `project.yaml` `backplane[]` deklaruje sygnał i jego endpointy
- Walidator dopasowuje port pakietu do endpointu sygnału po `connector` + `pin`

### Side enum

```
left    | right   | top   | bottom
```

Stosuje się do:
- `Pin.side` — z której strony bramki wystaje pin
- `Port.side` — która krawędź strony (chevron otwiera się do środka)
- `CrossRef.side` — która krawędź strony

### Rotation enum

```
0 | 90 | 180 | 270
```

Tylko dla bramek/elementów.

### Statusy

```
raw         plik istnieje, nic nie zmapowane
wip         w trakcie
done        zmapowane, niezweryfikowane
verified    zmapowane i zweryfikowane przez czlowieka
```

Na poziomach: `project.status`, `package.status`, `page.status`,
`gate.verified` (boolean shortcut: `verified` ⇔ `true`).

---

## Walidacja

`validatePage` i `validateProject` (z `shared/src/validate.ts`)
zwracają listę `Issue`:

```ts
interface Issue {
  level: 'err' | 'warn' | 'info';
  code: string;
  message: string;
  ref?: string;
}
```

### Kody błędów

#### Page-level

| Kod                            | Poziom | Znaczenie                                                     |
| ------------------------------ | ------ | ------------------------------------------------------------- |
| `PAGE_PACKAGE_MISMATCH`        | err    | `page.package` ≠ `pkg.package.id` z package.yaml             |
| `PIN_ID_MALFORMED`             | err    | wpis w `net.pins[]` ma zły format                            |
| `NET_DISCONNECTED`             | err    | jeden net ma N rozłącznych klastrów wire'ów                  |
| `NET_ORPHAN_ENDPOINT`          | err    | endpoint netu nie dotyka żadnego segmentu                    |
| `NET_FLOATING`                 | err    | net ma tylko 1 endpoint (czerwone)                           |
| `ENDPOINT_NET_MISMATCH`        | err    | endpoint na pozycji segmentu sieci X, ale `endpoint.net = Y` |
| `GATE_REF_NOT_IN_PACKAGE`      | err    | `gate.ref` nie istnieje w package.components                  |
| `GATE_LETTER_NOT_IN_COMPONENT` | err    | `gate.gate` letter nie istnieje w `component.gates`           |
| `GATE_LETTER_WRONG_PAGE`       | err    | bramka jest tu, ale `component.gates[letter].page` mówi inaczej |
| `PIN_NOT_IN_IC_MAP`            | err    | pin.num nie ma mapowania w `ic_map.gate_pins[letter]`         |
| `NET_EMPTY`                    | warn   | net nie ma referencji z żadnego endpointu                    |
| `NET_NO_SEGMENTS`              | info   | net renderowany jako dashed (brak geometrii)                  |
| `PORT_NET_MISSING`             | warn   | `port.net` nie ma entry w `page.nets`                         |
| `PORT_NOT_ON_BACKPLANE`        | warn   | port nie dopasowany do żadnego backplane endpoint            |
| `GATES_UNVERIFIED`             | info   | liczba bramek z `verified: false`                             |

#### Project-level

| Kod                          | Poziom | Znaczenie                                              |
| ---------------------------- | ------ | ------------------------------------------------------ |
| `BACKPLANE_UNKNOWN_PACKAGE`  | err    | endpoint signal'a wskazuje pakiet spoza projektu      |
| `BACKPLANE_SINGLE_ENDPOINT`  | warn   | sygnał ma <2 endpointy (nie łączy nic)                |

#### Package-level

| Kod                          | Poziom | Znaczenie                                              |
| ---------------------------- | ------ | ------------------------------------------------------ |
| `IC_NOT_IN_MAP`              | warn   | `comp.ic` (po normalizacji prefiksu) nie w `ic_map.yaml` |

---

## Współrzędne i geometria

Wszystkie pozycje w **pikselach oryginalnego skanu** (origin top-left).

- `gate.x/y` — środek prostokąta bramki
- `gate.w/h` (opcjonalne) — wymiary pudełka; brak = auto z `ic_map.shape` lub default
- `pin.px/py` — końcówka pinu (gdzie wchodzi wire)
- `port.x/y` — chevron tip; open-end gdzie podpina się wire jest derived
  ze strony + szerokości labelu
- `cross_ref.x/y` — koniec chevron-strzałki gdzie wchodzi wire
- `power.x/y` — punkt symbolu zasilania
- `net.segments[].[x1,y1,x2,y2]` — odcinek wire (zawsze poziomy lub pionowy)
- `net.junctions[].[x,y]` — kropka połączenia T/X

---

## Backupy

Server endpoint `/make-bak` zapisuje obok pliku `<name>.sch.yaml.bak`
(rolling, zawsze ostatnia kopia) plus timestamped
`<name>.sch.yaml.<ISO-timestamp>.bak`. Restore przez `/restore-bak`.
Pliki `*.bak` są w `.gitignore`.

---

## Co format obsluguje

| Feature                            | Poziom        | Status            |
| ---------------------------------- | ------------- | ----------------- |
| Bramki IC z pinami                 | sch.yaml      | tak               |
| Elementy pasywne R/C               | sch.yaml      | tak               |
| Symbole zasilania                  | sch.yaml      | tak               |
| Porty edge-connector (`<A50>`)     | sch.yaml      | tak (split conn+pin) |
| Cross-page intra-package           | sch.yaml      | tak (cross_refs)  |
| Geometria sciezek (segmenty)       | sch.yaml      | tak               |
| Junction doty                      | sch.yaml      | tak (auto + manualne) |
| Rotacja elementow                  | sch.yaml      | tak               |
| Override w/h pudla bramki          | sch.yaml      | tak               |
| Weryfikacja (verified, note)       | sch.yaml      | tak               |
| Rejestr IC pakietu                 | package.yaml  | tak               |
| Zdjecia PCB                        | package.yaml  | tak               |
| Backplane multi-drop signals       | project.yaml  | tak               |
| Validacja (page + project + pkg)   | shared        | tak               |
| BOM per pakiet                     | eksporter     | wkrotce           |
| Eksport KiCad .kicad_sch           | eksporter     | wkrotce           |
| Bus / hierarchical sheets          | —             | poza zakresem     |
