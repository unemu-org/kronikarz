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

Hipoteza w liczbach `eval-digitize` nie jest spełniona. Ślepy wynik held-out (v1) to wireR
0,84 na 2-60 i 0,36 na 2-61; późniejsze wersje stroiłem już po obejrzeniu tych stron.

Tryb (b), w którym bramki są wykrywane samodzielnie, **nie nadaje się jeszcze do użytku
poza P-R3-2/P-X3-2** (zob. „Poza P-R3-2”). Na JPP-16-18 i SM-POSET-1 nie wykrywa
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
2-59 2,35, 2-60 2,58, 2-61 2,97, P-X3-2 2-1 2,16, JPP-16-18 2-115 2,69, SM-POSET-1 2-97
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
   w kleksie na skrzyżowaniu cienkich linii daje r ≤ 4,2 (SM-POSET-1 2-97); prawdziwe
   blade kropki mają 5,4 (P-X3-2) i 7,6 (2-61).

**Tekst.** Usuwam składowe w rozmiarze znaku i znaki przyklejone do drutu (po odjęciu
pewnych linii). W pasie numerów pinów (`PIN_BAND` = 25 px, wcześniej 20) kasuję tylko
krótkie (< 32 px) kreski równoległe do krawędzi. Słupek „1” na 2-61 stoi 22 px od
krawędzi, a długi drut biegnący w pasie zostaje.

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
- Czas na stronę (sam rdzeń): v4 0,14–0,40 s (najwolniej SM-POSET-1 2-100: 0,40 s; dwie
  transformaty odległości w `detect_dots`). W v3 było 0,12–0,41 s.

### Poza P-R3-2

Wszystkie pomiary w trybie (b), bez wzorca, więc bez liczb `eval-digitize`. Ocena z overlayu
i statystyk.

| strona | sw | v3: nety / odcinki / kropki | v3 największy net | v4: nety / odcinki / kropki | v4 największy net |
|---|---|---|---|---|---|
| JPP-16-18 2-115 | 2,69 | 124 / 384 / 125 | 8690 px | 163 / 262 / 22 | 3608 px |
| SM-POSET-1 2-97 | 1,56 | 68 / 277 / 107 | 25 283 px | 90 / 184 / 25 | 3282 px |
| SM-POSET-1 2-100 | 1,88 | 195 / 609 / 186 | 7197 px | 235 / 506 / 99 | 2090 px |
| P-X3-2 2-1 | 2,16 | 69 / 187 / 39 | 3786 px | 70 / 176 / 37 | 3384 px |

Recenzja zmierzyła na SM-POSET-1 2-97 bez zamalowania 8045 px (v3). v4 bez zamalowania
(`DOT_HOLE=0`) daje 2897 px, a z zamalowaniem 3282 px. Część różnicy wobec v3 wynika też
z najbliższej nieparzystej w `DOT_D` (2-115: 9 → 7) i z przycinania końców do kropek.

Cztery klasy błędów (zmierzone przez recenzję i potwierdzone na overlayach v3/v4):

1. **Kropki z zamalowanych dziur** (v3). `DOT_HOLE` = `DOT_D`² zamalowywał kółka negacji,
   oczka liter i kratki ramek, przez co kandydatów na kropki było dwa razy więcej
   (2-58: 108 → 236 kropek). Na SM-POSET-1 2-97 największy net urósł do 25 283 px.
   **Naprawione w v4**:
   - liczba kropek (z testem promienia) z zamalowaniem / bez: 2-58 106/108, 2-61 85/83,
     P-X3-2 163/161, SM-POSET-1 2-97 77/77, JPP 2-115 56/58 (v3: 236/174/289/107/241);
   - zysk zostaje: (1480, 243) na P-X3-2 łączy zegar M2 C3/C11 z C bramek M4/M6/M7,
     a złącze 2-61 (716, 679) jest nadal wykrywane;
   - SM-POSET-1 2-97: kółko negacji ~(612, 1203) nie jest już kropką. Przy ~(612, 1046)
     zostaje kandydat r = 3,6 (kółko zlane z grubą ramką układu, bez zamalowania) — to już
     klasa 2.
2. **Złożone układy** (RAM K565 na JPP 2-115, rejestry/liczniki z kolumnami etykiet
   pinów na SM-POSET): czworobok ich nie łapie (JPP 2-115: 3 maski), więc ramki,
   przegródki i kolumny etykiet stają się drutami. Do kr-9p8.3.
3. **Ramka strony i tabliczka.** Na JPP 2-115 ramka arkusza (x ≈ 130–2200, y ≈ 170–1520)
   jest jednym długim „netem”, a tabliczka ma inne położenie i rozmiar niż na P-R3-2, więc
   maska `TITLE` (x ≥ 0,66 W, y ≥ 0,76 H) jej nie obejmuje i tabela tabliczki zamienia się
   w druty. Do nowego beada.
4. **Odręczne dopiski i klamry magistral.** Na SM-POSET 2-97 jest pionowa kreska / klamra
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

### Testy i mutacje

58 testów na syntetycznych obrazach. Druty mają 2–3 px dokładnej szerokości, ramki 5 px,
kropki promień 4 + szerokość. Testy obejmują:

- przegląd grubości kreski 2–6 px;
- tryb (b): grube druty, dwie belki bez boków, za szeroki i za wysoki prostokąt, bok
  z przerwą, stos z cienką górą;
- kropki: kółko negacji na skrzyżowaniu, bladą kropkę, szum w kleksie;
- równoległy drut 10–22 px pod T z kropką (oba ustawienia `T_NEEDS_DOT`);
- słupek „1” przy bramce i przebudowę grafu przy `SPUR_ITERS=1`.

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
  pakietów — JPP i SM-POSET wyglądają inaczej niż P-R3-2), z augmentacją grubości kreski,
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

- SM-POSET-1 2-97: 22/22 bramki, 0 fałszywych ramek, stosy podzielone poprawnie;
- P-X3-2 2-1: 21/21 bramek i 1 rezystor, M3 znaleziona, 0 fałszywych.

### Metoda

Szczegóły są w docstringu. Najważniejsze decyzje:

- **Grubość ramki nie jest kryterium.** Na SM-POSET-1 ramka ma ~1,6 px, tyle co drut;
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
    (SM-POSET H4/J4) też dostaje tę klasę;
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
  ślepy wynik. JPP 2-115 i SM-POSET 2-97 znałem wcześniej z miniatur skanów (opis zadania),
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
| SM-POSET-1 2-97 | 22 | 22 / 1 | 22 / 0 | – |
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
| P-R3-2 2-58…2-63, P-X3-2, JPP, SM-POSET, I-SK1-1 | jak wyżej | bez zmian (te same ramki) |
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
  - SM-POSET: FP (1362, 683, 1398, 997) — prostokąt z drutów przy J2/J6;
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
  | SM-POSET 2-97 | 6 | 80 / 168 / 20 | 90 / 184 / 25 | 3138 px |
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
