import type { LayoutMachine } from '../types';
import { DEFAULT_PIXELS_PER_METER, machineHeightPx, machineWidthPx } from './layoutConstants';

/** Row of machines lying at about the same height, left to right. */
interface Row {
  centerY: number;
  height: number;
  machines: { machine: LayoutMachine; centerX: number }[];
  /** Take Up on the bottom ('normal' orientation) for most of the row's machines. */
  takeUpDown: boolean;
}

function rowsOf(layout: LayoutMachine[], pixelsPerMeter: number): Row[] {
  const items = layout
    .map((machine) => {
      const width = machineWidthPx(machine, pixelsPerMeter);
      const height = machineHeightPx(machine, pixelsPerMeter);
      return { machine, centerX: machine.x + width / 2, centerY: machine.y + height / 2, height };
    })
    .sort((a, b) => a.centerY - b.centerY || a.centerX - b.centerX);
  const rows: Row[] = [];
  items.forEach((item) => {
    const row = rows[rows.length - 1];
    // Same row when it sits within half a machine of the row's own height.
    if (row && Math.abs(item.centerY - row.centerY) <= Math.max(row.height, item.height) / 2) {
      row.machines.push({ machine: item.machine, centerX: item.centerX });
    } else {
      rows.push({ centerY: item.centerY, height: item.height, machines: [{ machine: item.machine, centerX: item.centerX }], takeUpDown: false });
    }
  });
  rows.forEach((row) => {
    const down = row.machines.filter(({ machine }) => machine.orientation !== 'flipped').length;
    row.takeUpDown = down * 2 >= row.machines.length;
    row.machines.sort((a, b) => a.centerX - b.centerX);
  });
  return rows;
}

/**
 * The order machines are assigned by default: from the top-left corner, two rows at a time whose
 * Take Ups face each other (a row with TU at the bottom right above one with TU at the top), going
 * left to right and taking the upper then the lower machine of each column — so 4 machines on a
 * 1001… / 2001… pair of rows are 1001, 2001, 1002, 2002. Once a pair of rows is used up it moves on
 * to the next pair down; a row with no facing partner is taken on its own.
 */
export function defaultAssignmentOrder(layout: LayoutMachine[], pixelsPerMeter = DEFAULT_PIXELS_PER_METER): LayoutMachine[] {
  const rows = rowsOf(layout, pixelsPerMeter > 0 ? pixelsPerMeter : DEFAULT_PIXELS_PER_METER);
  const order: LayoutMachine[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    const upper = rows[i];
    const lower = rows[i + 1];
    if (lower && upper.takeUpDown && !lower.takeUpDown) {
      const merged = [
        ...upper.machines.map((entry) => ({ ...entry, rank: 0 })),
        ...lower.machines.map((entry) => ({ ...entry, rank: 1 })),
      ].sort((a, b) => a.centerX - b.centerX || a.rank - b.rank);
      order.push(...merged.map((entry) => entry.machine));
      i += 1;
    } else {
      order.push(...upper.machines.map((entry) => entry.machine));
    }
  }
  return order;
}
