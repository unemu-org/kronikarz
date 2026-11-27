# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projekt

Kronikarz — narzędzie do digitalizacji schematów elektronicznych MERA-400 (Polska, lata 70.). Workflow: Vision-AI + człowiek wykrywają komponenty na skanie → człowiek rysuje ścieżki w viewerze → eksporter generuje KiCad.

Spec docs: `specyfikacje-kronikarza/` (`format-spec.md`, `vision-prompt.md`, `cross-refs-ulepszenia.md`).

## Praca z zadaniami (beads)

| Co | Gdzie | Kiedy |
|----|-------|-------|
| **Lista zadań (źródło prawdy)** | beads — `bd ready --exclude-type epic`, `bd list --type epic`, `bd show <id>` | Zawsze. **Nie czytaj roadmapy z markdown** (`docs/archive/plan.md` to tylko historia). |
| **Wspólne zasady: role, droga beada do main, briefy workerów, dane** | bd memories — `bd memories`, `bd recall <klucz>` | **Na starcie sesji, przed jakąkolwiek pracą nad zadaniem** |
| Statusy, epiki, Definition of Done, git flow | [`docs/praca-z-zadaniami.md`](docs/praca-z-zadaniami.md) | Przed claimem pierwszego beada |

Role, droga od beada do `main`, zasady dla workerów i ochrona danych to bd memories — czytaj je przez `bd memories` (`bd recall <klucz>` dla jednej; `bd prime` też je drukuje). Statusy (`open` / `in_progress` / `closed`), epiki, Definition of Done i git flow opisuje `docs/praca-z-zadaniami.md`. Supervisor wybiera pracę przez `bd ready --exclude-type epic`, claimuje ją `bd update <id> --claim` **zanim** powstanie kod, i zamyka dopiero po wylądowaniu na `main`, z reason podającym commit. Workerzy nie claimują i nie zamykają beadów; raportują do supervisora. Notatki dopisuj przez `--append-notes` — nigdy `--notes` na istniejącym beadzie (zastępuje pole). Treść beadów po polsku. Tam gdzie ogólne rady `bd prime` różnią się od tych dokumentów i memories, wygrywają dokumenty i memories.

Start sesji: `bd memories`, potem `bd list --status in_progress` i `bd show <id>`. Pauza: `bd update <id> --append-notes "Pauza sesji $(date -I). Zrobione: <X>. Dalej: <Y>. Blocker: <Z|brak>."`.

## Środowisko

Nix flake + direnv. DevShell ma Node.js 22, python3, uv, prettier, eslint, yq-go, just, watchexec, git-lfs.

```bash
direnv allow                 # pierwszy raz / po zmianie flake.nix
just install                 # npm install (workspaces)
cp .env.example .env         # KRONIKARZ_DATA, KRONIKARZ_PORT, ANTHROPIC_API_KEY
```

Python scripts: `uv run scripts/<name>.py`. Server resolwuje `uv` z PATH lub `nix develop --command uv` jako fallback.

## Komendy

```bash
just dev                     # viewer (Vite :5173) + server (:8080) równolegle
just viewer | just server    # pojedynczy proces
just build / just typecheck / just lint / just fmt
just validate data/MJC-400/<PKG>  # yq sprawdza YAML pakietu i stron
just export PKG=...          # node export/index.js → dist/kicad/   (nie zaimplementowane)
```

Per workspace: `npm run <script> -w viewer|server|export|shared`.

## Architektura

Monorepo npm workspaces, 4 paczki + skrypty Python:

- **shared** (`@kronikarz/shared`) — typy YAML (`types.ts`), parser i `resolveIcKey` normalizujący 74xx prefiksy (SN/UCY/MCY/MH/CDB/HCF, polski H, sufiks N/D), walidator (`validate.ts`). `io.ts` Node-only — nie importować z viewera.
- **viewer** — React 18 + Vite + Konva (canvas) + Zustand (`store.ts`) + js-yaml + Tailwind. Routing przez hash w `router.ts`. Trzy widoki: **moduł** (`project.yaml`, backplane), **pakiet** (`package.yaml`), **strona** (`*.sch.yaml`, główny widok roboczy). Auto-save: PUT z debounce 500ms przez kolejkę `saveQueue.ts` — przed POST zmieniającym pliki i przed reload zawsze `flushSaves`, a operacje przepisujące stronę na serwerze (restore .bak) idą przez `runRewrite` (strona zablokowana do przeładowania). Testy: `npm test -w viewer`. Vite proxy do `:8080` dla `/files /list /health /ai-detect /yolo-* /vision-page /vision-page-zones /make-bak /restore-bak`.
- **server** — Express, fs-based, słucha tylko na `127.0.0.1` (`KRONIKARZ_HOST`), przyjmuje tylko `Host` loopback, a każdy zapis (PUT/DELETE/POST) wymaga nagłówka `X-Kronikarz: 1` — w viewerze zawsze przez `apiWrite` z `viewer/src/api.ts`. Testy: `npm test -w server`. GET/PUT/DELETE `/files/*` w `KRONIKARZ_DATA`. Serializowane per plik (kolejka promise po ścieżce, w kolejności przyjścia): PUT i DELETE `/files/*`, `/make-bak`, `/restore-bak` (`/vision-page*` nie — skrypt pisze sam). PUT: `*.sch.yaml`/`package.yaml`/`project.yaml` muszą być mapą z `kronikarz: "1"`, `ic_map.yaml`/`*.zones.yaml` mapą — inaczej 422 i plik nietknięty; brak body (bez Content-Length/Transfer-Encoding) → 400. GET `*.yaml` zwraca silny `ETag` (sha1 treści; JSON-owe odpowiedzi bez ETag); PUT z niezgodnym `If-Match` → 409 `{error:'conflict', etag}` i plik nietknięty — wyjątek: body identyczne z bieżącą treścią → 200 bez zapisu (bezpieczny retry PUT-a, którego odpowiedź zginęła). Bez `If-Match` zapis bezwarunkowy; sukces zwraca nowy `ETag`. Viewer: autosave wysyła `If-Match` (409 = błąd „plik zmieniony poza tą kartą”, bez ponawiania, do przeładowania); zapisy innych stron (kopiuj do wszystkich stron, auto-add cross_ref) tylko przez `updateDataFile` z `store.ts` (flush → GET → PUT z `If-Match`); loader przed wczytaniem robi flush. POST endpoints odpalają Python scripts przez uv. Body globalnie `express.raw` (dowolny/brak Content-Type) → JSON ręcznie przez `parseJsonBody`. `/make-bak` i `/vision-page*` robią `.bak` + timestamped; `/restore-bak` tylko timestamped (patrz Backups). Bez bazy.
- **export** — Node CLI (commander). **Niezaimplementowane** — tylko `package.json` + stub.

### Warstwy viewera (`viewer/src/layers/`)

- `ImageLayer` — skan
- `GateLayer` — bramki + 8-handle resize (gdy `shape === 'rect'`) + multi-select drag
- `PinLayer` — drag z `snapPinToEdge`, etykietki nad pinami, orphan pins na czerwono
- `NetLayer` — segmenty + auto-junctions + `pushOutOfGates` + port-stub dla orphanów + czerwone złe nety. Alt+klik na segment w edit = split przy kursorze + dot
- `PortLayer` — chevron + kuleczka na open-end (rotowana per side), label/pid renderowane OSOBNYM Group (zawsze poziomo)
- `CrossRefLayer` — label NAD wirem + lista sheets (per-sheet kolor: zielony=ok, czerwony=brak return). Klik na sheet = nawigacja (faulty: + auto-add cross_ref na docelowej)
- `AnnotationLayer` — tekst z rotacją (0/90/180/270), drag w edit
- `DecorationLayer` — `line` (ortho domyślnie, Shift = freeform) / `rect` / `ellipse`
- `PowerLayer`, `CrossPageLayer`

Narzędzia: V (select + rubber-band), E (edit), R (ROI/AI detect), W (wire — orto domyślnie, Shift = freeform, auto-L corner unika landing na istniejących segmentach), Z (zones dla Vision-AI per-strefa). Multi-select: shift+klik lub rubber-band drag w V. Drag jednego elementu z multi przenosi cały zestaw. Toolbar buttony: `+ bramka/xref/port/tekst/linia/rect/koło`, align/distribute/stack-column dla multi-gate.

### Skrypty (`scripts/`)

Cache: `data/.vision-cache/`, `data/.cv-cache/...`. Wszystkie odpalane przez `uv run`.

- `vision-page.py` — Vision na cały skan, vision-prompt.md jako system → `*.sch.yaml`
- `vision-zones.py` — Vision per-strefa (zones tool w viewerze), role-specific prompty (gates/ports_left/ports_right/cross_refs_left/cross_refs_right), crop+API per zone, scale-back koordów do oryginału
- `vision-digitize.py` / `-v2.py` — legacy/eksperymentalne wersje
- `vision-classify.py`, `ai-detect-roi.py` — pomocnicze
- `detect-rects.py` / `-sam.py` — CV/SAM bramki
- `export-yolo-from-yamls.py` — eksport YOLO datasetu
- `migrate-*.py` — migracje schematu (port-split, sheet-numbers, fix-pr3-2-*)
- `gen-stubs.py`, `sync-packages.py`, `build-ic-map.py`, `install-hooks.sh` — `gen-stubs.py` i `build-ic-map.py` bez `--force` odmawiają nadpisania istniejących plików (wszystko albo nic, `_safe_write.py`); `--force` robi `<plik>.<ISO>.bak` i resetuje kuratorowane pola — na `data/` nie używać. `--root` / `--dry-run` do prób na kopii.

## Format danych (`specyfikacje-kronikarza/format-spec.md` v1.1)

Cztery typy YAML (`kronikarz: "1"`):

- `project.yaml` — manifest modułu, pakiety, `backplane` (multi-drop signals: `endpoints: [{package, connector, pin}, ...]`)
- `package.yaml` — manifest pakietu, rejestr IC (sufiks → wystąpienia), lista stron z `sheet: N` (1..N per pakiet — pokrywa się z numerem arkusza w dokumentacji)
- `*.sch.yaml` — strona: `gates`, `ports`, `cross_refs`, `power`, `nets`, `annotations` (z `rotation/fontSize`), `decorations` (line/rect/ellipse) — **pozycje w pikselach skanu**
- `ic_map.yaml` — sufiks → KiCad symbol + `gate_pins` per litera (in/out/clk/d/q/nq/pre/clr/j/k/wa/we/ra/re); `shape: triangle|resistor|capacitor|capacitor_polarized` opcjonalnie

Cross-package: `port.connector` (litera) + `port.pin` (int) dopasowywane do `project.backplane[].endpoints`. Cross-page: `cross_ref.pages: [string]` to numery arkuszy (sheet) w pakiecie — validator mapuje przez `package.pages[].sheet`.

**Source-of-truth for connectivity**: `pin.net` / `port.net` / `cr.net`. Pole `net.pins[]` jest legacy/info-only.

## Walidator (`shared/src/validate.ts`)

Kluczowe kody:
- `NET_DISCONNECTED` / `NET_ORPHAN_ENDPOINT` (err) — geometria nie pokrywa się z deklaracją netu
- `NET_FLOATING` (err) — sieć z 1 endpointem
- `ENDPOINT_NET_MISMATCH` (err) — pin/port leży na segmencie netu X ale ma `endpoint.net = Y`. Mid-line match wymaga junction-dot żeby uznać (krzyżujące się druty bez dota = osobne nety)
- `CROSS_REF_NO_RETURN` (err) — cross_ref do strony X bez powrotnego cross_refa
- `PORT_NOT_ON_BACKPLANE` (warn) — port nie dopasowany do żadnego backplane endpointu
- `GATE_LETTER_NOT_IN_COMPONENT` / `GATE_LETTER_WRONG_PAGE` / `PIN_NOT_IN_IC_MAP` (err)

`validatePackagePages(pkg, pagesMap)` ładuje wszystkie strony pakietu i sprawdza cross-page consistency. Wywoływane w loader.ts; `allPages` Map cache'owana w store, live override aktualnej strony.

## Backups

Rolling `<plik>.bak` = ostatni **ręczny** checkpoint: zmienia go tylko `/make-bak` i backup przed operacjami przepisującymi stronę (`/vision-page*`); oba robią też timestamped `<plik>.<ISO>.bak`. `/restore-bak` przywraca rolling `.bak`, a bieżący stan zapisuje tylko jako timestamped.

Autosave (PUT `/files/*.yaml` istniejącego pliku) **nigdy nie rusza rolling `.bak`** — robi tylko timestamped backup **poprzedniej** treści, najwyżej raz na 10 min na plik (`BACKUP_INTERVAL_MS`, `createApp({backupIntervalMs})`; liczą się tylko backupy autosave; stan w pamięci, po restarcie serwera pierwszy PUT znów robi backup). Tylko po takim backupie autosave serwer zostawia najnowsze 50 timestamped backupów pliku (`BACKUP_KEEP`, `createApp({backupKeep})`) — liczą się wszystkie `<plik>.<ISO>.bak` tego pliku, także z `/make-bak`, vision i restore; starsze są kasowane. Błąd sprzątania → log, zapis i tak idzie; błąd samego backupu → 500 i brak zapisu. Pliki `*.bak` w `.gitignore`.

## Licencja

Kod i dokumenty projektu: BSD-2-Clause (`LICENSE`, pole `license` w każdym `package.json`). `data/` (zdigitalizowane schematy) **nie jest objęte licencją** — to praca inżynierów MERA-400, nie nasza (`data/README.md`). Nie dopisuj nagłówków licencji do plików w `data/` i nie przenoś treści schematów do kodu jako „przykładów”; fixture’y testów rób własne.

## Skany (poza repo)

Repo jest publiczne, a do skanów dokumentacji MERA-400 nie mamy prawa redystrybucji — **skany nie są w gicie** i nie wolno ich commitować (`.gitignore`: `data/scans-raw/`, `data/MJC-400/*/scans/`, `*.pdf`). Źródłem jest `oracles/` (submodule `unemu-org/oracles`, fetch-only, przypięty sha256): `oracles/mera400/mera400-dtr-t4-cz2-mjc400-schematy.pdf`. `just scans` pobiera ten jeden PDF (z URL przypiętego w oracles) i odtwarza bajt w bajt `data/scans-raw/page-NNN.png` (arkusz `2-(NNN+1)`) i `data/MJC-400/<pkg>/scans/2-N.jpg`, sprawdzając `data/scans.sha256`. Pozostałe dokumenty MERA-400 (DTR, dokumentacja projektowa, oprogramowanie, Amepol) są w `oracles/mera400/` po `./fetch-oracles.sh fetch`; opis w `oracles/MANIFEST.md`. Worktree agenta nie ma checkoutu submodule — wskazuj mu `oracles/` z głównego checkoutu (read-only) albo `--oracles DIR`.
