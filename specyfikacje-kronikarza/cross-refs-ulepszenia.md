# Cross-refs — pomysły na ulepszenia

Status: roadmap, nie wszystko zaimplementowane.

Obecny stan (2026-05-19):
- Cross_ref renderowany jako chevron + label NAD wirem + lista sheets obok
- Per-sheet czerwone podświetlenie gdy brak `cross_ref` z tym netem na docelowym arkuszu
- Walidator `CROSS_REF_NO_RETURN` (err) i `CROSS_REF_UNKNOWN_PAGE` (warn)
- `package.yaml` ma `sheet: N` per stronę (1..N w pakiecie), cross_ref używa numerów arkuszy
- `validatePackagePages` ładuje wszystkie strony pakietu i sprawdza powroty

---

## P1 — must-have, mała robota

### 1. Click czerwoną stronę = jump + auto-add

Klik w czerwony numer arkusza (broken page) →
- nawiguj do tego arkusza
- automatycznie utwórz tam cross_ref z tym samym netem, w pozycji domyślnej (np. lewa krawędź)
- pokaż jako placeholder do umieszczenia (drag na właściwe miejsce)

Implementacja: `CrossRefLayer` Text dla page number ma `onClick` (require `listening: true` per token).
Handler nawiguje + dispatch event do edit-flow.

### 2. SelectionPanel: edycja pages przez multi-select

Obecnie field `pages` to string CSV. Zastąpić:
- Lista wszystkich sheets w pakiecie z checkboxami
- Zaznaczone = w `cross_ref.pages`
- Click na sheet ID → nawigacja

Implementacja: nowa sekcja w `cross_ref` panelu w `SelectionPanel.tsx`.

---

## P2 — UX nice

### 3. Auto-sync z portem (validator + fix button)

Jeśli port ma `label = "-BLR"` i jakiś cross_ref ma `label = "-BLR"` na tej samej stronie,
gwarantuj `net` ten sam.
- Validator: nowy kod `PORT_CROSSREF_LABEL_NET_MISMATCH` (warn)
- Auto-fix button w ValidationPanel: ujednolić nety

### 4. Pages range format

Display "2-5" zamiast "2,3,4,5" gdy lista jest contiguous.
Tylko display, w yaml zostają numery (`["2","3","4","5"]`).

Implementacja: helper `formatSheetRanges(pages: string[]): Token[]`.

### 5. Tworzenie cross_refa z wire-toola

W trybie wire albo edit:
- Klawisz X = enter cross-ref-place mode
- Klik na canvas → tworzy cross_ref z auto-name = `net` z najbliższego wire'a/pinu
- Lub: klik na wolny koniec wire'a w wire-toolu → dialog "wstaw cross_ref tu?"

---

## P3 — auto / wizard

### 6. Auto-create reverse cross_ref

Po dodaniu cross_ref na arkuszu A → [B, C], automatycznie:
- Na B: dodaj cross_ref z tym samym netem, pages = [A] (lub append A jeśli istnieje)
- Na C: jak wyżej

Pozycja domyślna: lewa krawędź docelowej strony, user przesuwa później.

Wymaga: edycja innych stron z poziomu jednej. Server musi obsłużyć batch update lub viewer
ładować i zapisywać każdy plik osobno.

### 7. Quick-link mode

Panel/dialog: siatka wszystkich sheets pakietu (12 kafelków per P-R3-2).
User klika które sheets mają mieć ten cross_ref.
Pod spodem flag "auto-create-reverse".

---

## P4 — nice-to-have

### 8. Glow na chevron-dot gdy broken

Czerwona obwódka kuleczki cross_refa gdy ANY page broken.
Aktualnie tylko numery są czerwone — chevron sam pozostaje zielony.

### 9. Hover tooltip: back-refs

Najedź na cross_ref → tooltip pokazuje "widoczny też na arkuszach: 5, 7, 10"
(wyliczone reverse: które arkusze mają ten net w cross_ref.pages wskazującym aktualny arkusz).

### 10. Wizualne grupowanie cross_refów

Jeśli kilka cross_refów leży blisko siebie, grupuj wizualnie (jak na schemacie często chevrony są w kolumnie).

---

## Priorytet sugestia

Zacząć: **P1 (1, 2)** — UX gain duży, robota mała.
Następnie wedle potrzeb.
