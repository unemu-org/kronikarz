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

clean:
    rm -rf dist/ viewer/dist/ .parcel-cache/
    find . -name "node_modules" -type d -maxdepth 3 -exec rm -rf {} +
