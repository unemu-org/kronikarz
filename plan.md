# Kronikarz — Plan implementacji

Plan zadań od fundamentów po pełny edytor. Każdy etap kończy się działającym artefaktem. Numeracja zadań trwała — przesuwamy je do "done" zamiast usuwać.

Źródła:
- `specyfikacje-kronikarza/format-spec.md` — schema YAML
- `specyfikacje-kronikarza/podglad-edytor-spec.md` — UX, warstwy, skróty
- `specyfikacje-kronikarza/srodowisko-developerskie.md` — toolchain

Legenda statusów: `[ ]` todo, `[~]` w trakcie, `[x]` done, `[!]` zablokowane.

---

## Etap 0 — Bootstrap projektu

Cel: każdy klon repo daje działający shell + workspace.

- [x] 0.1 `flake.nix` + `.envrc` + `.env.example`
- [x] 0.2 `Justfile` z taskami `dev/build/lint/fmt/typecheck/validate/export/install/clean`
- [x] 0.3 `package.json` root z npm workspaces `viewer`, `server`, `export`
- [x] 0.4 `package.json` per workspace (deps z `srodowisko-developerskie.md`)
- [x] 0.5 `.gitignore` + `.gitattributes` (LFS dla `*.jpg|jpeg|png|pdf`)
- [x] 0.6 `CLAUDE.md` (zrobione w trakcie inicjalizacji)
- [x] 0.7 Inicjalizacja `git init` + `git lfs install --local`
- [x] 0.8 `prettier`/`eslint` config (root: `.prettierrc`, `.prettierignore`, `.eslintrc.cjs`)
- [x] 0.9 `tsconfig.base.json` w root + `tsconfig.json` w `viewer` i `export`
- [x] 0.10 Dane: `data/MJC-400/<pkg>/scans/` — 155 stron z DTR PDF, podzielone na 12 pakietów (P-X3-2, P-M3-2, P-D3-2, P-P3-2, P-R3-2, P-A3-2, I-SK1-1, SM-POSET-1, SM-PKT-1, JPP-16-18, SPP-32-16, PPS-32)
- [x] 0.11 Smoke test: `nix develop` + `npm install` + `just --list` OK

Artefakt: katalog wchodzi do shella, `just --list` pokazuje taski.

---

## Etap 0.5 — Ekstrakcja i klasyfikacja skanów (zrobione)

Cel: skany z DTR PDF rozdzielone na pakiety zgodnie z `format-spec.md`.

- [x] 0.5.1 `pdfimages -all` → `data/scans-raw/page-NNN.png` (155 stron, lossless z PDF)
- [x] 0.5.2 `scripts/vision-classify.py` — crop title-block + `claude-opus-4-7` vision API → JSON `{package, page_id, confidence}`
- [x] 0.5.3 Cache odpowiedzi w `data/.vision-cache/page-NNN.json` (gitignored, odtwarzalne)
- [x] 0.5.4 Sekwencyjny fill: pojedyncze odstępstwa absorbowane przez sąsiadów (założenie: pakiety w DTR ciągłe)
- [x] 0.5.5 Konwersja PNG → JPEG q90, kopia do `data/MJC-400/<pkg>/scans/<page-id>.jpg`

Artefakt: 12 pakietów × 6-21 stron, 0 unmatched, każdy plik z page-id z DTR (2-1 ... 2-155).

Odrzucone wcześniejsze podejścia:
- `tesseract` OCR + regex — zbyt dużo OCR-misreads (P→2, X→13, D→P), wymagało ręcznej normalizacji i tak dawało błędne grupowania
- `scripts/ocr-split.sh` + `scripts/normalize.py` — usunięte

---

## Etap 1 — Server plików (Node.js)

Cel: `GET/PUT /files/*` nad `KRONIKARZ_DATA`. Najprostszy fundament — viewer może działać bez bazy.

- [x] 1.1 `server/index.js` — Express + CORS, czyta `KRONIKARZ_DATA`, `KRONIKARZ_PORT`
- [x] 1.2 `GET /files/*path` — strumieniowo serwuje plik z `KRONIKARZ_DATA`; 404 jeśli brak
- [x] 1.3 `PUT /files/*path` — body do pliku; `mkdir -p` parent dir; atomic write (`.tmp` + rename)
- [x] 1.4 `GET /list/*path` — listing katalogu (JSON: `{files, dirs}`)
- [x] 1.5 Path traversal guard — odrzuć `..`, ścieżki poza ROOT
- [x] 1.6 Logging: metoda, URL, status, ms
- [x] 1.7 `watchexec` w `npm run dev -w server` — restart na zmianę (już w package.json)
- [x] 1.8 Smoke test: health/list/PUT/GET/DELETE/traversal/404 wszystkie ✓
- [x] 1.9 Bonus: `DELETE /files/*` + `/health` endpoint

Artefakt: lokalny FS-as-API. Reszta to klient.

---

## Etap 2 — Parsery i typy YAML (shared)

Cel: jeden zestaw typów TS i loaderów używany przez viewer i export.

- [ ] 2.1 Katalog `shared/` jako workspace (`@kronikarz/shared`) z `tsconfig` i `index.ts`
- [ ] 2.2 Typy TS dla `project.yaml`, `package.yaml`, `*.sch.yaml`, `ic_map.yaml` (1:1 z `format-spec.md`)
- [ ] 2.3 Loadery: `loadProject(path)`, `loadPackage(path)`, `loadPage(path)`, `loadIcMap(path)`
  - parsują `js-yaml`, walidują wersję `kronikarz: "1"`, zwracają sparsowany obiekt + ścieżki względne rozwiązane
- [ ] 2.4 Writery: `writePage(path, page)` etc. — używają `js-yaml.dump` z opcją zachowania kolejności kluczy + stabilny styl (cytowanie etykiet jak `"-K1"`, `"+WP"`)
- [ ] 2.5 Helper `pinId(ref, gate, num) → "REF.GATE.NUM"` + parser odwrotny
- [ ] 2.6 Walidatory (czysto strukturalne, nie business-logic):
  - `validatePage(page, pkg, icMap) → Issue[]` — referencje gate'ów istnieją w `package.yaml`; piny w `ic_map`; nety mają ≥1 pin
  - `validatePackage(pkg, projectIcMap) → Issue[]` — bramki przypisane do istniejących stron; sufiks IC w `ic_map`
  - `validateProject(proj) → Issue[]` — backplane refs do istniejących pakietów
- [ ] 2.7 `Issue = { level: 'err'|'warn'|'info', code, message, ref? }` — kod używany przez UI i CLI

Artefakt: `import { loadPage, validatePage } from '@kronikarz/shared'` działa.

---

## Etap 3 — Viewer szkielet (Vite + React + Konva)

Cel: aplikacja startuje, ładuje przez `fetch` jeden `*.sch.yaml` + skan, rysuje pusty canvas.

- [ ] 3.1 `viewer/vite.config.ts` + plugin React + proxy `/files` → `http://localhost:8080`
- [ ] 3.2 `viewer/index.html`, `src/main.tsx`, `src/App.tsx`
- [ ] 3.3 Tailwind config + paleta z `podglad-edytor-spec.md` (zmienne CSS `--phosphor` itd.), font IBM Plex Mono
- [ ] 3.4 Zustand store `useDocStore` — pola: `project`, `pkg`, `page`, `icMap`, `mode: 'module'|'package'|'page'`, `tool: 'select'|'edit'`
- [ ] 3.5 Routing przez URL hash: `#/page/<pkg>/<page>`, `#/package/<pkg>`, `#/module` — pozwala deep-linkować
- [ ] 3.6 Loader: po zmianie route fetch z `/files/...`, parse przez `shared`, zapis do store
- [ ] 3.7 `Canvas.tsx` — `<Stage>` Konva, scroll-to-zoom, Space+drag pan, klawisze `0/1/2` (fit/100%/200%)
- [ ] 3.8 Tło canvas + komunikat "brak danych" gdy `page === null`

Artefakt: `just dev`, `localhost:5173/#/page/MJC-400/P-X3-2/2-1` → widać pusty stage z zoomem.

---

## Etap 4 — Tryb Strony, MVP renderingu (read-only)

Cel: `Etap 1` z spec UX — proof of concept że pozycje z YAML siadają na skan.

- [ ] 4.1 `ImageLayer` — `<Image>` Konva ze skanem strony (`pkg.pages[i].scan`), regulowana opacity, suwak w toolbarze (`[`/`]`/`\`)
- [ ] 4.2 `GateLayer` — prostokąty z `gates[]`:
  - bramka IC: prostokąt z `ref` (góra) i `ic` (dół) — obrys wg `verified` (zielony/żółty)
  - rotacja 0/90/180/270 (Konva `rotation`)
- [ ] 4.3 `PinLayer` — kropki w `pins[].px,py`, numer pinu jako label
- [ ] 4.4 `LabelLayer` — `label_left`, `label_right` przy bramce
- [ ] 4.5 `SelectionLayer` — highlight po kliknięciu (niebieski obrys)
- [ ] 4.6 Panel prawy `SelectionPanel.tsx` — pokazuje dane zaznaczonej bramki: ref/gate/ic/piny/pozycja/verified/note
- [ ] 4.7 Toolbar: zoom %, opacity, info o pakiecie/stronie
- [ ] 4.8 Statusbar dolny: strona, pakiet, zoom, opacity, hover-info
- [ ] 4.9 Hover tooltip nad bramką: ref, gate, ic, piny+nety

Artefakt: można otworzyć stronę i zobaczyć czy AI dobrze rozmieściła bramki.

---

## Etap 5 — Nety i ścieżki

Cel: druga warstwa wizualna — połączenia.

- [ ] 5.1 `NetLayer` — rysuje `nets[*].segments` jako linie `#666666`
- [ ] 5.2 Przerywane linie (dash) gdy `segments: null` — łączy piny netu po prostej (placeholder)
- [ ] 5.3 Junction doty: wypełnione kółka w `nets[*].junctions`
- [ ] 5.4 Klik na segment → zaznacza net → podświetla wszystkie piny i segmenty (`#FF9800`)
- [ ] 5.5 Klik na bramkę → podświetla wszystkie nety jej pinów (ten sam kolor)
- [ ] 5.6 `SelectionPanel` w trybie "net": lista pinów, liczba segmentów/junctions, cross-page
- [ ] 5.7 Cross-page strzałki `< A23 >` — render jako trójkątne końcówki przy pinach z `cross:` (nieaktywne klikalnie na tym etapie)
- [ ] 5.8 Symbole zasilania — `VCC` (strzałka w górę), `GND` (trzy kreski malejące)

Artefakt: pełny widok strony — bramki + nety + symbole.

---

## Etap 6 — Rendering elementów pasywnych i specjalnych

Cel: nie tylko prostokąty IC.

- [ ] 6.1 Rezystor (`shape: resistor` w `ic_map`): linia-prostokąt-linia, rotacja honoruje pionowy/poziomy
- [ ] 6.2 Kondensator (`shape: capacitor`, `capacitor_polarized`): dwie równoległe kreski prostopadle do osi pinów; polarized: jedna zaokrąglona
- [ ] 6.3 Bufor trójstanowy (`shape: triangle`): trójkąt w kierunku rotacji
- [ ] 6.4 Flip-flop (74175/H06): prostokąt z polami `clk/d/q/nq/pre/clr` zamiast `in/out` — etykiety pinów wg `gate_pins` z `ic_map`
- [ ] 6.5 Generyczny fallback: nieznany `shape` → prostokąt z numerami pinów

Artefakt: pełna paleta elementów spec.

---

## Etap 7 — Tryb Pakietu

Cel: panel lewy z listą stron + IC, nawigacja, podgląd PCB.

- [ ] 7.1 Loader `package.yaml` aktywny gdy URL `#/package/<pkg>` lub strona ze znanego pakietu
- [ ] 7.2 Panel lewy `SidebarLeft.tsx` — sekcja STRONY: lista `pages[]` ze statusem, klik → przejście
- [ ] 7.3 Sekcja IC: lista `components` z licznikami `zmapowane/wszystkie` (bramka zmapowana = istnieje w `pages/*.sch.yaml`)
- [ ] 7.4 Klik na IC → panel prawy: lista wszystkich bramek IC w pakiecie, `[→]` do stron docelowych
- [ ] 7.5 Widok pakietu (`#/package/<pkg>`): zakładki `[Schemat] [PCB Front] [PCB Back]`, miniatura wybranej strony lub `pcb.front/back`
- [ ] 7.6 Cross-page strzałki klikalne — nawigacja do strony docelowej + auto-select odpowiadającego netu
- [ ] 7.7 BOM panel: zliczenie IC i pasywnych

Artefakt: praca na całym pakiecie, nie tylko jednej stronie.

---

## Etap 8 — Edycja podstawowa

Cel: spec `Etap 3`. Przełącznik V/E, drag, edycja właściwości, persist przez PUT.

- [ ] 8.1 Toolbar: przełącznik `V Zaznacz` / `E Edytuj`, klawisze `V`/`E`
- [ ] 8.2 Drag bramki w trybie E → aktualizuje `gate.x, gate.y`; piny przesuwają się o ten sam offset; segmenty podłączone do tych pinów również (końcówka segmentu = pozycja pinu)
- [ ] 8.3 Debounced PUT (500ms) — `writePage` przez `/files/...`; wskaźnik "Zapisano" / "Zapisywanie..." w toolbarze
- [ ] 8.4 Edycja pól w `SelectionPanel` w trybie E: `ref`, `gate`, `ic`, `rotation` (dropdown), nazwy netów, `cross.page`/`cross.label`
- [ ] 8.5 Zmiana `ic` → re-resolve z `ic_map` (nowe pin layout, `gate_pins`) + walidacja czy bramka ma jeszcze sens
- [ ] 8.6 Klawisz `K` → toggle `verified` zaznaczonej bramki + PUT
- [ ] 8.7 Undo/redo (Ctrl+Z/Y), historia 50 kroków, zustand-middleware `temporal` lub własna implementacja diff-based
- [ ] 8.8 Escape → odznacz / anuluj operację
- [ ] 8.9 Delete → usuń zaznaczony element (z confirm gdy bramka z mapowanymi netami)

Artefakt: korekta YAML wygenerowanego przez AI bez wychodzenia z viewera.

---

## Etap 9 — Edycja pełna (sieci, dodawanie, usuwanie)

Cel: spec `Etap 5`. Rzeczywisty edytor schematów.

- [ ] 9.1 Dodawanie bramki: klik w pustą przestrzeń (tryb E) → popup `ref/gate/ic`, "auto" znajduje pierwszą wolną literę gate'u dla danego `ref`
- [ ] 9.2 Auto-update `package.yaml`: nowy `components[ref]` jeśli ref nie istnieje, nowy `gates[X]` jeśli ic znany
- [ ] 9.3 Usuwanie bramki: czyści wpisy w `package.yaml` (`gates[X] = null`) + usuwa z `*.sch.yaml`
- [ ] 9.4 Edycja ścieżek:
  - klik segment → zaznacza → drag końcówki → modyfikuje współrzędne
  - klik segment + `[Dodaj węzeł]` → dzieli na dwa segmenty z węzłem do przeciągania
  - `[Usuń segment]`
- [ ] 9.5 Tworzenie nowego segmentu: klik pin → klik inny pin → segment + (opcjonalnie) prosta routing
- [ ] 9.6 Junction doty: klik w skrzyżowanie segmentów → dodaj; klik na istniejący → usuń
- [ ] 9.7 Mergowanie/splitowanie netów: drag pin z netu A na pin netu B → konsolidacja (z confirm); rozłączenie pinu od netu
- [ ] 9.8 Rename netu globalnie w stronie — propagacja do wszystkich `pins[].net`

Artefakt: można narysować schemat od zera, nie tylko poprawiać AI.

---

## Etap 10 — Tryb Modułu + walidacja globalna

Cel: spec `Etap 6`.

- [ ] 10.1 Loader `project.yaml` (`#/module`)
- [ ] 10.2 Layout tryb Modułu: lewy panel pakietów, prawy backplane signals
- [ ] 10.3 Klik backplane signal → przejście do strony pakietu ze złączem `connector_pin`
- [ ] 10.4 Panel walidacji dolny prawy (zawsze widoczny): agregat `Issue[]` z `validatePage/Package/Project`
  - kategorie: ERR (referencje), WARN (wiszące nety, niezmapowane bramki), INFO (unverified, brak segmentów)
  - klik w issue → nawigacja + zaznaczenie obiektu
- [ ] 10.5 Liczniki bramek w panelu lewym pakietu — re-calculated po zmianach
- [ ] 10.6 Cross-package linki przez backplane (kolejna warstwa cross-page — między pakietami)

Artefakt: widok całego modułu, pełna walidacja.

---

## Etap 11 — Eksporter KiCad (CLI)

Cel: spec `Etap 7`. Osobny pipeline, używa tych samych typów `shared`.

- [ ] 11.1 `export/index.js` — `commander` CLI: `--package <path> --out <dir>` + `--project` (cały moduł)
- [ ] 11.2 Generator `*.kicad_sch`:
  - skala: piksele skanu → mm (parametr `--scale`, domyślnie heurystyka z `scan_size`)
  - symbole z `kicad_symbol` w `ic_map`
  - placement bramek wg `x,y,rotation`
  - sieci: nazwy + segmenty (skonwertowane), junctions
  - hierarchical labels dla `cross:`
- [ ] 11.3 BOM `*-bom.csv` — agregat z `components` per pakiet
- [ ] 11.4 `--validate-only` flag — tylko raport, bez generowania
- [ ] 11.5 Test: round-trip — KiCad otwiera output bez błędów; netlist matchuje YAML
- [ ] 11.6 `just export PKG=...` używa CLI

Artefakt: `.kicad_sch` otwiera się w KiCad 8+ z poprawnym netlistem.

---

## Etap 12 — Polish

- [ ] 12.1 Estetyka: pełny phosphor theme, animacje (fade selection), kursory per tryb
- [ ] 12.2 Skróty klawiszowe wszystkie ze spec (`[`/`]`/`\`/`0`/`1`/`2`/V/E/K/Del/Esc/Ctrl+Z/Y)
- [ ] 12.3 Auto-save indicator, error toast na nieudany PUT
- [ ] 12.4 Pre-commit: `prettier --check` + `tsc --noEmit` w hooku
- [ ] 12.5 `mdbook` z dokumentacją w `docs/` (opcjonalnie, jeśli będzie potrzeba)
- [ ] 12.6 Performance: virtualizacja gdy >500 bramek na stronie; lazy load skanów

---

## Decyzje otwarte (do rozstrzygnięcia w trakcie)

- Routing: hash vs `react-router` history API (hash prostszy z `python -m http.server`)
- Undo: zustand-temporal middleware vs ręczna historia diff'ów
- Format zapisu YAML: zachowanie komentarzy z oryginału? `js-yaml` ich nie zachowuje. Alternatywa: `yaml` (eemeli) z `Document`/`Node` API
- Skala piksele→mm dla KiCad: czy w `package.yaml` per pakiet, czy parametr CLI
- LFS vs goły git: zdjęcia PCB mogą być >5MB każde
