// Warstwy płótna a bieżący krok (kr-9p8.20): wyszarzenie / ukrycie części
// innych kroków i kolor pochodzenia elementów bieżącego kroku. Logika w
// stepView.ts (czysta, testowana); tu tylko odczyt ze store.
import { stepStatus, type Src } from '@kronikarz/shared';
import { useDocStore } from '../store.ts';
import { partLook, provColor, type Look, type Part } from '../stepView.ts';

export interface StepView {
  look: (part: Part) => Look;
  /**
   * Kolor pochodzenia, gdy część należy do bieżącego kroku (rola `own`);
   * null = zwykły kolor warstwy. Zaznaczenie i błędy mają pierwszeństwo —
   * warstwa używa tego koloru tylko zamiast koloru domyślnego.
   */
  prov: (part: Part, src: Src) => string | null;
}

export function useStepView(): StepView {
  const step = useDocStore((s) => s.currentStep);
  const others = useDocStore((s) => s.othersMode);
  const steps = useDocStore((s) => s.page?.steps);
  return {
    look: (part) => partLook(part, step, others),
    prov: (part, src) => {
      if (step === null || step === 'kicad') return null;
      if (partLook(part, step, others).role !== 'own') return null;
      return provColor(stepStatus({ steps }, step), src);
    },
  };
}
