# kronikarz

Narzędzie do digitalizacji schematów elektronicznych minikomputera MERA-400 (Polska, lata 70.).
Vision-AI i człowiek wykrywają komponenty na skanie, człowiek rysuje połączenia w przeglądarce
(viewer), a walidator sprawdza spójność netów między arkuszami i pakietami. Docelowo eksporter
generuje projekty KiCad.

## Start

```sh
direnv allow                     # Nix flake + direnv (Node.js 22, python3, uv, just)
just install
git submodule update --init      # oracles/ — źródła dokumentacji
just scans                       # pobiera PDF DTR i odtwarza skany (nie są w repo)
cp .env.example .env
just dev                         # viewer :5173 + server :8080
```

Szczegóły: [`CLAUDE.md`](CLAUDE.md), specyfikacje w
[`specyfikacje-kronikarza/`](specyfikacje-kronikarza/), praca z zadaniami (beads) w
[`docs/praca-z-zadaniami.md`](docs/praca-z-zadaniami.md).

## Licencja

- Kod i dokumenty projektu: [BSD 2-Clause](LICENSE).
- `data/` (zdigitalizowane schematy MERA-400): **bez licencji** — to praca inżynierów MERA-400,
  nie autorów kronikarza. Zob. [`data/README.md`](data/README.md).
- Skany dokumentacji nie są redystrybuowane; są przypięte sha256 w
  [`unemu-org/oracles`](https://github.com/unemu-org/oracles).
