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
| bez sprawdzenia boków czworoboku | two_bars_without_sides |
| bez `_extend_stack` | stack_with_thin_top_frame |
| bez przebudowy grafu po pętli odgałęzień | spur_removal_rebuilds_graph[1] |
| stare zamalowanie (`DOT_D`², bez szarości) | negation_bubble_on_crossing, speckle_hole |
| bez `trim_to_dots` | dot_does_not_bridge_to_parallel_wire[10/12/14] |
| bez wyłączenia kropek z domknięcia | dot_does_not_bridge…[10–22] |
| `BOX_WMAX`/`BOX_HMAX` = ∞ | oversized_box |
| `BOX_SIDE_GAP` = ∞ | two_bars…, stack… |
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
