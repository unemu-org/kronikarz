# Automatyczna digitalizacja — plan

Cel: 155 arkuszy MJC-400 (i kolejne pakiety) zamienia się w `*.sch.yaml` bez ręcznego
rysowania. Człowiek tylko zatwierdza albo poprawia to, co pipeline oznaczył jako niepewne.
Wszystko działa lokalnie (MacBook M5 Pro, 64 GB), bez płatnego API.

Epik: `kr-9p8` *Automatyczna digitalizacja (lokalnie, M5 Pro 64 GB)* — `bd list --parent kr-9p8`.

## Stan wyjściowy (2026-11-26)

- MEASURED: 155 stron, bramki na 11, druty na 7. Komplet (wszystkie bramki `verified` i
  wszystkie druty) mają tylko P-R3-2 2-58…2-61; 2-63 ma zweryfikowane bramki bez drutów.
- MEASURED: skany 2340×1654 px, 200 dpi, skala szarości, czysty rysunek kreskowy (`pdfimages -list`).
- READ: obecne podejście (`vision-page.py`, `vision-zones.py`) wysyła cały arkusz lub strefę do
  Claude i prosi o YAML. Daje bramki, ale nie daje drutów — te człowiek rysuje ręcznie. To jest
  główny koszt ludzki.

## Dlaczego nie „jeden VLM na cały arkusz”

Literatura z 2025–2026 mówi to samo co nasze doświadczenie: VLM dobrze czyta tekst i rozpoznaje
symbole, ale źle odtwarza połączenia. W AMSbench netlisty nawet najlepszego modelu
(Gemini-2.5-Pro) wymagały dużych poprawek. SINA (DATE 2026) dochodzi do ~96 % poprawności netlisty
tylko dzięki rozbiciu zadania: detektor YOLO dla symboli, osobna ekstrakcja połączeń, OCR, a
VLM tylko do składania etykiet.

Nasze arkusze bardzo sprzyjają takiemu rozbiciu:

- druty są wyłącznie poziome i pionowe, jednej grubości;
- połączenie oznacza kropka (junction), skrzyżowanie bez kropki to brak połączenia
  (tę regułę już ma walidator);
- bramki to prostokąty z tekstem w środku (`&`/`1`, typ `04`/`10`/`H11`, ref `M54`);
- tekst to szablonowe pismo inżynierskie: numery pinów, etykiety netów, numery arkuszy.

## Architektura: geometria deterministycznie, tekst przez VLM

```
skan ──► 1. preprocessing (binaryzacja, odszumienie)
     ├─► 2. prostokąty bramek (kontury / YOLO)        ─┐
     ├─► 3. druty H/V + kropki + końce (morfologia)    ├─► 5. składanie grafu ─► 6. walidacja
     └─► 4. tekst w wycinkach (lokalny VLM, crop)     ─┘      (piny→krawędzie,     i samokorekta
                                                               nety = spójne       (ic_map, pakiet,
                                                               składowe drutów)    cross-refy)
                                                                        │
                                                    7. kolejka przeglądu w viewerze
                                                       (tylko elementy niepewne)
```

1. **Preprocessing** — OpenCV: próg adaptacyjny, usunięcie drobnego szumu.
2. **Bramki** — prostokąty z konturów (`scripts/detect-rects.py` już to robi, z nadmiarem);
   filtr i klasyfikacja kształtu przez detektor YOLO trenowany na zweryfikowanych stronach
   (`scripts/export-yolo-from-yamls.py` już eksportuje dataset).
3. **Druty** — po wymazaniu prostokątów i tekstu: otwarcie morfologiczne poziomym i pionowym
   elementem, wektoryzacja do odcinków, kropki jako bloby. Wynik: odcinki + junctions +
   wolne końce (porty, cross-refy, piny). Bez żadnego modelu.
4. **Tekst** — małe wycinki (wnętrze bramki, okolica końca pinu, etykieta przy porcie,
   lista arkuszy przy cross-refie) do lokalnego VLM z wąskim pytaniem i odpowiedzią w JSON.
   Mały wycinek to zadanie OCR, w którym lokalne modele są mocne. Dwa przebiegi (dwa modele
   albo dwa prompty) — niezgodność oznacza niepewność.
5. **Składanie** — pin = koniec drutu dotykający krawędzi bramki; net = spójna składowa
   drutów (z regułą junction); nazwy netów z etykiet; porty i cross-refy z wolnych końców
   przy lewej/prawej krawędzi arkusza.
6. **Samokorekta** — `ic_map` mówi, jakie piny ma bramka danego typu; `package.yaml` mówi,
   które litery bramek należą do którego arkusza; cross-refy muszą mieć powrót. Odczyt
   sprzeczny z tymi faktami jest poprawiany (gdy jest jedna zgodna kandydatura) albo
   oznaczany do przeglądu.
7. **Przegląd** — viewer pokazuje tylko elementy z niską pewnością, z klawiszami
   zatwierdź / popraw. Wszystko inne trafia jako `verified: false`, ale bez potrzeby
   oglądania.

Zasada nadrzędna: pipeline **nigdy nie nadpisuje** elementów `verified: true` ani ręcznie
narysowanych drutów. Pisze do nowych stron albo scala (zob. beady o bezpiecznym zapisie).

## Pipeline etapowy z punktem kontroli (projekt, kr-9p8.17)

Decyzje opiekuna (2026-11-27): każdy krok pipeline'u uruchamia się z przeglądarki (bez
przeskakiwania do terminala; CLI zostaje do pracy wsadowej i testów), jego wynik od razu
widać w viewerze, opiekun go poprawia i zatwierdza, a następny krok bierze **poprawiony** wynik
jako wejście. W viewerze nie ma przycisku „Vision”. Zatwierdzone strony są danymi do uczenia.
Makieta GUI zaakceptowana (pasek kroków, kolejka przeglądu, kolory stanów); eksport KiCad to
krok ⑥ (podgląd arkusza), a projekt KiCad całego pakietu powstaje z widoku pakietu.

### Kroki

| Krok | Nazwa w CLI | Wejście (zatwierdzone) | Wynik | Narzędzie | Co poprawia człowiek |
|---|---|---|---|---|---|
| ① | `gates` | skan | prostokąty bramek (bez tekstu) | `cv-gates.py` | dodaje / usuwa / zmienia ramki |
| ② | `text` | ① | ref, typ, litera, numery i strony pinów | VLM na wycinkach + `ic_map` + rejestr pakietu | tekst, piny |
| ③ | `wires` | ①② | odcinki, kropki, wolne końce | `cv-wires.py` (ramki z ① wymazane) | rysuje / usuwa druty i kropki |
| ④ | `labels` | ③ | porty (złącze, pin, etykieta) i odsyłacze (etykieta, arkusze) na wolnych końcach | VLM na wycinkach | etykiety, typ końca |
| ⑤ | `nets` | ①–④ | nety: piny, porty, odsyłacze, nazwy | składanie grafu (kr-9p8.5) + samokorekta (kr-9p8.6) + walidator | błędy walidacji kroku |
| ⑥ | — | ⑤ wszystkich stron pakietu dla eksportu | podgląd `.kicad_sch` arkusza | eksporter (kr-4rq) | nic — tylko podgląd |

### Gdzie jest wynik i status

- Wynik każdego kroku trafia do tego samego `*.sch.yaml`, który edytuje viewer — jedno źródło prawdy.
- Każdy element ma pole `src`: `auto` (z pipeline'u, nieruszony), `edited` (zmieniony albo dodany
  przez człowieka). Brak pola = `edited` (dane sprzed pipeline'u są ręczne).
- Strona ma sekcję `steps` ze stanem każdego kroku:
  `steps: {gates: {status: approved, run: <id>, at: <ISO>}, text: {status: auto, …}, …}`.
  Stany: `todo` → `auto` (krok przebiegł, czeka na przegląd) → `approved`; `stale`, gdy po
  zatwierdzeniu zmieniono wcześniejszy krok.
- **Zatwierdzenie kroku** w viewerze: wszystkie elementy tego kroku na stronie są uznane za
  sprawdzone (`verified: true` dla bramek; dla reszty wystarcza status kroku). Krok ⑤ można
  zatwierdzić tylko bez błędów walidacji.
- Surowy wynik każdego przebiegu (przed poprawkami) zapisuje się osobno jako niezmienny
  snapshot w `data/.auto/<pakiet>/<strona>/<krok>-<run>.yaml` (ignorowany przez git). Różnica
  snapshot → zatwierdzona strona to dane do uczenia (kr-9p8.10).

### Ponowne uruchomienie kroku

- Krok `approved` → odmowa bez `--force`; z `--force` krok wraca do `auto`.
- Krok przebiega tylko, gdy poprzedni jest `approved` (wyjątek: `--draft` do prób).
- Zastępuje wyłącznie elementy `src: auto` tego kroku; elementy `edited` zostają. Nigdy nie
  rusza elementów innych kroków.
- Puste aspekty (decyzja opiekuna 2026-11-27 — USER): krok może
  wypełnić aspekt (ramka / tekst / net) dowolnego elementu, także dodanego przez człowieka,
  tylko gdy **cały** aspekt jest pusty, i ustawia wtedy jego `*_src: auto`. Aspektu niepustego
  (także częściowo wypełnionego) nie nadpisuje. Np. bramka dorysowana w ① dostaje tekst z ②,
  a bramka z wpisanym samym `ref` zostaje bez zmian. Sprawdza to `aspectEmpty` w
  `shared/src/steps.ts`; szczegóły w `format-spec.md` v1.2.
- Każda zmiana treści kroku (w viewerze — także kroku niezatwierdzonego — albo przez ponowny
  przebieg z `--force`) oznacza wszystkie późniejsze zatwierdzone kroki jako `stale`; sam
  zmieniony krok zachowuje swój stan. Viewer to pokazuje, a opiekun decyduje: zatwierdzić
  ponownie albo przepuścić krok jeszcze raz. `verified`, `note` i stan kroków nie są treścią.
- Zapis przez `_safe_write` (atomowo, `.bak`). Krok uruchomiony z viewera: viewer najpierw
  robi flush zapisów, serwer blokuje stronę na czas przebiegu, po zakończeniu viewer
  przeładowuje stronę (jak dziś `runRewrite`). Krok uruchomiony z CLI przy otwartej stronie:
  ETag sprawia, że viewer nie nadpisze nowego wyniku (409 „plik zmieniony poza tą kartą”) —
  trzeba przeładować stronę.

### Uruchamianie

W viewerze: przycisk „Uruchom krok” przy bieżącym kroku na pasku kroków (z opcją „wymuś”
dla kroku zatwierdzonego) i „Uruchom następny krok na wszystkich stronach” w widoku pakietu.
Serwer: jeden endpoint (np. `POST /auto {pkg, page, step, force}`) przez wspólny `runScript`
z timeoutem, przerwaniem i blokadą per strona (kr-0sn.7); viewer pokazuje postęp i log
przebiegu. Krok z płatnym VLM pokazuje przed startem szacowany koszt i wymaga potwierdzenia;
limit budżetu w ustawieniach.

Serwer (kr-9p8.19): `POST /auto {pkg, page: <id>|'all', step, force?, draft?, dryRun?}` →
`auto.py --data <KRONIKARZ_DATA> … --json`. Pakiet i strona muszą być w `project.yaml` /
`package.yaml` (inaczej 404, zły kształt pola 400, ścieżka strony poza danymi 403). Blokada:
każdy plik strony przebiegu (`all` = wszystkie strony pakietu — te same klucze co przy jednej
stronie i przy PUT, więc `all` i pojedyncza strona tego pakietu wykluczają się wprost); drugi
przebieg → 409 `{error: 'busy', job}`, `GET /auto/status` pokazuje trwające zadania. Przebieg
bez `dryRun` czeka na trwający PUT strony, a w trakcie przebiegu PUT / DELETE / make-bak /
restore-bak tej strony dostają od razu 409 busy (viewer ponawia zapis; jeśli przebieg zmienił
stronę, ponowienie kończy się zwykłym konfliktem → przeładowanie). Timeout 120 s × liczba
stron, najwyżej 3000 s (proxy Vite: 3600 s) → 504 (proces zabity); zamknięcie karty też
zabija przebieg. Przebieg zabity między snapshotem a zapisem strony zostawia snapshot
`.auto/<pkg>/<strona>/<krok>-<run>.yaml` bez zapisanej strony (strona nietknięta). Exit 0 → 200
(podsumowanie JSON), 2 → 409 `{error: 'refused', reasons, result}`, 3 → 501, 1 albo wyjście bez
pasującego JSON (np. błąd samego `uv`) → 500 z końcówką stderr. Przy `all` część stron mogła
się zapisać mimo 409/500 — `result.pages[].written`. Potwierdzenie kosztu: hak
`paidStepRefusal` w `server/index.js` (dziś `text`/`labels` → 501, nic nie kosztuje).

Ten sam kod z CLI (praca wsadowa, testy):

```bash
just auto PKG=P-R3-2 PAGE=2-58 STEP=gates      # jeden krok jednej strony
just auto PKG=P-R3-2 PAGE=all STEP=next        # na każdej stronie następny krok, którego poprzednik jest zatwierdzony
just auto PKG=P-R3-2 PAGE=2-58 STEP=text --force
```

Każdy przebieg wypisuje: strony, krok, liczbę elementów `auto`, liczbę niepewnych, czas, koszt
(przy płatnym VLM — tylko za zgodą opiekuna i w ustalonym budżecie).

### Uruchomienie (kr-9p8.21)

`scripts/auto.py` — wspólne wejście CLI i (kr-9p8.19) serwera. Zaimplementowane kroki:
① `gates` (`cv-gates.py`) i ③ `wires` (`cv-wires.py` tryb (a) na **bieżących** bramkach
strony, z pinami, jeśli są). `text`, `labels`, `nets` są rozpoznawane i odrzucane z exit 3.
Reguły kroków (`canRun`, `nextRunnableStep`, `markStaleAfter`, `aspectEmpty`, druty po
wartości, liczby jak w JS: 545.0 = 545, -0 = 0) są przeniesione do `scripts/_steps.py` — te
same co w `shared/src/steps.ts`.

```bash
just auto PKG=P-R3-2 PAGE=2-58 STEP=gates [DATA=<kopia>] [--dry-run]   # bez --dry-run ostrzega: pisze do danych
uv run scripts/auto.py --data <DATA_ROOT> --pkg P-R3-2 --page 2-58|all \
    --step gates|wires|next [--force] [--draft] [--dry-run] [--json]
PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy \
    --with opencv-python-headless pytest -p no:cacheprovider \
    scripts/test_auto.py scripts/test_steps.py scripts/test_jsyaml.py
```

- Pakiet: `<DATA_ROOT>/<moduł>/<pkg>/package.yaml`, gdzie moduł ma `project.yaml`
  (`data/gold` nie jest modułem). Strony i skany ze ścieżek w `package.yaml`.
- Exit: 0 ok (także `--step next`, gdy wszystko zatwierdzone); 1 błąd; 2 odmowa (`canRun`
  albo ochrona kroku ⑤, niżej); 3 krok niezaimplementowany. Przy `--page all` wygrywa
  najpoważniejszy: 1 > 3 > 2 > 0. Błąd użycia (argparse) też daje 1, bo 2 znaczy odmowę.
- Zapis:
  1. Tuż przed zapisem strona jest czytana jeszcze raz; jeśli zmieniła się od wczytania
     (viewer, drugi przebieg), błąd (exit 1) i nic nie jest zapisane — także snapshot.
  2. Niezmienny snapshot surowego wyniku narzędzia `<DATA_ROOT>/.auto/<pkg>/<strona>/<krok>-<run>.yaml`
     (tworzony wyłącznie; `run` = czas UTC `20261127T153000`, wspólny dla całego wsadu, ten sam
     w `steps[krok].run`; przy kolizji sufiks `-2`, `-3`…; dowiązanie symboliczne na ścieżce
     `.auto` = odmowa). W snapshocie także pola spoza formatu: `cv_class`, `cv_pins` bramek,
     `cv_free` (wolne końce) i `pin.net` z cv-wires — wejście dla kroków ②, ④, ⑤.
  3. Strona przez `_safe_write` (kopia `<plik>.<ISO>.bak`, zapis atomowy, symlink = odmowa).
  `--dry-run` nie zapisuje nic, także snapshotu.
- Styl YAML (`scripts/_jsyaml.py`): wczytywanie jak js-yaml (YAML 1.2 core: `yes`/`no` to
  napisy, `1e3` to liczba), zapis bajt w bajt jak `serializePage` viewera. Sekcje strony, których
  treść się nie zmieniła, zostają bajt w bajt (także w stylu innego writera, np. gen-stubs);
  zmieniona sekcja (`gates`, `nets`, `steps`) jest zapisana w stylu viewera. Przebieg bez zmian
  treści dopisuje więc tylko sekcję `steps`. Sprawdza to `test_jsyaml.py` na wszystkich
  stronach `data/MJC-400` (tylko odczyt; porównanie z prawdziwym serializerem przez node).
  Komentarze YAML wewnątrz zmienionej sekcji najwyższego poziomu (i zaraz za nią) mogą zniknąć
  — viewer gubi je zawsze; dziś żadna ze 155 stron nie ma komentarzy. Tekst strony i snapshotu
  musi się wczytać z powrotem jako ten sam dokument, a powtórzony klucz mapy (także `1` i `'1'`)
  to błąd jak w js-yaml — w obu przypadkach exit 1 i nic nie jest zapisane.
- Zmiana strony w trakcie przebiegu (viewer, drugi przebieg) jest sprawdzana przed snapshotem
  i jeszcze raz tuż przed zapisem strony; w drugim przypadku świeży snapshot jest usuwany. Także
  nieudany zapis strony usuwa snapshot — snapshot istnieje tylko dla zapisanego przebiegu.
- `steps[krok] = {status: auto, run, at}`. Późniejsze kroki `approved` → `stale`, gdy krok był
  zatwierdzony (`--force`) albo zmieniła się jego treść (`stepFingerprint`).
- **① gates.** Bramka znika tylko, gdy jej ramka jest `auto`, `note` pusta, a każdy inny aspekt
  na niej (tekst, piny, nety pinów) jest pusty albo `auto` z kroku, który nie jest `approved` /
  `stale` (zatwierdzony tekst jest sprawdzony przez człowieka — zostaje). `verified` nie chroni
  (to nie treść). Wykryta ramka jest odrzucana jako ta sama bramka, gdy z bramką, która zostaje,
  ma IoU ≥ 0,5 **albo** środek jednej leży w drugiej. Sam IoU nie wystarczał: ludzkie bramki bez
  `w`/`h` mają autoBox viewera (80 × 90+, osobno dla każdego wymiaru, `w: 0` zostaje 0), często
  dużo mniejszy od narysowanej ramki — IoU 0,18–0,43 dawało 13 duplikatów na 2-64/2-67/2-68
  (teraz 0). Nowa bramka: `ref: ""`, `gate: null`, `pins: []`, `src: auto`, **bez** `text_src`
  — krok ustawia `auto` tylko na aspektach, które sam wypełnia (format-spec v1.2); aspekt tekstu
  jest pusty, więc krok ② i tak może go wypełnić (`aspectEmpty`).
- **③ wires.** Odcinki i kropki `auto` (po wartości) są usuwane razem z polami `auto_*`; net,
  który przez to opustoszał i którego nic nie używa (pin / port / odsyłacz / zasilanie, `cross`,
  `pins[]`), znika. Wykryty odcinek jest przycinany do części niepokrytej przez zostające
  odcinki (równoległe, ≤ 3 px w poprzek; resztka < 8 px odpada; odcinki netu `""` się nie
  liczą), kropka przy zostającej kropce odpada — inaczej ponowne przebiegi na stronie z ręcznymi
  drutami dublowałyby rysunek. Każda składowa spójna z cv-wires = nowy net `NET_AUTO_<n>`
  (najmniejszy wolny numer), wszystkie jego odcinki i kropki w `auto_segments` /
  `auto_junctions`. Krok ③ niesie samą geometrię: `pin.net`, porty, odsyłacze i nety ludzkie
  zostają nietknięte; nazwy i scalanie netów to krok ⑤ (zmiana nazwy / scalenie w viewerze
  zostawia odcinki `auto`). Składowa zamiast jednego wspólnego netu, bo `eval-digitize`
  i walidator liczą per net, a podział na składowe to już wynik CV.
- **Ochrona kroku ⑤.** Jeśli ponowny ③ miałby usunąć odcinki / kropki `auto` z netu spoza
  `NET_AUTO_*` (nazwanego) albo z netu, którego używa końcówka (pin / port / odsyłacz /
  zasilanie), to cofnąłby pracę kroku ⑤ — odmowa (exit 2) z listą netów i liczbą elementów.
  Z `--force` krok przebiega i raportuje te nety (`step5_nets` w `--json`).
- Znane ograniczenia: usunięcie elementu `auto` przez człowieka nie jest pamiętane — ponowny
  przebieg kroku doda go znowu (do przeglądu: usunąć jeszcze raz albo poprawić wykrycie).
  ③ na stronie z ręcznie narysowanymi drutami dodaje krótkie „ścinki” tam, gdzie CV i rysunek
  ręczny się rozjeżdżają o więcej niż 3 px (2-58 z danymi ręcznymi: 155 wykrytych odcinków,
  136 odrzuconych, 14 przyciętych, 19 dodanych w 17 netach).
- Walidator na stronie po krokach ① + ③: `GATE_UNKNOWN_REF` (err) na każdej nowej bramce
  (`ref` pusty do kroku ②) i `NET_EMPTY` (warn) na każdym `NET_AUTO_*` (końcówki dopiero
  w ⑤) — oczekiwane; viewer powinien filtrować walidację do bieżącego kroku.

Pomiar (MEASURED, 2026-11-27, kopia danych; strony wzorca 2-58…2-61, 2-63 najpierw
zredukowane do pustej strony — bez bramek, netów, portów, odsyłaczy, zasilania; adnotacje
i dekoracje zostały — potem `--step gates`, `--step wires --draft`): `eval-digitize` daje
gateP/R/F1 = 1,000 na 2-58…2-61, 0,947 / 1,000 / 0,973 na 2-63 (TOTAL 0,987 / 1,000 / 0,993 —
tyle co `cv-gates` końcowa) i wireP/R/F1/wF1geom/juncP/juncR identyczne z tabelą v4 (a)
`cv-wires` (2-58 .926/.944/.935/.936/1.000/.864 … 2-61 .810/.837/.823/.832/.923/.923), mimo
że bramki są z `cv-gates`, nie ze wzorca. Odcinki, kropki i podział na nety są identyczne
z bezpośrednim `cv-wires.py --gates <ta sama strona>` (także 2-62 z 10 ręcznymi bramkami:
wszystkie 10 wykrytych ramek odrzucone, ręczne zostały). Czas ①+③: 0,4–0,8 s na stronę.
Ponowny przebieg obu kroków daje tę samą treść. `--step gates` na kopii ręcznych stron P-R3-2:
na 2-58…2-62, 2-64…2-66 diff to tylko dopisana sekcja `steps` (5 linii); na 2-63, 2-67, 2-68,
2-69 zmienione tylko sekcje `gates` i `steps`.

### Viewer

- Pasek kroków ①–⑥ nad płótnem ze stanem każdego kroku; wybór kroku ogranicza widoczne
  warstwy i narzędzia do tego kroku; warstwy innych kroków domyślnie wyszarzone, z przełącznikiem
  „ukryj” (USER).
- Prawy panel = kolejka przeglądu kroku: najpierw elementy niepewne (pewność, niezgodność dwóch
  odczytów, sprzeczność z `ic_map` / rejestrem / walidatorem), klawisze „zatwierdź” / „popraw” /
  „następny”; przycisk „Zatwierdź krok”.
- Kolory: `auto` (żółty), `edited` (niebieski), krok zatwierdzony (zielony) — jak w makiecie (USER).
- Walidacja na dole filtrowana do bieżącego kroku.
- Lista stron i widok pakietu pokazują stan kroków każdej strony (①–⑥).
- Przycisk „Vision”, okno AI (R) i narzędzie stref (Z) znikają (kr-9p8.16). Zostają
  „cleanup nets” (ratunek, gdy nety się rozsypią) i symbole +5V/+0V (podciąganie
  rezystorów i potencjometrów) — USER.

Zrobione (kr-9p8.20; logika w `viewer/src/stepView.ts`, testy `stepView.test.ts`,
`stepStore.test.ts`):

- `StepBar.tsx` nad płótnem: „wszystko” (bez filtra, jak przed pipeline'em) i ①–⑥ ze stanem
  (`○ czeka`, `● do przeglądu`, `✓ zatwierdzony`, `◐ nieaktualny`), przełącznik „inne kroki:
  wyszarzone | ukryte”. Krok po otwarciu strony: strona bez `steps` → „wszystko”; inaczej
  pierwszy `auto`/`stale`, potem następny do uruchomienia; wszystko zatwierdzone → „wszystko”.
  Wybór kroku to stan widoku (store `currentStep`), nie pliku.
- Części rysunku i kroki (`partRole`): ramka bramki ①; tekst bramki i piny ② (`text_src`,
  `pin.src`); odcinki / kropki ③ (`auto_segments`); porty, odsyłacze, zasilanie ④ (`src`); nety
  pinów / portów / odsyłaczy / zasilania i strzałki `pin.cross` ⑤ (`net_src`). Kontekst
  (pełny, zwykłe kolory): ramki w ②③⑤, piny w ③, druty w ④⑤, tekst bramek w ⑤ — tylko do
  odczytu (klik zaznacza, W przyciąga drut; bez przeciągania, zmiany rozmiaru, usuwania). Reszta,
  także adnotacje i dekoracje, wyszarzona bez interakcji albo ukryta.
- Edycja w kroku (`canEditElement(krok, rodzaj, aspekt)`): wolno zmienić tylko aspekt bieżącego
  kroku — ramkę w ①, tekst bramki / pinu w ②, geometrię drutu w ③, etykietę końcówki w ④, net
  w ⑤; bez kroku wszystko, w ⑥ nic. Prostokąt (V) i Shift+klik zaznaczają tylko elementy
  edytowalne (w ④ porty, choć w prostokącie są też środki bramek); Delete, K, wklejanie (jak
  przyciski „+ …”) sprawdzają to samo. Panel zaznaczenia elementu spoza kroku jest tylko do
  odczytu (`panelEditable`: bramka ①②⑤, odcinek ③, net ③⑤, końcówka ④⑤) z przyciskiem „przełącz”
  na jego krok; w panelu edytowalne są tylko pola aspektu kroku (`fieldEditable`): bramka — obrót
  w ①; ref, litera, wartość, typ / rozkład pinów i NC (`pin.disconnected`, pin nienarysowany —
  tekst pinu jak w `pinTextKey`) w ②; nety pinów (✎, rozłącz ×) w ⑤; port / odsyłacz / zasilanie —
  etykieta, arkusze, strona, usuń w ④, net w ⑤. Zmiana kroku przerywa rozpoczęte wstawianie /
  rysowanie i czyści historię cofania.
- Kolory w bieżącym kroku: `auto` żółty `#e5c07b`, `edited` niebieski `#61afef`, krok
  zatwierdzony zielony `#66bb6a`, krok nieaktualny pomarańczowy (jedna paleta `PROV_COLORS`;
  barwy jak w makiecie — decyzja opiekuna 2026-11-28); zaznaczenie, aktywny net i błędy mają
  pierwszeństwo, a zaznaczona bramka / odcinek / port ma też grubszą przerywaną linię. Błędy /
  ostrzeżenia barwią płótno tylko z kodów bieżącego kroku (`issueRelevant`).
- Narzędzia (`toolAllowed`, `placeAllowed`, `pageActionAllowed`): w krokach ①–⑤ V i E; W (drut)
  tylko w ③ i ⑤; R (AI) i Z (strefy) tylko bez kroku; ⑥ tylko V. „+ bramka” w ①; „+ port / xref /
  +5V / +0V” w ④; „+ tekst / linia / rect / koło” tylko bez kroku. „cleanup nets” w ③ / ⑤ / bez
  kroku; „vision”, „make .bak”, „restore .bak” tylko bez kroku.
- W trakcie przebiegu kroku (bez podglądu) strona jest zablokowana (`pageLock`): `editPage`, cofnij
  / ponów nic nie robią, płótno przykryte komunikatem „trwa krok pipeline’u — edycja
  zablokowana”, panel zaznaczenia, „Zatwierdź”, „+ …” i akcje strony nieaktywne; zamknięcie karty
  pyta (beforeunload). Po niepewnym wyniku blokada zostaje z „przeładuj stronę”. Wynik przebiegu
  i licznik czasu należą do strony, na której go uruchomiono; wynik z `sessionStorage` tylko dla
  tej strony i nie starszy niż 10 min.
- „Uruchom krok” (z „wymuś” przy kroku zatwierdzonym, „szkic” przy niezatwierdzonym poprzedniku,
  „podgląd (dry-run)”): flush, POST `/auto` przez `runRewrite` (blokada zapisów strony, po
  zapisie przeładowanie; wynik pokazany po przeładowaniu z `sessionStorage`), w trakcie
  GET `/auto/status`. 409 refused / busy, 501, 4xx → nic nie zapisano, edycja wraca; 500 bez
  wyniku, 504, brak odpowiedzi → strona zablokowana do ręcznego przeładowania. Podgląd bez
  `runRewrite`.
- Prawy panel (`ReviewPanel.tsx`, minimalny — rozbudowa w kr-9p8.7): elementy kroku z `src: auto`,
  najpierw niepewne (problem walidatora tego kroku przy elemencie; odcinki: krótszy niż 10 px,
  koniec we wnętrzu innego odcinka bez kropki), klik / N / Shift+N = zaznacz i przybliż.
  „Zatwierdź krok” przez `editPage` (stan kroku i `verified` nie są treścią): ① ustawia też
  `verified: true` na każdej bramce; ⑤ tylko bez błędów walidacji strony (kody kroków ①–⑤).
  Krok `todo` — z potwierdzeniem. „Cofnij zatwierdzenie”: krok wraca do `auto` (był przebieg) albo
  `todo`, późniejsze zatwierdzone → `stale`.
- Walidacja: problemy bieżącego kroku (`issueStep`; `CROSS_REF_NO_RETURN` w ⑤ — brak powrotu
  netu) i osobno „inne (bez kroku)”: rejestr pakietu (także `Issue.scope: 'package'`), projekt,
  format, kody nieznane; problemy innych kroków i innych stron (`Issue.page`) ukryte, przełącznik
  „wszystkie”.
- Lista stron i widok pakietu: znaczki ①–⑤ (`✓ ● ◐ ○`). Widok pakietu: „Uruchom następny krok na
  wszystkich stronach” (POST `/auto {page: 'all', step: 'next'}`, z potwierdzeniem i podglądem),
  wynik per strona, potem ponowne wczytanie pakietu — tylko gdy nadal otwarty jest widok tego
  pakietu (bieżąca trasa ze store).

### Dane do uczenia z każdego kroku

| Krok | Para do uczenia |
|---|---|
| ① | skan + poprawione ramki → detektor bramek (YOLO), progi CV |
| ② | wycinek bramki / pinu + poprawiony tekst → słownik, few-shot, LoRA VLM |
| ③ | skan + poprawione druty i kropki → parametry `cv-wires.py` (Optuna), ewentualnie segmentacja |
| ④ | wycinek etykiety + poprawiona etykieta → słownik sygnałów (kr-wuy.1), few-shot |
| ⑤ | poprawki netów → reguły składania i samokorekty |

`data/gold` nie jest używany do uczenia (zob. „Pętla uczenia”).

## Pomiar zamiast wiary

Wszystko powyżej to hipotezy. Najpierw powstaje zestaw wzorcowy i skrypt oceny; każdy etap
ma liczbę, którą poprawiamy.

- **Zestaw wzorcowy:** P-R3-2 2-58…2-61 (komplet) + 2-63 (bramki) + 2 arkusze z innych
  pakietów (ręcznie, dla różnorodności — jedyny zaplanowany koszt ludzki).
- **Metryki** (`scripts/eval-digitize.py`, szczegóły niżej): połączenia na poziomie
  endpointów (`ep_acc` — odsetek pinów/portów/cross-refów w pełni poprawnie połączonych),
  pary endpointów (`pair_F1`), bramki (P/R przy IoU ≥ 0,5; dokładność ref i litery), piny
  (P/R numerów, błąd położenia), druty (P/R/F1 w tolerancji 3 px z przynależnością do netu),
  junctions, porty i cross-refy (dokładność etykiet), czas na arkusz.
- **Linia bazowa:** obecny `vision-page.py` (Claude) na tych samych arkuszach.
- **Próg sukcesu etapu:** ≤ 5 poprawek na arkusz przy `ep_acc` ≥ 95 % (≥ 95 % endpointów
  ma dokładnie te same współczłonki netu co we wzorcu).

Zestaw wzorcowy jest zamrożony w `data/gold/` (`manifest.yaml`: strony, `scope`
`full`/`gates_only`, sha256 każdego pliku, historia poprawek opiekuna). Pipeline'y nigdy go nie
edytują. Integralność jest sprawdzana przed oceną: brak pliku = exit 3; brak sha256 albo
niezgodne sha256 = exit 3 (obejście `--allow-modified`). Kandydat ma układ
`<pakiet>/<strona>.sch.yaml` albo `<pakiet>/pages/<strona>.sch.yaml` (działa też
`--candidate data/MJC-400`); brak strony = strona pusta, brak wszystkich = błąd, exit 2.

```bash
uv run scripts/eval-digitize.py --gold data/gold --candidate <katalog> [--json wynik.json]
```

Wynik: tabela per strona + `TOTAL` (micro-average: liczniki sumowane po stronach) i linia
`HEADLINE ep_acc=… pair_F1=… gate_F1=… wire_F1=…`.

- `ep_acc` (liczba nagłówkowa): dla każdego endpointu wzorca (pin `REF.GATE.NUM`, port,
  cross-ref) zbiór pozostałych endpointów jego netu we wzorcu i u kandydata musi być identyczny;
  nazwy netów nie muszą się zgadzać. Nieodnaleziony endpoint = błąd; endpoint kandydata bez
  odpowiednika w necie = błędny członek. `epJac` to średni Jaccard tych zbiorów (miękka diagnostyka).
- `pair_F1`: dla każdej pary endpointów z sumy wzorca i kandydata — czy leżą w tym samym necie.
  Waży nety kwadratem rozmiaru (jeden net z 10 endpointami = 45 par), dlatego nie jest nagłówkiem.
  `pF1cond` to samo tylko na endpointach dopasowanych w obu.
- Bramki: IoU ≥ 0,5; brak `w`/`h` = domyślny rozmiar viewera (`autoBox`). Piny: precision
  i recall numerów w dopasowanych bramkach.
- Druty: geometria per net znormalizowana (scalone współliniowe odcinki, bez duplikatów), próbki
  co 5 px deduplikowane na siatce 1 px. Nety kandydata mapowane 1:1 na nety wzorca po wspólnych
  endpointach (rozstrzygająco geometrią). Próbka liczy się tylko przy odcinku ZMAPOWANEGO netu,
  więc druty przypisane do złych netów nie dają punktów. `wF1geom` = to samo bez netów.
  Nety o pustej nazwie są pomijane (viewer ich nie rysuje).
- Junctions: zapisane `junctions` ∪ kropki z reguły viewera (≥ 3 końce odcinków jednego netu
  w dokładnie tym samym punkcie; duplikaty odcinków liczą się raz). T-złącze bez podziału
  odcinka nie dostaje kropki — tak jak w viewerze.
- Druty, junctions, pary i `ep_*` tylko na stronach `full`.

Testy (nie zostawiają `__pycache__` ani `.pytest_cache`):
`PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy --with scipy pytest -p no:cacheprovider scripts/test_eval_digitize.py`.

## Pętla uczenia

Każda strona zatwierdzona przez człowieka to dane treningowe. Pipeline zapisuje niezmienny snapshot swojego wyniku; po zatwierdzeniu `learn-diff` porównuje go ze stroną i dopisuje poprawki do logu (`kr-9p8.10`). `just learn` (`kr-9p8.12`) po sesji przeglądu: słownik etykiet netów, typów IC, refów i pinów (samokorekta, ograniczenie odpowiedzi VLM); przykłady few-shot z podobnych zatwierdzonych wycinków; retrening YOLO i ewentualnej segmentacji drutów; strojenie parametrów CV (Optuna, `kr-9p8.11`); LoRA VLM (`kr-9p8.9`). Nowa wersja wchodzi tylko, jeśli jest lepsza na `data/gold` bez regresji.

**Zasada:** `data/gold` służy wyłącznie do testu — nigdy do treningu ani strojenia. Uczymy się tylko na stronach zatwierdzonych spoza wzorca.

## Modele online — dla porównania

OmniSch (arXiv 2604.00270, 1854 prawdziwe schematy, zero-shot schemat → graf) mierzy Net F1: GPT-5.2 0,20; Claude Sonnet 4.6 0,17; Gemini 3.1 Pro 0,27; Qwen3.5-122B-A10B 0,42; klasyczny pipeline CV 0,59; człowiek 0,99. Z podanymi ramkami elementów Gemini 3.1 Pro czyta nazwy netów z dokładnością 0,89. Czyli: żaden model online nie odtwarza połączeń z całego arkusza, a w czytaniu tekstu przy znanym położeniu są dobre. Modele online (Claude Opus 5.5 / Fable 5.2, Gemini 3.x, GPT-5.x) wchodzą do bake-offu obok lokalnych, w obu trybach (cały arkusz i wycinki). Koszt nie jest przeszkodą (pełny przebieg rzędu kilkudziesięciu USD, do zmierzenia); decyduje dokładność.

## Lokalne modele (do sprawdzenia w bake-offie)

Kandydaci na start, uruchamiani przez `mlx-vlm` na M5 Pro 64 GB (4-bit, z zapasem pamięci):
rodzina Qwen3-VL (32B dense, 30B-A3B MoE — szybki), MiniCPM-V, modele OCR dokumentów
(PaddleOCR-VL, dots.ocr). Wybór należy do spike'a, nie do tego dokumentu; nazwy i wersje
trzeba sprawdzić na kartach modeli w chwili startu. Jeśli żaden nie osiągnie progu na
wycinkach: fine-tuning LoRA (`mlx-vlm`) na wycinkach z poprawionych arkuszy — każdy
poprawiony arkusz powiększa zbiór treningowy.

## Kolejność

1. Najpierw beady P0 o utracie danych (`kr-pfj.*`, `kr-4dt.*`): pipeline będzie masowo
   zapisywać strony.
2. Zestaw wzorcowy + skrypt oceny.
3. Równolegle: druty (CV), bramki (CV/YOLO), bake-off VLM na wycinkach.
4. Składanie grafu + samokorekta.
5. Kolejka przeglądu w viewerze.
6. Przebieg nocny na wszystkich arkuszach, przegląd, fine-tuning na poprawkach.

## Wyniki: druty CV (kr-9p8.2)

Spike: czy klasyczne CV (OpenCV/numpy, bez modelu) wyciąga druty, kropki i wolne końce na
tyle dobrze, żeby zbudować nety. Hipoteza: recall drutów ≥ 95 %, recall junctions ≥ 98 %
na stronach wzorca. Skrypt `scripts/cv-wires.py`, testy `scripts/test_cv_wires.py`.

**Werdykt.** Druty i kropki wyciągnięte klasycznym CV działają, **gdy prostokąty bramek są
znane** (tryb a). Na P-R3-2 v4 daje wireR 0,79–0,94, juncR 0,80–1,00, a `pairP` = 1,000
na każdej stronie — żaden pin nie trafia do cudzego netu. Pozostałe braki to głównie
reprezentacja i wzorzec: przy tolerancji 6 px pokrycie drutów wzorca wynosi 0,97–1,00.

v5 (kr-9p8.22) usuwa fałszywe piony ze słupków tekstu i szewronów portów oraz odzyskuje
krótkie odcinki do pinów z cyfrą. Liczby wzorca nie spadły na żadnej stronie (zob.
„v5: tekst przy drutach”).

v6 (kr-9p8.23) usuwa słupki liter przecinające kolejne druty (2-63 „+NB0/+NB3/+NB2”),
linie sklejone z napisów przy portach i minusów etykiet (SM-POSE11 2-100) oraz resztki ramek
bramek. Wzorzec bez zmian poza 2-61 wireR 0,837 → 0,836 (zob. „v6: słupki liter i napisy przy
portach”).

Hipoteza w liczbach `eval-digitize` nie jest spełniona. Ślepy wynik held-out (v1) to wireR
0,84 na 2-60 i 0,36 na 2-61; późniejsze wersje stroiłem już po obejrzeniu tych stron.

Tryb (b), w którym bramki są wykrywane samodzielnie, **nie nadaje się jeszcze do użytku
poza P-R3-2/P-X3-2** (zob. „Poza P-R3-2”). Na JPP-16-18 i SM-POSE11 nie wykrywa
złożonych układów, a ramka strony, tabliczka i odręczne dopiski stają się drutami.

Dalsze kroki:

- **kr-9p8.3** — wykrywanie bramek, w tym złożonych układów;
- **nowy bead** — ramka strony, tabliczka rysunkowa, odręczne dopiski i klamry magistral.

Uwaga metodyczna: zgodnie z zadaniem spike'a stroiłem na 2-58 i 2-59, czyli na stronach
wzorca. To łamie zasadę „`data/gold` tylko do testu” z „Pętli uczenia”. Liczby 2-58/2-59
są więc optymistyczne, a jedyny ślepy test to v1 na 2-60/2-61. Docelowo strojenie trzeba
przenieść na zatwierdzone strony spoza wzorca.

### Metoda (v4)

Szczegóły są w docstringu skryptu.

**Grubość kreski `sw`** mierzę na każdej stronie: średni przekrój długich linii (Otsu),
bez biegów dłuższych niż mediana + 1 (żeby pominąć ramki bramek). Wyniki: 2-58 2,09 px,
2-59 2,35, 2-60 2,58, 2-61 2,97, P-X3-2 2-1 2,16, JPP-16-18 2-115 2,69, SM-POSE11 2-97
1,56. Rozmiary związane z kreską liczę ze wzorów:

| parametr | wzór |
|---|---|
| `DOT_D` | najbliższa nieparzysta od 7 + 2 (sw − 2,2), ≥ 5 |
| `DOT_DT` | sw + 1,6 |
| `DOT_MAX_SIDE` | 2 DOT_D + 2 sw + 1 |
| `DOT_HOLE` | ⌈sw²⌉ |
| `DOT_R` | DOT_D |
| `END_SNAP` | DOT_D + 2 |
| `SNAP` | round(2,5 sw) |
| `BOX_T`, `PAD`, `THIN_W` | round(sw + 1,6) |
| `MAX_THICK` | round(2 sw + 4) |
| `PAR_OFF` | round(2 sw + 1) |

Wzory dla `DOT_D` i `DOT_DT` są addytywne, bo rozlanie tuszu pogrubia kreskę i kropkę
o tyle samo pikseli.

Rozmiary bezwzględne:

- wielkości związane z tekstem przy 200 dpi (znak ~16 px) — `TEXT_MAX`, `GLYPH_MIN`,
  `MIN_LEN`, `PIN_BAND`, `SPUR_LEN`, `MIN_ISOLATED`;
- przerwy ze skanowania (`GAP2`, `BRIDGE_*`). To cecha skanu, nie rysunku. Gdyby rosły
  razem z grubą kreską, częściej mostkowałyby na sąsiednie druty.

Pozostałe stałe są w PARAMS.

**Kropki:**

1. Zamalowanie dziur. Kropka bywa blada w środku (P-X3-2 2-1 (1480, 243): po progu ma
   dziury 2 i 4 px o szarości 162 i 193). Dziurę zamalowuję tylko wtedy, gdy jest mała
   (≤ `DOT_HOLE`) i szara (średnia ≤ 200, `DOT_HOLE_GRAY`). Wnętrza kółek negacji (~50 px),
   oczka liter i kratki ramki to biały papier albo są za duże.
2. Otwarcie dyskiem `DOT_D`.
3. Promień koła wpisanego ≥ `DOT_DT`. Kandydat, który przechodzi próg dopiero po
   zamalowaniu, musi mieć ≥ `DOT_DT` + 1,5 (`DOT_FILL_EXTRA`). Szum JPEG (1–2 px dziurki)
   w kleksie na skrzyżowaniu cienkich linii daje r ≤ 4,2 (SM-POSE11 2-97); prawdziwe
   blade kropki mają 5,4 (P-X3-2) i 7,6 (2-61).

**Tekst.** Usuwam składowe w rozmiarze znaku i znaki przyklejone do drutu (po odjęciu
pewnych linii). W pasie numerów pinów (`PIN_BAND` = 25 px, wcześniej 20) kasuję tylko
krótkie (< 32 px) kreski równoległe do krawędzi. Słupek „1” na 2-61 stoi 22 px od
krawędzi, a długi drut biegnący w pasie zostaje. W v5 kasowanie znaków przy drutach
zmieniło się (zob. „v5: tekst przy drutach”).

**Linie:**

- otwarcie długim cienkim jądrem, osobno H i V;
- domknięcie wzdłuż linii bez pikseli kropek — dokładam je dopiero przed otwarciem;
- scalanie kawałków współliniowych oraz równoległych, zachodzących na siebie bliżej niż
  `PAR_OFF`;
- mostkowanie przerw z bladym tuszem;
- **koniec odcinka leżący w kropce przycinam do jej środka** (v4). Bez tego SNAP liczony
  od końca wydłużonego o promień kropki sięgał równoległego drutu 10–14 px niżej (przy
  `T_NEEDS_DOT=False` łączył go).

**Połączenia.** Narożnik łączy zawsze, skrzyżowanie tylko z kropką, T tylko z kropką
(`T_NEEDS_DOT`, opis niżej). Po ostatnim usunięciu odgałęzień graf budowany jest od nowa.

**Tryb (a)** bierze prostokąty bramek z YAML-a wzorca. Do kandydata trafiają tylko pola
z białej listy (ref, gate, x, y, w, h, rotation, piny {num, side, px, py, net}) oraz
`verified: false`.

**Tryb (b)** szuka domkniętych czworoboków: dwa przeciwległe boki grube o zgodnych
końcach, dwa pozostałe ciągłe, rozsądny rozmiar, a stos przedłużany wzdłuż ciągłych
boków. Tylko na P-R3-2/P-X3-2, zob. „Poza P-R3-2”.

**T bez kropki.** W v1 i v2 uzasadniałem regułę `T_NEEDS_DOT` tym, że „T bez kropki to
cyfra albo litera”. To było w większości nieprawdziwe: wiele odrzuconych T powstało
z błędów samego potoku. Domknięcie przeciągało drut przez kropkę (2-58
[884, 1175, 884, 1201]), a kropka dawała równoległy pasek (2-59 [1290, 1031, 1318, 1031]).

v4 odrzuca 1/2/2/3 T na 2-58/2-59/2-60/2-61. Wszystkie to kreski tekstu (zmierzone):

- 2-58 (660, 938) — cyfra „4” przy M53;
- pozostałe — kolumny etykiet `+RA/+RB/-PISZRW/+L9` przy lewej krawędzi (x 283–433).

Reguła zostaje. Z `T_NEEDS_DOT=False` wireF1 na 2-59 spada z 0,786 do 0,646.

### Liczby (`eval-digitize`, tolerancja 3 px)

Wersje:

- **v1** — parametry zamrożone przed pierwszym uruchomieniem na 2-60/2-61, binaryzacja
  `<`. To **jedyny ślepy wynik held-out**.
- **v2** — `DOT_DT` = 4,8 i `MAX_THICK`.
- **v3** — rozmiary od `sw`, domknięcie bez kropek, tryb (b) na czworobokach, zamalowanie
  dziur przy `DOT_HOLE` = `DOT_D`².
- **v4** — zamalowanie tylko małych szarych dziur + `DOT_FILL_EXTRA`, przycinanie końców
  do środka kropki, `PIN_BAND` = 25, najbliższa nieparzysta w `DOT_D`.

v2–v4 stroiłem po obejrzeniu held-out.

Kolumny: wireP / wireR / wireF1 / wF1geom / juncP / juncR.

| strona | tryb | v1 (ślepy na 2-60/61) | v3 | v4 |
|---|---|---|---|---|
| 2-58 | a | .926/.944/.935/.936/1.000/.864 | .926/.944/.935/.936/1.000/.864 | .926/.944/.935/.936/1.000/.864 |
| 2-59 | a | .786/.785/.786/.791/.778/.840 | .787/.785/.786/.791/.800/.800 | .787/.785/.786/.791/.800/.800 |
| 2-60 | a | .838/.839/.838/.940/.920/.920 | .909/.926/.918/.966/1.000/1.000 | .916/.926/.921/.968/1.000/1.000 |
| 2-61 | a | .358/.363/.361/.822/.489/.846 | .805/.837/.821/.830/.889/.923 | .810/.837/.823/.832/.923/.923 |
| 2-58 | b | .899/.945/.921/.923/.950/.864 | .926/.944/.935/.936/1.000/.864 | .927/.944/.935/.936/1.000/.864 |
| 2-59 | b | .786/.786/.786/.791/.778/.840 | .786/.786/.786/.792/.800/.800 | .786/.786/.786/.792/.800/.800 |
| 2-60 | b | .876/.811/.842/.909/.952/.800 | .909/.927/.918/.966/1.000/1.000 | .916/.927/.921/.968/1.000/1.000 |
| 2-61 | b | .463/.469/.466/.705/.289/.423 | .805/.837/.821/.830/.889/.923 | .810/.837/.823/.831/.923/.923 |

Wyniki v2 są w historii tej sekcji (v2 (a) 2-61: .788/.819/.803/.831/.917/.846).

Uwagi:

- Tryb (b) na P-R3-2 jest bliski trybowi (a), ale **nie identyczny** — różnice na
  3. miejscu po przecinku: 2-58 wireP .927 wobec .926, 2-59 wireP .786 wobec .787 i
  wF1geom .792 wobec .791, 2-60 wireR .927 wobec .926, 2-61 wF1geom .831 wobec .832.
  W v3 wyglądało to podobnie.
- Przejście v1 → v2 zmieniło 2-59: juncP 0,778 → 0,808.
- Binaryzacja `<` → `<=` nie jest obojętna. v1 z `<=` daje 2-61 (a) juncP 0,500 zamiast
  0,489 i 2-58 (b) wireF1 0,923 zamiast 0,921.
- Tryb (a) v4: `pairP` = 1,000 na wszystkich stronach, `pF1cond` 0,959 / 1,000 / 0,816 /
  0,977.
- `ep_acc` jest niskie, bo kandydat nie ma portów ani cross-refów.
- Czas na stronę (sam rdzeń): v4 0,14–0,40 s (najwolniej SM-POSE11 2-100: 0,40 s; dwie
  transformaty odległości w `detect_dots`). W v3 było 0,12–0,41 s.

### Poza P-R3-2

Wszystkie pomiary w trybie (b), bez wzorca, więc bez liczb `eval-digitize`. Ocena z overlayu
i statystyk.

| strona | sw | v3: nety / odcinki / kropki | v3 największy net | v4: nety / odcinki / kropki | v4 największy net |
|---|---|---|---|---|---|
| JPP-16-18 2-115 | 2,69 | 124 / 384 / 125 | 8690 px | 163 / 262 / 22 | 3608 px |
| SM-POSE11 2-97 | 1,56 | 68 / 277 / 107 | 25 283 px | 90 / 184 / 25 | 3282 px |
| SM-POSE11 2-100 | 1,88 | 195 / 609 / 186 | 7197 px | 235 / 506 / 99 | 2090 px |
| P-X3-2 2-1 | 2,16 | 69 / 187 / 39 | 3786 px | 70 / 176 / 37 | 3384 px |

Recenzja zmierzyła na SM-POSE11 2-97 bez zamalowania 8045 px (v3). v4 bez zamalowania
(`DOT_HOLE=0`) daje 2897 px, a z zamalowaniem 3282 px. Część różnicy wobec v3 wynika też
z najbliższej nieparzystej w `DOT_D` (2-115: 9 → 7) i z przycinania końców do kropek.

Cztery klasy błędów (zmierzone przez recenzję i potwierdzone na overlayach v3/v4):

1. **Kropki z zamalowanych dziur** (v3). `DOT_HOLE` = `DOT_D`² zamalowywał kółka negacji,
   oczka liter i kratki ramek, przez co kandydatów na kropki było dwa razy więcej
   (2-58: 108 → 236 kropek). Na SM-POSE11 2-97 największy net urósł do 25 283 px.
   **Naprawione w v4**:
   - liczba kropek (z testem promienia) z zamalowaniem / bez: 2-58 106/108, 2-61 85/83,
     P-X3-2 163/161, SM-POSE11 2-97 77/77, JPP 2-115 56/58 (v3: 236/174/289/107/241);
   - zysk zostaje: (1480, 243) na P-X3-2 łączy zegar M2 C3/C11 z C bramek M4/M6/M7,
     a złącze 2-61 (716, 679) jest nadal wykrywane;
   - SM-POSE11 2-97: kółko negacji ~(612, 1203) nie jest już kropką. Przy ~(612, 1046)
     zostaje kandydat r = 3,6 (kółko zlane z grubą ramką układu, bez zamalowania) — to już
     klasa 2.
2. **Złożone układy** (RAM K565 na JPP 2-115, rejestry/liczniki z kolumnami etykiet
   pinów na SM-POSE11): czworobok ich nie łapie (JPP 2-115: 3 maski), więc ramki,
   przegródki i kolumny etykiet stają się drutami. Do kr-9p8.3.
3. **Ramka strony i tabliczka.** Na JPP 2-115 ramka arkusza (x ≈ 130–2200, y ≈ 170–1520)
   jest jednym długim „netem”, a tabliczka ma inne położenie i rozmiar niż na P-R3-2, więc
   maska `TITLE` (x ≥ 0,66 W, y ≥ 0,76 H) jej nie obejmuje i tabela tabliczki zamienia się
   w druty. Do nowego beada.
4. **Odręczne dopiski i klamry magistral.** Na SM-POSE11 2-97 jest pionowa kreska / klamra
   przy lewej kolumnie wejść (x ≈ 220), do której dochodzi kilkanaście drutów.
   W v3 sklejało się to w największy net (z kropkami z klasy 1). W v4 druty dochodzące
   do klamry tworzą T bez kropki, więc się nie łączą (największy net 3282 px). Klamra
   i dopiski zostają jednak fałszywymi „drutami”. Do nowego beada.

### Ile z tego to wzorzec (pomocniczo, poza `eval-digitize`)

Mierzę próbki drutów wzorca (co 5 px) leżące dalej niż 3 px od jakiegokolwiek tuszu skanu
(próg 190). Ich odsetek ogranicza od góry recall każdej metody wiernej skanowi. Tabela
dla v4, tryb a; v3 różni się o ≤ 0,001.

| strona | wzorzec na tuszu | geomR @3 px | geomR @6 px | geomR @3 px tylko tam, gdzie wzorzec na tuszu |
|---|---|---|---|---|
| 2-58 | 0,952 | 0,945 | 0,997 | 0,971 |
| 2-59 | 0,855 | 0,790 | 0,998 | 0,869 |
| 2-60 | 0,992 | 0,974 | 0,999 | 0,980 |
| 2-61 | 0,902 | 0,846 | 0,970 | 0,897 |

### Główne błędy na P-R3-2 (v4)

1. **Skos skanu wobec ortogonalnego wzorca** (zmierzone). Linie mają skos 4–10 px na
   1000 px, a wzorzec trzyma współrzędną z jednego końca linii. Na 2-59 `-V` ma we wzorcu
   y = 390, na skanie linia biegnie od ≈ 391 do ≈ 399, a kandydat ma 395. To prawie cała
   strata na 2-59 (geomR 0,79 przy 3 px, 0,998 przy 6 px). Złącza przesunięte o 5–8 px:
   (631, 952) we wzorcu wobec (633, 947) u kandydata, (691, 868) wobec (690, 860) na 2-61.
2. **Złącza wzorca w kotwicach cross-refów** (zmierzone). 2-58: (1530, 933/987/1015) oraz
   (1200, 1285/1413/1446) — to wszystkie 6 brakujących złączy na 2-58.
3. **Ogony pod etykietami cross-refów** (zmierzone). Drut kończy się przy x ≈ 1565,
   a wzorzec przy kotwicy x = 1530.
4. **Drobne** (zmierzone):
   - 2-61: `+L10` ma osobny kawałek ~(900–1031, 863);
   - 2-60: `+W4` i `+W6` mają po 4–5 próbek w sąsiednim necie na skrzyżowaniach.
5. **Naprawione w v3–v4 i pokryte testami:**
   - domknięcie przez kropkę na równoległy drut;
   - równoległy pasek przy kropce;
   - SNAP liczony od końca wydłużonego kropką;
   - słupek „1” 22 px od krawędzi (2-61 [770, 651, 770, 706]);
   - kropki gubione przy bezwzględnym `DOT_DT`;
   - zamalowywanie kółek i oczek liter;
   - pas pinów kasujący drut;
   - graf nieprzebudowywany po usuwaniu odgałęzień;
   - przeciek pól bramek wzorca do kandydata;
   - zaokrąglanie `DOT_D` zawsze w górę (7,76 → 9).

### v5: tekst przy drutach (kr-9p8.22)

Opiekun obejrzał overlaye trybu (a) na całych arkuszach (2-62, 2-58) i zgłosił trzy klasy
błędów. Przyczyny zmierzyłem na powiększeniach i obrazach pośrednich potoku.

1. **Słupki znaków stojących na kolejnych drutach stają się pionowymi drutami.**
   Przykłady: 2-62 lewy dół (`+RA/+RB/-PISZRW`, `+L15`…`+L12`) i numery pinów
   14/13/12 przy M24.
   - Każdy znak dotyka drutu pod sobą i prawie dotyka drutu nad sobą. Przebieg
     zachowawczy (`GAP1` = 3, `MIN_LEN1` = 28) uznawał więc cały słupek za „pewną”
     linię pionową.
   - v4 odejmowała pewne linie obu orientacji naraz, więc słupek nie trafiał do reszty
     i nie był kasowany jako znak.
   - Przy M24 bieg słupka przechodził przez druty i miał ≥ 32 px, więc pas pinów
     (`BAND_RUN`) też go nie kasował.
   - Skutek na M24: drut WA (pin 14) i EN (pin 12) skręcał przez cyfry. Pion
     [778, 680–731] łączył narożnikami drut WA z drutem EN, piny 14 i 12 nie miały netu.
     Drut C1 (pin 2, y ≈ 654) biegł dalej przez górę „14” aż do krawędzi bramki, a pin 2
     dostawał tylko krótki kawałek zamiast drutu.
2. **Zgubione krótkie odcinki do pinu** (2-58 M64.12 i M40.3). Odcinek od narożnika do
   pinu ma ~25 px, mniej niż `MIN_LEN1`, więc nie był „pewną” linią. Numer pinu
   („12”, „3”) stoi na nim i go dotyka. Składowa „odcinek + cyfra” mieściła się
   w rozmiarze znaku i była kasowana w całości. Etap: `strip_glyphs`.
3. **Szewrony portów jeden nad drugim** (2-62 A18/A05, 2-61 x ≈ 1722). Końce ukośnych
   kresek „>” leżą w jednej kolumnie. Domknięcie (`GAP2`) i mostkowanie sklejały je
   w pionową „linię” długą na 107 px, choć tusz był pod nią tylko na małej części długości.

**Zmiany (v5):**

- **Kasowanie znaków w trzech przebiegach** (`GLYPH_PASSES = "h v hv"`):
  - „h” odejmuje tylko pewne linie poziome, więc słupek rozpada się na pojedyncze znaki,
    które giną;
  - „v” odejmuje tylko pionowe; pewne linie poziome są wtedy chronione (tekst jest
    poziomy);
  - „hv” odejmuje obie orientacje, jak dawniej (znak w narożniku).
- **Kropki nie są kasowane.** Rozmiar składowej liczę bez pikseli chronionych. Przykład:
  pion między dwiema kropkami 25 px od siebie (2-65 (766, 1400)) jest po odjęciu kropek
  okruchem, nie znakiem.
- **Rdzeń krótkiego drutu** (`CORE_FRAC` = 0,85, `CORE_MIN` = 9, `CORE_REACH` = 6).
  Z kasowanej składowej zostaje prosty, cienki bieg (wiersz albo kolumna) na ≥ 85 %
  jej długości, jeśli oba jego końce dochodzą tuszem do jednego z trzech miejsc:
  - odjętej linii, przez którą bieg przechodzi (skrzyżowanie) albo na której ta linia
    się kończy (narożnik);
  - maski bramki;
  - prostopadłego rdzenia, który sam ma mocny koniec (narożnik C1 na 2-62).

  Samo dotknięcie linii biegnącej dalej w obie strony (znak stojący na drucie) nie
  wystarcza. Długość składowej liczę bez pół kropki (2-58 M40.1). Uzupełnienia po
  recenzji opisuje „Poprawka po recenzji (tryb b)”.
- **`_split_thick` liczy profil po odjęciu skosu** (`SPLIT_DESKEW`). Długi pion ze skosem
  i kropką (2-66 x ≈ 494–500) miał tusz na ≥ 50 % długości tylko w kolumnach dolnej
  części, więc górny kawałek drutu ginął. To błąd v4, który wyszedł przy porównaniu.
- **Pokrycie tuszem** (`MIN_COVER` = 0,6). Odcinek ma licznik tuszu z pikseli składowej
  przed domknięciem. Przy scalaniu liczniki się sumują, przy mostkowaniu dochodzi tusz
  z przerwy. Odcinek z tuszem na < 60 % długości jest odrzucany. Liczenie na pikselach
  składowej nie zależy od skosu; pas wokół osi gubił skośny drut 480 px na P-X3-2 2-9.

**Dyscyplina zbioru.** Mechanizmy stroiłem na stronach spoza wzorca:

- P-R3-2: 2-62 oraz 2-64…2-68 w trybie (a) z bramkami ze stron `data/MJC-400`;
- 2-69 w trybie (b), bo strona nie ma bramek;
- P-X3-2 2-1…2-10 w trybie (b).

Oglądałem diff kawałków v4/v5 na powiększeniach.

Wyjątki dotyczą 2-58:

- dwa zgłoszone przypadki (M64.12, M40.3) leżą na wzorcowej 2-58 i diagnozowałem je
  na jej wycinkach;
- poprawkę „długość bez pół kropki” znalazłem, bo wcześniejsza wersja v5 zgubiła na
  2-58 drut M40.1.

2-58 nie jest więc czystym testem v5. Liczby z 2-59…2-61 są tylko kontrolą: niczego na
nich nie stroiłem.

**Wzorzec, tryb (a) z bramkami wzorca** (`eval-digitize`, 3 px). Kolumny: wireP / wireR /
wireF1 / wF1geom / juncP / juncR.

| strona | v4 | v5 | pF1cond v4 → v5 |
|---|---|---|---|
| 2-58 | .926/.944/.935/.936/1.000/.864 | .927/.948/.937/.938/1.000/.864 | .959 → 1.000 |
| 2-59 | .787/.785/.786/.791/.800/.800 | .789/.785/.787/.792/.800/.800 | 1.000 → 1.000 |
| 2-60 | .916/.926/.921/.968/1.000/1.000 | bez zmian | .816 → .816 |
| 2-61 | .810/.837/.823/.832/.923/.923 | .815/.837/.826/.834/.923/.923 | .977 → .977 |

`pairP` = 1,000 na każdej stronie. Piny z netem: 2-58 73/76 → 76/76, 2-62 46/48 → 48/48.
Liczby po poprawce z recenzji. Przed nią 2-58 miało .928/.948/.938. Różnica to jeden
fałszywy kawałek 26 px: dolna kreska cyfry „11” przy kropce (642, 609).

**Przypadki opiekuna (zmierzone skryptem kontrolnym):**

| przypadek | v4 | v5 |
|---|---|---|
| 2-62 M24 pin 14 (WA) | bez netu | net drutu od kropki (739, 680), prosto |
| 2-62 M24 pin 13 (WE) | ok | ok |
| 2-62 M24 pin 12 (EN) | bez netu | net długiego drutu y ≈ 730 |
| 2-62 M24 pin 2 (C1) | sam kawałek; drut y ≈ 654 szedł do krawędzi | net narożnika (767, 600–654) i drutu y ≈ 654 |
| 2-62 M24: piony w kolumnie cyfr x 770–786 | [778, 680–731] | brak |
| 2-58 M64.D pin 12 | bez netu | = M64.A pin 2 (jak we wzorcu) |
| 2-58 M40.B pin 3 | bez netu | = M40.A pin 1 (jak we wzorcu) |

**Strony spoza wzorca** (2-62, 2-64…2-69). Porównuję kawałki drutów, które są tylko w v4
albo tylko w v5 (tolerancja 3 px), i każdy oceniam na powiększeniu skanu:

- **tylko w v4: 72 kawałki.** Wszystkie to tekst, słupki znaków, szewrony portów albo
  symbole. Jedna z nich, na 2-65 (1020, 579), łączyła piny C i Q jednej bramki.
- **tylko w v5: 21 kawałków.** Prawdziwe:
  - druty WA/EN na 2-62 dochodzą teraz prosto do pinu;
  - pion x ≈ 553 na 2-65, odzyskany dzięki `SPLIT_DESKEW`;
  - odcinki do pinów z cyfrą (2-64, 2-65, 2-66);
  - długi pion na 2-67 (430, 547–699).

  Pozostałe ~10 to śmieci w ramkach na 2-67/2-68. YAML tych stron ma tylko część
  bramek: piny z netem 2/60 i 6/56.

Heurystyka „pływających netów” liczy nety < 150 px bez końca bliżej niż 12 px od bramki.
Wynik v4 → v5: 132 → 100, w tym 2-62 3 → 0, 2-67 36 → 25, 2-68 31 → 21.

Heurystyka „krótkich wiszących odcinków” (< 40 px, wolny koniec z dala od bramki) daje
9 → 9. Tej klasy błędu nie łapie, bo fałszywe słupki są długie (50–110 px).

P-X3-2 (tryb b) ma 102 kawałki tylko w v4 i 55 tylko w v5:

- w v4 to głównie kolumny minusów etykiet `-R1/-I1` (2-8), szewrony i słupki etykiet;
- w v5 to odcinki do pinów z cyfrą i odzyskany drut y ≈ 481 na 2-9 (~360 px);
- w obu wersjach zostają śmieci w etykietach elementów biernych (`C25 47p`, `R12 0,25`)
  i we wnętrzach niewykrytych bramek. Różnica jest tam mieszana.

Czas rdzenia na stronę:

- tryb (a): v4 0,12–0,16 s, v5 0,16–0,21 s;
- tryb (b): v4 0,19–0,32 s, v5 0,20–0,36 s.

**Mutacje v5 na stronach** (P-R3-2, tryb jak wyżej; kawałki utracone (−) albo dodane (+)
względem v5):

| mutacja | skutek |
|---|---|
| `GLYPH_PASSES="hv"` (strip z v4) | wracają słupki: 2-62 +10 (w tym M24 i +L15…), 2-64 +4, 2-65 +6, 2-67 +18, 2-68 +13, 2-69 +3; 2-58/2-59/2-61 +1…3 |
| `GLYPH_PASSES="h hv"` (bez „v”) | 2-65 +1 (`+ZER`), 2-67 +2, 2-68 +1 |
| `CORE_FRAC=None` (bez rdzeni) | − 5…45 kawałków na stronę, m.in. 2-58 M64.12, M40.1, M40.3, 2-62 narożnik C1, piony między skrzyżowaniami z cyfrą |
| bez „skrzyżowania” jako mocnego końca | −2…9 na stronę (piony między drutami z dotykającą cyfrą), 2-62 C1 |
| „dotknięcie” = mocny koniec | 2-65 łączy piny C i Q (pion (1019, 579–601)), 2-68 zmiany w słupku cyfr |
| bez ochrony linii poziomych w „v” | 2-67 −17/+2, 2-68 −15, 2-69 −2 |
| rdzeń prostopadły bez warunku mocnego końca | 2-67 +2 (etykieta `R9-1k`) |
| długość z pół kropką | 2-58 −1 (drut M40.1) |
| rozmiar z pikselami kropek | 2-58 −1, 2-65 −1 (pion między kropkami) |
| `MIN_COVER=None` | szewrony i słupki: 2-61 +1 (78 px), 2-62 +1 (A18/A05, 107 px), 2-67 +10, 2-68 +8 |
| `SPLIT_DESKEW=False` | 2-65 −3 (pion x ≈ 553), 2-66 −2, 2-67 −2 (pion 152 px) |

**Błędy, które zostają:**

1. **Grube krótkie kreski-symbole** na drucie (2-64 (807, 239–282), 2-65 (982, 812–840)).
   v4 łączyła je z drutem pod spodem, v5 z drutem nad nimi. Obie wersje się mylą — to
   symbol, nie drut.
2. **Znaki pionowe (bez pochylenia) dokładnie jeden nad drugim** wyglądają jak drut
   przecinający druty, bo ich kreski przechodzą przez drut w tej samej kolumnie. Na P-R3-2
   szablon jest pochyły, więc to nie występuje. Inne pakiety mogą mieć pismo proste.
3. **Wąskie szewrony** (≤ 16 px szerokości) nadal mogą dać pion. Strome kreski mają tusz
   na > 60 % długości. Synteza: pion znika dopiero od ~20 px szerokości szewronu.
4. **Tryb (b).** Etykiety elementów biernych i wnętrza niewykrytych bramek dalej dają
   śmieci (klasa 2 z „Poza P-R3-2”). Na 49 stronach recenzji to ~40 % kawałków, które
   są tylko w v5. Resztki pionów z tekstu liczą się jako przecinane linie i kotwiczą
   poprzeczki liter (JPP 2-114, SPP 2-133). Na 2-63 słupek etykiet `+RB14/11/13/12`
   (x 2063, y 826–881) został tylko skrócony.
5. **Strony z niepełnymi bramkami w YAML-u** (2-67, 2-68) nadal mają dużo śmieci.
6. **Przebiegi „v” i „hv” osobno nie mają testu, który je wykrywa.** Ich wpływ pokazuje
   tylko tabela mutacji na stronach. Pozostałe mechanizmy mają testy jednostkowe (zob.
   „Poprawka po recenzji”).

### Poprawka po recenzji (tryb b)

Recenzja uruchomiła v5 w trybie (b) na 49 stronach innych pakietów:

- SM-POSE11 2-92…102;
- JPP-16-18 2-111…118;
- SPP-32-16 2-132…139;
- PPS-32 2-148…155;
- I-SK1-1 2-85…91;
- P-A3-2 i P-M3-2 (po trzy strony);
- P-R3-2 2-63.

Przebieg „h” kasował tam prawdziwe odcinki w kształcie L: kropka → pion → narożnik →
krótki odcinek do rezystora. Przykłady: SPP-32-16 2-137 (528, 299–318), SM-POSE11 2-100
(642, 518–547).

Pion ma ≥ `MIN_LEN1`, więc v4 odejmowała go jako pewną linię. W „h” pion nie jest odejmowany
i całe L staje się składową w rozmiarze znaku (bez kropki). Rdzeń nie ratował go z czterech
powodów:

- kropka nie była kotwicą: mała kropka (r ≈ 5) dawała tylko „dotknięcie”, a duża
  „skrzyżowanie” — wynik zależał od promienia;
- ramiona L mogły zakotwiczyć się wzajemnie tylko przez warunek „dobrego” rdzenia, a często
  żadne nie miało mocnego końca;
- rdzeń kreski falującej zostawał 1-px kolumną i ginął później jako okruch (2-100
  (740, 543–595));
- pozioma kreska zaczynała się kolumnę przed jedyną pełną kolumną pionu.

**Zmiany:**

- **Kropka jest mocną kotwicą rdzenia** (maska kropek w `strong`), niezależnie od promienia,
  ale tylko gdy przez jej środek przechodzi linia odjęta w tym przebiegu (druga poprawka,
  niżej).
- **Przyjęcie iteracyjne.** Koniec przy przyjętym albo „dobrym” prostopadłym rdzeniu jest
  mocny, także gdy ten rdzeń przecina bieg do `CORE_REACH` px od końca w głąb biegu
  (narożnik L). Narożnik, w którym tylko jedno ramię ma mocny koniec zewnętrzny, przechodzi
  w całości. Przykład: 2-100 (642, 518), gdzie kropki przy odejściu nie wykryto.
- **Zostaje cała kreska wokół przyjętego biegu** (±1 px tylko w poprzek biegu), a nie sam
  bieg.
- **Koniec na długiej prostopadłej kresce** (≥ `CORE_T_MIN` = 20 px) liczy się jako
  „dotknięcie”. Przykład: pion od kropki do boku nierozpoznanego rezystora, SM-POSE11
  2-101 (685, 320–338).
- **Cienka reszta przy kropce albo chronionym drucie nie jest kasowana** (bok ≤ `THIN_W`).
  Przykład: blady odcinek od kropki na P-A3-2 2-74 (786, 1334–1372).

Próbowałem też, żeby kotwicą rdzenia była tylko długa linia (≥ 40 albo 60 px). Miało to
zmniejszyć śmieci trybu (b), w których słupki z resztek tekstu kotwiczą poprzeczki liter.
Na 49 stronach dodało jednak 70–80 kawałków tylko w v5 i 120–250 tylko w v4, więc tę
zmianę porzuciłem.

**Pomiar.** 49 stron w trybie (b); kawałki tylko w jednej wersji (tolerancja 3 px,
≥ 8 px), narzędzia recenzenta:

| | tylko v4 (sztuk / px) | w tym przy kropce | tylko v5 (sztuk / px) |
|---|---|---|---|
| v5 przed recenzją | 1664 / 38 732 | 161 | 613 / 20 452 |
| v5 po poprawce | 1519 / 35 364 | 109 | 652 / 21 065 |
| v5 po drugiej poprawce | 1521 / 35 428 | 107 | 651 / 21 155 |

- Przypadki recenzenta (10 odcinków na SPP 2-137/2-138, PPS 2-149, SM-POSE11 2-100/2-101):
  przed poprawką pokrycie 0,0–0,3, po poprawce wszystkie 1,0.
- „Tylko v4 przy kropce” — 64 wycinki oglądane w trzech próbkach:
  - prawdziwe straty v5 znalazłem trzy (P-A3-2 2-74, SM-POSE11 2-101 (685, 329),
    SM-POSE11 2-100 (642, 518)) i wszystkie są naprawione;
  - w ostatniej próbce 24 wycinków po poprawce nie ma prawdziwej straty;
  - reszta to tekst, tabliczki, diody i etykiety, które v4 brała za druty.
- „Tylko v5” — próbka 24 wycinków:
  - ~15 to prawdziwe druty, których v4 nie miała (odcinki do pinów z cyfrą, odejścia
    od kropek do rezystorów);
  - ~9 to śmieci (wnętrza niewykrytych układów, słupki etykiet JPP, tabliczki).

  Szacunek: ~40 % z 652 kawałków, czyli ~250, to śmieci.
- P-R3-2 bez zmian, z dwoma wyjątkami:
  - 2-58 +1 fałszywy kawałek (patrz wyżej);
  - 2-68: słupek cyfr przy bramce spoza YAML-a zamienił się z −4 na +2 kawałki śmieci.

  Przypadki opiekuna nadal są poprawne.

**Mutacje kodu po poprawce.** Każda wywala test:

| mutacja | test |
|---|---|
| kropka nie jest kotwicą | strip_pass_dot_anchor_only_on_line[True], …from_dot_into_box_edge |
| kropka kotwicą bez linii przez środek | strip_pass_dot_anchor_only_on_line[False] |
| bez przyjęcia iteracyjnego | strip_pass_h_keeps_l_corner_to_gate |
| bez rdzenia przecinającego koniec (perp_near) | strip_pass_h_keeps_l_corner_to_gate[wobbly] |
| sam bieg zamiast całej kreski | strip_pass_h_keeps_l_corner_to_gate[wobbly], core_keeps_stroke_only_across_its_run |
| kreska ±1 px także za końce biegu (3×3) | core_keeps_stroke_only_across_its_run |
| `CORE_T_MIN=1000` | strip_pass_h_keeps_wire_from_dot_into_box_edge |
| bez ochrony linii poziomych w „v” | strip_pass_v_protects_horizontal_lines |
| dotknięcie = mocny koniec | anchored_touch_crossing_corner_free, pin_number_stack…[22] |
| rdzeń prostopadły bez warunku | core_perpendicular_needs_strong_end, pin_number_stack…[22] |
| długość z pół kropką | strip_pass_h_keeps_wire_from_dot_into_box_edge |

Pliki recenzenta `test_review_repro.py` przechodzą w 50 z 55 przypadków. Pada 5:

- `pullup_stub_into_gate` z r = 4 i kreską 3 px — kropka mniejsza od kreski;
- `pullup_stub_dot_corner_to_gate` z pionem 25 px. Tu pomiar `sw` na syntetycznym obrazie
  bez drutów daje 4,2, a przy `SW=3` test przechodzi.

Wszystkie 5 padają też w v4.

**Druga poprawka (ponowna recenzja, 2-63).**

Problem na 2-63 (tryb a z bramkami wzorca, strona nie była oglądana):

- zamalowane „0” etykiety `+NB0` (1011, 830) detektor brał za kropkę;
- jako mocna kotwica zakotwiczało kreski liter (1011, 823–875) i (996, 840–902);
- kreska ±1 px wokół rdzenia wydłużała bieg za jego koniec, więc drut y ≈ 823 wchodził
  w znak (od x 1011);
- narożnik z pionem x 1028 stawał się T bez kropki i drut się rozłączał.

Zmiany:

- kropka kotwiczy rdzeń tylko wtedy, gdy przez jej środek (±1 px) przechodzi linia odjęta
  w tym przebiegu. Linia drugiej orientacji nie wystarcza, bo w „h” bywa nią słupek liter;
- poszerzenie wokół rdzenia jest tylko w poprzek biegu.

Wynik na 2-63:

- narożnik jest połączony (v4 i v5 przed poprawką: rozłączony);
- drut y ≈ 823 zaczyna się na narożniku x = 1028;
- zostaje jedna kreska (996, 840–902) ze słupka „NB3/NB2”. v4 też ma tu kreskę
  (1002, 822–902). To ta sama klasa co błąd 2 (prawie pionowe znaki jeden nad drugim).

Wzorzec, przypadki opiekuna i strony P-R3-2 są bez zmian.

Na 49 stronach trybu (b) względem pierwszej poprawki ubyło 12 kawałków i przybyło 8.
Ubyłe to wszystkie kreski liter i wydłużenia drutów w znaki (oglądane).

Test integracyjny recenzenta `filled_glyph_below_corner_keeps_corner` przechodzi także
przed poprawką, bo synteza nie odtwarza błędu z 2-63. Mechanizmy sprawdzają testy
jednostkowe `strip_pass_dot_anchor_only_on_line` i
`core_keeps_stroke_only_across_its_run`.

Zostały dwa odcinki L na SPP-32-16 2-136 (492, 278–300) i 2-137 (816, 681–704). Kleks
kropki na dole pionu poszerza składową (maska kropki jest przesunięta). Bieg odcinka do
bramki ma wtedy < 85 % szerokości składowej.

Próba z progiem liczonym od zasięgu składowej w pasie ±2 wiersze wokół biegu odzyskała
oba odcinki. Dodała jednak ~36 kawałków ze słupków etykiet (JPP 2-115, PPS 2-153, 2-63)
i zgubiła ~42, więc tę zmianę porzuciłem.

Overlaye całych arkuszy v4/v5 dostał opiekun: 2-62 i 2-58 w trybie (a), SM-POSE11 2-100
i SPP-32-16 2-137 w trybie (b). Druty są niebieskie, tusz skasowany jako tekst ma czerwony
kontur. Overlaye nie są w repo, bo zawierają skany.

### v6: słupki liter i napisy przy portach (kr-9p8.23)

Opiekun zgłosił po v5 (w kolejności ważności):

1. **Zwarcie na 2-63** — etykiety „+NB0 / +NB3 / +NB2” nad trzema drutami do portów. Kreski
   „B” stoją jedna nad drugą i dają pion (996, 840–902), który przecina wszystkie trzy druty.
2. **Minusy przed etykietami** „-DDTx” przy szewronach portów (SM-POSE11 2-100, C5, A5/B5).
   Druty do portów biegną przez litery i mieszają się z etykietami.
3. **Inne przypadki na 2-100**: linia przez „-DBK” (E4); brak drutu z góry do pinu 3 (E)
   układu T1 (D5); prawy bok ramki H1 przy SE/SO jako pionowy drut (C2).
4. Ile śmieci na 2-100 znika w trybie (a), z bramkami z kroku ①.
5. Resztki z kr-9p8.22: odcinki L na SPP-32-16 2-136/2-137 i grube krótkie kreski-symbole.

**Przyczyny (zmierzone):**

- **2-63.** W grafie v5 pion był **osobnym netem**. Oba końce to T bez kropki, a skrzyżowanie
  w środku nie miało kropki. Pliku YAML nie łączył więc trzech sygnałów (`pairP` = 1,000), ale
  na rysunku i dla każdego późniejszego kroku wyglądał jak zwarcie. Pion przeżywał kasowanie
  znaków: każda kreska „B” kończy się na drucie, a za drutem dalej jest tusz (następne „B”).
  `_anchored` uznawało to za „skrzyżowanie” (mocny koniec), więc rdzeń zostawał.
- **Napisy przy portach (2-100).** Słowa z grubych, stykających się liter („<Y50>”, „-DDT2”)
  są większe od znaku (`TEXT_MAX`) i nie są kasowane. Domknięcie (`GAP2`) robi z wierzchołków,
  środków albo spodów liter linie dłuższe od `MIN_LEN`, a `MIN_COVER` je przepuszcza. Drut
  Y62 zaczynał się w napisie „Y62” (x 535), nie w czubku szewronu (x ≈ 583). Belki „-DDT2”
  (583–632, y 1144) z narożnikiem przez „2” zamieniały narożnik drutu Y68 w T bez kropki.
  Y68 nie miał połączenia z pinem 10.
- **Y71 (2-100, (606, 1212–1237)).** Etykieta „-DDT3” przyklejona z prawej do krótkiego pionu
  przesuwała jego medianę o 7 px (613 zamiast 606). Do tego domknięcie przedłużało pion przez
  4 px przerwy w „D” etykiety pod drutem. Narożnik stawał się T bez kropki.
- **E4 „-DBK”** to ta sama klasa (linia przez napis).
- **D5.** Pion (737, 980–1085) schodzi do narożnika 22 px przed T1. Ostatnie 30 px leży
  w pasie numerów pinów (`PIN_BAND`), a `clear_pin_band` mierzyło bieg tylko wewnątrz pasa
  (30 < `BAND_RUN` 32) i go kasowało.
- **C2.** Prawy bok H1 ma skos ~4 px. U góry wystaje poza maskę (prostokąt + `PAD`), więc
  (750, 105–195) był pionem, do którego dochodziły druty SE i SO jako T.

**Zmiany (v6), każda z parametrem:**

- **Profil osi odcinka** (`AXIS_*`, `axis_profile`, `trim_text_ends`). Dla każdej pozycji
  wzdłuż odcinka sprawdzam trzy rzeczy:
  - tusz w pasie ±`AXIS_BAND` (round(sw/2) + 1) wokół osi; oś to prosta dopasowana do
    cienkich przekrojów (sam drut), szukana ±`AXIS_SEARCH`;
  - „przecięcie”: tusz w wierszu tuż za pasem po obu stronach (3 kolumny, bo kreska bywa
    skośna). Kreska litery przecina oś. Znak stojący na drucie dotyka tylko z jednej strony,
    a cyfra wisząca pod drutem z przerwą 1–2 px nie przecina;
  - „obłożenie”: tusz obok pasa (do `AXIS_SIDE` = 4 px) po którejkolwiek stronie.

  Tusz długich odcinków drugiej orientacji i kropek nie liczy się jako litera.

  Koniec odcinka przycinam do początku pierwszego biegu „drutu” (tusz, bez przecięcia)
  ≥ `AXIS_RUN` = 12 px; przerwy ≤ `AXIS_GAP` = 2 są domykane. Odcinek bez takiego biegu
  odpada. Dodatkowo:
  - krótki bieg (< 2 `AXIS_RUN`) na końcu za **pustą** przerwą > `AXIS_GAP2` = 10 px też
    odpada (ukośna kreska „2” przed szewronem Y62). Przerwa wypełniona tuszem się nie liczy
    (kleks niewykrytej kropki, P-A3-2 2-70 (362, 1204));
  - końca przy bramce (pin) nie przycinam — numery pinów dotykają drutu z obu stron (słupek
    14/13/12 przy M24);
  - końca w narożniku z odcinkiem o biegu ≥ `AXIS_CORNER` = 36 px też nie przycinam.
    Zaokrąglony róg grubej kreski i litera obok dają tam „przecięcie” (SM-POSE11 2-98
    (1964, 877)).
- **Koniec w znaku za narożnikiem** (`OVERHANG_TEXT`, `_cut_glyph_overhang`). Gdy drut
  dłuższy niż `TEXT_MAX` kończy się na odcinku, a odcinek biegnie dalej najwyżej
  `TEXT_MAX + SNAP` px, końcówkę ucinam do punktu styku (narożnik zamiast T). Warunki:
  - końcówka ma obłożenie ≥ `ISO_TEXT_FRAC` albo pustą przerwę na osi > `AXIS_GAP`;
  - w styku nie ma kropki;
  - koniec nie wchodzi w bramkę.

  Skrzyżowania po drodze się nie liczą. Krótka kreska kończąca się na odcinku to znak, nie
  drut. Bez tego warunku pion „0” w „Q07” ucinał na 2-66 drut 32 px przed szewronem.
- **Samotny odcinek z tekstem** (`ISO_TEXT_LEN` = 80, `ISO_TEXT_FRAC` = 0,6). Odcinek
  krótszy niż 80 px, bez żadnego połączenia, z oboma końcami wolnymi (nie przy bramce)
  i z obłożeniem na ≥ 60 % długości odpada w pętli odgałęzień.
- **Mostek przez druty** (`BRIDGE_TEXT`, `_text_bridge`). Samotny krótki odcinek, który
  przecina albo dotyka (T) ≥ 2 prostopadłe druty i wystaje za skrajne z nich najwyżej
  `TEXT_MAX`, odpada. Drut, który przecina dwa druty bez połączenia i nigdzie dalej nie
  prowadzi, nie ma sensu. To bezpośrednia reguła na przypadek 1.
- **Bok ramki bramki** (`BOX_EDGE` = `PAD` + `BOX_T`, `BOX_EDGE_FRAC` = 0,8). Odcinek
  równoległy do boku maski, najwyżej `BOX_EDGE` px od niego, leżący przy nim na ≥ 80 %
  długości, odpada. Drut w pasie pinów leży ≥ 12 px od boku.
- **Pas pinów liczy bieg także poza pasem** (`BAND_EXT`). Pion, który wchodzi do pasu
  z zewnątrz, nie jest cyfrą.
- **Krótki odcinek bierze współrzędną poprzeczną z najgęstszego pasa 3 wierszy**, nie
  z mediany (`SEG_MODE` = 60 px, `SEG_MODE_MIN` = 2 px). Dotyczy to tylko odcinków ≤ 60 px.
  Na długich mediana zostaje, bo skos skanu: wersja „zawsze” obniżała 2-59 wireP .789 → .780
  i 2-61 juncP .923 → .846.

**Wzorzec, tryb (a) z bramkami wzorca** (wireP / wireR / wireF1 / wF1geom / juncP / juncR):

| strona | v5 | v6 |
|---|---|---|
| 2-58 | .927/.948/.937/.938/1.000/.864 | bez zmian |
| 2-59 | .789/.785/.787/.792/.800/.800 | bez zmian |
| 2-60 | .916/.926/.921/.968/1.000/1.000 | bez zmian |
| 2-61 | .815/.837/.826/.834/.923/.923 | .815/.836/.826/.834/.923/.923 |

- `pairP` = 1,000 i `pF1cond` bez zmian (1.000 / 1.000 / .816 / .977).
- 2-61: drut kończy się teraz w czubku szewronu portu (1635, 813), nie 9 px w nim.
- Piny z netem: bez zmian na 2-58 76/76, 2-62 48/48, 2-60 47/48, 2-61 50/51, 2-66 81/86,
  2-63 101/119.
- Piny z netem, zmiany: 2-64 89 → 91/106, 2-65 77 → 79/88 (narożniki obok bramki,
  `BAND_EXT`), 2-67 2 → 1/60. Na 2-67 piny z YAML-a leżą obok bramki, a „net” pinu 15 v5
  był linią przez cyfry „15”.

Gotowych netów ludzkich do porównania nie ma (strony 2-62…2-68 w `data/` mają bramki, nety
prawie puste), więc `pairP` liczę tylko na wzorcu.

**Przypadki opiekuna** (skrypt kontrolny: net w punktach, tryb (b) dla 2-100, (a) dla 2-63):

| przypadek | v5 | v6 |
|---|---|---|
| 2-63 pion „B” (996, 840–902) przez +NB0/+NB3/+NB2 | jest | brak; trzy druty osobno |
| 2-63 (tryb b) piony „+RB14/11/13/12” (2057/2064, 825–881) | dwa | jeden: (2057, 852–881) wisi na fałszywej kropce (2059, 852) w „B” i przecina drut 877 bez połączenia |
| 2-100 Y62: drut od czubka szewronu | od x 535 (przez „Y62”) | od x 586 |
| 2-100 Y65, „<Y50>”, „-DDT8”: linie przez napisy | są | brak |
| 2-100 „-DDT2”: belki liter (583–632, y 1144) | są | brak |
| 2-100 Y68 → pin 10 | rozłączony (T bez kropki) | połączony narożnikiem (632, 1157) |
| 2-100 Y71 → pin 11 | rozłączony (pion x 613) | połączony (606, 1212–1237) |
| 2-100 E4 linia przez „-DBK” | jest | brak |
| 2-100 D5 pin 3 T1 z góry | brak 30 px pionu i odcinka | narożnik (737, 1086) → pin |
| 2-100 C2 bok H1 (750, 105–195) | drut, T z SE/SO | brak; SE i SO osobno |

**Licznik „mostków bez kropek”** (skrypt pomocniczy poza repo). Ciąg współliniowych
kawałków jednego netu ≤ 100 px, który dotyka (skrzyżowanie albo T, 4 px) odcinków ≥ 2 innych
netów, bez kropki (8 px) przy żadnym styku:

| zbiór | v5 | v6 |
|---|---|---|
| 49 stron trybu (b) | 458 | 91 |
| P-R3-2 2-62, 2-64…2-68 (a), 2-69 (b) | 9 | 3 |
| P-X3-2 2-1…2-10 (b) | 22 | 5 |
| wzorzec 2-58…2-61 (a) | 2 | 2 |
| 2-63 (a) | 3 | 0 |

Dwa na wzorcu (2-60 (633–733, 926), 2-61 (690–790, 860)) to prawdziwe druty 100 px, które
przecinają dwa inne bez połączenia. To fałszywe trafienia licznika.

**Tryb (b), 49 stron recenzji** (kawałki tylko w jednej wersji, tolerancja 3 px, ≥ 8 px):

- v5: 4228 netów / 9840 kawałków; v6: 3505 / 9005;
- tylko v5: 1713 kawałków / 63 840 px, w tym 101 przy kropce;
- tylko v6: 155 / 4088 px.

Obejrzane próbki (montaże v5 | v6):

- **tylko v5**: 4 próbki po 24–30 wycinków, z czego 2 losowe i 2 przy kropce, w kolejnych
  wersjach roboczych. To słupki liter, linie w napisach i tabliczkach, płytki kondensatorów,
  linie przerywane konturów, wnętrza symboli (diody, tranzystory) i reszty ramek.
  Prawdziwe straty znalazłem cztery:
  - P-A3-2 2-70: pion między kropką a kleksem — naprawione (pusta przerwa);
  - 2-66: drut przed szewronem przy „Q07” — naprawione (krótka kreska nie jest stykiem);
  - SM-POSE11 2-98 (1964, 877): narożnik — naprawione (`AXIS_CORNER`). Okazało się, że to
    ramka niewykrytego układu, która teraz odpada jako zamknięta;
  - I-SK1-1 2-86 (888, 416–432): 16 px bladego końca drutu z przerwami — **zostaje**.

  W ostatniej próbce (30 + 24 wycinków, wersja końcowa) prawdziwej straty nie ma.
- **tylko v6**, próbka 24: ~22 to prawdziwe narożniki L tuż przed bramką (`BAND_EXT`),
  ~2 to śmieci w napisach.

**Strony strojenia P-R3-2** (tryb a, v5 → v6, kawałki tylko w jednej wersji):

- 2-62: bez zmian;
- 2-64: −3 / +2 — znika linia przez „+UST”, dochodzą odcinek do pinu 12 i odcinek do kółka
  negacji;
- 2-65: −2 / +1 — znikają dwa piony przez cyfry „13” i „1”. Pierwszy z nich (809, 970–996)
  w v5 zabierał wolne końce drutów pinów 1 i 13 M15.B, więc oba piny nie miały netu. W v6
  oba mają ten sam net przez pion x 766, który jest w obu wersjach. Dochodzi pion obok bramki;
- 2-66: −1 (koniec drutu 10 px w szewronie);
- 2-67/2-68/2-69: −28/−29/−9, same śmieci (linie w tekście, tabela, kondensatory, linia
  przerywana).

P-X3-2: −84 / +11 kawałków.

**Tryb (a) na 2-100** (bramki z kroku ①, 76 ramek, `auto.py --step gates`, potem `wires`,
`--draft`, kopia danych w scratchpadzie):

| | v5 | v6 |
|---|---|---|
| tryb (a): nety / odcinki | 161 / 340 | 117 / 374 |
| tryb (b): nety / odcinki | 158 / 420 | 118 / 382 |

Tryb (a) z bramkami z kroku ① **prawie nie zmienia** obrazu względem trybu (b). Tryb (b) też
bierze ramki z `cv-gates.py`, a śmieci na 2-100 to tekst (etykiety portów, wartości
rezystorów), nie bramki. Overlaye obu trybów są praktycznie identyczne.

Czas rdzenia na stronę: v5 do 0,84 s, v6 do 0,60 s (tryb b, 49 stron). Mniej odcinków
w grafie.

**Mutacje** — każdy nowy mechanizm wywala co najmniej jeden test (zob. „Testy i mutacje”).

**Poprawka po recenzji v6.** Recenzja znalazła trzy błędy v6 na 49 stronach trybu (b):

- **F1 (blokujący).** Profil osi przycinał trzon prawdziwego T 8–20 px przed kropką: kleks
  kropki większy niż maska czytał się jak kreska litery przez oś, więc złącze się
  rozłączało. Przykłady: P-A3-2 2-70 (677, 1387), PPS-32 2-151 (591, 1480), 2-153
  (455, 968), SPP-32-16 2-132 (1559, 552), 2-133 (946, 1107), I-SK1-1 2-86 (916, 299)
  i w trybie (a) P-R3-2 2-65 (505, 546), gdzie pin M35.B.4 tracił drut.

  Poprawka: koniec ≤ `AXIS_DOT` = 3 px od maski kropek nie jest przycinany, o ile
  przycięcie byłoby ≤ `AXIS_DOT_MAX` = 17 px. Działa to tylko przy przycinaniu, nie przy
  końcówce za narożnikiem: tam fałszywa kropka w „D” na 2-100 (601, 1258) cofała naprawę
  Y71.

  Granicę `AXIS_DOT_MAX` dodała druga recenzja. Bez niej fałszywe „kropki” w literach
  etykiet przedłużały druty portów przez napis do sąsiedniego pionu — trzy zwarcia:
  - JPP-16-18 2-116, druty „21” (y 507) i „2” (y 532) przez „A9”/„A10” do pionu x 1131;
  - P-A3-2 2-70 (1794, 885–912): trzon „9” zwierał druty „10” i „9”;
  - SM-POSE11 2-96 (650, 405): drut „5” przez „B1” do krawędzi tabeli.

  Do tego ~35 kawałków śmieci, np. kolumna „-NB0…-NB3” na PPS-32 2-152.

  Kontrola na 13 kropkach z recenzji:
  - 7 prawdziwych złączy ma znowu 3 ramiona w jednym necie, jak w v5;
  - JPP-16-18 2-116 (2214, 1137) zostaje rozłączone (błąd niżej);
  - 3 to fałszywe kropki w literach (zwarcia wyżej) — teraz rozłączone;
  - 2 to tabliczka: „W” w „Wchodzi” na PPS-32 2-154 i pismo odręczne na PPS-32 2-150.
    v5 brała je za kropki, v6 nie rysuje tam drutów.
- **F2.** Przez `SEG_MODE` prawe kreski cyfr etykiet jedna nad drugą dawały krótki pion
  z narożnikami na dwóch sąsiednich drutach portów — fałszywe zwarcie. Przykłady: PPS-32
  2-150 (263, 983–1010) „-DT14”/„-DT15”, 2-154 (380, 527–552) „+S1”/„+S0”. Pion ma
  połączenia, więc `BRIDGE_TEXT` i `ISO_TEXT_*` go nie łapały.

  Poprawka `BRACKET_TEXT` (`_text_bracket`). Odpada odcinek, który spełnia wszystkie
  warunki:
  - ma ≤ `TEXT_MAX + SNAP`;
  - oba jego końce są narożnikami bez kropki, każdy z dokładnie jednym drutem;
  - oba druty biegną w tę samą stronę („⊐”);
  - jego najdłuższy czysty bieg drutu na osi (tusz bez przecięcia) jest krótszy niż
    `BRACKET_RUN` = 12 px.

  Schodek (druty w przeciwne strony) zostaje. Oba zwarcia znikły.

  Warunek biegu dodała druga recenzja. Bez niego reguła usuwała 9 prawdziwych pętli do pinów
  i wyprowadzeń kondensatorów: P-A3-2 2-78 (1121, 391–417), (1118, 708–734), SPP-32-16 2-133
  (1413, 490–514), SM-POSE11 2-92 (1478, 467–495) i pięć na 2-93. Klamry z kresek znaków mają
  czysty bieg 1 i 4 px, prawdziwe pętle 24–29 px, czyli całą długość. Wszystkie 9 pętli jest
  znowu połączonych.
- **F3.** `OVERHANG_TEXT` ucinał prawdziwe końce drutów portów o 11–32 px. Pion-śmieć
  wchodzący w etykietę „kończył się” na drucie, drut był przycinany do niego, a sam pion
  potem i tak znikał. Przykłady: SM-POSE11 2-101 (201–234, 1316), P-M3-2 2-20 (1973, 225),
  2-100 Y67 (571, 1313).

  Poprawka: końcówkę za narożnikiem liczę dopiero względem odcinków po przycięciu profilem
  osi i tylko przy drutach z biegiem ≥ `AXIS_CORNER`. Efekty:
  - wszystkie 13 końców z recenzji znowu są pokryte;
  - liczba cięć na 49 stronach spadła ze 147 do 47;
  - wszystkie 47 obejrzałem na montażu: cięcia kresek w napisach, wnętrza tranzystorów,
    ramki tabliczek, belka symbolu na P-M3-2 2-20 i zamierzone Y71. Szkodliwego cięcia nie
    znalazłem.

Liczby po obu recenzjach:

- wzorzec, piny z netem i przypadki opiekuna (14/14): bez zmian względem tabel wyżej;
- 13 końców z F3: wszystkie pokryte; cięć `OVERHANG_TEXT` na 49 stronach jest 46;
- mostki bez kropek: 49 stron 458 → 90; P-R3-2 9 → 3; P-X3-2 22 → 5; 2-63 (a) 3 → 0;
- 49 stron trybu (b):
  - v5 4228 netów / 9840 kawałków, v6 3500 / 9008;
  - tylko v5: 1691 kawałków, w tym 98 przy kropce; tylko v6: 153;
- czas: mediana 0,51 s, najwolniej 0,93 s na stronę.

Testy: +8. Sprawdzają:
- trzon T przy kropce, także z granicą `AXIS_DOT_MAX` dla napisu przy fałszywej kropce;
- krótki pion-śmieć a narożnik;
- klamrę z kresek, czystą pętlę i schodek;
- strażnik samotnego odcinka.

**Błędy, które zostają (v6):**

0. **Po recenzjach.** JPP-16-18 2-116 (2214, 1137): złącze z kropką rozłączone, bo
   przycięcie trzonu przekracza `AXIS_DOT_MAX`. Zostają też trzy drobne sklejenia śmieci:
   I-SK1-1 2-90 (1406, 690), JPP-16-18 2-113 (1006, 666) i PPS-32 2-153 (1523, 1278).

1. **Górna krawędź słowa.** Belki stykających się liter („TTTT”, „DDTT”) dają samotną linię
   55 px z długim biegiem na osi i obłożeniem ~30 %. Ani profil osi, ani `ISO_TEXT_*` jej
   nie usuwają. Test `isolated_short_stroke_flanked_by_text` sprawdza tylko kreskę obłożoną
   gęsto.
2. **Blady drut z przerwami.** Na końcu takiego drutu biegi bywają < 12 px i koniec jest
   przycinany: I-SK1-1 2-86 (888, 416–432) traci 16 px, bez zmiany połączeń.
3. **Fałszywe kropki w literach** chronią teraz koniec przed przycięciem (`AXIS_DOT`).
   Przykłady:
   - 2-63 (b): pion (2057, 852–881) z „B” zostaje;
   - 2-100 A5: pion x ≈ 222 znowu łączy się przez „kropkę” (226, 1107) — róg „D” w „-DDT9” —
     z drutem Y50, jak w v5.
4. **Resztki z kr-9p8.22** (odcinki L na SPP-32-16 2-136/2-137, grube kreski-symbole na
   2-64/2-65) — nie ruszane.
5. **Lewa kolumna 2-100 (A5/B5).** Wiązka wejść S1 z „-DDT9 … -DDT11” zostaje niepewna.
   Pion x ≈ 222 v5 łączyła kropką (226, 1107) z drutem Y50. Ta „kropka” to róg litery „D”,
   więc v6 ucina pion do 1115 i rozłącza. Moim zdaniem to poprawne (inaczej DDT9 = DDT11),
   ale nie jest potwierdzone.
6. **Tryb (b) poza P-R3-2.** Wnętrza niewykrytych układów i tabliczki dalej dają śmieci,
   choć mniej (49 stron: −15 % netów).
7. **Ramki w trybie (b)** (recenzja, F4) dalej scalają druty: PPS-32 2-154 (971, 291),
   SPP-32-16 2-136 (1188, 220–273), PPS-32 2-150 (972/998, 300–636), I-SK1-1 2-87 (1529, 671).
8. **Zgubione krótkie odcinki z jednym końcem** (recenzja, F5): SPP-32-16 2-132
   (491, 690–714), JPP-16-18 2-113 (1724, 965–984), P-R3-2 2-67 (651, 1335).
9. **Zgłoszenia opiekuna do 2-100 po v6** (zrzuty w scratchpadzie sesji, nie naprawiane):
   - brak kropek tam, gdzie szyny DT12–DT15 spotykają druty wejść J1;
   - fałszywy pion między R7 a R11 przy N1;
   - brak krótkich odcinków od lewych końców rezystorów do lewej szyny;
   - śmieciowy poziom na „-DDT6”;
   - brak drutu Y72 pod „-DDT4”;
   - plątanina w kolumnie Y47…Y59 → S1;
   - pionowy rezystor R4-1k (przy M19, do +5V) nie jest wykryty jako bramka, więc drut
     przechodzi przez jego korpus.

Overlaye dla opiekuna (całe arkusze v5/v6 i powiększenia v5 | v6) są w scratchpadzie sesji,
nie w repo (skany).

### Testy i mutacje

138 testów na syntetycznych obrazach (v5: +47, v6: +33, w tym parametryzowane). Znaki są rysowane
w teście własnym pochyłym szablonem. Testy jednostkowe sprawdzają `_anchored`, `_core`
i `_strip_pass` na małych tablicach. Druty mają 2–3 px dokładnej szerokości, ramki 5 px,
kropki promień 4 + szerokość. Testy obejmują:

- przegląd grubości kreski 2–6 px;
- tryb (b): grube druty, dwie belki bez boków, za szeroki i za wysoki prostokąt, bok
  z przerwą, stos z cienką górą;
- kropki: kółko negacji na skrzyżowaniu, bladą kropkę, szum w kleksie;
- równoległy drut 10–22 px pod T z kropką (oba ustawienia `T_NEEDS_DOT`);
- słupek „1” przy bramce i przebudowę grafu przy `SPUR_ITERS=1`;
- v5: słupki numerów pinów dotykające drutów, etykiety `+L1x` na kolejnych drutach,
  krótki odcinek z cyfrą do pinu, narożnik wokół cyfry, drut przez kropkę między
  cyframi, narożnik pod kropką, prosta cyfra między drutami pinów, pion między bliskimi
  kropkami, szewrony portów, długi pion ze skosem i kropką;
- v6: słupek „+NB” na trzech drutach (i kontrola, że bez mechanizmów v6 synteza daje pion),
  etykiety portów „<Y52>” przy drucie od szewronu, samotna kreska obłożona tekstem, krótki
  drut z etykietą od narożnika; jednostkowo `axis_profile` (przecięcie a dotknięcie),
  `trim_text_ends` (pusta przerwa a kleks, koniec przy bramce, narożnik, skrzyżowanie bez
  kropki, końcówka w literze za narożnikiem), `_cut_glyph_overhang`, `_text_bridge`,
  `drop_box_edges`, `clear_pin_band` (`BAND_EXT`), `_cross_center`.

Testy v5 `gate_frame_beyond_yaml_rect` i `stacked_port_chevrons` uruchamiają się teraz
z wyłączonym odpowiednio `BOX_EDGE_FRAC` i `AXIS_RUN`. Oba mechanizmy v6 też usuwają te
śmieci, więc bez tego mutacje `BOX_SEARCH=0` i `MIN_COVER=None` nie wywalały żadnego testu.
`stacked_port_chevrons` sprawdza dodatkowo wynik z domyślnymi parametrami.

Testy v6 z ramką portu dla minusa „-DDT” na syntezie przechodzą także w v5 (synteza nie
odtwarza błędu), więc ich nie dodałem. Minus i belki liter sprawdzałem tylko na 2-100.

Mutacje parametrów: `CVW_MUTATE="NAZWA=wartość"`. Każda wywala co najmniej jeden test:

| mutacja | test, który pada |
|---|---|
| `MAX_THICK=1e9` | dense_text_glued_between_wires |
| `BRIDGE_MAX=0` | faint_dashed_section |
| `PIN_BAND=0`, `PIN_BAND=20`, `BAND_RUN=0` | stacked_pin_number_ones (i pin_number_digits) |
| `SPUR_LEN=0` | text_stroke_at_wire_end, spur_removal_rebuilds_graph |
| `BOX_SEARCH=0` | gate_frame_beyond_yaml_rect |
| `MIN_ISOLATED=0` | isolated_short_dash |
| `THR=None` | pale_wire |
| `T_NEEDS_DOT=False` | t_joint_without_dot, dense_text |
| `DOT_DT=0` | blot_at_crossing, speckle_hole |
| `PAR_OFF=0` | parallel_stub_next_to_dot |
| `DOT_HOLE=0` | hollow_dot, pale_hollow_dot |
| `DOT_HOLE_GRAY=255` | negation_bubble_on_crossing |
| `DOT_FILL_EXTRA=0` | speckle_hole_in_crossing_blot |
| `GLYPH_PASSES="hv"` (v5) | pin_number_stack_touching_wires[21/22/24], label_stack_on_wires |
| `CORE_FRAC=None`, `CORE_REACH=0` (v5) | short_stub_with_digit, short_corner_wire_around_digit, wire_through_dot_to_pin |
| `MIN_COVER=None` (v5) | stacked_port_chevrons |
| `SPLIT_DESKEW=False` (v5) | skewed_long_wire_with_dot |
| `AXIS_RUN=None` (v6) | wire_does_not_run_through_port_label, trim_text_ends_* |
| `AXIS_GAP2=1000`, `AXIS_GAP2=-1` (v6) | trim_text_ends_drops_letter_run_behind_empty_gap_only |
| `AXIS_SIDE=0` (v6) | axis_profile_letter_crossing_vs_label_touching, isolated_short_stroke…[off1] |
| `ISO_TEXT_FRAC=None` (v6) | isolated_short_stroke_flanked_by_text_is_not_a_wire[off1] |
| `BRIDGE_TEXT=False` (v6) | stacked_letters_across_wires_are_not_a_wire |
| `OVERHANG_TEXT=False` (v6) | trim_text_ends_cuts_overhang_into_letter_below_corner |
| `BOX_EDGE_FRAC=None` (v6) | drop_box_edges |
| `BAND_EXT=False` (v6) | pin_band_keeps_wire_entering_band_from_outside |
| `SEG_MODE=None`, `SEG_MODE_MIN=100` (v6) | cross_center_short_segment_ignores_glued_label, connected_short_wire_under_label |
| `AXIS_DOT=None` (v6) | trim_text_ends_keeps_t_stem_at_dot[52-default-True] |
| `AXIS_DOT_MAX=1000` (v6) | trim_text_ends_keeps_t_stem_at_dot[44-default-False] |
| `BRACKET_TEXT=False`, `BRACKET_RUN=0` (v6) | short_bracket_between_parallel_wires[strokes] |
| `BRACKET_RUN=1000` (v6) | short_bracket_between_parallel_wires[clean] |
| `AXIS_CORNER=None` (v6) | trim_text_ends_keeps_corner_end, overhang_ignores_short_junk_perpendicular |

Po v5 i po v6 wszystkie wcześniejsze mutacje z tej tabeli nadal wywalają co najmniej jeden
test (sprawdzone). `GLYPH_PASSES="h hv"` i `"h v"` nie wywalają żadnego — ich wpływ widać tylko
na stronach (tabela w „v5: tekst przy drutach”).

Mutacje kodu: `CVW_SCRIPT=<zmieniona kopia>`. Też każda wywala test:

| mutacja kodu | test, który pada |
|---|---|
| ~~bez sprawdzenia boków czworoboku~~ (kod usunięty w kr-9p8.3) | ~~two_bars_without_sides~~ |
| ~~bez `_extend_stack`~~ (kod usunięty w kr-9p8.3) | ~~stack_with_thin_top_frame~~ |
| bez przebudowy grafu po pętli odgałęzień | spur_removal_rebuilds_graph[1] |
| stare zamalowanie (`DOT_D`², bez szarości) | negation_bubble_on_crossing, speckle_hole |
| bez `trim_to_dots` | dot_does_not_bridge_to_parallel_wire[10/12/14] |
| bez wyłączenia kropek z domknięcia | dot_does_not_bridge…[10–22] |
| ~~`BOX_WMAX`/`BOX_HMAX` = ∞~~ (parametry usunięte w kr-9p8.3) | ~~oversized_box~~ |
| ~~`BOX_SIDE_GAP` = ∞~~ (parametr usunięty w kr-9p8.3) | ~~two_bars…, stack…~~ |
| stary `_odd` | derive_dot_d_nearest_odd |
| v5: rozmiar składowej z pikselami kropek | **żaden** po drugiej poprawce (pion między kropkami ratuje teraz rdzeń z kropką jako kotwicą) |
| v5: bez skrzyżowania jako mocnego końca rdzenia | anchored_touch_crossing_corner_free |
| v5: bez ochrony linii poziomych w „v” | strip_pass_v_protects_horizontal_lines |
| v5: dotknięcie = mocny koniec | anchored_touch_crossing_corner_free, pin_number_stack…[22] |
| v5: rdzeń prostopadły bez warunku | core_perpendicular_needs_strong_end |
| v5: kropka nie jest kotwicą, bez przyjęcia iteracyjnego, bez perp_near, sam bieg | zob. „Poprawka po recenzji (tryb b)” |
| v5: długość z pół kropką | strip_pass_h_keeps_wire_from_dot_into_box_edge |
| v6: przecięcie = tusz po jednej ALBO drugiej stronie | axis_profile_letter_crossing_vs_label_touching, text_between_parallel_wires…, skewed_long_wire_with_dot, connected_short_wire_under_label |
| v6: bez wyłączenia tuszu drutów drugiej orientacji | trim_text_ends_ignores_crossing_wire_ink |
| v6: oś = mediana, bez dopasowania | skewed_long_wire_with_dot |
| v6: przycinanie także końca przy bramce | pin_number_stack_touching_wires[21/22/24], trim_text_ends_keeps_gate_end |
| v6: mostek bez warunku wystawania | text_bridge_needs_two_contacts_and_short_overhang |
| v6: końcówka za narożnikiem mimo kropki w styku | cut_glyph_overhang[True-True-False] |
| v6: styk także na skrzyżowaniu | cut_glyph_overhang_skips_crossings |
| v6: bok ramki bez warunku pokrycia boku | pullup_stub_from_dot_into_gate (18 przypadków) |
| v6: samotny odcinek także z połączeniem w środku | short_flanked_wire_with_dot_joint_is_not_isolated |
| v6: końcówka za narożnikiem względem odcinków przed przycięciem | overhang_ignores_short_junk_perpendicular |
| v6: końcówka za narożnikiem przy drucie bez długiego biegu | overhang_ignores_short_junk_perpendicular |
| v6: klamra także dla drutów w przeciwne strony (schodek) | short_bracket_between_parallel_wires[step] |

Kryterium „grubości pierścienia” wokół dziury (propozycja z recenzji) odrzuciłem: przy
polu ≤ sw² każda zamalowana dziura i tak ma pierścień grubszy niż swój promień, a mutacja
tego warunku nie zmieniała żadnego testu. O zamalowaniu decydują rozmiar i szarość dziury.

Wpływ mutacji na stronach strojenia (wireF1 2-58 / 2-59, tryb a; zmierzone na v3, bez
mutacji 0,935 / 0,786 — tyle samo co v4):

| mutacja | 2-58 | 2-59 |
|---|---|---|
| `PIN_BAND=0` | 0,868 | 0,765 |
| `BRIDGE_MAX=0` | 0,904 | 0,786 |
| `DOT_DT=0` | 0,935 | 0,714 |
| `SPUR_LEN=0` | 0,931 | 0,786 |
| `MIN_ISOLATED=0` | 0,934 | 0,786 |
| `BOX_SEARCH=0` | 0,934 | 0,786 |
| `T_NEEDS_DOT=False` | 0,933 | 0,646 |

### Plan B (model uczony)

Model nie naprawi błędów 1–3 z P-R3-2, bo to sprawa reprezentacji i wzorca. Na tekst,
kropki, ramki stron i złożone układy wystarczy mała segmentacja semantyczna:

- model: U-Net albo SegFormer-B0, klasy tło / drut / kropka / ramka bramki / ramka
  strony, tekst jako „ignoruj”, kafelki 256–512 px;
- etykiety z rasteryzacji zatwierdzonych stron spoza wzorca (20–50 arkuszy, z różnych
  pakietów — JPP i SM-POSE11 wyglądają inaczej niż P-R3-2), z augmentacją grubości kreski,
  skosu, bladości i kompresji JPEG;
- trening na MPS/MLX.

Wynik modelu przechodziłby dalej przez tę samą wektoryzację i regułę połączeń
z `cv-wires.py`.

### Uruchomienie

```bash
uv run scripts/cv-wires.py --scan data/MJC-400/P-R3-2/scans/2-58.jpg \
    [--gates data/gold/P-R3-2/2-58.sch.yaml] --out <kat>/P-R3-2/2-58.sch.yaml \
    --overlay 2-58.png [--gold data/gold/P-R3-2/2-58.sch.yaml --diff 2-58-diff.png] [--fit]
uv run scripts/eval-digitize.py --gold data/gold --candidate <kat>
PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy \
    --with opencv-python-headless pytest -p no:cacheprovider scripts/test_cv_wires.py
CVW_MUTATE="PIN_BAND=0" PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml \
    --with numpy --with opencv-python-headless pytest -p no:cacheprovider scripts/test_cv_wires.py
```

## Wyniki: bramki (kr-9p8.3)

Spike: czy prostokąty bramek (pojedyncze, stosy, złożone układy z kolumnami, elementy bierne)
da się wykryć klasycznym CV z geometrii ramek, czy potrzebny jest detektor uczony (YOLO).
Hipoteza: recall bramek ≥ 97 % na stronach wzorca i działanie na innych pakietach. Skrypt
`scripts/cv-gates.py`, testy `scripts/test_cv_gates.py`. Tryb (b) `cv-wires.py` woła teraz
ten detektor zamiast własnego szukania grubych czworoboków.

**Werdykt (na ślepych liczbach).** Hipoteza **nie jest spełniona w całości.**

- Wzorzec P-R3-2: ślepy v1 na held-out 2-60/2-61 ma recall 1,00. Na 2-63 ma recall 0,83
  i precyzję 0,56.
- Strony bez wzorca, ślepe dla wersji końcowej (7 stron w 5 pakietach):
  - recall 65/89 = 0,73 przy precyzji 1,00;
  - bez SPP-32-16 recall 59/65 = 0,91.
  Szczegóły w tabeli niżej.
- Fałszywych ramek nie ma: precyzja ślepa = 1,00. Ten sposób jest więc bezpieczny jako
  pierwszy etap, ale na części pakietów nie wystarcza.
- Wszystkie braki mają jedną z dwóch przyczyn:
  - blada albo przerwana ramka (SPP-32-16: falujące ramki 1 px, PPS-32: przerwana górna
    krawędź nad wąską kolumną);
  - pin albo kółko w samym narożniku (P-D3-2).
- YOLO nie jest potrzebne do lokalizacji tam, gdzie ramki są wyraźne. Na pakietach typu SPP
  detektor uczony (albo wspólna maska tabliczki z `SIDE_WOBBLE`) jest realnym kandydatem;
  szacunek niżej.

Kontrola wzrokowa opiekuna (overlaye wersji końcowej):

- SM-POSE11 2-97: 22/22 bramki, 0 fałszywych ramek, stosy podzielone poprawnie;
- P-X3-2 2-1: 21/21 bramek i 1 rezystor, M3 znaleziona, 0 fałszywych.

### Metoda

Szczegóły są w docstringu. Najważniejsze decyzje:

- **Grubość ramki nie jest kryterium.** Na SM-POSE11 ramka ma ~1,6 px, tyle co drut;
  stary tryb (b) przez to gubił układy. Liczy się topologia:
  - prostokąt z czterech długich linii (tekst znika z map linii, bo znak jest krótszy
    od `LINE_L` = 25 px);
  - co najmniej 3 z 4 narożników „czyste”: linia ramki nie biegnie za narożnik. Sonda
    leży na samej linii ściany. Prostokąty z drutów i kratka tabliczki mają w narożnikach
    T i skrzyżowania;
  - piny (druty prostopadłe do boków) z co najmniej dwóch stron. Ramka numeru arkusza i
    opisy pinów nie mają.
- **Najpierw kandydat z pary odcinków**, potem sprawdzenie pozostałych boków. Najpierw
  próbowałem komórek tła (białe obszary zamknięte liniami), scalanych w prostokątne bloki.
  Odrzuciłem to: kółka negacji i podpisy przy ścianach rozbijały komórki, a kolejność
  scalania dawała różne bloki (2-59 M56/M57).
- **Kółka negacji wypełnione** przed mapami linii. Kółko w narożniku (2-58 M54, wyjście 10)
  albo na boku (2-59 M56: ER/EN) przerywa ramkę.
- **Skos skanu.** Końce pary odcinków mogą się różnić o `END_TOL` + 1,2 % odległości
  (2-63 M31…M42: 9 px na 960 px). Pas boku idzie liniowo od końca do końca.
- **Podział stosu.** Cięcie następuje, gdy linie pokrywają ≥ 60 % szerokości wnętrza.
  Stos 7404 ma tu 100 %, stos 74170 M56/M57 ~80 % (prawa kolumna jest ciągła).
  Przegródki kolumny etykiet albo A/B/C/D 74175 mają 20–50 %. Kawałek bez pinu albo za
  niski traci słabsze cięcie: podpis „M65” przyklejony do ściany daje 0,6 tuż nad
  przegródką 1,0.
- **Złożony układ = jedna bramka**, zgodnie ze wzorcem. 74170 M47/M48/M56/M57 i 74175
  M30/M31/M42 to we wzorcu po jednej bramce A z 14 pinami.
- **Klasy:**
  - `composite`: ≥ 2 wewnętrzne pionowe ściany albo wysokość ≥ 200 px, więc wysoka 7430
    (SM-POSE11 H4/J4) też dostaje tę klasę;
  - `passive`: mały płaski prostokąt z jednym wyprowadzeniem na każdym krótkim boku
    (rezystory); kondensatorów nie wykrywam;
  - `gate`: pozostałe.
- **Piny** mają osobne mapy linii: z poszerzeniem w poprzek o 3 px i domknięciem 3 px,
  bo na I-SK1-1 2-87 drut ma 1 px z przerwami (szarość 168–206). Tych map **nie** używam
  do ramek: na P-M3-2 sklejały pionowe kreski tekstu w fałszywe ściany, a na 2-58/2-59
  podpisy w fałszywe cięcia.
- **Wynik:**
  - `gates: [{ref: "?", gate: null, x, y, w, h, rotation: 0, pins: [], verified: false,
    cv_class, cv_pins}]`;
  - `cv_pins` (side/px/py) to kandydaci pinów. Są poza `pins`, bo nie mają numerów, a
    eval liczyłby je jako błędne;
  - elementy bierne też trafiają do `gates` (`gate: null`, jak w modelu danych).
- **Czas:** 0,08–0,24 s na stronę.

### Wersje i ślepy wynik

- **v1** (sha256 `6c0d4ccb…`) zamrożona po strojeniu na 2-58/2-59 i oglądzie P-X3-2 2-1,
  przed pierwszym uruchomieniem na 2-60/2-61/2-63 i na stronach spoza P-R3-2. To jedyny
  ślepy wynik. JPP 2-115 i SM-POSE11 2-97 znałem wcześniej z miniatur skanów (opis zadania),
  ale nie z wyników detektora.
- **końcowa** (sha256 `d2a60bde…`) powstała po obejrzeniu wyników v1 na 2-63 i 4 stronach
  bez wzorca. Zmiany:
  - sonda narożnika na linii ściany zamiast ±1 px od osi z końca odcinka (2-63: prostokąty
    z drutów oparte o ścianę M30);
  - `SIDE_GAP` 6 → 16 (2-63 M18: 14 px bladej przerwy w boku);
  - tolerancja skosu i pas boku za skosem;
  - pas pinów 6–20 px zamiast 14–28 (JPP M18: wyjście W to kółko + 20 px drutu);
  - osobne mapy pinów;
  - piny długich boków elementu biernego liczone bez domknięcia;
  - odrzucanie nakładających się ramek.
- **Ślepy test wersji końcowej:**
  - P-D3-2 2-31 i SPP-32-16 2-142 (moje; pakiety wcześniej nieoglądane, strona =
    największy plik pakietu). Po ich obejrzeniu zmieniłem tylko położenie sondy narożnika
    (bez wpływu na wynik którejkolwiek strony) i dodałem wyłączony przełącznik
    `SIDE_WOBBLE`;
  - P-A3-2 2-72, P-P3-2 2-46 i PPS-32 2-150 (recenzja).
- **v3** (sha256 `5b039716…`, poprawki po recenzji) nie jest już ślepa dla żadnej z tych
  stron. Zmiany:
  - pełna przegródka (cięcie ≥ `CUT_KEEP` = 0,95) nie jest usuwana, gdy kawałek nie ma pinu;
    usuwa ją tylko za niski kawałek. Wcześniej środkowa bramka z bladymi pinami zlewała się
    z sąsiadem;
  - pin to także tusz dotykający ściany, który ≥ `PIN_NEAR` px dalej łączy się
    z jakąkolwiek linią H/V: drut skręcający 12 px za ścianą albo kropka na magistrali
    13 px dalej. Pas boku liczony jest za skosem;
  - pokrycie boku liczone bez najdłuższej przerwy (≤ `SIDE_GAP`). P-P3-2 M49 ma 9 px
    przerwy w 80-px boku, co dawało pokrycie 0,87 < 0,9;
  - składowa mapy linii grubsza niż 1,5 sw + 2 jest dodatkowo dzielona na wiersze-linie.
    P-A3-2: napis „0,25” zlewa obie ściany R9, a podpis „R14-1k” zlewa się z górną ścianą;
  - element bierny sprawdzany przed bramką (pionowy rezystor 30–39 px szeroki).
    Wyprowadzenie na długim boku musi dochodzić do końca pasa i nie może leżeć w gęstym
    tekście (`PIN_TEXT_DENS`). Pogrubiony podpis „R8-1k” dotyka korpusu i drutu nad nim;
  - usunięte zbędne sprawdzenie `inside`: zawarcie to `overlap` = 1.

### Liczby na wzorcu (`eval-digitize`, IoU ≥ 0,5)

gateP / gateR / gateF1:

| strona | rola | v1 (ślepy poza 2-58/59) | końcowa |
|---|---|---|---|
| 2-58 | strojenie | 1,000 / 1,000 / 1,000 | 1,000 / 1,000 / 1,000 |
| 2-59 | strojenie | 1,000 / 1,000 / 1,000 | 1,000 / 1,000 / 1,000 |
| 2-60 | held-out | 1,000 / 1,000 / 1,000 | 1,000 / 1,000 / 1,000 |
| 2-61 | held-out | 1,000 / 1,000 / 1,000 | 1,000 / 1,000 / 1,000 |
| 2-63 | held-out | 0,556 / 0,833 / 0,667 | 0,947 / 1,000 / 0,973 |
| TOTAL | | 0,855 / 0,959 / 0,904 | 0,987 / 1,000 / 0,993 |

Średnie IoU dopasowanych bramek: 0,895–0,921. Krawędzie leżą 1–4 px od wzorca.

- **2-63 v1:** 11 fałszywych „układów” to prostokąty z drutów oparte o ścianę M30/M42 i stosu
  M29/M41. Sonda narożnika trafiała w koniec drutu, nie w ścianę. Do tego zgubiony stos
  M18/M8/M19 (14 px przerwy w prawym boku).
- **2-63 końcowa:** jedyny „FP” to prawdziwy rezystor R4-1k (1700, 1061, 1723, 1120), którego
  wzorzec nie zawiera. Same bramki bez klasy `passive`: 1,000 / 1,000.

### Strony bez wzorca (ogląd overlayu, liczba prawdziwych bramek policzona przeze mnie)

| strona | bramki (prawdziwe) | v1: trafione / FP | końcowa: trafione / FP | rezystory v1 / końc. |
|---|---|---|---|---|
| P-X3-2 2-1 (ogląd przy strojeniu) | 21 | 21 / 0 | 21 / 0 | 1/1 / 1/1 |
| JPP-16-18 2-115 | 4 (K565) | 3 / 2 | 4 / 0 | – |
| SM-POSE11 2-97 | 22 | 22 / 1 | 22 / 0 | – |
| P-M3-2 2-13 | 23 | 21 / 4 | 22 / 0 | 1/5 / 3/5 |
| I-SK1-1 2-87 | 56 | 33 / 34 | 54 / 0 | 3/14 / 13/14 |
| razem 4 strony powyżej: ślepe dla v1, **strojenie** dla końcowej | 105 | 79 / 41 (R 0,75, P 0,66) | 102 / 0 (R 0,97, P 1,00) — nie ślepe | |

Ślepe dla wersji końcowej:

| strona | bramki (prawdziwe) | końcowa: trafione / FP | rezystory | kto liczył |
|---|---|---|---|---|
| P-D3-2 2-31 | 13 | 10 / 0 | – | ja |
| SPP-32-16 2-142 | 24 | 6 / 0 | 1/1 | ja |
| P-A3-2 2-72 | 16 | 16 / 0 | 0/4 | recenzja |
| P-P3-2 2-46 | 28 | 27 / 0 (brak M49 (786, 372, 842, 451)) | 2/2 | recenzja |
| PPS-32 2-150 | 8 | 6 / 0 (brak C2, E2) | 1/1 (R9) | recenzja |
| **razem ślepe** | 89 | **65 / 0 (R 0,73, P 1,00)**; bez SPP 59/65 = 0,91 | | |

v3 (po recenzji, **nie ślepa**, ponowne uruchomienie wszystkich 15 stron):

| strona | końcowa | v3 |
|---|---|---|
| P-R3-2 2-58…2-63, P-X3-2, JPP, SM-POSE11, I-SK1-1 | jak wyżej | bez zmian (te same ramki) |
| P-M3-2 2-13 | 22/23, rez. 3/5 | 22/23, rez. **5/5** (R24, R3) |
| P-D3-2 2-31 | 10/13 | **11/13** (M95 (1883, 216, 1940, 297)) |
| SPP-32-16 2-142 | 6/24 | **14/24** (stosy A7 (769, 308, 826, 624) i T7 (694, 1016, 748, 1333)) |
| P-A3-2 2-72 | 16/16, rez. 0/4 | 16/16, rez. **4/4** |
| P-P3-2 2-46 | 27/28 | **28/28**, rez. 2/2 |
| PPS-32 2-150 | 6/8 | 6/8, R9 |

Żadna ramka z wersji końcowej nie znikła w v3 (porównanie 1:1 przy IoU ≥ 0,5 na
15 stronach). Wzorzec bez zmian: TOTAL 0,987 / 1,000 / 0,993.

**PPS-32 2-150, C2 i E2** — dlaczego nie są kandydatami (zmierzone):

- **C2 (7485, ≈ 970–1078, 297–640):** górna krawędź nad kolumną etykiet (x 972–998) jest
  przerwana. Szarość w przerwach dochodzi do 251, a odcinek górny zaczyna się dopiero
  przy x 998. Para góra/dół ma więc końce rozjechane o 27 px, a para lewy/prawy ma 18 px
  przerwy w górnym boku (> `SIDE_GAP` = 16). `SIDE_WOBBLE=True` albo `SIDE_GAP=30`
  znajduje C2.
- **E2 (≈ 1433–1542, 190–506):** górna ściana kończy się przy x 1512, 27 px przed prawym
  narożnikiem nad kolumną A. Prawa ściana jest przerwana przy y 216–223 przez wyjście 2.
  Żadna para nie ma zgodnych końców. Tych samych przełączników to nie ratuje.
- To ta sama klasa co SPP (blada albo przerwana ramka nad wąską kolumną). Poza zakresem;
  nowy bead razem z maską tabliczki kr-9p8.13 i `SIDE_WOBBLE`.

Konkretne błędy (współrzędne skanu x0, y0, x1, y1):

- **v1:**
  - JPP: FP w kolumnie dat tabliczki (1749, 1257, 1827, 1466) i (1749, 1466, 1827, 1524);
    zgubiony M18 (1508, 314, 1611, 788): wyjście W to kółko + 20 px drutu, a pas pinów
    14–28 px go nie widział;
  - SM-POSE11: FP (1362, 683, 1398, 997) — prostokąt z drutów przy J2/J6;
  - P-M3-2: FP (382, 767, 499, 900), (831, 692, 890, 799), (831, 799, 890, 849),
    (831, 849, 890, 933) — prostokąty z drutów przy M91 i przy stosie M16…M17; zgubione
    M1 (1679, 284, 1738, 366) i M30 w lewym górnym rogu;
  - I-SK1-1: 34 FP to kolumny prostokątów z drutów (x 514–572 i 1577–1636), częściowo
    zdublowane. Zgubione: 14 z 16 bramek lewego stosu 7438 (568–622, 371–1445) i bramki
    z bladymi drutami pinów.
- **końcowa:**
  - P-M3-2: M30 (≈ 300–392, 316–392) przekreślona/dopisana odręcznie; rezystory R24
    (282, 445, 343, 470) i R3 (≈ 292–358, 1063–1087) odrzucone przez `leads`;
  - I-SK1-1: K1 (≈ 1475–1530, 650–720) i G2 (≈ 720–775, 975–1050) — blada, nieciągła
    górna ściana, brak kandydata; R24 (≈ 290–350, 1200–1225);
  - P-D3-2: M81 DMx 154 (≈ 567–675, 183–633), M95 (≈ 1863–1933, 217–300) i M82
    (≈ 1880–1958, 375–455). W M95 i M82 drut wejścia biegnie na wysokości górnej ściany,
    a kółko wyjścia siedzi w narożniku, więc zostają ≤ 2 czyste narożniki. W M81 kółka
    wejść 18/19 leżą w narożniku;
  - SPP-32-16: zgubione A6 (175), A8 (85) i wszystkie 16 bramek 7400 w stosach A7
    (768, 308, 826, 624), B7, S7 i T7. Ściany są blade, mają 1 px i falują między wierszami
    (górna ściana A7: minimum szarości kolumn 25–160, ale żaden wiersz nie ma ciągłego
    biegu 25 px). Znalezione: B6, B8, S6, S8, T6, T8 i R101.

Przełącznik `SIDE_WOBBLE=True` sprawdza boki na mapach pinów. Na SPP znajduje stosy A7 i T7
(+8 bramek), ale daje po 1 FP w dużym tekście numeru arkusza na 2-61 (1913, 1413, 1969,
1453), P-X3-2 (1919, 1478, 1964, 1520) i JPP (1901, 1463, 2014, 1499). Dlatego jest
wyłączony. Włączyć go można dopiero razem z maską tabliczki i numeru arkusza (bead o ramce
strony z kr-9p8.2).

### Wpływ na `cv-wires.py` tryb (b)

- Na P-R3-2 2-58…2-61 wireP/R/F1/wF1geom/juncP/juncR są identyczne z tabelą v4 (b).
- Na stronach spoza P-R3-2 maskowane są teraz złożone układy:

  | strona | maski | nety / odcinki / kropki | v4 | największy net |
  |---|---|---|---|---|
  | JPP 2-115 | 4 | 158 / 245 / 17 | 163 / 262 / 22 | 3608 px |
  | SM-POSE11 2-97 | 6 | 80 / 168 / 20 | 90 / 184 / 25 | 3138 px |
  | P-X3-2 2-1 | 11 | 66 / 168 / 36 | 70 / 176 / 37 | 3383 px |

  Na overlayu JPP korpusy M16…M19 nie mają już drutów. Kolumny etykiet „A15 12…” przed
  układami dalej dają pionowe fałszywe druty; to tekst, czyli osobny bead.
- `cv-wires` maskuje bloki w całości (stos, nie pojedyncze bramki).
- Ustawia `GATES_P = {PIN_SIDES_MIN: 1}`: do maski wystarczą druty z jednej strony, bo
  domknięta ramka o czystych narożnikach nie jest drutem. Wymaga tego test
  `mode_b_stack_with_thin_top_frame`.
- Stare `detect_gate_boxes` / `_extend_stack` / `_thick_segments` i parametry `BOX_L`,
  `BOX_SIDE_GAP`, `BOX_WMAX` itd. zostały usunięte. Wiersze tabeli mutacji kr-9p8.2 o tych
  nazwach są nieaktualne; testy trybu (b) przechodzą na nowym detektorze.

### Testy i mutacje

35 testów syntetycznych (v3). Każdy przypadek z oczekiwanym wynikiem:

- pojedyncza bramka z tekstem → 1 bramka, ramka ±3 px, piny po obu stronach;
- stos 3 bramek z podpisem dotykającym przegródki → 3 bramki, cięcia na przegródkach,
  kandydaci pinów przy własnej bramce;
- stos 3 bramek, środkowa bez widocznych pinów → nadal 3 bramki;
- bramka z jedną wewnętrzną kolumną (2-58 M52) → `gate`, nie `composite`;
- 74175 z kolumnami → 1 `composite` (przegródka D na wysokości sekcji C/R daje ~50 %,
  bez cięcia);
- K565 → `composite`;
- stos dwóch 74170 z ciągłą prawą kolumną → 2 `composite`;
- kółko w narożniku → 1 bramka; kółka na boku wejść → 1 bramka;
- cienka ramka 2 px → 1 bramka;
- piny 8 px od narożników → 1 bramka;
- wysoki stos ze skosem 10 px i przerwą w boku → 10 bramek;
- blady przerywany drut wyjścia i drut skaczący między wierszami → pin, bramka przyjęta;
- krótkie wyjście za kółkiem (JPP M18) → pin;
- wyjście skręcające 12 px za ścianą i wyjście kropką do magistrali 13 px dalej → piny;
- przerwa 9 px w boku bramki 80 px → bramka (przerwa liczona raz);
- rezystor → `passive`;
- rezystor z pogrubionym podpisem dotykającym korpusu i drutu nad nim → `passive`;
- rezystor z napisem zlewającym obie ściany → `passive`;
- pionowy rezystor 30 × 70 → `passive`;
- mała ramka z dwoma drutami na jednym krótkim boku → nie `passive`;
- ramka strony → nie bramka, a bramka w środku zostaje;
- kratka tabliczki → 0;
- ramka numeru arkusza z dużym tekstem → 0;
- blok tekstu → 0;
- kratka drutów → 0;
- pętla drutów przy boku bramki → nie zmienia bramki;
- dwie belki bez boków → 0;
- ramka z drutami z jednej strony → 0;
- za wysoka i za szeroka ramka → 0;
- nakładające się ramki → 1;
- wpis YAML.

Mutacje (`CVG_MUTATE` / `CVG_SCRIPT`). Każda wywala co najmniej jeden test:

| mutacja | test, który pada |
|---|---|
| `CORNERS_MIN=0`, `CORNER_FRAC=1.01`, bez sondy narożnika | title_block_grid |
| `PINS_MIN=0,PIN_SIDES_MIN=0` | page_number_frame, wires_on_one_side |
| `PIN_SIDES_MIN=1` | wires_on_one_side |
| `CUT_FRAC=1.01` | stack_of_three, two_composites |
| `CUT_FRAC=0.3` | composite_with_internal_columns |
| `SIDE_COV=0,SIDE_GAP=1000` (razem; osobno się dublują) | two_bars_without_sides |
| `SIDE_GAP=6`, `SKEW=0`, bez pasa za skosem | skewed_tall_stack |
| `END_TOL=1000` | page_border |
| `GATE_WMAX=1e5` / `GATE_HMAX=1e5` | oversized / too_tall |
| `BUB_AMAX=0`, bez wypełniania kółek | bubbles_on_input_side (+ short_output) |
| `PIN_GAP=0` / `PIN_WOBBLE=1` | pale_dashed_output / pale_wire_wobbling |
| `PIN_NEAR=14,PIN_FAR=28` | short_output_after_bubble |
| `COMP_H=1e5` | tall_ic_with_label_column |
| `OVERLAP_MAX=1.0` | overlapping_frames |
| cięcie usuwane po stronie dolnej zamiast słabszej | stack_of_three |
| sonda narożnika w pasie `WALL_BAND` | pins_close_to_corners |
| `CUT_KEEP=1.01`, stara reguła cięć (usuwa też pełną przegródkę) | stack_gate_with_invisible_pins |
| bez pinu „tusz przy ścianie + dowolna linia” | output_turning_down, output_joining_vertical_bus |
| pokrycie boku z przerwą (`prof.mean()`) | side_gap_counts_once |
| `SEG_SPLIT=100` | passive_with_text_touching_both_walls (+ label_touching) |
| `PIN_TEXT_DENS=1.0` | passive_with_label_touching_body |
| bramka przed elementem biernym | vertical_resistor_30px_wide |
| `gp = list(pins)` (piny całego bloku w każdej bramce) | stack_of_three |
| `nv >= 1` zamiast `>= 2` | gate_with_single_internal_column |
| `_passive_leads`: `count(b) >= 1` bez długości | small_box_with_two_leads_on_one_short_side |

### YOLO — szacunek (bez treningu)

Nie trenowałem. Ślepo CV ma precyzję 1,00 i recall 0,91 bez SPP (0,73 z SPP). Braki to
blade albo przerwane ramki i piny w narożnikach, więc detektor uczony miałby sens jako
uzupełnienie dla takich pakietów (ASSUMED):

- **Etykiety:** prostokąty bloków (stos / układ / bramka / rezystor). Wstępnie z
  `cv-gates.py`, poprawiane w viewerze. 30–50 stron z różnych pakietów, w tym 5–10 z SPP,
  PPS i P-D3-2, to ~800–1500 ramek.
- **Koszt etykiet:** z gotowymi kandydatami 2–4 min na stronę, czyli 1,5–3 h człowieka.
- **Trening:** YOLOv8n/11n na kafelkach 1024–1280 px z augmentacją bladości i skosu,
  ~100 epok na MPS (M5 Pro), około 20–40 min.
- **Korzyść:** odporność na blade, falujące ramki i piny w narożnikach. Podział stosu na
  bramki, cięcia kolumn i piny zostają w CV, bo YOLO podaje tylko prostokąt bloku i klasę.
- **Tańsza alternatywa:** najpierw maska tabliczki i numeru arkusza (osobny bead), potem
  `SIDE_WOBBLE=True` i ponowny pomiar na SPP i P-D3-2.

### Uruchomienie

```bash
uv run scripts/cv-gates.py --scan data/MJC-400/P-X3-2/scans/2-1.jpg \
    --out <kat>/P-X3-2/2-1.sch.yaml --overlay 2-1-gates.png [--set SIDE_WOBBLE=True]
uv run scripts/eval-digitize.py --gold data/gold --candidate <kat>
PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with numpy \
    --with opencv-python-headless pytest -p no:cacheprovider scripts/test_cv_gates.py
CVG_MUTATE="CORNERS_MIN=0" PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml \
    --with numpy --with opencv-python-headless pytest -p no:cacheprovider scripts/test_cv_gates.py
```

Overlay: cały skan w pełnej rozdzielczości, jasnoszary. Kolory ramek:

- zielona = `gate`, niebieska = `composite`, fioletowa = `passive`, z numerem;
- jasnoturkusowa = blok (stos albo układ w całości);
- pomarańczowa przerywana = kandydat odrzucony, z kodem powodu (`corner2`, `pins1`,
  `leads`…).

Niebieskie kropki to kandydaci pinów.

## Wyniki: VLM na wycinkach (kr-9p8.4)

Spike: który model najlepiej czyta tekst schematu z małych wycinków — lokalnie (MLX na M5 Pro
64 GB) albo online. Pola: wnętrze bramki (symbol, typ, ref), numery pinów przy bokach, port
(złącze+pin, etykieta), cross-ref (etykieta, lista arkuszy). Hipoteza: najlepszy model lokalny
≥ 97 % dokładnych trafień na każde pole i ≤ 60 s na arkusz. Skrypt `scripts/vlm-bakeoff.py`,
testy `scripts/test_vlm_bakeoff.py`.

**Werdykt.** Hipoteza **nie jest spełniona.**

- **Najlepszy lokalny** (Qwen3.8-27B 4-bit, prompt v3, ×2) na held-out:
  - bramki (symbol, typ, ref), piny i złącza portów: 100 %;
  - etykiety portów 93,1 % (27/29), etykiety cross-refów 83,8 % (62/74), listy arkuszy
    93,2 % (69/74);
  - 178 s na arkusz średnio, 266 s na 2-63.
  Nie spełnia ani progu 97 %, ani 60 s. Szybki MoE Qwen3.6-35B-A3B ma średnio 50 s, ale na
  gęstym 2-63 75 s (> 60 s), a etykiety cross-refów czyta na 60,8 % (45/74).
- **Online najlepszy jest Claude Opus 5.5** (effort low, v3): 98,8 % wszystkich pól
  (601/608), $0,17 na arkusz. On też nie przekracza 97 % na etykietach cross-refów held-out
  (94,6 %, 70/74).
- Prawda ma 16 poprawek wzorca, wszystkie potwierdzone przez opiekuna na pełnych arkuszach
  (USER). 6 z nich jest na held-out 2-63; bez nich wszystkie modele tracą tyle samo (piny
  36/39, typ 37/39), więc ranking się nie zmienia.
- **Trudność nie leży w bramkach, tylko w ręcznie pisanych etykietach sygnałów:**
  - R z zawijasem czytane jako A/Q/D, P↔D, B↔8, 5↔S, `11` jako `H`;
  - numer arkusza przed etykietą przy lewej krawędzi.
- **Cały arkusz w jednym callu** (Opus) daje to samo co wycinki na bramkach i portach, a na
  etykietach cross-refów trochę mniej. Na 2-60 ma 100 %. Para „wycinek + cały arkusz” zgadza
  się na 597 z 608 pól i wtedy myli się 3 razy (99,5 %). Niezgodne pola (~2 na arkusz) idą do
  przeglądu.

### Metoda

- **Wycinki z geometrii wzorca**, nie z detekcji: 231 sztuk na P-R3-2 (74 bramki, 53 porty,
  104 cross-refy). Strojenie na 2-58/2-59 (89 wycinków), held-out 2-60/2-61/2-63 (142).
  - bramka: prostokąt + 36 px w poziomie (numery pinów nad drutem i kółko negacji),
    10 px w górę, 4 px w dół, a pionowo co najmniej każdy pin wzorca `py − 22 … py + 4`;
  - port: wiersz `y − 30 … y + 26`, 48 px na zewnątrz od szewronu i 215 px w głąb arkusza;
  - cross-ref: wiersz `y − 30 … y + 14`; przy prawym końcu drutu 175 px w lewo i 125 px
    w prawo, przy lewej krawędzi 75 px w lewo i 200 px w prawo;
  - port i cross-ref mają biały margines 14 px po bokach z czerwonymi trójkątami na wysokości
    drutu celu. Sąsiednie wiersze (co 25–55 px) są w kadrze, trójkąty mówią, który czytać;
  - **zmiana po obejrzeniu held-out:** pierwsza wersja dawała bramce z pinami „top” +34 px
    u góry. Jedyna taka bramka, 2-63 M19 (held-out), ma te piny w rzeczywistości z lewej, a
    margines wciągał ref sąsiada M8. Margines usunąłem i zbudowałem wszystkie wycinki bramek
    od nowa. Żaden wynik w tabelach nie pochodzi ze starych wycinków (na starych szedł tylko
    test dymny 4 wycinków), ale sama decyzja opiera się na stronie held-out;
  - skala 1 (natywnie) i 2 (LANCZOS ×2). Na stronach strojenia ×2 wygrywa dla Qwen
    (piny 94 % vs 89 %, symbol/typ/ref Qwen3.6 +5–6 pp.), dla Opus remis, dla GPT ×1 (ref 94 %
    vs 74 %). Dalej: Qwen i Opus ×2, GPT ×1.
- **Prawda** to wzorzec plus 16 jawnych poprawek (wycinków) `TRUTH_OVERRIDES` tam, gdzie
  wzorzec nie opisuje NADRUKU. Wszystkie potwierdził opiekun na pełnych arkuszach (USER,
  2026-11-26), z jednym wyjątkiem opisanym przy M8:
  - typ z `package.yaml` różny od nadruku: 2-58 M55 D/F (nadruk `04`, rejestr `170`),
    2-63 M18 (`174` vs `74`), 2-63 M8 (`175` vs `00`);
  - porty bez własnej etykiety, wzorzec ma tu nazwę netu. Każdy łączy się z opisanym portem:
    - 2-58: C41 z A50 `-BLR`, C48 z B48 `-RA`, C46 z B49 `-RB`, C43 z B47 `-W∤R`,
      C47 z A49 `-RC`;
    - 2-63: D40 z A86 `-DNBØ`, D43 z B84 `-DNB3`;
  - piny:
    - 2-58 M52 B: nadruk 1/13/9/10, wzorzec 11/12/9/10;
    - 2-58 M7 B: 6 nad 5;
    - 2-63 M30: pin 4 nienarysowany;
    - 2-63 M19: piny 9 i 1 z lewej, bo górę zajmuje M8;
    - 2-63 M8: nienarysowane wyjścia 3/6/11/14. Opiekun nie był o nie pytany, więc ta część
      jest NIEPOTWIERDZONA; typ M8 potwierdzony;
  - **błąd wzorca w etykiecie:** 2-58 A49 ma nadruk `-RC`, wzorzec `-PC` (USER).
  Podejrzenia rozstrzygnięte przez opiekuna na korzyść wzorca (USER):
  - B03 `+RPC`, B43 `+A52`, 2-61 `+L11` i `-CZYTRN`, 2-63 `+ŁRP`;
  - odczyty modeli `+RDC`, `+AS2`, `+LH1`, `-CZYTAN`, `+ŁRB` to więc prawdziwe błędy;
  - w tym piśmie wielkie A ma szpiczastą górę, a R z zawijasem nie.

  **Zastrzeżenie.** 6 poprawek dotyczy held-out 2-63: M18 A, M8 A, M30 A, M19 A, D40, D43.
  - Znalazłem je przy oglądaniu tej strony: zestawienia wycinków i pełny skan.
  - Typ M8 wrócił dopiero po pierwszych błędach Opusa na held-out: wpis zginął przez
    zdublowany klucz w słowniku.
  - Audyt prawdy nie był systematyczny. Objął pola, które obejrzałem, i pola, gdzie modele
    nie zgadzały się ze wzorcem. Nie objął wszystkich 608 pól; błąd wzorca, z którym model się
    zgadza, zostałby niezauważony.
  - Efekt (MEASURED, `score --no-overrides`) na held-out, dla każdego modelu tak samo:
    - piny bramek 39/39 → 36/39;
    - typ 39/39 → 37/39;
    - symbol 39/39 → 37/38 (M18 z typem `74` nie ma symbolu w mapie);
    - etykieta portu Opus v3 28/29 → 27/29.
  - Opiekun sprawdził potem wszystkie poprawki na pełnych arkuszach i potwierdził je (USER;
    wyjątek: nienarysowane wyjścia M8 nie były pytane). Sposób ich znalezienia pozostaje
    zastrzeżeniem: wzorzec nie został przejrzany pole po polu.
- **Symbol** wynika z typu (`&` dla 00/03/08/10/11/H11/20, `1` dla 02/04, `R` dla
  170/174/175); 51 (AOI) ma dwa symbole i nie jest oceniany.
- **Normalizacja** przed porównaniem: bez spacji, minusy `−–—` → `-`, `Ø` → `0`; znak
  „∤” w środku etykiety (`W∤R`; wzorzec pisze go jako `/`, `#` albo `+`) → `/`. Litera `O` i
  cyfra `0` NIE są utożsamiane, wielkość liter i polskie litery bez zmian. Złącze: litera +
  liczba bez zer wiodących (`B03` = `B3`). Arkusze: posortowana lista liczb. Piny bramki:
  zaliczone, gdy listy lewa/prawa/góra są identyczne (z kolejnością).
- **Prompty** (angielskie, JSON):
  - `v1` — opis pola z przykładami;
  - `v2` — inne sformułowanie bez przykładów, drugi „głos” do flagi (a);
  - `v3` = v1 + wskazówki wyprowadzone **wyłącznie** z błędów na 2-58/2-59. Wskazówki:
    R w tym piśmie wygląda jak Q/D/A; 5 jak S; `∤` to `/`; numer arkusza przy lewej krawędzi
    stoi przed etykietą; Ł tylko z wyraźną kreską; format pól bramki (Qwen3.6 wpisywał ref
    w typ).
- **Modele** (wersje sprawdzone na kartach 2026-11-26):
  - lokalne przez `mlx-vlm` 0.8.1, temperatura 0, myślenie wyłączone:
    - `Qwen3.8-27B` 4-bit (15 GB) i 8-bit (28 GB) — już na dysku;
    - pobrane do `/Volumes/Dane/llm/hf`: `mlx-community/Qwen3.6-35B-A3B-4bit` (MoE, 20,4 GB)
      i `mlx-community/PaddleOCR-VL-1.6-4bit` (0,7 GB). PaddleOCR-VL daje wolny tekst
      (`OCR:`), pola wyłuskuje parser regułowy, więc pinów nie czyta wcale;
  - online:
    - `claude-opus-5-5` (effort low; medium na próbce 50);
    - `claude-fable-5-2` (tylko próbka 50);
    - `gpt-5.6-sol` — najnowszy GPT-5.x z `models.list()`, cena $4/$20 za MTok
      z developers.openai.com/api/docs/pricing; effort low, medium na próbce 50.
    Bez fallbacków, żeby wynik dotyczył jednego modelu.
- **Cały arkusz** (linia bazowa): jeden call z pełnym skanem i JSON wszystkich pól
  z przybliżonym położeniem. Wymagany był 2-60; zrobiłem wszystkie 5 stron, bo 2-60 jest
  najrzadszy.
  - **Dopasowanie** elementów do wycinków wzorca jest zachłanne. Koszt = odległość od
    położenia wzorca / 100 px + liczba pól niezgodnych z odczytem WYCINKOWYM tego samego
    dostawcy (Opus arkusz ↔ Opus v3, GPT arkusz ↔ GPT v3), próg 6. Pola nieoceniane (symbol
    bramki 51) się nie liczą.
  - Prawda nie bierze udziału. Pierwsza wersja dopasowywała do prawdy i zawyżała wynik:
    GPT xref.label held-out 85,1 → 79,7 % po zmianie, Opus bez zmian.
  - Samo położenie nie wystarcza: stosy bramek i porty są co 25–55 px, a współrzędne GPT
    są zgrubne.
  - Dopasowanie do odczytu wycinkowego sprzyja zgodności, więc liczba niezgodności „wycinek
    vs arkusz” niżej to raczej dolna granica (ASSUMED).

### Liczby (MEASURED)

Dokładne trafienia na held-out (2-60, 2-61, 2-63: 39 bramek, 29 portów, 74 cross-refy), %
i liczba. Szum próby: 1 pole to 2,6 pp. na bramkach, 3,4 pp. na portach i 1,35 pp. na
cross-refach.

- **Odtwarzalność:**
  - temperatury w API online nie da się ustawić;
  - Opus cały arkusz low vs medium różni się 1 polem (MEASURED);
  - powtórzenie runu może zmienić kilka odpowiedzi (ASSUMED, nie powtarzałem runów).
- **Czas i koszt tylko z 3 stron held-out:**
  - s/arkusz = suma czasów wycinków danej strony, czyli sekwencyjnie; średnia i maksimum
    po stronach;
  - nie obejmuje ładowania modelu, renderu wycinków ani detekcji CV;
  - online z 6 wątkami ściana jest 5,7–5,9× krótsza (MEASURED z czasów runów Opus/GPT v3);
  - pamięć to szczyt MLX.

| model, prompt, skala | symbol | typ | ref | piny | złącze | etyk. portu | etyk. xref | arkusze | s/arkusz śr. / max | pamięć | $/arkusz |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Qwen3.8-27B 4-bit, v3, ×2 | 100 (39/39) | 100 (39/39) | 100 (39/39) | 100 (39/39) | 100 (29/29) | 93,1 (27/29) | 83,8 (62/74) | 93,2 (69/74) | 178 / 266 | 17,4 GB | 0 |
| Qwen3.8-27B 4-bit, v1, ×2 | 100 (39/39) | 100 (39/39) | 100 (39/39) | 100 (39/39) | 100 (29/29) | 89,7 (26/29) | 75,7 (56/74) | 83,8 (62/74) | 159 / 228 | 17,4 GB | 0 |
| Qwen3.8-27B 8-bit, v3, ×2 | 84,6 (33/39) | 84,6 (33/39) | 82,1 (32/39) | 84,6 (33/39) | 96,6 (28/29) | 89,7 (26/29) | 79,7 (59/74) | 90,5 (67/74) | 359 / 523 | 30,8 GB | 0 |
| Qwen3.6-35B-A3B 4-bit, v3, ×2 | 97,4 (38/39) | 100 (39/39) | 97,4 (38/39) | 97,4 (38/39) | 100 (29/29) | 89,7 (26/29) | 60,8 (45/74) | 77,0 (57/74) | 50 / 75 | 21,4 GB | 0 |
| Qwen3.6-35B-A3B 4-bit, v1, ×2 | 94,9 (37/39) | 97,4 (38/39) | 97,4 (38/39) | 100 (39/39) | 96,6 (28/29) | 93,1 (27/29) | 63,5 (47/74) | 63,5 (47/74) | 40 / 58 | 21,5 GB | 0 |
| PaddleOCR-VL-1.6 4-bit, OCR, ×2 | 25,6 (10/39) | 17,9 (7/39) | 33,3 (13/39) | 0 (0/39) | 96,6 (28/29) | 69,0 (20/29) | 31,1 (23/74) | 14,9 (11/74) | 6 / 9 | 1,9 GB | 0 |
| Opus 5.5 low, v3, ×2 | 100 (39/39) | 100 (39/39) | 100 (39/39) | 100 (39/39) | 100 (29/29) | 96,6 (28/29) | 94,6 (70/74) | 100 (74/74) | 72 / 105 | – | 0,17 |
| Opus 5.5 low, v1, ×2 | 100 (39/39) | 100 (39/39) | 97,4 (38/39) | 100 (39/39) | 100 (29/29) | 96,6 (28/29) | 83,8 (62/74) | 98,6 (73/74) | 76 / 111 | – | 0,15 |
| GPT-5.6-sol low, v3, ×1 | 100 (39/39) | 100 (39/39) | 89,7 (35/39) | 94,9 (37/39) | 93,1 (27/29) | 75,9 (22/29) | 73,0 (54/74) | 98,6 (73/74) | 159 / 232 | – | 0,23 |
| Opus 5.5, **cały arkusz** | 100 (39/39) | 100 (39/39) | 100 (39/39) | 100 (39/39) | 100 (29/29) | 100 (29/29) | 91,9 (68/74) | 100 (74/74) | 14 / 19 | – | 0,06 |
| GPT-5.6-sol, **cały arkusz** | 100 (39/39) | 100 (39/39) | 89,7 (35/39) | 94,9 (37/39) | 100 (29/29) | 82,8 (24/29) | 79,7 (59/74) | 98,6 (73/74) | 20 / 23 | – | 0,06 |

- **Odtwarzalność z cache:** wszystkie 21 runów wycinkowych przeliczone z
  `run --cache-only --rescore` dają te same odpowiedzi co przy wywołaniu (MEASURED,
  0 różnic). Dotyczy to także Qwen3.6 v1, który wcześniej nie dawał się odtworzyć: zmiana
  nazwy modelu zmieniła klucz cache. Teraz klucz MLX zawiera hash pełnej ścieżki, a stare
  wpisy są czytane pod dawnymi nazwami i kopiowane pod nowy klucz.

- **Cały arkusz 2-60** (wymagana linia bazowa): Opus 5.5 ma 33/33 elementów i wszystkie pola
  poprawne. Trwa 11,6 s i kosztuje $0,05. GPT-5.6-sol na tym arkuszu ma xref.label 13/15.
  Opus na pozostałych arkuszach: 2-61 xref.label 16/20 (R→A w `-PISZRN`, `-CZYTRW`…),
  2-58 port.label 12/16 (`W∤R` → `WAR`, P→D, 5→S). Opus low i medium na całym arkuszu
  różnią się jednym polem (2-61 `+RPP` → `+RPD` przy medium).
- **Strojenie (2-58/2-59) vs held-out.** Opus v3: tune 100 % na wszystkich polach poza
  port.label 91,7 % (22/24; błędy B03 `+RDC` i B43 `+AS2`, wzorzec poprawny — USER). Qwen3.8-27B
  4-bit v3: tune piny 94,3 % (33/35), port.label 91,7 % (22/24), xref.label 83,3 % (25/30). Held-out nie jest gorszy, czyli
  wskazówki v3 nie przeuczyły się na 2-58/2-59.
- **Wpływ v3** (wskazówki z 2-58/2-59) na held-out:
  - Opus xref.label 83,8 → 94,6 %;
  - Qwen3.8-27B xref.label 75,7 → 83,8 %, arkusze 83,8 → 93,2 %;
  - Qwen3.6-35B-A3B: gramatyka pól lepsza (symbol 94,9 → 97,4 %), ale arkusze przy lewej
    krawędzi dalej gubi;
  - v2 (bez przykładów) jest gorszy u wszystkich: Opus xref.label 81,1 %, Qwen3.6 piny 61,5 %.
- **Effort / model online** (próbka 50 wycinków = 137 pól, w tym 65 pól z 2-58/2-59;
  porównanie na tych samych wycinkach):
  - Opus v1 medium 134/137 vs low 133/137; na stronach strojenia 64/65 oba. Medium jest
    ~14 % droższy, więc zostaje low;
  - Fable 5.2 low: v1 130/137 (Opus 133/137), v3 136/137 (Opus 137/137). Jedyny błąd Fable
    v3 to 2-61 M38 B ref `M36`. 2× droższy od Opus ($0,0075/wycinek), bez zysku na tej
    próbce;
  - GPT v1 medium 120/137 = low 120/137.
- **Skala ×1 vs ×2:** Qwen3.6 ×2 lepszy na bramkach; Qwen3.8 ×2 lepszy na pinach
  (94,3 vs 88,6 % tune); Opus remis; GPT ×1 dużo lepszy na refach (94,3 vs 74,3 % tune).

### Pomyłki (MEASURED)

Pary prawda → odczyt; liczby to pola na wszystkich 5 stronach.

- **Opus 5.5 v3** (7 błędów na 608 pól = 98,8 %):
  - P→D/B ×2 (`+RPC` → `+RDC`, `+ŁRP` → `+ŁRB`);
  - 11→H ×2 (`+L11` → `+LH1`/`+LH`), 5→S ×1 (`+A52` → `+AS2`), R→A ×1 (`-CZYTRN`);
  - port bez etykiety: odczytana etykieta sąsiedniego cross-refa (2-63 D40 → `+NB0`).
- **Opus 5.5 v1**: R→Q ×7, R→A ×4, R→D ×2. To „R” z zawijasem, które v3 prawie usuwa.
- **GPT-5.6-sol v3** (45 błędów):
  - L→Ł ×7 (v1 ×2: ×11), B→8 ×4;
  - cyfry w refach ×6 (`M54` → `M51`, `M57` → `M37`, `M47` → `M17`, `M38` → `M3`/`M48`/`M36`);
  - odczyt sąsiedniego wiersza ×5 (`+W12` → `+W13`, `-CZYTRN` → `-CZYTRW`, `-M` → `-V`);
  - `∤` → `1`/`Y`.
- **Qwen3.8-27B 4-bit v3** (30 błędów): R→A/Q ×5, P→D ×2, B→8 ×2, 11→1 w pinach (2-58 M63 C),
  zmyślony pin u góry ×1, `∤` → `A`/`4`, Ł→L.
- **Qwen3.6-35B-A3B v3** (76 błędów):
  - brak numeru arkusza ×15, wszystkie przy lewej krawędzi (`[1]` → `[]`);
  - R→A/Q ×11, B→8 ×4;
  - numer arkusza doklejony do etykiety (`8-M`, `g-E`);
  - minus→plus ×2.
- **0 vs O w refach i typach: 0 pomyłek; H11 vs M11: 0** u wszystkich modeli. Zero z kreską
  (Ø) modele piszą jako 0 albo Ø; Ø normalizuję do 0. Odwrotnie zdarza się w etykietach:
  `+STROB1` → `+STR0B1` (Qwen v1 ×3), PaddleOCR `+RB0` → `+QBO`.

Wycinki do obejrzenia (s2, w scratchpadzie sesji; skany nie trafiają do repo):

1. `crops/s2/2-61/2-61_X_13_+L11.png` — `+L11` czytane jako `+LH1` (Opus v3; Qwen3.6 `+LH`);
2. `crops/s2/2-61/2-61_X_09_-CZYTRN.png` — `-CZYTAN` (R→A), Opus v3 i Opus cały arkusz;
3. `crops/s2/2-58/2-58_P_B43.png` — `+A52` → `+AS2` u wszystkich modeli; wzorzec poprawny (USER);
4. `crops/s2/2-58/2-58_P_A49.png` — wzorzec miał `-PC`, wszystkie modele czytały `-RC`; opiekun
   potwierdził nadruk `-RC` (USER), więc to błąd wzorca, teraz poprawiony;
5. `crops/s2/2-60/2-60_X_00_-E.png` — Qwen3.6: `g-E` i brak arkusza `9` przy lewej krawędzi.

### Flagi do kolejki przeglądu (MEASURED)

Precyzja i czułość flagi jako predyktora błędu, na polach (608 pól na 5 stronach).

| sygnał | oflagowane pola | P | R |
|---|---|---|---|
| (b) słownik, Opus v3 | 0 | – | 0/7 |
| (b) słownik, Qwen3.8-27B v3 | 3 | 1,00 | 0,10 |
| (b) słownik, Qwen3.6-35B-A3B v3 | 25 | 1,00 | 0,33 |
| (a) dwa prompty: Opus v3 vs v2 | 39 | 0,05 | 0,29 |
| (a) dwa prompty: Qwen3.6 v3 vs v2 | 154 | 0,36 | 0,72 |
| (a) dwa modele: Opus v3 vs GPT v3 | 47 | 0,13 | 0,86 |
| (a) dwa modele: Qwen3.8 v3 vs Qwen3.6 v3 | 64 | 0,22 | 0,47 |
| (a) kwantyzacja: Qwen3.8 4-bit vs 8-bit, v3 | 51 | 0,08 | 0,13 |
| (a) Opus: wycinek v3 vs cały arkusz | 11 | 0,36 | 0,57 |

- Flaga słownikowa (b) **nigdy się nie myli (P = 1,00), ale łapie mało**. Etykiety sygnałów nie
  mają słownika, a to w nich są prawie wszystkie błędy. Słownik etykiet z pakietu (cross-ref
  musi mieć powrót, etykieta portu jest na backplane) to najtańsze rozszerzenie (ASSUMED).
- Niezgodność dwóch modeli albo dwóch promptów łapie ½–¾ błędów, ale oflagowuje 4–8× więcej
  pól niż błędów. v2 jest za słaby jako drugi głos.
- **Opus wycinek + Opus cały arkusz**:
  - gdy oba się zgadzają (597 pól), zostają 3 błędy (99,5 %): `+RPC` → `+RDC`,
    `+A52` → `+AS2`, `-CZYTRN` → `-CZYTAN`. Wszystkie trzy to prawdziwe błędy, bo wzorzec jest
    tu poprawny (USER);
  - niezgodne pola to 11 na 5 arkuszy (~2 na arkusz);
  - koszt ~$0,23 na arkusz.
  To najlepsza para spośród zmierzonych.

### Werdykt i rekomendacja

- **Najlepszy lokalny: Qwen3.8-27B 4-bit, prompt v3, ×2** (MEASURED):
  - bramki, piny i złącza 100 % na held-out;
  - etykiety portów 93,1 %, etykiety cross-refów 83,8 %, arkusze 93,2 %;
  - 178 s na arkusz średnio (266 s na 2-63), 17,4 GB.
  Nie spełnia ani progu 97 % (etykiety), ani 60 s.
- 8-bit: 35 z 37 błędnych pól bramek to 9 bramek (bloki 170/174/175 i M52) uciętych na
  `max_tokens=300` (MEASURED: wszystkie mają dokładnie 300 tokenów wyjścia). Model zaczyna od
  prozy zamiast JSON i nie mieści odpowiedzi w limicie. To limit harnessu, nie błąd czytania.
  Pozostałe 2 to odczyt: 2-58 M63 C pin 11→1 (jak 4-bit) i 2-61 M38 A ref `M36`. Etykiety czyta tak jak 4-bit (port 26/29, xref 59/74). Jest 2× wolniejszy
  (359 s/arkusz średnio, 523 s na 2-63) i zajmuje 30,8 GB.
- Qwen3.6-35B-A3B (MoE) ma średnio 50 s/arkusz, ale na 2-63 75 s, więc 60 s nie trzyma na
  gęstym arkuszu. Etykiety cross-refów ma na 60,8 % (45/74).
- PaddleOCR-VL odpada: czyta tylko złącza (96,6 %); bramek i list pinów regułowy parser
  z wolnego tekstu nie odtworzy.
- **Online: Opus 5.5, effort low, v3, ×2** (MEASURED):
  - 98,8 % wszystkich pól (held-out: wszystkie pola bramek 100 %, port.label 96,6 %,
    xref.label 94,6 %);
  - $0,17 na arkusz.
  - GPT-5.6-sol jest wyraźnie słabszy na refach i etykietach (L→Ł, cyfry), Fable 5.2 nie
    lepszy na próbce.
- **Cały arkusz zamiast wycinków:** Opus z całego skanu (jeden call, ~14 s, $0,06) czyta
  bramki, piny i złącza tak samo dobrze jak z wycinków, a etykiety cross-refów gorzej
  (91,9 vs 94,6 %). Na 2-60 ma 100 %. Wycinki opłacają się jako drugi, niezależny odczyt
  (tabela flag), nie jako jedyny.
- **Zalecenie na teraz:**
  - tekst: Opus 5.5 low, prompt v3, ×2 na wycinkach z geometrii CV;
  - plus jeden odczyt całego arkusza tym samym modelem; niezgodności do kolejki przeglądu;
  - koszt 155 arkuszy ≈ 155 × $0,23 ≈ $36 (ASSUMED: arkusze podobne do P-R3-2).
  - Lokalnie Qwen3.8-27B 4-bit v3 nadaje się na bramki, piny i złącza, czyli pola z tabeli
    wyżej, które mają 100 %.

### Co musiałaby dać LoRA (kr-9p8.9)

ASSUMED, na podstawie powyższych pomyłek:

- **Cel:** etykiety sygnałów (port i cross-ref) i numer arkusza przy lewej krawędzi. Bramki,
  piny i złącza już mają 100 %.
- **Błędy do wyuczenia:**
  - kształt „R” z zawijasem (R↔A/Q/D), P↔D, B↔8, 5↔S, 11↔H;
  - glif `∤`, Ł tylko z kreską;
  - etykieta przy porcie bez własnego napisu ma być pusta.
- **Dane:**
  - ~40 wycinków na arkusz, z czego ~25 to etykiety; 30–40 zatwierdzonych arkuszy spoza
    `data/gold` daje ~1000 przykładów etykiet;
  - pseudo-etykiety mogą pochodzić z Opusa (para wycinek + arkusz, 99,5 % przy zgodności,
    ~$0,23/arkusz). Człowiek poprawia tylko niezgodności;
  - augmentacja: przesunięcie wiersza (sąsiednie etykiety w kadrze), bladość, skala ×1/×2.
- **Model bazowy:**
  - Qwen3.6-35B-A3B, jeśli LoRA ma zmieścić się w 60 s/arkusz. Teraz 50 s średnio, ale
    75 s na 2-63, więc trzeba też skrócić odpowiedzi;
  - Qwen3.8-27B, jeśli ważniejsza jest dokładność (178 s średnio, czyli 155 arkuszy to
    ~7,7 h — w nocy do przyjęcia);
  - próg wejścia jak w „Pętli uczenia”: lepszy na `data/gold` bez regresji.
- **Czas lokalny** bez LoRA da się skrócić: krótsze odpowiedzi (bramki ~40 tokenów
  wyjścia), cache prefiksu promptu, kilka wycinków w jednym obrazie (ASSUMED, niezmierzone).

### Uruchomienie

```bash
OUT=<katalog wyników>  # wycinki, odpowiedzi, score.md — poza repo
export UV_CACHE_DIR=/Volumes/Dane/llm/uv-cache HF_HOME=/Volumes/Dane/llm/hf
uv run scripts/vlm-bakeoff.py crops --out $OUT --scale 1 2
uv run --with mlx-vlm scripts/vlm-bakeoff.py run --out $OUT --scale 2 --prompt v3 \
    --model mlx:/Volumes/Dane/llm/models/lmstudio-community/Qwen3.8-27B-MLX-4bit
uv run scripts/vlm-bakeoff.py run --out $OUT --scale 2 --prompt v3 \
    --model anthropic:claude-opus-5-5 --effort low [--limit 20]
uv run scripts/vlm-bakeoff.py run --out $OUT --scale 1 --prompt v3 --model openai:gpt-5.6-sol
uv run scripts/vlm-bakeoff.py sheet --out $OUT --page 2-60 --model anthropic:claude-opus-5-5 \
    --ref-run anthropic_claude-opus-5-5_low__v3__s2
uv run scripts/vlm-bakeoff.py run ... --cache-only --rescore   # przeliczenie bez wywołań modelu
uv run scripts/vlm-bakeoff.py score --out $OUT --pairs 'runA|runB' [--no-overrides]
PYTHONDONTWRITEBYTECODE=1 uv run --with pytest --with pyyaml --with pillow \
    pytest -p no:cacheprovider scripts/test_vlm_bakeoff.py
```

Klucze API skrypt czyta z `.env` głównego checkoutu i nigdy ich nie wypisuje. Odpowiedzi są
cache'owane w `/Volumes/Dane/llm/kronikarz-cache/vlm-bakeoff` po (model, parametry, hash
wycinka, hash promptu). Ponowny `score` nic nie kosztuje. Łączny koszt spike'a: ~$7
(Anthropic ~$4,6, OpenAI ~$2,4; MEASURED z `usage`, z dokładnością do podwójnie liczonych
wycinków z cache).
