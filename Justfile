# Kronikarz — task runner
# uzycie: just <komenda>

default:
    @just --list

dev:
    npm run dev --workspace=viewer &
    npm run dev --workspace=server
    wait

viewer:
    npm run dev --workspace=viewer

server:
    npm run dev --workspace=server

build:
    npm run build --workspace=viewer

typecheck:
    npm run typecheck --workspace=viewer
    npm run typecheck --workspace=export

lint:
    eslint viewer/src export/src server/src
    prettier --check "**/*.{ts,tsx,js,json,yaml,md}"

fmt:
    prettier --write "**/*.{ts,tsx,js,json,yaml,md}"

export PKG="data/MJC-400/P-X3-2":
    node export/index.js --package {{PKG}}/package.yaml --out dist/kicad/

validate PKG="data/MJC-400/P-X3-2":
    yq eval '.' {{PKG}}/package.yaml > /dev/null && echo "package.yaml OK"
    for f in {{PKG}}/pages/*.sch.yaml; do \
        yq eval '.' "$f" > /dev/null && echo "$f OK"; \
    done

install:
    npm install

# Krok pipeline'u etapowego (scripts/auto.py, docs/auto-digitalizacja.md) — narzędzie opiekuna,
# PISZE do prawdziwych danych (DATA, domyślnie $KRONIKARZ_DATA albo ./data).
# just auto PKG=P-R3-2 PAGE=2-58|all STEP=gates|wires|next [DATA=<kopia>] [--force] [--draft] [--dry-run] [--json]
[positional-arguments]
auto *ARGS:
    #!/usr/bin/env bash
    set -euo pipefail
    pkg=""; page=""; step=""; data="${KRONIKARZ_DATA:-./data}"; rest=(); dry=0
    for a in "$@"; do
        case "$a" in
            PKG=*) pkg="${a#PKG=}" ;;
            PAGE=*) page="${a#PAGE=}" ;;
            STEP=*) step="${a#STEP=}" ;;
            DATA=*) data="${a#DATA=}" ;;
            --dry-run) dry=1; rest+=("$a") ;;
            *) rest+=("$a") ;;
        esac
    done
    if [ -z "$pkg" ] || [ -z "$page" ] || [ -z "$step" ]; then
        echo "użycie: just auto PKG=<pakiet> PAGE=<strona|all> STEP=<gates|wires|next> [DATA=<katalog>] [--force] [--draft] [--dry-run] [--json]" >&2
        exit 1
    fi
    if [ "$dry" = 0 ]; then
        echo "UWAGA: zapis do PRAWDZIWYCH danych w $data (strona + .bak obok, snapshot w $data/.auto). Próby: DATA=<kopia> albo --dry-run." >&2
    fi
    exec uv run scripts/auto.py --data "$data" --pkg "$pkg" --page "$page" --step "$step" ${rest[@]+"${rest[@]}"}

# Skany MJC-400 z oracles (fetch-only PDF) -> data/scans-raw + data/MJC-400/*/scans
scans:
    git submodule update --init oracles
    # tylko ten jeden PDF (pełne ./fetch-oracles.sh fetch to kilka GB); pin sprawdza extract-scans.py
    test -s oracles/mera400/mera400-dtr-t4-cz2-mjc400-schematy.pdf || (mkdir -p oracles/mera400 && curl -fL -o oracles/mera400/mera400-dtr-t4-cz2-mjc400-schematy.pdf https://mera400.pl/files/mera400-dtr-t4-cz2-mjc400-schematy.pdf)
    uv run scripts/extract-scans.py

clean:
    rm -rf dist/ viewer/dist/ .parcel-cache/
    find . -name "node_modules" -type d -maxdepth 3 -exec rm -rf {} +
