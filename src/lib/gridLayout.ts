import type { LayoutMachine, MachinePairSide } from '../types';
import { MACHINE_H, MACHINE_W } from './layoutConstants';

export const PAIR_GAP = 14;
const ROW_GAP = MACHINE_H + 66;

/**
 * Lays out machines in left/right touching pairs (columns 0&1, 2&3, ...).
 * At 20 px/m, pairs have no internal gap, pair-to-pair spacing is 0.7 m,
 * and row spacing leaves a 3.3 m gap between machine bodies.
 */
export function generatePairedGrid(rows: number, cols: number, startX = 40, startY = 40): LayoutMachine[] {
  const machines: LayoutMachine[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const idx = r * cols + c + 1;
      const pairIndex = Math.floor(c / 2);
      const subIndex = c % 2;
      const pairSide: MachinePairSide = cols % 2 === 1 && c === cols - 1 ? 'single' : subIndex === 0 ? 'left' : 'right';
      const x = startX + pairIndex * (2 * MACHINE_W + PAIR_GAP) + subIndex * MACHINE_W;
      const y = startY + r * ROW_GAP;
      machines.push({
        id: `m-${idx}`,
        label: String(idx),
        x,
        y,
        type: 'normal',
        orientation: r % 2 === 0 ? 'normal' : 'flipped',
        pairSide,
      });
    }
  }
  return machines;
}
