# Dane: zdigitalizowane schematy MERA-400

**Ten katalog NIE jest objęty licencją BSD z pliku [`LICENSE`](../LICENSE).**

`data/MJC-400/` zawiera zapis schematów elektronicznych minikomputera MERA-400 w formacie
YAML ([`format-spec.md`](../specyfikacje-kronikarza/format-spec.md)): bramki, piny, połączenia,
porty, odsyłacze między arkuszami i ich położenie na skanach. To przepisanie dokumentacji
technicznej z lat 70., a nie samodzielny projekt. Treść schematów jest pracą inżynierów, którzy
projektowali MERA-400 (m.in. MERA-ZSM i jej zakładów). Autorzy kronikarza nie mają do niej praw
i **nie udzielają na nią żadnej licencji**.

- Źródło: skany dokumentacji techniczno-ruchowej (DTR) publikowane przez wiki
  [mera400.pl](https://mera400.pl/DTR), przypięte sha256 w
  [`unemu-org/oracles`](https://github.com/unemu-org/oracles) (`mera400/`, fetch-only).
- Same skany nie są w repozytorium. Odtwarza je lokalnie `just scans`
  (`scripts/extract-scans.py`, wynik sprawdzany z [`scans.sha256`](scans.sha256)).
- Dane są tu po to, by dokumentację dało się zachować, przeszukiwać i sprawdzać (walidator,
  eksport do KiCad). Jeśli reprezentujesz posiadaczy praw do dokumentacji MERA-400 i masz
  zastrzeżenia, otwórz issue w repozytorium.

Licencją BSD objęte są natomiast narzędzia i dokumenty napisane dla tego projektu: kod
(`shared/`, `viewer/`, `server/`, `export/`, `scripts/`), specyfikacje w
`specyfikacje-kronikarza/` i `docs/`.

## English

**This directory is NOT covered by the BSD licence in [`LICENSE`](../LICENSE).** `data/MJC-400/`
is a transcription of the MERA-400 minicomputer's 1970s schematics (gates, pins, nets, ports,
cross-sheet references and their positions on the scans). The schematic content is the work of
the engineers who designed the MERA-400. The kronikarz authors hold no rights to it and grant no
licence for it. The source scans are not redistributed here; they are pinned by sha256 in
`unemu-org/oracles` and reproduced locally with `just scans`.
