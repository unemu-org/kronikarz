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
- **viewer** — React 18 + Vite + Konva (canvas) + Zustand (`store.ts`) + js-yaml + Tailwind. Routing przez hash w `router.ts`. Trzy widoki: **moduł** (`project.yaml`, backplane), **pakiet** (`package.yaml`), **strona** (`*.sch.yaml`, główny widok roboczy). Auto-save: PUT z debounce 500ms przez kolejkę `saveQueue.ts` — przed POST zmieniającym pliki i przed reload zawsze `flushSaves`, a operacje przepisujące stronę na serwerze (restore .bak) idą przez `runRewrite` (strona zablokowana do przeładowania). Testy: `npm test -w viewer`. Vite proxy do `:8080` dla `/files /list /health /ai-detect /yolo-* /vision-page /vision-page-zones /make-bak /restore-bak /auto`.
- **server** — Express, fs-based, słucha tylko na `127.0.0.1` (`KRONIKARZ_HOST`), przyjmuje tylko `Host` loopback, a każdy zapis (PUT/DELETE/POST) wymaga nagłówka `X-Kronikarz: 1` — w viewerze zawsze przez `apiWrite` z `viewer/src/api.ts`. Testy: `npm test -w server`. GET/PUT/DELETE `/files/*` w `KRONIKARZ_DATA`. Serializowane per plik (kolejka promise po ścieżce, w kolejności przyjścia): PUT i DELETE `/files/*`, `/make-bak`, `/restore-bak` (klucz blokady = realpath katalogu + nazwa, na systemie plików bez rozróżniania wielkości liter małymi literami — symlink / inna pisownia to ten sam klucz). Strona przepisywana przez trwające zadanie (`/vision-page*`, `/auto` bez `dryRun`): PUT/DELETE/`/make-bak`/`/restore-bak` tej strony → od razu 409 `{error:'busy', job}` (viewer: stan „strona zajęta przez zadanie — zapis czeka”, ponawia co 3 s; po zadaniu, które zmieniło stronę, ponowienie dostaje zwykły 409 konfliktu). PUT: `*.sch.yaml`/`package.yaml`/`project.yaml` muszą być mapą z `kronikarz: "1"`, `ic_map.yaml`/`*.zones.yaml` mapą — inaczej 422 i plik nietknięty; brak body (bez Content-Length/Transfer-Encoding) → 400. GET `*.yaml` zwraca silny `ETag` (sha1 treści; JSON-owe odpowiedzi bez ETag); PUT z niezgodnym `If-Match` → 409 `{error:'conflict', etag}` i plik nietknięty — wyjątek: body identyczne z bieżącą treścią → 200 bez zapisu (bezpieczny retry PUT-a, którego odpowiedź zginęła). Bez `If-Match` zapis bezwarunkowy; sukces zwraca nowy `ETag`. Viewer: autosave wysyła `If-Match` (409 = błąd „plik zmieniony poza tą kartą”, bez ponawiania, do przeładowania); zapisy innych stron (kopiuj do wszystkich stron, auto-add cross_ref) tylko przez `updateDataFile` z `store.ts` (flush → GET → PUT z `If-Match`); loader przed wczytaniem robi flush. POST endpoints odpalają Python scripts przez uv, zawsze przez `runScript` (`server/index.js`): blokada zadania per klucz (strona dla skryptów piszących stronę, katalog datasetu dla `/yolo-export`; drugie zadanie na tym samym kluczu → 409 `{error:'busy', job}`), timeout (`SCRIPT_TIMEOUTS`: ai-detect i yolo-export 110 s, vision 230/290 s; SIGTERM, po `killGraceMs` SIGKILL całej grupy procesów → 504; grupa żyjąca dalej = zadanie `stuck`, blokady zostają do jej końca), zabicie przy rozłączeniu klienta — **także `/vision-page*`: zamknięcie / przeładowanie karty w trakcie zabija płatny przebieg (koszt przepada, strona nietknięta)**, jedna odpowiedź, limit stdout/stderr, JSON = ostatni obiekt na stdout (baner `nix develop` przed nim nie szkodzi). `POST /auto {pkg, page|'all', step, force?, draft?, dryRun?}` odpala `scripts/auto.py --json` (blokuje każdą stronę przebiegu, `text`/`labels`/`next` dodatkowo wirtualny klucz `<DATA>/.auto/vlm` = jeden przebieg z modelem naraz i `uv run --with mlx-vlm==0.8.1`; timeout 120 s × strony — `text`, `labels` i `next` 600 s × strony (`autoPerPageStep`) — najwyżej 3000 s; każdy `uv` z `UV_CACHE_DIR` = env albo `/Volumes/Dane/llm/uv-cache`, jeśli istnieje; exit 0 → 200, 2 → 409 `refused`, 3 → 501, 1 → 500; zabity przebieg może zostawić snapshot `.auto/…` bez zapisanej strony); `GET /auto/status` = trwające zadania. Vite proxy: timeout ≥ serwer + 2 × grace + zapas, dłuższa ścieżka przed swoim prefiksem. Body globalnie `express.raw` (dowolny/brak Content-Type) → JSON ręcznie przez `parseJsonBody`. `/make-bak` i `/vision-page*` robią `.bak` + timestamped; `/restore-bak` tylko timestamped (patrz Backups). Bez bazy.
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

Pasek kroków ①–⑥ (`StepBar.tsx`, kr-9p8.20): bieżący krok (store `currentStep`, null = „wszystko”) wyszarza / ukrywa części innych kroków, barwi elementy kroku wg pochodzenia (auto / edited / zatwierdzony), ogranicza narzędzia i filtruje walidację; „Uruchom krok” = POST `/auto` przez `runRewrite`; prawy panel `ReviewPanel.tsx` = kolejka przeglądu + „Zatwierdź krok”. Logika czysta w `stepView.ts` (testy), warstwy czytają ją przez `layers/stepLook.ts`. Szczegóły: `docs/auto-digitalizacja.md` „Viewer”.

Narzędzia: V (select + rubber-band), E (edit; drag po pustym = rubber-band), R (ROI/AI detect), W (wire — klik–klik, przyciąga do pinów / portów / końców / wnętrza drutu = T z kropką, 2×klik / Enter = wolny koniec, orto domyślnie, Shift = freeform, auto-L corner unika landing na istniejących segmentach), Z (zones dla Vision-AI per-strefa). Druty po ③ (V/E/W, gdzie geometria edytowalna — ③, ⑤ i „wszystko”): kursor nad drutem + `X` usuń, `J` kropka dodaj / usuń (scala / dzieli nety), `T` przetnij; rubber-band zaznacza druty (Alt = dotknięte, Shift = dodaj/zdejmij), Delete usuwa je naraz. Scalanie netów bez pytania (pytanie tylko o wybór nazwy), z mignięciem netu i komunikatem; scalenie dwóch netów z ≥ 2 końcówkami → „podejrzane” w kolejce przeglądu ③/⑤ (tylko sesja). Zmiana drutów unieważnia ⑤, a ④ tylko gdy zmieni się, które porty/odsyłacze/zasilanie mają koniec drutu w ≤ 8 px (`staleTargets` w `shared/src/steps.ts` = `stale_targets` w `scripts/_steps.py`). Logika czysta w `viewer/src/wireEdit.ts` (podział netu: kawałek bez nazwy → etykieta kawałka albo `NET_AUTO_<n>`; scalanie: `planMerge`) i `wireDraft.ts` (sekwencja kliknięć W), klawisze/mysz/nakładka w `useWireEditing.tsx`; opis w `docs/auto-digitalizacja.md` „Viewer”. Multi-select: shift+klik lub rubber-band drag w V. Drag jednego elementu z multi przenosi cały zestaw. Toolbar buttony: `+ bramka/xref/port/tekst/linia/rect/koło`, align/distribute/stack-column dla multi-gate.

### Skrypty (`scripts/`)

Cache: `data/.vision-cache/`, `data/.cv-cache/...`. Wszystkie odpalane przez `uv run`.

- `vision-page.py` — Vision na cały skan, vision-prompt.md jako system → `*.sch.yaml`
- `vision-zones.py` — Vision per-strefa (zones tool w viewerze), role-specific prompty (gates/ports_left/ports_right/cross_refs_left/cross_refs_right), crop+API per zone, scale-back koordów do oryginału
- `vision-digitize.py` / `-v2.py` — legacy/eksperymentalne wersje
- `vision-classify.py`, `ai-detect-roi.py` — pomocnicze
- `detect-rects.py` / `-sam.py` — CV/SAM bramki
- `export-yolo-from-yamls.py` — eksport YOLO datasetu
- `auto.py` — krok pipeline'u etapowego na stronach pakietu (`just auto`, `POST /auto`): ① `gates` (cv-gates), ② `text` (lokalny VLM Qwen3.8-27B 4-bit tylko z `/Volumes/Dane/llm`, mlx-vlm dokładane przez `--with` — nie jest zależnością skryptu, prompt v3 ×2 na wycinkach bramek + samokorekta z `ic_map` i rejestrem; niepewne w `steps.text.uncertain`; płatny model tylko przez hak `--allow-paid`, dziś exit 3), ③ `wires` (cv-wires), ④ `labels` (`_labels.py`: wolne końce bieżących drutów → CV szewron / cyfry arkuszy / napis / kreska masy → ten sam lokalny VLM, prompty v3 portu i odsyłacza + prompt zasilania; samokorekta złącza, arkuszy z `package.yaml` i etykiet innych stron pakietu; niepewne w `steps.labels.uncertain`; nowe elementy `src: auto`, `net: ""`); `_vlm.py` = wspólny kod wycinków / promptów / adaptera MLX z `vlm-bakeoff.py`, `_steps.py` = reguły kroków (port `shared/src/steps.ts`). Testy: `test_auto.py`, `test_auto_text.py`, `test_auto_labels.py` (model podmieniony)
- `migrate-*.py` — migracje schematu (port-split, sheet-numbers, fix-pr3-2-*)
- `gen-stubs.py`, `sync-packages.py`, `build-ic-map.py`, `install-hooks.sh` — `gen-stubs.py` i `build-ic-map.py` bez `--force` odmawiają nadpisania istniejących plików (wszystko albo nic, `_safe_write.py`); `--force` robi `<plik>.<ISO>.bak` i resetuje kuratorowane pola — na `data/` nie używać. `--root` / `--dry-run` do prób na kopii.

## Format danych (`specyfikacje-kronikarza/format-spec.md` v1.2)

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
- `NET_EMPTY` (warn) — net bez końcówek (po krokach ①+③ oczekiwane na `NET_AUTO_*`)
- `CROSS_REF_NO_RETURN` (err) — cross_ref do strony X bez powrotnego cross_refa z tym netem; `CROSS_REF_UNKNOWN_PAGE` (warn) — nieznany arkusz
- `PORT_NOT_ON_BACKPLANE` / `PORT_NET_MISSING` (warn) — port poza backplane / net portu bez wpisu w `nets`
- `GATE_UNKNOWN_REF` / `GATE_LETTER_MISSING` / `GATE_UNKNOWN_LETTER` / `GATE_PIN_INVALID` (err), `GATE_PIN_MISSING` / `IC_UNKNOWN_SUFFIX` (warn) — bramka vs rejestr pakietu i `ic_map`
- `GATE_PAGE_UNKNOWN` / `GATE_UNUSED` / `PASSIVE_PAGE_UNKNOWN` — rejestr pakietu (`validatePackage`, `scope: 'package'` przy `IC_UNKNOWN_SUFFIX` z rejestru)
- `STEP_INVALID` / `SRC_INVALID` / `AUTO_GEOM_INVALID` (warn) — pola formatu v1.2

Problemy między stronami mają `Issue.page` (strona z odsyłaczem). Viewer przypisuje kody krokom ①–⑤ (`issueStep` w `viewer/src/stepView.ts`) i filtruje walidację do bieżącego kroku.

`validatePackagePages(pkg, pagesMap)` ładuje wszystkie strony pakietu i sprawdza cross-page consistency. Wywoływane w loader.ts; `allPages` Map cache'owana w store, live override aktualnej strony.

## Backups

Rolling `<plik>.bak` = ostatni **ręczny** checkpoint: zmienia go tylko `/make-bak` i backup przed operacjami przepisującymi stronę (`/vision-page*`); oba robią też timestamped `<plik>.<ISO>.bak`. `/restore-bak` przywraca rolling `.bak`, a bieżący stan zapisuje tylko jako timestamped.

Autosave (PUT `/files/*.yaml` istniejącego pliku) **nigdy nie rusza rolling `.bak`** — robi tylko timestamped backup **poprzedniej** treści, najwyżej raz na 10 min na plik (`BACKUP_INTERVAL_MS`, `createApp({backupIntervalMs})`; liczą się tylko backupy autosave; stan w pamięci, po restarcie serwera pierwszy PUT znów robi backup). Tylko po takim backupie autosave serwer zostawia najnowsze 50 timestamped backupów pliku (`BACKUP_KEEP`, `createApp({backupKeep})`) — liczą się wszystkie `<plik>.<ISO>.bak` tego pliku, także z `/make-bak`, vision i restore; starsze są kasowane. Błąd sprzątania → log, zapis i tak idzie; błąd samego backupu → 500 i brak zapisu. Pliki `*.bak` w `.gitignore`.

## Licencja

Kod i dokumenty projektu: BSD-2-Clause (`LICENSE`, pole `license` w każdym `package.json`). `data/` (zdigitalizowane schematy) **nie jest objęte licencją** — to praca inżynierów MERA-400, nie nasza (`data/README.md`). Nie dopisuj nagłówków licencji do plików w `data/` i nie przenoś treści schematów do kodu jako „przykładów”; fixture’y testów rób własne.

## Skany (poza repo)

Repo jest publiczne, a do skanów dokumentacji MERA-400 nie mamy prawa redystrybucji — **skany nie są w gicie** i nie wolno ich commitować (`.gitignore`: `data/scans-raw/`, `data/MJC-400/*/scans/`, `*.pdf`). Źródłem jest `oracles/` (submodule `unemu-org/oracles`, fetch-only, przypięty sha256): `oracles/mera400/mera400-dtr-t4-cz2-mjc400-schematy.pdf`. `just scans` pobiera ten jeden PDF (z URL przypiętego w oracles) i odtwarza bajt w bajt `data/scans-raw/page-NNN.png` (arkusz `2-(NNN+1)`) i `data/MJC-400/<pkg>/scans/2-N.jpg`, sprawdzając `data/scans.sha256`. Pozostałe dokumenty MERA-400 (DTR, dokumentacja projektowa, oprogramowanie, Amepol) są w `oracles/mera400/` po `./fetch-oracles.sh fetch`; opis w `oracles/MANIFEST.md`. Worktree agenta nie ma checkoutu submodule — wskazuj mu `oracles/` z głównego checkoutu (read-only) albo `--oracles DIR`.
