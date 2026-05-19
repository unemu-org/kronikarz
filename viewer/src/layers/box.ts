import type { Gate, Side } from '@kronikarz/shared';

const GATE_W = 80;
const GATE_H_PER_PIN = 22;
const MIN_H = 90;

export function autoBox(g: Gate): { w: number; h: number } {
  const leftPins = g.pins.filter((p) => p.side === 'left').length;
  const rightPins = g.pins.filter((p) => p.side === 'right').length;
  const maxSide = Math.max(leftPins, rightPins, 1);
  return { w: GATE_W, h: Math.max(MIN_H, maxSide * GATE_H_PER_PIN + 20) };
}

export function gateBox(g: Gate): { w: number; h: number } {
  const auto = autoBox(g);
  return { w: g.w ?? auto.w, h: g.h ?? auto.h };
}

// Snap a scan-frame point to the nearest edge of the gate box.
// Returns new scan coords + which side it snapped to.
export function snapPinToEdge(
  g: Gate,
  scanX: number,
  scanY: number,
): { px: number; py: number; side: Side } {
  const rad = (g.rotation * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = scanX - g.x;
  const dy = scanY - g.y;
  // inverse rotation → local frame
  const lx = dx * cos + dy * sin;
  const ly = -dx * sin + dy * cos;
  const { w, h } = gateBox(g);
  const dL = Math.abs(lx + w / 2);
  const dR = Math.abs(lx - w / 2);
  const dT = Math.abs(ly + h / 2);
  const dB = Math.abs(ly - h / 2);
  const min = Math.min(dL, dR, dT, dB);
  let nlx = lx;
  let nly = ly;
  let side: Side;
  const clampY = (v: number): number => Math.max(-h / 2, Math.min(h / 2, v));
  const clampX = (v: number): number => Math.max(-w / 2, Math.min(w / 2, v));
  if (min === dL) {
    nlx = -w / 2;
    nly = clampY(ly);
    side = 'left';
  } else if (min === dR) {
    nlx = w / 2;
    nly = clampY(ly);
    side = 'right';
  } else if (min === dT) {
    nly = -h / 2;
    nlx = clampX(lx);
    side = 'top';
  } else {
    nly = h / 2;
    nlx = clampX(lx);
    side = 'bottom';
  }
  const px = Math.round(g.x + nlx * cos - nly * sin);
  const py = Math.round(g.y + nlx * sin + nly * cos);
  return { px, py, side };
}
