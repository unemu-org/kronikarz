# Kronikarz — Srodowisko deweloperskie Nix
## Flake, direnv, konfiguracja

---

## Filozofia

Srodowisko deweloperskie Kronikarz jest w pelni odtwarzalne i
deklaratywne. Kazdy kto sklonuje repozytorium i ma Nix z flakes
otrzymuje identyczne srodowisko — ta sama wersja Node.js, tych samych
narzedzi CLI, tego samego formatera. Zero "u mnie dziala".

Docelowo projekt sklada sie z trzech komponentow:

```
kronikarz/
├── viewer/          React + Konva.js (frontend)
├── server/          lokalny serwer GET/PUT plikow (Node.js)
└── export/          eksporter YAML → KiCad (Node.js CLI)
```

Wszystkie trzy zyja w jednym repo, jednym flake, jednym srodowisku.

---

## Wymagania wstepne

```bash
# Nix z wlaczonymi flakes i nix-command
# W /etc/nix/nix.conf lub ~/.config/nix/nix.conf:
experimental-features = nix-command flakes

# direnv z hookiem w shellu (fish, zsh, bash)
# Jesli uzywasz home-manager — juz masz
```

Sprawdzenie:

```bash
nix --version          # >= 2.18
direnv --version       # >= 2.32
```

---

## Struktura plikow

```
kronikarz/
├── flake.nix              # deklaracja srodowiska
├── flake.lock             # przypiety hash nixpkgs
├── .envrc                 # direnv hook
├── .direnv/               # cache direnv (gitignore)
├── .env                   # zmienne lokalne (gitignore)
├── package.json           # root workspace
├── viewer/
│   ├── package.json
│   ├── src/
│   └── ...
├── server/
│   ├── package.json
│   └── index.js
└── export/
    ├── package.json
    └── index.js
```

---

## `flake.nix`

```nix
{
  description = "Kronikarz — digitalizacja schematow elektronicznych";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        devShells.default = pkgs.mkShell {
          name = "kronikarz";

          packages = with pkgs; [
            # --- Node.js ---
            nodejs_22                  # LTS, React + serwer + eksporter
            nodePackages.npm           # package manager

            # --- Jakos kodu ---
            nodePackages.typescript    # tsc do sprawdzania typow
            nodePackages.prettier      # formatowanie JS/TS/JSON/YAML/MD
            nodePackages.eslint        # linting

            # --- YAML ---
            yq-go                      # yq — walidacja i podglad YAML z CLI
            # python3Packages.yamllint  # odkomentuj jesli chcesz lint YAML

            # --- Git ---
            git
            git-lfs                    # skany PCB i schematy to duze pliki

            # --- Narzezia deweloperskie ---
            just                       # task runner (Justfile)
            watchexec                  # watch + restart serwera przy zmianach
            httpie                     # testowanie endpointow GET/PUT
            jq                         # debug JSON z CLI

            # --- Dokumentacja ---
            mdbook                     # opcjonalnie: dokumentacja projektu

            # --- Opcjonalnie: PDF/obrazy ---
            # poppler_utils             # pdftoppm — rasteryzacja PDF do JPEG
            # imagemagick               # konwersja i preprocessing skanow
            # tesseract                 # OCR lokalny (zamiast API)
          ];

          shellHook = ''
            echo ""
            echo "  KRONIKARZ — srodowisko deweloperskie"
            echo "  ====================================="
            echo "  node:    $(node --version)"
            echo "  npm:     $(npm --version)"
            echo "  just:    $(just --version)"
            echo ""
            echo "  Komendy:"
            echo "    just dev       uruchom viewer + serwer"
            echo "    just lint      sprawdz kod"
            echo "    just export    eksportuj przykladowy pakiet"
            echo ""

            # automatyczny npm install jesli node_modules nie istnieje
            if [ ! -d "node_modules" ]; then
              echo "  Instaluje zaleznosci npm..."
              npm install --silent
            fi
          '';

          # zmienne srodowiskowe dostepne w shellu
          KRONIKARZ_DATA = "./data";      # domyslna lokalizacja projektow
          NODE_ENV = "development";
        };
      }
    );
}
```

---

## `.envrc`

```bash
use flake

# laduj zmienne z .env jesli istnieje
if [ -f .env ]; then
  dotenv .env
fi

# upewnij sie ze node_modules/.bin jest w PATH
PATH_add node_modules/.bin
PATH_add viewer/node_modules/.bin
PATH_add server/node_modules/.bin
PATH_add export/node_modules/.bin

# layout — katalogu projektu kronikarz (jesli uzywasz direnv layouts)
layout node
```

---

## `.env` (gitignore — lokalny)

```bash
# Lokalny plik — nie commituj
# Skopiuj z .env.example i uzupelnij

# Sciezka do katalogu z projektami Kronikarz
KRONIKARZ_DATA=/home/user/mera400

# Port lokalnego serwera plikow
KRONIKARZ_PORT=8080

# Opcjonalnie: klucz API Claude do generowania YAML
# ANTHROPIC_API_KEY=sk-ant-...
```

---

## `.env.example` (commitowany)

```bash
KRONIKARZ_DATA=./data
KRONIKARZ_PORT=8080
# ANTHROPIC_API_KEY=
```

---

## `Justfile`

```just
# Kronikarz — task runner
# uzycie: just <komenda>

# domyslna komenda — pokaz pomoc
default:
    @just --list

# uruchom viewer (Vite dev server) i serwer plikow jednoczesnie
dev:
    npm run dev --workspace=viewer &
    npm run dev --workspace=server
    wait

# uruchom tylko viewer
viewer:
    npm run dev --workspace=viewer

# uruchom tylko serwer plikow
server:
    npm run dev --workspace=server

# zbuduj viewer do katalogu dist/
build:
    npm run build --workspace=viewer

# sprawdz typy TypeScript
typecheck:
    npm run typecheck --workspace=viewer
    npm run typecheck --workspace=export

# linting
lint:
    eslint viewer/src export/src server/src
    prettier --check "**/*.{ts,tsx,js,json,yaml,md}"

# formatowanie
fmt:
    prettier --write "**/*.{ts,tsx,js,json,yaml,md}"

# uruchom eksporter na przykladowym pakiecie
export PKG="data/MJC-400/P-X3-2":
    node export/index.js --package {{PKG}}/package.yaml --out dist/kicad/

# waliduj YAML pakietu
validate PKG="data/MJC-400/P-X3-2":
    yq eval '.' {{PKG}}/package.yaml > /dev/null && echo "package.yaml OK"
    for f in {{PKG}}/pages/*.sch.yaml; do
        yq eval '.' "$f" > /dev/null && echo "$f OK"
    done

# instaluj zaleznosci npm we wszystkich workspace
install:
    npm install

# czyszczenie
clean:
    rm -rf dist/ viewer/dist/ .parcel-cache/
    find . -name "node_modules" -type d -maxdepth 3 -exec rm -rf {} +
```

---

## `package.json` (root workspace)

```json
{
  "name": "kronikarz",
  "private": true,
  "workspaces": [
    "viewer",
    "server",
    "export"
  ],
  "scripts": {
    "dev": "concurrently \"npm run dev -w viewer\" \"npm run dev -w server\"",
    "build": "npm run build -w viewer",
    "lint": "eslint viewer/src server/src export/src",
    "fmt": "prettier --write \"**/*.{ts,tsx,js,json,yaml,md}\""
  },
  "devDependencies": {
    "concurrently": "^8.0.0",
    "prettier": "^3.0.0",
    "eslint": "^8.0.0",
    "@typescript-eslint/eslint-plugin": "^6.0.0",
    "@typescript-eslint/parser": "^6.0.0"
  }
}
```

---

## `viewer/package.json`

```json
{
  "name": "@kronikarz/viewer",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "react": "^18.0.0",
    "react-dom": "^18.0.0",
    "konva": "^9.0.0",
    "react-konva": "^18.0.0",
    "zustand": "^4.0.0",
    "js-yaml": "^4.0.0"
  },
  "devDependencies": {
    "@types/react": "^18.0.0",
    "@types/react-dom": "^18.0.0",
    "@types/js-yaml": "^4.0.0",
    "@vitejs/plugin-react": "^4.0.0",
    "typescript": "^5.0.0",
    "vite": "^5.0.0",
    "tailwindcss": "^3.0.0",
    "autoprefixer": "^10.0.0",
    "postcss": "^8.0.0"
  }
}
```

---

## `server/package.json`

```json
{
  "name": "@kronikarz/server",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "watchexec -e js node index.js",
    "start": "node index.js"
  },
  "dependencies": {
    "express": "^4.0.0",
    "cors": "^2.0.0"
  },
  "devDependencies": {
    "@types/express": "^4.0.0",
    "@types/cors": "^2.0.0"
  }
}
```

---

## `export/package.json`

```json
{
  "name": "@kronikarz/export",
  "private": true,
  "type": "module",
  "bin": {
    "kronikarz-export": "./index.js"
  },
  "scripts": {
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "js-yaml": "^4.0.0",
    "commander": "^11.0.0"
  },
  "devDependencies": {
    "typescript": "^5.0.0",
    "@types/js-yaml": "^4.0.0",
    "@types/node": "^20.0.0"
  }
}
```

---

## `.gitignore`

```gitignore
# Nix
.direnv/
result

# Node
node_modules/
dist/
.parcel-cache/

# Lokalne
.env
*.local

# KiCad output
dist/kicad/

# Skany i obrazy — duze pliki
# Jesli uzywasz git-lfs, odkomentuj nizej i skonfiguruj .gitattributes
# *.jpg
# *.jpeg
# *.png
# *.pdf
```

---

## `.gitattributes` (dla git-lfs)

```gitattributes
# Skany schematow i zdjecia PCB przez git-lfs
*.jpg filter=lfs diff=lfs merge=lfs -text
*.jpeg filter=lfs diff=lfs merge=lfs -text
*.png filter=lfs diff=lfs merge=lfs -text
*.pdf filter=lfs diff=lfs merge=lfs -text
```

Inicjalizacja git-lfs:

```bash
git lfs install
git lfs track "*.jpg" "*.jpeg" "*.png" "*.pdf"
git add .gitattributes
```

---

## Pierwsze uruchomienie

```bash
# 1. Sklonuj repo
git clone https://radicle.xyz/kronikarz kronikarz
cd kronikarz

# 2. direnv pozwoli na wejscie do srodowiska
direnv allow

# srodowisko Nix zostaje zbudowane (~2-5 minut przy pierwszym uruchomieniu)
# nastepne wejscia w katalog sa natychmiastowe

# 3. Zainstaluj zaleznosci npm
just install

# 4. Skopiuj .env
cp .env.example .env
# edytuj .env — ustaw KRONIKARZ_DATA na katalog z projektami

# 5. Uruchom
just dev

# viewer: http://localhost:5173
# serwer: http://localhost:8080
```

---

## Codzienne uzycie

```bash
cd kronikarz          # direnv automatycznie aktywuje srodowisko
just dev              # uruchom wszystko
just fmt              # przed commitem
just validate PKG=data/MJC-400/P-X3-2   # sprawdz YAML pakietu
just export PKG=data/MJC-400/P-X3-2     # generuj KiCad
```

---

## Aktualizacja zaleznosci Nix

```bash
# aktualizacja nixpkgs do najnowszego
nix flake update

# sprawdz co sie zmienilo
git diff flake.lock

# jesli wszystko OK
git add flake.lock
git commit -m "nix: update flake inputs"
```

---

## Dodanie pakietu Nix tymczasowo

```bash
# bez modyfikacji flake.nix — tylko na czas sesji
nix shell nixpkgs#imagemagick

# lub jednorazowo
nix run nixpkgs#imagemagick -- convert scan.jpg -rotate 90 out.jpg
```

---

## Troubleshooting

**direnv nie aktywuje srodowiska:**
```bash
direnv allow          # wymagane po kazdej zmianie .envrc lub flake.nix
```

**node_modules zdezaktualizowane po zmianie package.json:**
```bash
just install
```

**Stary flake.lock powoduje bledy:**
```bash
nix flake update
just install
```

**Serwer nie zapisuje plikow:**
```bash
# sprawdz ze KRONIKARZ_DATA wskazuje na istniejacy katalog z prawami zapisu
ls -la $KRONIKARZ_DATA
```