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

interface ColumnPair {
  centerX: number;
  upper?: LayoutMachine;
  lower?: LayoutMachine;
}

function buildFacingColumns(
  upperMachines: { machine: LayoutMachine; centerX: number }[],
  lowerMachines: { machine: LayoutMachine; centerX: number }[],
  thresholdPx: number,
): ColumnPair[] {
  const uSorted = [...upperMachines].sort((a, b) => a.centerX - b.centerX);
  const lSorted = [...lowerMachines].sort((a, b) => a.centerX - b.centerX);

  const columns: ColumnPair[] = [];
  let uIdx = 0;
  let lIdx = 0;

  while (uIdx < uSorted.length || lIdx < lSorted.length) {
    const u = uSorted[uIdx];
    const l = lSorted[lIdx];

    if (u && l && Math.abs(u.centerX - l.centerX) <= thresholdPx) {
      columns.push({
        centerX: (u.centerX + l.centerX) / 2,
        upper: u.machine,
        lower: l.machine,
      });
      uIdx++;
      lIdx++;
    } else if (u && (!l || u.centerX < l.centerX)) {
      columns.push({
        centerX: u.centerX,
        upper: u.machine,
      });
      uIdx++;
    } else if (l) {
      columns.push({
        centerX: l.centerX,
        lower: l.machine,
      });
      lIdx++;
    }
  }

  return columns;
}

/**
 * The order machines are assigned: from the top-left corner, two rows at a time whose Take Ups face
 * each other (or a single row on its own), traversing along aisles in a continuous serpentine (snake)
 * path so that transitions between adjacent aisles enter from whichever end is physically closest.
 * This guarantees that operators assigned blocks of machines always handle compact, contiguous groups
 * without jumping across the factory floor.
 */
export function defaultAssignmentOrder(layout: LayoutMachine[], pixelsPerMeter = DEFAULT_PIXELS_PER_METER): LayoutMachine[] {
  const ppm = pixelsPerMeter > 0 ? pixelsPerMeter : DEFAULT_PIXELS_PER_METER;
  const rows = rowsOf(layout, ppm);
  const order: LayoutMachine[] = [];
  let lastX: number | null = null;

  for (let i = 0; i < rows.length; i += 1) {
    const upper = rows[i];
    const lower = rows[i + 1];

    if (lower && upper.takeUpDown && !lower.takeUpDown) {
      // Facing pair: upper has TU at bottom, lower has TU at top
      const threshold = Math.max(15, (upper.machines[0] ? machineWidthPx(upper.machines[0].machine, ppm) : 30) * 0.7);
      const columns = buildFacingColumns(upper.machines, lower.machines, threshold);

      if (columns.length > 0) {
        const minX = Math.min(...columns.map((c) => c.centerX));
        const maxX = Math.max(...columns.map((c) => c.centerX));

        let direction: 'ltr' | 'rtl' = 'ltr';
        if (lastX !== null) {
          const distToMin = Math.abs(minX - lastX);
          const distToMax = Math.abs(maxX - lastX);
          direction = distToMax < distToMin ? 'rtl' : 'ltr';
        }

        if (direction === 'ltr') {
          columns.sort((a, b) => a.centerX - b.centerX);
          for (const col of columns) {
            if (col.upper) order.push(col.upper);
            if (col.lower) order.push(col.lower);
          }
          lastX = maxX;
        } else {
          columns.sort((a, b) => b.centerX - a.centerX);
          for (const col of columns) {
            if (col.upper) order.push(col.upper);
            if (col.lower) order.push(col.lower);
          }
          lastX = minX;
        }
      }

      i += 1;
    } else {
      // Single row on its own
      const machines = [...upper.machines];
      if (machines.length > 0) {
        const minX = Math.min(...machines.map((m) => m.centerX));
        const maxX = Math.max(...machines.map((m) => m.centerX));

        let direction: 'ltr' | 'rtl' = 'ltr';
        if (lastX !== null) {
          const distToMin = Math.abs(minX - lastX);
          const distToMax = Math.abs(maxX - lastX);
          direction = distToMax < distToMin ? 'rtl' : 'ltr';
        }

        if (direction === 'ltr') {
          machines.sort((a, b) => a.centerX - b.centerX);
          for (const m of machines) {
            order.push(m.machine);
          }
          lastX = maxX;
        } else {
          machines.sort((a, b) => b.centerX - a.centerX);
          for (const m of machines) {
            order.push(m.machine);
          }
          lastX = minX;
        }
      }
    }
  }

  return order;
}
