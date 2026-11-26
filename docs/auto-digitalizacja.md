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
- **Metryki:** bramki (precision/recall przy IoU ≥ 0,5; dokładność ref/typu/litery), piny
  (dokładność numeru), druty (recall odcinków w tolerancji 3 px), nety (zgodność podziału
  pinów na nety — para pinów w tym samym necie lub nie), porty i cross-refy (dokładność
  etykiet), czas na arkusz.
- **Linia bazowa:** obecny `vision-page.py` (Claude) na tych samych arkuszach.
- **Próg sukcesu etapu:** ≤ 5 poprawek na arkusz przy ≥ 95 % poprawnych par pin–net.

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
