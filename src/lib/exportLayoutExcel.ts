import type ExcelJS from 'exceljs';
import type {
  LayoutMachine,
  ProductionMachineAssignment,
  ProductionSetup,
} from '../types';
import { buildDistinctColorMap, buildSetupConstructionColorMap } from './constructionColors';
import { DEFAULT_PIXELS_PER_METER, machineHeightPx, machineWidthPx } from './layoutConstants';
import {
  TASK_OPERATOR_FIELDS,
  type TaskOperatorField,
} from './productionActivityRouting';
import { doffPriorityText } from '../components/ui/doffPriorityText';

const UNPLANNED_FILL_ARGB = 'FFE2E8F0';
const UNASSIGNED_OPR_FILL_ARGB = 'FFF1F5F9';
const HEADER_FILL_ARGB = 'FF0F172A';
const SUBHEADER_FILL_ARGB = 'FF1E293B';
const LABEL_COL_FILL_ARGB = 'FFF8FAFC';
const BORDER_COLOR_ARGB = 'FF334155';

/** Converts `#rrggbb`, `#rgb`, or `hsl(...)` CSS color strings into 8-char Excel ARGB (`FFRRGGBB`). */
export function cssColorToArgb(color: string | undefined, fallback = UNPLANNED_FILL_ARGB): string {
  if (!color) return fallback;
  const trimmed = color.trim();

  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3) {
      const r = hex[0] + hex[0];
      const g = hex[1] + hex[1];
      const b = hex[2] + hex[2];
      return `FF${r}${g}${b}`.toUpperCase();
    }
    if (hex.length === 6) {
      return `FF${hex}`.toUpperCase();
    }
    return fallback;
  }

  const hslMatch = /^hsla?\(\s*([\d.]+)[,\s]+([\d.]+)%[,\s]+([\d.]+)%/i.exec(trimmed);
  if (hslMatch) {
    const h = ((parseFloat(hslMatch[1]) % 360) + 360) % 360;
    const s = Math.max(0, Math.min(1, parseFloat(hslMatch[2]) / 100));
    const l = Math.max(0, Math.min(1, parseFloat(hslMatch[3]) / 100));

    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    const m = l - c / 2;

    let r1 = 0;
    let g1 = 0;
    let b1 = 0;
    if (h < 60) [r1, g1, b1] = [c, x, 0];
    else if (h < 120) [r1, g1, b1] = [x, c, 0];
    else if (h < 180) [r1, g1, b1] = [0, c, x];
    else if (h < 240) [r1, g1, b1] = [0, x, c];
    else if (h < 300) [r1, g1, b1] = [x, 0, c];
    else [r1, g1, b1] = [c, 0, x];

    const toHex = (v: number) =>
      Math.round((v + m) * 255)
        .toString(16)
        .padStart(2, '0')
        .toUpperCase();

    return `FF${toHex(r1)}${toHex(g1)}${toHex(b1)}`;
  }

  return fallback;
}

/** Picks dark or white text color for legible contrast against an ARGB cell background. */
export function contrastTextArgb(bgArgb: string): string {
  const hex = bgArgb.length === 8 ? bgArgb.slice(2) : bgArgb.slice(0, 6);
  const r = parseInt(hex.slice(0, 2), 16) / 255;
  const g = parseInt(hex.slice(2, 4), 16) / 255;
  const b = parseInt(hex.slice(4, 6), 16) / 255;
  const lin = (c: number) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
  const lum = 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
  return lum > 0.36 ? 'FF0F172A' : 'FFFFFFFF';
}

export interface GridColumnDescriptor {
  kind: 'machine' | 'aisle';
  slotIndex?: number;
}

export interface BayOperatorRowSpec {
  rowLabel: string;
  cells: (OperatorCellValue | null)[];
}

export interface OperatorCellValue {
  text: string;
  fillArgb: string;
  textArgb: string;
  mergeKey: string;
}

export interface MachineCellSpec {
  label: string;
  constructionLabel: string;
  constructionId?: string;
  fillArgb: string;
  textArgb: string;
}

export interface LayoutBaySpec {
  bayIndex: number;
  hasSplitTask: boolean;
  operatorRows: BayOperatorRowSpec[];
  machineCells: (MachineCellSpec | null)[];
}

export interface ExcelLayoutGrid {
  columns: GridColumnDescriptor[];
  bays: LayoutBaySpec[];
  plannedCount: number;
  totalMachines: number;
  operatorColorArgb: Map<string, string>;
  constructionColorArgb: Map<string, string>;
}

function median(nums: number[], fallback: number): number {
  if (nums.length === 0) return fallback;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

function hasAnySplitTaskOperator(a: ProductionMachineAssignment | undefined): boolean {
  if (!a) return false;
  return Object.values(TASK_OPERATOR_FIELDS).some((field) => (a[field]?.length ?? 0) > 0);
}

/**
 * Converts flat `(x, y)` shopfloor machine coordinates into aligned Excel columns and bay blocks,
 * preserving walkways as empty spacer columns and switching between 1 Operator row (Multi Task)
 * and 4 Operator rows (Split Task) per bay.
 */
export function buildExcelLayoutGrid(
  setup: ProductionSetup,
  areaByConstructionId: Map<string, string>,
  productIdsInOrder: string[],
): ExcelLayoutGrid {
  const constructionCssMap = buildSetupConstructionColorMap(
    setup.assignments.map((a) => a.constructionDetailId),
    productIdsInOrder,
  );
  const operatorCssMap = buildDistinctColorMap(setup.operators.map((o) => o.id));

  const constructionColorArgb = new Map<string, string>();
  constructionCssMap.forEach((css, id) => constructionColorArgb.set(id, cssColorToArgb(css)));

  const operatorColorArgb = new Map<string, string>();
  operatorCssMap.forEach((css, id) => operatorColorArgb.set(id, cssColorToArgb(css)));

  const assignmentByMachine = new Map(setup.assignments.map((a) => [a.machineId, a]));
  const operatorLabelById = new Map(setup.operators.map((o) => [o.id, o.label]));
  const plannedCount = setup.assignments.filter((a) => a.constructionDetailId).length;

  if (setup.layout.length === 0) {
    return {
      columns: [],
      bays: [],
      plannedCount,
      totalMachines: 0,
      operatorColorArgb,
      constructionColorArgb,
    };
  }

  const ppm = setup.movement?.pixelsPerMeter || DEFAULT_PIXELS_PER_METER;
  const boxes = setup.layout.map((machine) => {
    const w = machineWidthPx(machine, ppm);
    const h = machineHeightPx(machine, ppm);
    return {
      machine,
      x1: machine.x,
      x2: machine.x + w,
      cx: machine.x + w / 2,
      y1: machine.y,
      h,
      cy: machine.y + h / 2,
      w,
    };
  });

  // 1. Group machines into horizontal bays (rows) ordered top-to-bottom.
  const byY = [...boxes].sort((a, b) => a.cy - b.cy || a.cx - b.cx);
  type RawBay = { anchorCy: number; anchorH: number; items: (typeof boxes)[number][] };
  const rawBays: RawBay[] = [];

  for (const box of byY) {
    const current = rawBays[rawBays.length - 1];
    if (!current || Math.abs(box.cy - current.anchorCy) > Math.max(36, current.anchorH * 0.48)) {
      rawBays.push({ anchorCy: box.cy, anchorH: box.h, items: [box] });
    } else {
      current.items.push(box);
      const count = current.items.length;
      current.anchorCy = ((current.anchorCy * (count - 1)) + box.cy) / count;
    }
  }

  const bayOfMachineId = new Map<string, number>();
  rawBays.forEach((bay, bayIdx) => {
    bay.items.sort((a, b) => a.cx - b.cx);
    bay.items.forEach((item) => bayOfMachineId.set(item.machine.id, bayIdx));
  });

  // 2. Align global X positions across bays into columns and insert aisle spacers for true walkways.
  const typicalWidth = median(boxes.map((b) => Math.min(b.w, b.h)), 30);
  const slotTol = Math.max(12, typicalWidth * 0.48);

  const byX = [...boxes].sort((a, b) => a.cx - b.cx || a.cy - b.cy);
  type XCluster = {
    centerCx: number;
    minX1: number;
    maxX2: number;
    bayIndices: Set<number>;
    machineByBay: Map<number, LayoutMachine>;
  };
  const xClusters: XCluster[] = [];

  for (const box of byX) {
    const bayIdx = bayOfMachineId.get(box.machine.id)!;
    const current = xClusters[xClusters.length - 1];
    if (
      current &&
      box.cx - current.centerCx <= slotTol &&
      !current.bayIndices.has(bayIdx)
    ) {
      const n = current.bayIndices.size + 1;
      current.centerCx = ((current.centerCx * (n - 1)) + box.cx) / n;
      current.minX1 = Math.min(current.minX1, box.x1);
      current.maxX2 = Math.max(current.maxX2, box.x2);
      current.bayIndices.add(bayIdx);
      current.machineByBay.set(bayIdx, box.machine);
    } else {
      xClusters.push({
        centerCx: box.cx,
        minX1: box.x1,
        maxX2: box.x2,
        bayIndices: new Set([bayIdx]),
        machineByBay: new Map([[bayIdx, box.machine]]),
      });
    }
  }

  const aisleGapThreshold = Math.max(42, typicalWidth * 1.45);
  const columns: GridColumnDescriptor[] = [];
  xClusters.forEach((_, idx) => {
    if (idx > 0) {
      const gap = xClusters[idx].minX1 - xClusters[idx - 1].maxX2;
      if (gap > aisleGapThreshold) {
        columns.push({ kind: 'aisle' });
      }
    }
    columns.push({ kind: 'machine', slotIndex: idx });
  });

  const cellFromOperatorIds = (ids: string[] | undefined): OperatorCellValue => {
    const cleanIds = (ids ?? []).filter(Boolean);
    if (cleanIds.length === 0) {
      return {
        text: '',
        fillArgb: UNASSIGNED_OPR_FILL_ARGB,
        textArgb: 'FF64748B',
        mergeKey: '',
      };
    }
    const labels = cleanIds.map((id) => operatorLabelById.get(id) ?? id);
    const fillArgb = operatorColorArgb.get(cleanIds[0]) ?? UNASSIGNED_OPR_FILL_ARGB;
    return {
      text: labels.join(' / '),
      fillArgb,
      textArgb: contrastTextArgb(fillArgb),
      mergeKey: `${cleanIds.join('|')}::${fillArgb}`,
    };
  };

  // 3. Build row specs per bay (1 Operator row vs 4 Split Task rows).
  const bays: LayoutBaySpec[] = rawBays.map((bay, bayIdx) => {
    const bayMachines = bay.items.map((item) => item.machine);
    const hasSplitTask = bayMachines.some((m) => hasAnySplitTaskOperator(assignmentByMachine.get(m.id)));

    const areas = new Set(
      bayMachines
        .map((m) => assignmentByMachine.get(m.id)?.constructionDetailId)
        .filter((cid): cid is string => !!cid)
        .map((cid) => areaByConstructionId.get(cid))
        .filter((a): a is string => !!a),
    );
    const hasDiesArea = [...areas].some((a) => ['WW', 'BA', 'CA'].includes(a));
    const hasDefectArea = [...areas].some((a) => ['CB', 'BU', 'SP', 'CH', 'CR'].includes(a));
    const fourthSlotLabel =
      hasDiesArea && !hasDefectArea
        ? 'Dies Change'
        : hasDefectArea && !hasDiesArea
          ? 'Defect Repairing'
          : 'Defect / Dies';

    const machineAtCol = (col: GridColumnDescriptor): LayoutMachine | null => {
      if (col.kind !== 'machine' || col.slotIndex === undefined) return null;
      return xClusters[col.slotIndex]?.machineByBay.get(bayIdx) ?? null;
    };

    const machineCells: (MachineCellSpec | null)[] = columns.map((col) => {
      const m = machineAtCol(col);
      if (!m) return null;
      const a = assignmentByMachine.get(m.id);
      const cid = a?.constructionDetailId;
      const fillArgb = cid ? (constructionColorArgb.get(cid) ?? UNPLANNED_FILL_ARGB) : UNPLANNED_FILL_ARGB;
      return {
        label: m.label,
        constructionLabel: a?.constructionDetailLabel ?? '',
        constructionId: cid,
        fillArgb,
        textArgb: cid ? contrastTextArgb(fillArgb) : 'FF475569',
      };
    });

    const slotOperatorCell = (a: ProductionMachineAssignment | undefined, fields: TaskOperatorField[]): OperatorCellValue => {
      for (const field of fields) {
        if ((a?.[field]?.length ?? 0) > 0) {
          return cellFromOperatorIds(a?.[field]);
        }
      }
      // Multi Task machines in a mixed Split-Task bay mirror their Multi Task operator across all 4 slots.
      return cellFromOperatorIds(a?.assignedOperatorIds);
    };

    const operatorRows: BayOperatorRowSpec[] = hasSplitTask
      ? [
          {
            rowLabel: 'Doffing',
            cells: columns.map((col) => {
              const m = machineAtCol(col);
              return m ? slotOperatorCell(assignmentByMachine.get(m.id), ['doffingOperatorIds']) : null;
            }),
          },
          {
            rowLabel: 'Loading',
            cells: columns.map((col) => {
              const m = machineAtCol(col);
              return m ? slotOperatorCell(assignmentByMachine.get(m.id), ['loadingOperatorIds']) : null;
            }),
          },
          {
            rowLabel: 'Fracture',
            cells: columns.map((col) => {
              const m = machineAtCol(col);
              return m ? slotOperatorCell(assignmentByMachine.get(m.id), ['fractureRepairingOperatorIds']) : null;
            }),
          },
          {
            rowLabel: fourthSlotLabel,
            cells: columns.map((col) => {
              const m = machineAtCol(col);
              if (!m) return null;
              const a = assignmentByMachine.get(m.id);
              const area = a?.constructionDetailId ? areaByConstructionId.get(a.constructionDetailId) : undefined;
              const preferredFields: TaskOperatorField[] =
                area && ['WW', 'BA', 'CA'].includes(area)
                  ? ['diesChangeOperatorIds', 'defectRepairingOperatorIds']
                  : ['defectRepairingOperatorIds', 'diesChangeOperatorIds'];
              return slotOperatorCell(a, preferredFields);
            }),
          },
        ]
      : [
          {
            rowLabel: 'Operator',
            cells: columns.map((col) => {
              const m = machineAtCol(col);
              return m ? cellFromOperatorIds(assignmentByMachine.get(m.id)?.assignedOperatorIds) : null;
            }),
          },
        ];

    return {
      bayIndex: bayIdx,
      hasSplitTask,
      operatorRows,
      machineCells,
    };
  });

  return {
    columns,
    bays,
    plannedCount,
    totalMachines: setup.layout.length,
    operatorColorArgb,
    constructionColorArgb,
  };
}

function thinBorder(): Partial<ExcelJS.Borders> {
  const edge: Partial<ExcelJS.Border> = { style: 'thin', color: { argb: BORDER_COLOR_ARGB } };
  return { top: edge, left: edge, bottom: edge, right: edge };
}

function mergeHorizontalRuns(
  sheet: ExcelJS.Worksheet,
  rowIndex: number,
  colOffset: number,
  keys: string[],
): void {
  let runStart = -1;
  let currentKey = '';

  const flush = (endColOffsetIdx: number) => {
    if (runStart !== -1 && endColOffsetIdx > runStart && currentKey !== '') {
      sheet.mergeCells(rowIndex, colOffset + runStart, rowIndex, colOffset + endColOffsetIdx);
    }
    runStart = -1;
    currentKey = '';
  };

  keys.forEach((key, idx) => {
    if (!key) {
      flush(idx - 1);
      return;
    }
    if (key === currentKey) {
      return;
    }
    flush(idx - 1);
    runStart = idx;
    currentKey = key;
  });
  flush(keys.length - 1);
}

export interface ExportLayoutExcelOptions {
  setup: ProductionSetup;
  areaByConstructionId: Map<string, string>;
  productIdsInOrder: string[];
  theoreticalTotal: number | null;
}

/** Builds a styled 2-sheet ExcelJS workbook (`Layout Map` + `Summary`) for a Production Setup. */
export async function buildLayoutExcelWorkbook(
  options: ExportLayoutExcelOptions,
): Promise<ExcelJS.Workbook> {
  const {
    setup,
    areaByConstructionId,
    productIdsInOrder,
    theoreticalTotal,
  } = options;

  const ExcelJSModule = await import('exceljs');
  const ExcelJSRuntime =
    (ExcelJSModule as unknown as { default?: typeof ExcelJS }).default ?? ExcelJSModule;
  const workbook = new ExcelJSRuntime.Workbook();
  workbook.creator = 'WorkLoad';
  workbook.created = new Date();

  const grid = buildExcelLayoutGrid(setup, areaByConstructionId, productIdsInOrder);
  const startCol = 2; // Col A holds row role labels

  // --- Sheet 1: Layout Map ---
  const mapSheet = workbook.addWorksheet('Layout Map', {
    views: [{ state: 'frozen', xSplit: 1, ySplit: 3, showGridLines: true }],
  });

  mapSheet.getColumn(1).width = 20;
  grid.columns.forEach((col, i) => {
    mapSheet.getColumn(startCol + i).width = col.kind === 'aisle' ? 2.5 : 4.5;
  });

  const bannerLastCol = Math.max(8, startCol + grid.columns.length - 1);
  const titleRow = mapSheet.getRow(1);
  titleRow.height = 24;
  mapSheet.mergeCells(1, 1, 1, bannerLastCol);
  const titleCell = titleRow.getCell(1);
  titleCell.value = `Machine Layout Map — ${setup.name}`;
  titleCell.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  const metaRow = mapSheet.getRow(2);
  metaRow.height = 19;
  mapSheet.mergeCells(2, 1, 2, bannerLastCol);
  const metaCell = metaRow.getCell(1);
  const theoText = theoreticalTotal !== null ? theoreticalTotal.toFixed(2) : '—';
  metaCell.value = `Shift: ${setup.shiftTime} min  |  Planned: ${grid.plannedCount}/${grid.totalMachines} machines  |  Setup Operators: ${setup.operators.length}  |  Theoretical #Opr Required: ${theoText}  |  Exported: ${new Date().toLocaleDateString()}`;
  metaCell.font = { size: 9.5, color: { argb: 'FFE2E8F0' } };
  metaCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: SUBHEADER_FILL_ARGB } };
  metaCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };

  let cursorRow = 4;

  if (grid.bays.length === 0) {
    mapSheet.getCell(cursorRow, 1).value = 'No machines in this setup layout.';
  } else {
    for (const bay of grid.bays) {
      // 1) Operator row(s): 1 for Multi Task bay, 4 for Split Task bay
      for (const oprRowSpec of bay.operatorRows) {
        const row = mapSheet.getRow(cursorRow);
        row.height = 20;

        const labelCell = row.getCell(1);
        labelCell.value = oprRowSpec.rowLabel;
        labelCell.font = { bold: true, size: 9, color: { argb: 'FF1E293B' } };
        labelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LABEL_COL_FILL_ARGB } };
        labelCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
        labelCell.border = thinBorder();

        const mergeKeys: string[] = [];
        oprRowSpec.cells.forEach((cellVal, i) => {
          const excelCell = row.getCell(startCol + i);
          if (!cellVal) {
            mergeKeys.push('');
            return;
          }
          excelCell.value = cellVal.text;
          excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: cellVal.fillArgb } };
          excelCell.font = { bold: true, size: 9.5, color: { argb: cellVal.textArgb } };
          excelCell.alignment = { vertical: 'middle', horizontal: 'center', shrinkToFit: true };
          excelCell.border = thinBorder();
          mergeKeys.push(cellVal.mergeKey);
        });

        mergeHorizontalRuns(mapSheet, cursorRow, startCol, mergeKeys);
        cursorRow += 1;
      }

      // 2) Machines No. row (vertical text stacked, colored by Construction Detail)
      const machineRow = mapSheet.getRow(cursorRow);
      machineRow.height = 56;
      const machineLabelCell = machineRow.getCell(1);
      machineLabelCell.value = 'Machines No.';
      machineLabelCell.font = { bold: true, size: 9, color: { argb: 'FF1E293B' } };
      machineLabelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LABEL_COL_FILL_ARGB } };
      machineLabelCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      machineLabelCell.border = thinBorder();

      bay.machineCells.forEach((mCell, i) => {
        if (!mCell) return;
        const excelCell = machineRow.getCell(startCol + i);
        excelCell.value = mCell.label;
        excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: mCell.fillArgb } };
        excelCell.font = { bold: true, size: 9.5, color: { argb: mCell.textArgb } };
        excelCell.alignment = {
          vertical: 'middle',
          horizontal: 'center',
          textRotation: 'vertical',
        };
        excelCell.border = thinBorder();
      });
      cursorRow += 1;

      // 3) Construction Detail row (merged horizontally for identical contiguous Constructions)
      const constRow = mapSheet.getRow(cursorRow);
      constRow.height = 21;
      const constLabelCell = constRow.getCell(1);
      constLabelCell.value = 'Construction Detail';
      constLabelCell.font = { bold: true, size: 9, color: { argb: 'FF1E293B' } };
      constLabelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: LABEL_COL_FILL_ARGB } };
      constLabelCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
      constLabelCell.border = thinBorder();

      const constMergeKeys: string[] = [];
      bay.machineCells.forEach((mCell, i) => {
        if (!mCell) {
          constMergeKeys.push('');
          return;
        }
        const excelCell = constRow.getCell(startCol + i);
        excelCell.value = mCell.constructionLabel || 'Unplanned';
        excelCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: mCell.fillArgb } };
        excelCell.font = { bold: !!mCell.constructionId, size: 9, color: { argb: mCell.textArgb } };
        excelCell.alignment = { vertical: 'middle', horizontal: 'center', shrinkToFit: true };
        excelCell.border = thinBorder();
        constMergeKeys.push(mCell.constructionId ? `${mCell.constructionId}::${mCell.fillArgb}` : '');
      });

      mergeHorizontalRuns(mapSheet, cursorRow, startCol, constMergeKeys);
      cursorRow += 1;

      // Spacer row between bays
      mapSheet.getRow(cursorRow).height = 14;
      cursorRow += 1;
    }
  }

  if (setup.remarks && setup.remarks.length > 0) {
    cursorRow += 1;
    const remHeader = mapSheet.getRow(cursorRow);
    remHeader.getCell(1).value = 'Layout Remarks';
    remHeader.getCell(1).font = { bold: true, size: 10, color: { argb: 'FF0F172A' } };
    cursorRow += 1;
    for (const remark of setup.remarks) {
      mapSheet.getRow(cursorRow).getCell(1).value = remark.text;
      cursorRow += 1;
    }
  }

  // --- Sheet 2: Summary (Operator, Construction, and Machine List) ---
  const summarySheet = workbook.addWorksheet('Summary', {
    views: [{ showGridLines: true }],
  });

  const styleTableHeader = (row: ExcelJS.Row, headers: string[]) => {
    row.height = 22;
    headers.forEach((h, idx) => {
      const c = row.getCell(idx + 1);
      c.value = h;
      c.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
      c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: HEADER_FILL_ARGB } };
      c.alignment = { vertical: 'middle', horizontal: idx === 0 ? 'center' : 'left' };
      c.border = thinBorder();
    });
  };

  const assignmentByMachine = new Map(setup.assignments.map((a) => [a.machineId, a]));
  const operatorLabelById = new Map(setup.operators.map((o) => [o.id, o.label]));
  const namesOf = (ids: string[] | undefined) =>
    (ids ?? []).map((id) => operatorLabelById.get(id) ?? id).join(', ');

  let sRow = 1;
  summarySheet.getCell(sRow, 1).value = `Operator Summary — ${setup.name}`;
  summarySheet.getCell(sRow, 1).font = { bold: true, size: 12, color: { argb: 'FF0F172A' } };
  sRow += 1;

  styleTableHeader(summarySheet.getRow(sRow), [
    'Color',
    'Operator',
    'Role Mode',
    'Machines',
  ]);
  sRow += 1;

  for (const op of setup.operators) {
    const row = summarySheet.getRow(sRow);
    const machineIds = new Set<string>();
    let usesMulti = false;
    let usesSplit = false;
    for (const a of setup.assignments) {
      if (a.assignedOperatorIds?.includes(op.id)) {
        usesMulti = true;
        machineIds.add(a.machineId);
      }
      if (Object.values(TASK_OPERATOR_FIELDS).some((f) => a[f]?.includes(op.id))) {
        usesSplit = true;
        machineIds.add(a.machineId);
      }
    }
    const modeLabel =
      usesMulti && usesSplit ? 'Multi + Split' : usesSplit ? 'Split Task' : usesMulti ? 'Multi Task' : 'Unassigned';
    const argb = grid.operatorColorArgb.get(op.id) ?? UNASSIGNED_OPR_FILL_ARGB;

    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    row.getCell(2).value = op.label;
    row.getCell(3).value = modeLabel;
    row.getCell(4).value = machineIds.size;
    for (let c = 1; c <= 4; c += 1) {
      row.getCell(c).border = thinBorder();
    }
    sRow += 1;
  }

  sRow += 2;
  summarySheet.getCell(sRow, 1).value = 'Construction Detail Summary';
  summarySheet.getCell(sRow, 1).font = { bold: true, size: 12, color: { argb: 'FF0F172A' } };
  sRow += 1;

  styleTableHeader(summarySheet.getRow(sRow), [
    'Color',
    'Construction Detail',
    'Area',
    'Groups',
    'Planned Machines',
  ]);
  sRow += 1;

  const constStats = new Map<string, { label: string; area: string; groups: Set<string>; count: number }>();
  for (const a of setup.assignments) {
    if (!a.constructionDetailId) continue;
    const entry = constStats.get(a.constructionDetailId) ?? {
      label: a.constructionDetailLabel ?? a.constructionDetailId,
      area: areaByConstructionId.get(a.constructionDetailId) ?? '',
      groups: new Set<string>(),
      count: 0,
    };
    if (a.groupName) entry.groups.add(a.groupName);
    entry.count += 1;
    constStats.set(a.constructionDetailId, entry);
  }

  for (const [cid, stat] of constStats.entries()) {
    const row = summarySheet.getRow(sRow);
    const argb = grid.constructionColorArgb.get(cid) ?? UNPLANNED_FILL_ARGB;
    row.getCell(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb } };
    row.getCell(2).value = stat.label;
    row.getCell(3).value = stat.area || '—';
    row.getCell(4).value = stat.groups.size > 0 ? [...stat.groups].join(', ') : '—';
    row.getCell(5).value = stat.count;
    for (let c = 1; c <= 5; c += 1) {
      row.getCell(c).border = thinBorder();
    }
    sRow += 1;
  }

  sRow += 2;
  summarySheet.getCell(sRow, 1).value = 'Machine Assignment Details';
  summarySheet.getCell(sRow, 1).font = { bold: true, size: 12, color: { argb: 'FF0F172A' } };
  sRow += 1;

  styleTableHeader(summarySheet.getRow(sRow), [
    'Machine',
    'Area',
    'Construction Detail',
    'Group',
    'Multi Task',
    'Doffing',
    'Loading',
    'Fracture',
    'Defect / Dies',
    'Doff Priority',
  ]);
  sRow += 1;

  const sortedMachines = [...setup.layout].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: 'base' }),
  );
  for (const m of sortedMachines) {
    const a = assignmentByMachine.get(m.id);
    const cid = a?.constructionDetailId;
    const area = cid ? (areaByConstructionId.get(cid) ?? '') : '';
    const defectOrDies =
      area && ['WW', 'BA', 'CA'].includes(area)
        ? namesOf(a?.diesChangeOperatorIds)
        : namesOf(a?.defectRepairingOperatorIds) || namesOf(a?.diesChangeOperatorIds);

    const row = summarySheet.getRow(sRow);
    row.getCell(1).value = m.label;
    row.getCell(2).value = area || '—';
    row.getCell(3).value = a?.constructionDetailLabel ?? 'Unplanned';
    row.getCell(4).value = a?.groupName ?? '—';
    row.getCell(5).value = namesOf(a?.assignedOperatorIds) || '—';
    row.getCell(6).value = namesOf(a?.doffingOperatorIds) || '—';
    row.getCell(7).value = namesOf(a?.loadingOperatorIds) || '—';
    row.getCell(8).value = namesOf(a?.fractureRepairingOperatorIds) || '—';
    row.getCell(9).value = defectOrDies || '—';
    row.getCell(10).value = doffPriorityText(a);
    for (let c = 1; c <= 10; c += 1) {
      row.getCell(c).border = thinBorder();
    }
    sRow += 1;
  }

  summarySheet.columns = [
    { width: 12 },
    { width: 24 },
    { width: 32 },
    { width: 18 },
    { width: 20 },
    { width: 18 },
    { width: 16 },
    { width: 18 },
    { width: 18 },
    { width: 14 },
  ];

  return workbook;
}

/** Generates and downloads the formatted Excel layout mapping file in the browser. */
export async function downloadLayoutMappingExcel(options: ExportLayoutExcelOptions): Promise<void> {
  const workbook = await buildLayoutExcelWorkbook(options);
  const buffer = await workbook.xlsx.writeBuffer();
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
  const safeName = (options.setup.name || 'WorkLoad')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .trim();
  const dateTag = new Date().toISOString().slice(0, 10);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${safeName}_Layout_Mapping_${dateTag}.xlsx`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}
