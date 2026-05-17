# Kronikarz — Viewer/Edytor
## Specyfikacja aplikacji webowej v1.0

Kronikarz to narzędzie do digitalizacji i rekonstrukcji schematów
elektronicznych. AI generuje `.sch.yaml` ze skanu → uzytkownik otwiera
Kronikarz, porownuje YAML ze skanem i poprawia bledy → eksporter
generuje KiCad.

Aplikacja jest jednoczesnie viewerem i edytorem. Domyslnie tryb
weryfikacji, edycja odblokowana przez przelacznik w toolbarze.

---

## Stack techniczny

```
React + TypeScript
Konva.js            canvas 2D — skan + nakladka
js-yaml             parsowanie i serializacja YAML
Zustand             stan aplikacji
Tailwind CSS        UI panels
```

Dziala lokalnie w przegladarce. Pliki YAML i skany serwowane przez:

```bash
cd MJC-400/
python -m http.server 8080
# otworz http://localhost:8080/kronikarz/
```

Lokalny serwer Node.js do zapisu plikow:

```
GET  /files/*    → serwuje pliki statyczne
PUT  /files/*    → zapisuje plik na dysk
```

Zmiany w trybie edycji zapisywane przez `fetch PUT` natychmiastowo
(debounce 500ms).

---

## Tryby pracy

```
TRYB MODULU     wczytano project.yaml
                lista pakietow + mapa backplane signals

TRYB PAKIETU    wczytano package.yaml
                lista stron + rejestr IC + podglad PCB

TRYB STRONY     wczytano *.sch.yaml    <-- glowny widok roboczy
                skan + nakladka + weryfikacja + edycja
```

Mozna wejsc bezposrednio w tryb strony bez projektu — wtedy brak
globalnego rejestru IC i nawigacji miedzy stronami.

---

## Layout — Tryb Strony

```
┌─────────────────────────────────────────────────────────────────────┐
│ TOOLBAR                                                              │
│ [☰] [P-X3-2 ▼] [2-1 ▼] [V Zaznacz] [E Edytuj] [100%] [Opacity▓]  │
├────────────┬────────────────────────────────────────┬───────────────┤
│            │                                        │               │
│  PANEL     │           CANVAS                       │  PANEL        │
│  LEWY      │           skan + nakladka YAML         │  PRAWY        │
│            │                                        │               │
│ Strony     │                                        │ Szczegoly     │
│ ────────   │                                        │ zaznaczenia   │
│ 2-1  V    │                                        │               │
│ 2-5  …    │                                        │ ──────────    │
│ 2-15       │                                        │ Nety          │
│            │                                        │               │
│ ────────   │                                        │ ──────────    │
│ IC         │                                        │ Walidacja     │
│ ────────   │                                        │               │
│ M5  6/6    │                                        │               │
│ M8  3/4 !  │                                        │               │
│ M34 1/1    │                                        │               │
└────────────┴────────────────────────────────────────┴───────────────┘
│ STATUS  strona: 2-1 | pakiet: P-X3-2 | zoom: 147% | M5.A — pin1   │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Layout — Tryb Pakietu

```
┌─────────────────────────────────────────────────────────────────────┐
│ [☰ Modul] [P-X3-2]                                                   │
├────────────┬────────────────────────────────────────┬───────────────┤
│ STRONY     │  [Schemat] [PCB Front] [PCB Back]      │ REJESTR IC    │
│            │                                        │               │
│ 2-1  V    │  miniatura wybranej strony             │ M5  6/6   V  │
│ 2-5  …    │  lub zdjecie plytki                    │ M8  3/4   !  │
│ 2-15       │                                        │ M34 1/1   V  │
│            │                                        │               │
│            │                                        │ BOM: 8 IC     │
│            │                                        │ [Eksportuj]   │
└────────────┴────────────────────────────────────────┴───────────────┘
```

---

## Layout — Tryb Modulu

```
┌─────────────────────────────────────────────────────────────────────┐
│ MJC-400 — Modul Jednostki Centralnej                                │
├──────────────────────────┬──────────────────────────────────────────┤
│ PAKIETY                  │ BACKPLANE SIGNALS                         │
│                          │                                           │
│ P-X3-2  Sterowanie  wip  │ +K1   P-X3-2/A23 → P-M3-2/B15           │
│ P-M3-2  Magistrala  raw  │ -WP   P-X3-2/B21 → P-D3-2/C7            │
│ P-D3-2  Pakiet D    raw  │ +WA   P-X3-2/A25 → P-M3-2/A8            │
│                          │                                           │
│ [Otworz pakiet]          │ [klik → przejdz do strony ze zlaczem]    │
└──────────────────────────┴──────────────────────────────────────────┘
```

---

## Canvas — warstwy (od dolu)

```
1. ImageLayer       skan JPEG, regulowana opacity
2. NetLayer         segmenty sciezek i junction doty
3. GateLayer        prostokciety bramek, trojkaty, R/C
4. PinLayer         koncowki pinow, cross-page strzalki
5. LabelLayer       etykiety ref, ic, numery pinow
6. SelectionLayer   highlight zaznaczenia
7. EditLayer        tylko w trybie edycji — preview drag, nowe elementy
```

---

## Rendering elementow

### Bramka IC — prostokat

```
  label_left
      |
num ──┤  ref  ├── num
      │  ic   │
num ──┤       ├── num
      label_right
```

Kolory obrysu:
```
verified: true   →  #4CAF50  zielony
verified: false  →  #FFC107  zolty     (domyslny po AI)
blad walidacji   →  #F44336  czerwony
zaznaczony       →  #2196F3  niebieski
```

### Bufor trojstanowy

`shape: triangle` w ic_map → trojkat skierowany zgodnie z rotacja.

### Rezystor

Poziomy: linia-prostokat-linia
Pionowy (rotation 90): prostokat-linia pionowa

### Kondensator

Dwie rownolegle kreski prostopadle do kierunku pinu.

### Symbol zasilania

```
VCC:  strzalka w gore z etykieta
GND:  trzy malejace poziome kreski
```

### Cross-page strzalka

```
wyjscie:  NET ────────< A23 >
wejscie:  < B21 >──────── NET
```

Klikalna — przechodzi do strony docelowej jezeli projekt wczytany.

### Sciezka niezweryfikowana

`segments: null` → przerywana linia laczaca piny netu po linii prostej.
Sygnalizuje ze net istnieje ale geometria nie jest zmapowana.

### Junction dot

Wypelnione kolko w miejscu polaczenia T lub X.

---

## Tryb Zaznaczania (V)

### Klik na bramke

```
zaznacza bramke
podswietla wszystkie nety tej bramki (#FF9800 pomaranczowy)

panel prawy:
  M5 — gate A
  SN7404N — Hex Inverter
  ──────────────────────
  Piny:
    1 (in)   NET_BUS_13
    2 (out)  -K1 → A23
  Pozycja: x=340 y=120 rot=0
  verified: nie  [Oznacz tak]
  note: —  [Dodaj notate]
  ──────────────────────
  Inne bramki M5:
    A  2-1  (ta strona)
    B  2-1
    C  2-5   [→]
    D  2-5   [→]
    E  2-15  [→]
    F  nieuzywana
```

### Klik na sciezke lub net

```
zaznacza net
podswietla wszystkie piny i segmenty netu

panel prawy:
  NET_BUS_13
  ──────────────────────
  Piny (ta strona):
    M5.A.1
    M8.A.1
    M8.B.1
  Segmenty: 3
  Junctions: 2
  Cross-page: brak
```

### Klik na IC w panelu lewym

```
panel prawy — lista wszystkich bramek M8 w pakiecie:
  A  2-1  ok
  B  2-1  ok
  C  2-1  ok
  D  2-5  ! nie zmapowana
  [Przejdz do 2-5]
```

### Klik na cross-page strzalke

Jezeli projekt wczytany → przechodzi do strony docelowej i zaznacza
odpowiadajacy net.

### Hover na elemencie

Tooltip z: ref, gate, ic, lista pinow i netow.

---

## Tryb Edycji (E)

Przelacznik w toolbarze. Wszystkie zmiany zapisywane do YAML przez
`PUT /files/...` natychmiastowo (debounce 500ms).

### Przesuwanie bramki

```
drag bramki → aktualizuje x, y w YAML
piny (px, py) przesuwaja sie razem z bramka (offset zachowany)
segmenty sciezek podlaczonych do pinow rozciagaja sie odpowiednio
```

### Edycja wlasciwosci w panelu prawym

```
M5 — gate A
──────────────────────
ref:  [M5      ]      edytowalne pole
gate: [A       ]
ic:   [04      ]      zmiana → aktualizuje dane z ic_map
rot:  [0  ▼    ]      dropdown 0/90/180/270

Piny:
  1  NET_BUS_13  [NET_BUS_13     ]  edytowalne nazwy netow
  2  -K1         [-K1            ]
     cross page: [A23            ]

[Usun bramke]
```

### Dodawanie bramki

Klik na pusta przestrzen w trybie edycji:

```
popup:
  ref:  [    ]   np. M22
  gate: [    ]   np. A (lub auto — pierwsza wolna bramka M22)
  ic:   [    ]   np. 04
  [Dodaj]

→ bramka pojawia sie w miejscu klikniecia
→ package.yaml aktualizowany automatycznie (nowy wpis lub nowa bramka)
```

### Edycja sciezek

```
klik na segment → zaznacza segment
  drag punktu koncowego → wydluza/skraca
  [Usun segment]

klik na pin netu + klik na inny pin → dodaje segment miedzy nimi

klik na segment → [Dodaj wezel]
  → segment dzieli sie na dwa, mozna przeciagnac wezel
```

### Edycja junction dotow

```
klik w miejscu skrzyzowania sciezek → dodaje junction dot
klik na istniejacy junction dot → usuwa
```

---

## Skroty klawiszowe

```
V            tryb zaznaczania
E            tryb edycji
K            toggle verified na zaznaczonej bramce (oba tryby)
[ / ]        opacity skanu -/+ 10%
\            toggle opacity 0% / ostatnia wartosc
Scroll       zoom
Space+drag   pan
0            fit to screen
1            100%
2            200%
Delete       usun zaznaczony element (tryb edycji)
Ctrl+Z       undo (tryb edycji, ostatnie 50 operacji)
Ctrl+Y       redo
Escape       odznacz / anuluj operacje
```

---

## Panel lewy

### Lista stron

```
STRONY — P-X3-2
────────────────
▶ 2-1   P-X3-2   V done
  2-5   P-X3-2   … wip
  2-15  P-X3-2     raw
```

### Lista IC

```
IC W PAKIECIE
────────────────
M5   04  SN7404N   6/6  V
M8   00  SN7400N   3/4  !
M34  175 SN74175N  1/1  V
R1   —   1k             V
```

`3/4` = 3 bramki zmapowane na stronach, 1 brakuje.
`!` = kliknij aby zobaczyc ktora.

---

## Panel prawy — walidacja

Zawsze widoczna na dole panelu prawego:

```
WALIDACJA
────────────────────────────────
ERR  M5.C: zadeklarowana na 2-5, brak w pages/2-5.sch.yaml
WARN M8.D: nie zmapowana na zadnej stronie
WARN NET_BUS_9: tylko 1 pin (net wiszacy)
INFO 8 netow bez segmentow (segments: null)
INFO 4 bramki unverified
```

---

## Statusbar

```
[strona: 2-1] [pakiet: P-X3-2] [zoom: 147%] [opacity: 60%] | M5.A — SN7404N — pin 1: NET_BUS_13
```

---

## Estetyka

Nawiazuje do monitorow fosforowych z epoki Mery 400.

```css
--bg-main:      #0d1117;
--bg-panel:     #161b22;
--bg-accent:    #1c2333;
--phosphor:     #39ff14;   /* zielony fosfor — glowny akcent */
--phosphor-dim: #1a7a0a;
--text:         #c9d1d9;
--text-dim:     #8b949e;
--verified:     #4CAF50;
--warning:      #FFC107;
--error:        #F44336;
--selected:     #2196F3;
--net-active:   #FF9800;
--font:         'IBM Plex Mono', monospace;
```

Jeden font monospace przez caly interfejs.

---

## Implementacja — kolejnosc etapow

### Etap 1 — proof of concept

Cel: sprawdzic czy pozycje z YAML Claude nakladaja sie sensownie na skan.

1. Lokalny serwer Node.js (GET/PUT plikow)
2. Wczytanie jednego `*.sch.yaml` + skanu
3. Rendering bramek jako prostokotow na canvasie nad skanem
4. Suwak opacity skanu
5. Klik bramka → panel prawy z danymi
6. Zoom + pan

### Etap 2 — nety i sciezki

1. Rendering segmentow sciezek (#666666)
2. Przerywane linie dla `segments: null`
3. Junction doty
4. Klik net/sciezka → podswietlenie wszystkich pinow netu (#FF9800)
5. Cross-page strzalki (nieaktywne)

### Etap 3 — edycja podstawowa

1. Przelacznik V/E w toolbarze
2. Drag bramki → aktualizacja x, y → zapis do YAML przez PUT
3. Edycja nazwy netu w panelu (klik → input)
4. Toggle verified klawiszem K → zapis
5. Undo/redo (Zustand + historia, 50 krokow)

### Etap 4 — pakiet

1. Wczytanie `package.yaml`
2. Panel lewy: lista stron + lista IC z licznikami bramek
3. Nawigacja miedzy stronami pakietu
4. Widok wszystkich bramek IC po kliknieciu w panel
5. Cross-page linki aktywne (nawigacja miedzy stronami pakietu)

### Etap 5 — edycja pelna

1. Dodawanie bramek (popup przy kliknieciu na puste miejsce)
2. Usuwanie bramek
3. Edycja sciezek: dodawanie/usuwanie segmentow i wezlow
4. Dodawanie/usuwanie junction dotow
5. Auto-aktualizacja package.yaml przy dodaniu nowego IC

### Etap 6 — modul i walidacja

1. Wczytanie `project.yaml`
2. Tryb Modulu: lista pakietow i backplane signals
3. Panel walidacji z pelna lista bledow i ostrzezen
4. Cross-package linki przez backplane

### Etap 7 — eksport (osobny CLI)

```bash
node kronikarz-export.js --package P-X3-2/package.yaml --out kicad/
# generuje:
#   kicad/P-X3-2.kicad_sch
#   kicad/P-X3-2-bom.csv
```

---

## Czego Kronikarz NIE robi

- Nie jest pelnym edytorem schematow — AI generuje, czlowiek koryguje
- Nie zastepuje KiCad — jest przed nim w pipeline
- Nie generuje Gerberow
- Nie symuluje obwodow
- Nie edytuje `ic_map.yaml` — plik reczne utrzymywany