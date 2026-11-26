# Praca z zadaniami

Otwarta praca jest śledzona w **beads** (`bd`, tracker zadań na Dolt, prefiks `kr`). Wiedza —
specyfikacja, decyzje, przewodniki — zostaje w markdown (`specyfikacje-kronikarza/`, `docs/`);
bead linkuje do sekcji dokumentu i jej nie kopiuje. Role, droga od beada do `main`, review i
zasady dla workerów to **bd memories** (`bd memories`, klucze `role`, `bead-do-main`,
`konwencje-beadow`, `briefy-workerow`, `dane-kuratorowane`, `sandbox-workerzy`); ta strona to
codzienna ściąga. `bd <cmd> --help` podaje flagi. `bd prime` drukuje ogólny workflow narzędzia;
tam gdzie różni się od tego dokumentu i memories (kto claimuje i zamyka, co trafia do
`bd remember`, pushe) — wygrywa ten dokument i memories.

`bd` ≥ 1.3.1 instalujemy na hoście (`brew install beads`), nie w devShellu Nix.

## Statusy

| Status | Znaczenie |
|--------|-----------|
| `open` | Założony, opisany, nierozpoczęty. Domyślny dla nowego beada. |
| `in_progress` | Zaclaimowany i w pracy. Claim **przed** pisaniem kodu. |
| `closed` | Wylądował na `main`. Reason podaje commit i zmienioną sekcję dokumentu/spec. |

„Blocked” `bd` wylicza z zależności: bead z otwartym blockerem nie pojawia się w `bd ready`.

```sh
bd ready --exclude-type epic     # odblokowana praca, najwyższy priorytet pierwszy
bd list --status in_progress     # co jest teraz zaclaimowane
bd show <id>                     # jeden bead z zależnościami i rodzicem
bd list --parent <epic-id>       # dzieci jednego epika
bd list --type epic              # wszystkie epiki
```

Priorytety `P0`…`P4` (`P0` najwyższy): P0 = utrata danych / bezpieczeństwo, P1 = realny bug lub
brakująca kluczowa funkcja, P2 = utrzymanie / testy, P3 = drobiazg, P4 = kiedyś.

## Epiki

Każdy temat to epik; każdy bead należy do epika przez `--parent` (drobne chore mogą stać same).
Epik niesie etykietę tematu; dzieci mają własne etykiety (tworzone z `--no-inherit-labels`).

| Epik | Etykieta | Temat |
|------|----------|-------|
| `kr-0sn` | `serwer` | Serwer: bezpieczeństwo i integralność zapisów |
| `kr-pfj` | `zapis` | Viewer: utrata zapisów i wyścigi auto-save |
| `kr-4dt` | `skrypty` | Skrypty Python: bezpieczne nadpisywanie danych |
| `kr-53w` | `edycja` | Viewer: poprawność edycji netów, skrótów i undo |
| `kr-x00` | `walidator` | Walidator i parser (shared) |
| `kr-cdh` | `testy` | Testy, typecheck, lint, CI, higiena repo |
| `kr-4rq` | `eksport` | Eksporter KiCad (dawny Etap 11) |
| `kr-2fb` | `refaktor` | Struktura kodu i refaktor |
| `kr-p4g` | `spec` | Specyfikacja formatu i decyzje otwarte |
| `kr-0dl` | `ux` | Viewer: odłożone funkcje UX |

## Cykl życia beada

```sh
bd create --title "<tytuł>" --description "<po co i co>" --acceptance "<kryteria>" \
          --type task --priority P2 --parent <epic-id> --no-inherit-labels --labels <etykiety>
bd update <id> --claim                                # przed pisaniem kodu
bd update <id> --append-notes "MEASURED: <komenda> → <wynik>"
bd close <id> --reason "<commit> — <co wylądowało; zmieniona sekcja doc/spec>"   # dopiero na main
```

- **Nigdy `--notes` na istniejącym beadzie** — zastępuje całe pole. Używaj `--append-notes`.
- Dowody oznaczaj: **MEASURED** (uruchomiona komenda, podaj ją), **READ** (`file:line`),
  **ASSUMED** (jeszcze niesprawdzone).
- Praca znaleziona po drodze to nowy bead z `--deps discovered-from:<id>`, nie dokładka do
  bieżącego. Kolejność: `bd dep add <późniejszy> <wcześniejszy>`.
- Nie zamykaj, dopóki `main` nie zawiera zmiany — przedwczesne zamknięcie psuje `bd ready`.
- Typy: `bug`, `feature`, `task`, `chore`, `spike`, `decision`, `epic`.

## Definition of Done

Bead zamyka się dopiero, gdy na `main`:

1. `just typecheck` jest czysty.
2. `just lint` jest czysty.
3. `npm test -w shared` (i testy innych workspace'ów, gdy powstaną) przechodzą.
4. `prettier --check .` jest czysty.
5. Zmiana UI viewera została sprawdzona w działającym `just dev`.
6. Zmiana formatu danych ma odbicie w `specyfikacje-kronikarza/format-spec.md`.

Do czasu zamknięcia `kr-cdh.1` (bramki dziś są czerwone) obowiązuje zasada: **żadnych nowych
błędów** względem stanu `main` — podaj w notatce beada wynik bramek przed i po.

## Git flow

Jeden bead, jedna gałąź (`<type>/<bead-lub-temat>`, Conventional Branch), jeden worktree poza
głównym checkoutem. Supervisor squash-merguje bead do `main` jako jeden commit:
**Conventional Commits** (`feat:`, `fix:`, `docs:`, `refactor:`, `chore:`, `test:`, `build:`),
**podpisany GPG**, z trailerem `Refs: kr-xxx`. Commity i pushe tylko na prośbę maintainera. Nigdy
nie omijaj hooków. Szczegóły: `bd recall bead-do-main`.

Repozytorium nie ma jeszcze remote. Baza beads (`.beads/embeddeddolt/`) jest gitignorowana;
`export.auto` jest włączony, więc `.beads/issues.jsonl` (czytelny eksport, nie źródło prawdy)
trafia do gita razem z kodem. Po dodaniu remote: `bd dolt remote add origin <url>` i
`bd dolt push`; nowy klon odtwarza bazę przez `bd bootstrap`, nigdy `bd init` (init tworzy nową
tożsamość projektu). `bd init` i pierwszy `bd dolt push --yes` same robią commit — po każdej
komendzie setupu bd sprawdź `git log -1` i `git status`.

## Decyzje

- Decyzja dotycząca jednego beada → w beadzie:
  `bd update <id> --append-notes "Decyzja: X zamiast Y — <powód>."`
- Przekrojowa / architektoniczna → bead `--type decision` w epiku `kr-p4g`, a wynik w
  `specyfikacje-kronikarza/` lub `docs/`.

## Przekazanie sesji

```sh
bd update <id> --append-notes "Pauza sesji $(date -I). Zrobione: <X>. Dalej: <Y>. Blocker: <Z|brak>."
```

Następna sesja: `bd memories`, potem `bd list --status in_progress` i `bd show <id>` — kontynuuje
bez odtwarzania stanu z diffa.

## Historia

Do 2026-11-26 trackerem był `plan.md` (etapy 0–12). Jest zarchiwizowany read-only w
[`docs/archive/plan.md`](archive/plan.md) jako historia zrobionych etapów. Otwarte pozycje
(Etap 11, 4.11, 8.5, 10.6, 12.5, decyzje otwarte) przeszły do beads w epikach `kr-4rq`, `kr-0dl`
i `kr-p4g`. Znaleziska z review całego kodu z 2026-11-26 trafiły do pozostałych epików.
