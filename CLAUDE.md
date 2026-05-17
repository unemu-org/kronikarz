# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Projekt

Kronikarz — narzędzie do digitalizacji schematów elektronicznych ze skanów dokumentacji. Workflow: AI generuje YAML ze skanu → człowiek weryfikuje/koryguje w viewerze → eksporter generuje KiCad.

Repo zawiera obecnie tylko specyfikacje (`specyfikacje-kronikarza/`) i konfigurację środowiska Nix. Kod źródłowy trzech komponentów (`viewer/src`, `server/index.js`, `export/index.js`) nie istnieje jeszcze — implementacja w toku.

## Środowisko

Nix flake + direnv. Wejście do katalogu aktywuje devShell (Node.js 22, prettier, eslint, yq-go, just, watchexec, git-lfs).

```bash
direnv allow                 # pierwszy raz / po zmianie flake.nix lub .envrc
just install                 # npm install we wszystkich workspace
cp .env.example .env         # ustaw KRONIKARZ_DATA, KRONIKARZ_PORT
```

## Komendy

```bash
just dev                     # viewer (Vite :5173) + server (:8080) równolegle
just viewer                  # tylko viewer
just server                  # tylko server (watchexec restart)
just build                   # tsc + vite build viewer
just typecheck               # tsc --noEmit w viewer + export
just lint                    # eslint + prettier --check
just fmt                     # prettier --write
just validate PKG=...        # yq sprawdza YAML pakietu i wszystkich stron
just export PKG=...          # node export/index.js → dist/kicad/
just clean                   # usuwa dist/ i node_modules
```

Pojedynczy workspace: `npm run <script> -w viewer|server|export`.

## Architektura

Monorepo npm workspaces z trzema komponentami:

- **viewer** — React + TypeScript + Konva.js (canvas), Zustand (stan), Tailwind, js-yaml. SPA serwowane przez Vite. Trzy tryby: **modułu** (`project.yaml`, backplane), **pakietu** (`package.yaml`, lista stron + IC), **strony** (`*.sch.yaml`, skan + nakładka, główny widok roboczy). Edycja zapisuje przez `fetch PUT` z debounce 500ms.
- **server** — Express, GET/PUT `/files/*` serwuje i zapisuje pliki z `KRONIKARZ_DATA`. Bez bazy danych — tylko fs.
- **export** — Node CLI (commander), czyta `package.yaml` + `*.sch.yaml`, generuje pliki KiCad.

## Format danych (zob. `specyfikacje-kronikarza/format-spec.md`)

Cztery typy YAML:

- `project.yaml` — manifest modułu, lista pakietów, połączenia backplane (signal, package, connector_pin)
- `package.yaml` — manifest pakietu, rejestr IC (sufiks → wystąpienia), lista stron
- `*.sch.yaml` — pojedyncza strona schematu: bramki, nety, pozycje w **pikselach skanu** (nie siatka abstrakcyjna)
- `ic_map.yaml` — globalna tablica sufiks → symbol KiCad

Zasady formatu:
- **Jednostką jest bramka, nie IC** — jeden fizyczny układ może mieć bramki na wielu stronach/pakietach
- **Pakiet samodzielny** — można pracować bez ładowania całego projektu
- **`null` jako placeholder** dla pól niezmapowanych
- Status: `raw | wip | done | verified`

Layout katalogów danych: `<PROJECT>/<PACKAGE>/{scans/,pages/,package.yaml}` + `<PROJECT>/{project.yaml,ic_map.yaml}`.

## Git LFS

`.gitattributes` traktuje `*.jpg,jpeg,png,pdf` przez LFS (skany schematów i zdjęcia PCB). Przed pierwszym commitem skanów: `git lfs install`.
