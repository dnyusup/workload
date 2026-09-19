import { useEffect, useRef, useState, type ReactNode } from 'react';
import type { LayoutMachine, MachinePairSide, OperatorStartPoint } from '../../types';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { MachineZoneLabels } from '../ui/MachineZoneLabels';
import {
  machineWidthPx,
  machineHeightPx,
  DEFAULT_MACHINE_WIDTH_M,
  DEFAULT_MACHINE_LENGTH_M,
} from '../../lib/layoutConstants';
import { generatePairedGrid, PAIR_GAP } from '../../lib/gridLayout';

const PAIR_SIDE_CYCLE: Record<MachinePairSide, MachinePairSide> = {
  single: 'left',
  left: 'right',
  right: 'single',
};

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const FIT_MARGIN = 60;
const MAX_HISTORY = 50;
const PASTE_OFFSET = 30;
/** Matches the app-wide default (see layoutConstants.ts) — overridden by the real Movement
 * Parameters value when this builder is used inside the Simulator setup flow. */
const DEFAULT_PIXELS_PER_METER = 20;

type Point = { x: number; y: number };

type DragState =
  | {
      mode: 'machine';
      startWorld: Point;
      positions: Map<string, Point>;
      /** The layout as it was right before this drag started — pushed to history lazily, only
       * once the pointer actually moves past the click-jitter threshold below, so a plain click
       * (which never moves anything) never records a no-op undo step. */
      snapshot: LayoutMachine[];
      historyPushed: boolean;
      clickedId: string;
      /** Whether `clickedId` was already part of a >1-machine selection at pointerdown — if so,
       * and the pointer never actually drags, pointerup collapses the selection down to just the
       * clicked machine (a plain click always means "select only this one"; only an actual drag
       * means "move the whole group"). */
      wasAlreadyMultiSelected: boolean;
    }
  | { mode: 'pan'; startVb: Point; startPan: Point }
  | { mode: 'select'; startVb: Point; currentVb: Point; rightClick?: boolean; rightClickId?: string }
  | { mode: 'start'; startWorld: Point; startPoint: Point }
  | null;

/** Minimum pointer movement (world units, i.e. independent of zoom) before a machine pointerdown
 * counts as an actual drag rather than click jitter — without this, even a few px of unintentional
 * mouse movement while clicking to select a machine nudges its position, which at 0-gap pair
 * spacing can visually swap which machine appears to sit at a given spot. */
const DRAG_THRESHOLD = 3;

type Measurement = { points: Point[]; done: boolean };

/** Machine "numbers" (labels) must stay unique — parses existing numeric labels and returns the
 * next one after the highest, so Add/Paste never reuse a number still in use elsewhere. */
function nextMachineNumber(existing: LayoutMachine[]): number {
  return existing.reduce((max, m) => {
    const n = parseInt(m.label, 10);
    return Number.isFinite(n) && n > max ? n : max;
  }, 0) + 1;
}

export function LayoutBuilder({
  layout,
  machHandled,
  assignedMachineIds,
  onAssignedChange,
  pixelsPerMeter = DEFAULT_PIXELS_PER_METER,
  readOnly = false,
  selectMachineGroups = true,
  onSelectionChange,
  machineAppearance,
  sidePanel,
  onChange,
  operatorStart,
  onOperatorStartChange,
}: {
  layout: LayoutMachine[];
  /** Only relevant inside the Simulator setup flow — omit to hide the operator-assignment hint
   * (e.g. on the standalone Layouts manager page, which has no operator/machHandled context). */
  machHandled?: number;
  /** Explicit set of machine ids the operator handles — pass together with `onAssignedChange` and
   * `machHandled` to enable the Assign/Unassign-selection UI. Omit to fall back to the old
   * "first N in layout order" highlighting with no assign/unassign controls. */
  assignedMachineIds?: string[];
  onAssignedChange?: (ids: string[]) => void;
  /** Canvas scale used to convert the Measure tool's on-screen distance into meters — pass the
   * real Movement Parameters value where available. */
  pixelsPerMeter?: number;
  /** Disables dragging/adding/removing machines while keeping select, pan, zoom and measure — for
   * callers that only need machine *selection* against a fixed layout (e.g. Production Simulation
   * assigning Construction/operators to a shift-selected group). */
  readOnly?: boolean;
  /** When false, group members can be selected individually for assignment; dragging still moves the whole group. */
  selectMachineGroups?: boolean;
  /** Notified whenever the selection changes — lets a parent drive a "bulk action on selection"
   * panel without owning the selection state itself. */
  onSelectionChange?: (ids: string[]) => void;
  /** Optional per-machine visual overlay — used by Production Simulation to show planning status
   * (unplanned/planned/fully assigned), a unique border color per Construction, and a hover
   * tooltip with Construction + assigned operators. Omit for plain layout editing, where machines
   * keep their normal appearance. */
  machineAppearance?: (machine: LayoutMachine) => { status?: 'unplanned' | 'planned' | 'assigned'; borderColor?: string; tooltip?: string } | undefined;
  /** Extra content (e.g. a bulk "Assign Selection" panel) rendered as a floating panel over the
   * canvas WHILE this builder is in browser fullscreen — the Fullscreen API only keeps this
   * element's own DOM subtree visible, so a selection-actions panel that normally lives outside
   * this component would otherwise disappear the moment fullscreen is entered. */
  sidePanel?: ReactNode;
  onChange: (next: LayoutMachine[]) => void;
  /** Where the operator stands before the simulation starts — one per layout. Omit both this and
   * `onOperatorStartChange` to hide the start-point UI entirely (e.g. the read-only Production
   * Simulation canvas, which has no single-operator concept). */
  operatorStart?: OperatorStartPoint | null;
  onOperatorStartChange?: (point: OperatorStartPoint | null) => void;
}) {
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewSize, setViewSize] = useState({ width: 800, height: 520 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [drag, setDrag] = useState<DragState>(null);
  const [rows, setRows] = useState(2);
  const [cols, setCols] = useState(10);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [history, setHistory] = useState<LayoutMachine[][]>([]);
  const [clipboard, setClipboard] = useState<LayoutMachine[] | null>(null);
  const [pasteCount, setPasteCount] = useState(0);
  const [measureMode, setMeasureMode] = useState(false);
  const [measurement, setMeasurement] = useState<Measurement | null>(null);
  const [measurePreview, setMeasurePreview] = useState<Point | null>(null);
  const hasAutoFitRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const [rowExtendStep, setRowExtendStep] = useState(1);
  const [rowExtendCount, setRowExtendCount] = useState(1);
  const [pasteType, setPasteType] = useState<'pair' | 'single'>('pair');
  const [pasteGapM, setPasteGapM] = useState(PAIR_GAP / DEFAULT_PIXELS_PER_METER);
  const [placingStart, setPlacingStart] = useState(false);

  useEffect(() => {
    onSelectionChange?.(Array.from(selectedIds));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  const toggleMeasureMode = () => {
    setMeasureMode((prev) => !prev);
    setMeasurement(null);
    setMeasurePreview(null);
  };

  const finishMeasuring = () => {
    setMeasurement((prev) => (prev && !prev.done ? { ...prev, done: true } : prev));
  };

  const togglePlacingStart = () => {
    setPlacingStart((prev) => !prev);
  };

  const removeOperatorStart = () => {
    onOperatorStartChange?.(null);
  };

  /** Snapshots the layout as it was right before a mutation, so Undo can restore it. Call this
   * with the pre-mutation `layout` — never after `onChange` has already applied the change. */
  const pushHistory = (snapshot: LayoutMachine[]) => {
    setHistory((prev) => {
      const next = [...prev, snapshot];
      return next.length > MAX_HISTORY ? next.slice(next.length - MAX_HISTORY) : next;
    });
  };

  const undo = () => {
    setHistory((prev) => {
      if (prev.length === 0) return prev;
      onChange(prev[prev.length - 1]);
      return prev.slice(0, -1);
    });
    setSelectedIds(new Set());
  };

  const copySelection = () => {
    if (selectedIds.size === 0) return;
    setClipboard(layout.filter((m) => selectedIds.has(m.id)));
    setPasteCount(0);
  };

  const pasteClipboard = () => {
    if (!clipboard || clipboard.length === 0) return;
    pushHistory(layout);
    const nextCount = pasteCount + 1;
    const offset = PASTE_OFFSET * nextCount;
    const timestamp = Date.now();
    const startNumber = nextMachineNumber(layout);
    const pasted = clipboard.map((m, i) => ({
      ...m,
      id: `m-${timestamp}-${i}`,
      label: String(startNumber + i),
      x: m.x + offset,
      y: m.y + offset,
    }));
    onChange([...layout, ...pasted]);
    setSelectedIds(new Set(pasted.map((m) => m.id)));
    setPasteCount(nextCount);
  };

  const toViewBoxPoint = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width > 0 ? viewSize.width / rect.width : 1;
    const scaleY = rect.height > 0 ? viewSize.height / rect.height : 1;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  const toWorldPoint = (clientX: number, clientY: number): Point => {
    const vb = toViewBoxPoint(clientX, clientY);
    return { x: (vb.x - pan.x) / zoom, y: (vb.y - pan.y) / zoom };
  };

  const zoomAt = (vb: Point, newZoomRaw: number) => {
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoomRaw));
    const worldX = (vb.x - pan.x) / zoom;
    const worldY = (vb.y - pan.y) / zoom;
    setPan({ x: vb.x - worldX * newZoom, y: vb.y - worldY * newZoom });
    setZoom(newZoom);
  };

  const fitToPage = (targetLayout: LayoutMachine[] = layout, size = viewSize) => {
    if (targetLayout.length === 0) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
    const minX = Math.min(...targetLayout.map((m) => m.x));
    const minY = Math.min(...targetLayout.map((m) => m.y));
    const maxX = Math.max(...targetLayout.map((m) => m.x + machineWidthPx(m, pixelsPerMeter)));
    const maxY = Math.max(...targetLayout.map((m) => m.y + machineHeightPx(m, pixelsPerMeter)));
    const contentWidth = Math.max(1, maxX - minX);
    const contentHeight = Math.max(1, maxY - minY);
    const availableWidth = Math.max(50, size.width - FIT_MARGIN * 2);
    const availableHeight = Math.max(50, size.height - FIT_MARGIN * 2);
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(availableWidth / contentWidth, availableHeight / contentHeight)));
    const centerWorldX = (minX + maxX) / 2;
    const centerWorldY = (minY + maxY) / 2;
    setZoom(newZoom);
    setPan({ x: size.width / 2 - centerWorldX * newZoom, y: size.height / 2 - centerWorldY * newZoom });
  };

  // Track the wrapper's actual rendered size so viewBox always matches it 1:1 (no CSS scaling
  // mismatch), and fit the initial layout into view once we know that size.
  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      setViewSize({ width, height });
      if (!hasAutoFitRef.current) {
        hasAutoFitRef.current = true;
        fitToPage(layout, { width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Wheel-to-zoom needs a non-passive native listener so preventDefault actually stops page scroll.
  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();
      const vb = toViewBoxPoint(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(vb, zoom * factor);
    };
    wrapper.addEventListener('wheel', handleWheel, { passive: false });
    return () => wrapper.removeEventListener('wheel', handleWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pan, viewSize]);

  // Re-frame the layout once the browser has actually resized the panel for fullscreen — the
  // ResizeObserver above only auto-fits once, so entering/exiting fullscreen needs its own nudge.
  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsFullscreen(document.fullscreenElement === panelRef.current);
      requestAnimationFrame(() => requestAnimationFrame(() => fitToPage()));
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      panelRef.current?.requestFullscreen();
    }
  };

  // Ctrl/Cmd+Z to undo, Ctrl/Cmd+C / Ctrl/Cmd+V to copy/paste the current selection — skipped while
  // typing in an unrelated text field elsewhere on the page (e.g. Activity Table, Spec form).
  useEffect(() => {
    const isEditableTarget = (target: EventTarget | null) => {
      if (!(target instanceof HTMLElement)) return false;
      const tag = target.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
    };
    const handleKeyDown = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      if (e.key === 'Escape' && measureMode) {
        toggleMeasureMode();
        return;
      }
      if (e.key === 'Enter' && measureMode) {
        finishMeasuring();
        return;
      }
      if (e.key === 'Escape' && placingStart) {
        setPlacingStart(false);
        return;
      }
      if (!(e.ctrlKey || e.metaKey)) return;
      if (readOnly) return;
      const key = e.key.toLowerCase();
      if (key === 'z') {
        e.preventDefault();
        undo();
      } else if (key === 'c') {
        e.preventDefault();
        copySelection();
      } else if (key === 'v') {
        e.preventDefault();
        pasteClipboard();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, selectedIds, history, clipboard, pasteCount, measureMode, placingStart]);

  const handleMachinePointerDown = (id: string) => (e: React.PointerEvent) => {
    // Let the click bubble to the canvas handler so measuring/start-point placement works even
    // when clicking on top of a machine.
    if (measureMode || placingStart) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const clickedMachine = layout.find((m) => m.id === id);
    const groupIds = selectMachineGroups && clickedMachine?.groupId
      ? new Set(layout.filter((m) => m.groupId === clickedMachine.groupId).map((m) => m.id))
      : new Set([id]);
    if (e.button === 2) {
      e.preventDefault();
      const startVb = toViewBoxPoint(e.clientX, e.clientY);
      setDrag({ mode: 'select', startVb, currentVb: startVb, rightClick: true, rightClickId: id });
      return;
    }
    if (e.shiftKey) {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        const shouldRemove = next.has(id);
        groupIds.forEach((groupId) => (shouldRemove ? next.delete(groupId) : next.add(groupId)));
        return next;
      });
      return;
    }
    const wasAlreadyMultiSelected = selectedIds.has(id) && selectedIds.size > 1;
    if (!selectedIds.has(id)) setSelectedIds(groupIds);
    if (readOnly) return;
    // Selection may be individual (so each group member can receive a different assignment),
    // but dragging any member must always move its complete group. Expand every selected
    // machine to its group only for the movement operation.
    const movingIds = new Set<string>();
    const moveSelection = wasAlreadyMultiSelected ? new Set([...selectedIds, ...groupIds]) : groupIds;
    moveSelection.forEach((selectedId) => {
      const selected = layout.find((machine) => machine.id === selectedId);
      if (selected?.groupId) {
        layout
          .filter((machine) => machine.groupId === selected.groupId)
          .forEach((machine) => movingIds.add(machine.id));
      } else {
        movingIds.add(selectedId);
      }
    });
    const positions = new Map<string, Point>();
    layout.forEach((m) => {
      if (movingIds.has(m.id)) positions.set(m.id, { x: m.x, y: m.y });
    });
    setDrag({
      mode: 'machine',
      startWorld: toWorldPoint(e.clientX, e.clientY),
      positions,
      snapshot: layout,
      historyPushed: false,
      clickedId: id,
      wasAlreadyMultiSelected,
    });
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (placingStart) {
      const world = toWorldPoint(e.clientX, e.clientY);
      onOperatorStartChange?.(world);
      setPlacingStart(false);
      return;
    }
    if (measureMode) {
      const world = toWorldPoint(e.clientX, e.clientY);
      setMeasurement((prev) => (!prev || prev.done ? { points: [world], done: false } : { ...prev, points: [...prev.points, world] }));
      setMeasurePreview(world);
      return;
    }
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    const vb = toViewBoxPoint(e.clientX, e.clientY);
    if (e.button === 2 || e.shiftKey) {
      setDrag({ mode: 'select', startVb: vb, currentVb: vb, rightClick: e.button === 2 });
    } else {
      setSelectedIds(new Set());
      setDrag({ mode: 'pan', startVb: vb, startPan: pan });
    }
  };

  const handleStartPointerDown = (e: React.PointerEvent) => {
    if (measureMode || placingStart || readOnly || !operatorStart || !onOperatorStartChange) return;
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    setDrag({ mode: 'start', startWorld: toWorldPoint(e.clientX, e.clientY), startPoint: operatorStart });
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (measureMode && measurement && !measurement.done) {
      setMeasurePreview(toWorldPoint(e.clientX, e.clientY));
    }
    if (!drag) return;
    if (drag.mode === 'machine') {
      const world = toWorldPoint(e.clientX, e.clientY);
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      if (!drag.historyPushed && Math.hypot(dx, dy) < DRAG_THRESHOLD) return;
      if (!drag.historyPushed) {
        pushHistory(drag.snapshot);
        setDrag({ ...drag, historyPushed: true });
      }
      onChange(
        layout.map((m) => {
          const start = drag.positions.get(m.id);
          if (!start) return m;
          return { ...m, x: Math.max(0, start.x + dx), y: Math.max(0, start.y + dy) };
        }),
      );
    } else if (drag.mode === 'pan') {
      const vb = toViewBoxPoint(e.clientX, e.clientY);
      setPan({ x: drag.startPan.x + (vb.x - drag.startVb.x), y: drag.startPan.y + (vb.y - drag.startVb.y) });
    } else if (drag.mode === 'select') {
      setDrag({ ...drag, currentVb: toViewBoxPoint(e.clientX, e.clientY) });
    } else if (drag.mode === 'start') {
      const world = toWorldPoint(e.clientX, e.clientY);
      const dx = world.x - drag.startWorld.x;
      const dy = world.y - drag.startWorld.y;
      onOperatorStartChange?.({ x: Math.max(0, drag.startPoint.x + dx), y: Math.max(0, drag.startPoint.y + dy) });
    }
  };

  const handlePointerUp = () => {
    if (drag?.mode === 'select') {
      const { startVb, currentVb } = drag;
      const rightClickId = drag.rightClickId;
      const movedEnough = Math.hypot(currentVb.x - startVb.x, currentVb.y - startVb.y) >= DRAG_THRESHOLD;
      if (rightClickId && !movedEnough) {
        const clickedMachine = layout.find((machine) => machine.id === rightClickId);
        const selectedGroupIds =
          selectMachineGroups && clickedMachine?.groupId
            ? layout.filter((machine) => machine.groupId === clickedMachine.groupId).map((machine) => machine.id)
            : [rightClickId];
        setSelectedIds(new Set(selectedGroupIds));
        setDrag(null);
        return;
      }
      const minVb = { x: Math.min(startVb.x, currentVb.x), y: Math.min(startVb.y, currentVb.y) };
      const maxVb = { x: Math.max(startVb.x, currentVb.x), y: Math.max(startVb.y, currentVb.y) };
      const minWorld = { x: (minVb.x - pan.x) / zoom, y: (minVb.y - pan.y) / zoom };
      const maxWorld = { x: (maxVb.x - pan.x) / zoom, y: (maxVb.y - pan.y) / zoom };
      const hits = layout
        .filter((m) => m.x < maxWorld.x && m.x + machineWidthPx(m, pixelsPerMeter) > minWorld.x && m.y < maxWorld.y && m.y + machineHeightPx(m, pixelsPerMeter) > minWorld.y)
        .map((m) => m.id);
      if (hits.length > 0) {
        const hitSet = new Set(hits);
        layout.forEach((machine) => {
          if (
            selectMachineGroups &&
            machine.groupId &&
            hits.some((id) => layout.find((candidate) => candidate.id === id)?.groupId === machine.groupId)
          ) {
            hitSet.add(machine.id);
          }
        });
        setSelectedIds((prev) => (drag.rightClick ? hitSet : new Set([...prev, ...hitSet])));
      }
    }
    const clickedMachine = drag?.mode === 'machine' ? layout.find((m) => m.id === drag.clickedId) : undefined;
    if (drag?.mode === 'machine' && !drag.historyPushed && drag.wasAlreadyMultiSelected && !clickedMachine?.groupId) {
      // Plain click on a machine that was already part of a larger selection, with no actual
      // drag — collapse the selection down to just this one. A real drag instead moves (and
      // keeps selected) the whole group; only a no-op click means "select only this machine".
      setSelectedIds(new Set([drag.clickedId]));
    }
    setDrag(null);
  };

  const addMachine = () => {
    pushHistory(layout);
    const id = `m-${Date.now()}`;
    onChange([
      ...layout,
      { id, label: String(nextMachineNumber(layout)), x: 40, y: 40, type: 'normal', orientation: 'normal', pairSide: 'single' },
    ]);
    setSelectedIds(new Set([id]));
  };

  const [groupOpen, setGroupOpen] = useState(false);
  const [groupWidthM, setGroupWidthM] = useState(String(DEFAULT_MACHINE_WIDTH_M));
  const [groupLengthM, setGroupLengthM] = useState(String(DEFAULT_MACHINE_LENGTH_M));
  const [groupCount, setGroupCount] = useState('2');

  const addMachineGroup = () => {
    const widthM = parseFloat(groupWidthM);
    const lengthM = parseFloat(groupLengthM);
    const count = parseInt(groupCount, 10);
    if (!Number.isFinite(widthM) || widthM <= 0 || !Number.isFinite(lengthM) || lengthM <= 0 || !Number.isInteger(count) || count < 2) return;
    pushHistory(layout);
    const timestamp = Date.now();
    const groupId = `machine-group-${timestamp}`;
    const firstNumber = nextMachineNumber(layout);
    const widthPx = widthM * pixelsPerMeter;
    const created = Array.from({ length: count }, (_, index): LayoutMachine => ({
      id: `m-${timestamp}-${index}`,
      groupId,
      label: String(firstNumber + index),
      x: 40 + index * widthPx,
      y: 40,
      type: 'normal',
      orientation: 'normal',
      pairSide: 'single',
      widthM,
      lengthM,
    }));
    onChange([...layout, ...created]);
    setSelectedIds(new Set(created.map((machine) => machine.id)));
    setGroupOpen(false);
  };

  const removeSelected = () => {
    if (selectedIds.size === 0) return;
    pushHistory(layout);
    onChange(layout.filter((m) => !selectedIds.has(m.id)));
    setSelectedIds(new Set());
  };

  const toggleType = () => {
    if (selectedIds.size === 0) return;
    pushHistory(layout);
    onChange(layout.map((m) => (selectedIds.has(m.id) ? { ...m, type: m.type === 'bfx' ? 'normal' : 'bfx' } : m)));
  };

  const toggleOrientation = () => {
    if (selectedIds.size === 0) return;
    pushHistory(layout);
    onChange(
      layout.map((m) => (selectedIds.has(m.id) ? { ...m, orientation: m.orientation === 'flipped' ? 'normal' : 'flipped' } : m)),
    );
  };

  const cyclePairSide = () => {
    if (selectedIds.size === 0) return;
    pushHistory(layout);
    onChange(layout.map((m) => (selectedIds.has(m.id) ? { ...m, pairSide: PAIR_SIDE_CYCLE[m.pairSide] } : m)));
  };

  const [resizeOpen, setResizeOpen] = useState(false);
  const [resizeWidthM, setResizeWidthM] = useState('');
  const [resizeLengthM, setResizeLengthM] = useState('');

  const openResize = () => {
    if (selectedIds.size === 0) return;
    const first = layout.find((m) => selectedIds.has(m.id));
    setResizeWidthM(String(first?.widthM ?? DEFAULT_MACHINE_WIDTH_M));
    setResizeLengthM(String(first?.lengthM ?? DEFAULT_MACHINE_LENGTH_M));
    setResizeOpen(true);
  };

  const applyResize = () => {
    const widthM = parseFloat(resizeWidthM);
    const lengthM = parseFloat(resizeLengthM);
    if (!Number.isFinite(widthM) || widthM <= 0 || !Number.isFinite(lengthM) || lengthM <= 0) return;
    pushHistory(layout);
    onChange(layout.map((m) => (selectedIds.has(m.id) ? { ...m, widthM, lengthM } : m)));
    setResizeOpen(false);
  };

  const generateGrid = () => {
    pushHistory(layout);
    const next = generatePairedGrid(rows, cols);
    onChange(next);
    setSelectedIds(new Set());
    fitToPage(next);
  };

  const clearAll = () => {
    pushHistory(layout);
    onChange([]);
    setSelectedIds(new Set());
  };

  const assignedSet = new Set(assignedMachineIds ?? []);
  const assignedCount = layout.reduce((n, m) => (assignedSet.has(m.id) ? n + 1 : n), 0);
  const assignCapacity = machHandled !== undefined ? Math.max(0, machHandled - assignedCount) : Infinity;

  const assignSelection = () => {
    if (!onAssignedChange || selectedIds.size === 0) return;
    const toAdd = layout.filter((m) => selectedIds.has(m.id) && !assignedSet.has(m.id)).slice(0, assignCapacity);
    if (toAdd.length === 0) return;
    onAssignedChange([...(assignedMachineIds ?? []), ...toAdd.map((m) => m.id)]);
  };

  const unassignSelection = () => {
    if (!onAssignedChange || selectedIds.size === 0) return;
    onAssignedChange((assignedMachineIds ?? []).filter((id) => !selectedIds.has(id)));
  };

  const soleSelected = selectedIds.size === 1 ? layout.find((m) => selectedIds.has(m.id)) : undefined;

  // Keeps the rename box in sync with whichever single machine is currently selected — reset to
  // blank once the selection stops being exactly one machine, so a stale number can't linger.
  useEffect(() => {
    setRenameValue(soleSelected?.label ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [soleSelected?.id]);

  const commitRename = () => {
    if (!soleSelected || renameValue.trim() === '' || renameValue === soleSelected.label) return;
    pushHistory(layout);
    onChange(layout.map((m) => (m.id === soleSelected.id ? { ...m, label: renameValue.trim() } : m)));
  };

  /** Duplicates the current selection immediately to its left or right, `rowExtendCount` times.
   * The `pasteType` setting controls the layout convention used for the new copies:
   * - 'pair' (default): SAME paired spacing convention as Generate Grid (machines touching in
   *   left/right pairs with zero internal gap, `pasteGapPx` between pairs) rather than flush
   *   copies with no gap at all — so an extended row looks like it came out of the grid
   *   generator, not hand-pasted.
   *   - A 2-machine selection (already a formed pair) repeats as a whole pair, with `pasteGapPx`
   *     between each successive pair.
   *   - A single-machine selection pairs up the newly pasted copies two at a time (alternating
   *     'left'/'right' pairSide), inserting `pasteGapPx` before every new pair — including the
   *     first, so the new block reads as its own pair group next to the source machine.
   * - 'single': every pasted copy is forced to `pairSide: 'single'` and placed one after another,
   *   each separated from the previous by `pasteGapPx` (the "jarak antar mesin" setting) — no
   *   pairing/alternation at all. Only the first selected machine is used as the repeating source.
   * Each copy's machine number is shifted by `rowExtendStep` from the previous one. */
  const pasteRowExtend = (direction: 'left' | 'right') => {
    if (selectedIds.size === 0 || rowExtendCount < 1) return;
    const selectedMachines = layout.filter((m) => selectedIds.has(m.id)).sort((a, b) => a.x - b.x);
    if (selectedMachines.length === 0) return;
    const pasteGapPx = Math.max(0, pasteGapM) * pixelsPerMeter;
    const sign = direction === 'right' ? 1 : -1;
    pushHistory(layout);
    const timestamp = Date.now();
    const created: LayoutMachine[] = [];

    if (pasteType === 'single') {
      const base = selectedMachines[0];
      const baseWidth = machineWidthPx(base, pixelsPerMeter);
      const baseOriginalNumber = parseInt(base.label, 10);
      const step = baseWidth + pasteGapPx;
      for (let i = 1; i <= rowExtendCount; i += 1) {
        const offsetX = sign * step * i;
        const newLabel = Number.isFinite(baseOriginalNumber) ? String(baseOriginalNumber + rowExtendStep * i) : `${base.label}-${i}`;
        created.push({ ...base, id: `m-${timestamp}-${i}`, label: newLabel, x: base.x + offsetX, pairSide: 'single' });
      }
    } else if (selectedMachines.length === 2) {
      const minX = Math.min(...selectedMachines.map((m) => m.x));
      const maxX = Math.max(...selectedMachines.map((m) => m.x + machineWidthPx(m, pixelsPerMeter)));
      const groupWidth = Math.max(1, maxX - minX);
      const step = groupWidth + pasteGapPx;
      for (let i = 1; i <= rowExtendCount; i += 1) {
        const offsetX = sign * step * i;
        selectedMachines.forEach((m, idx) => {
          const originalNumber = parseInt(m.label, 10);
          const newLabel = Number.isFinite(originalNumber) ? String(originalNumber + rowExtendStep * i) : `${m.label}-${i}`;
          created.push({ ...m, id: `m-${timestamp}-${i}-${idx}`, label: newLabel, x: m.x + offsetX });
        });
      }
    } else {
      const minX = Math.min(...selectedMachines.map((m) => m.x));
      const maxX = Math.max(...selectedMachines.map((m) => m.x + machineWidthPx(m, pixelsPerMeter)));
      const groupWidth = Math.max(1, maxX - minX);
      const base = selectedMachines[0];
      const baseWidth = machineWidthPx(base, pixelsPerMeter);
      const baseOriginalNumber = parseInt(base.label, 10);
      // If the source is a lone 'left' half being extended rightward (or a lone 'right' half
      // extended leftward), the very first pasted machine completes THAT pair — touching, 0
      // gap — instead of starting a brand new pair with pasteGapPx, so the row's left/right
      // alternation stays consistent instead of leaving the source as a stray half-pair.
      const completesPairFirst =
        (direction === 'right' && base.pairSide === 'left') || (direction === 'left' && base.pairSide === 'right');
      // Once the completing machine is placed, it and the source together occupy 2×groupWidth —
      // the "fresh pairs" run has to start past BOTH of them, not just past the source, or the
      // first fresh pair lands on top of the completing machine.
      const freshRunStart = completesPairFirst ? 2 * groupWidth + pasteGapPx : groupWidth + pasteGapPx;

      interface Spec {
        x: number;
        label: string;
        forcedPairSide?: MachinePairSide;
        pairSide?: MachinePairSide;
      }
      const specs: Spec[] = [];
      for (let i = 1; i <= rowExtendCount; i += 1) {
        let columnOffset: number;
        let forcedPairSide: MachinePairSide | undefined;
        if (completesPairFirst && i === 1) {
          columnOffset = groupWidth;
          forcedPairSide = direction === 'right' ? 'right' : 'left';
        } else {
          const j = completesPairFirst ? i - 2 : i - 1; // index within the "fresh pairs" run
          const pairIndex = Math.floor(j / 2);
          const subIndex = j % 2;
          columnOffset = freshRunStart + pairIndex * (2 * baseWidth + pasteGapPx) + subIndex * baseWidth;
        }
        const newLabel = Number.isFinite(baseOriginalNumber) ? String(baseOriginalNumber + rowExtendStep * i) : `${base.label}-${i}`;
        specs.push({ x: base.x + sign * columnOffset, label: newLabel, forcedPairSide });
      }

      // Fresh (non-forced) entries get their left/right assigned by comparing actual resulting X
      // within each consecutive twosome — avoids sign confusion between paste directions, since
      // "smaller offset" doesn't consistently mean "more to the left" once direction flips it.
      const freshEntries = specs.filter((s) => !s.forcedPairSide);
      for (let k = 0; k < freshEntries.length; k += 2) {
        const a = freshEntries[k];
        const b = freshEntries[k + 1];
        if (b) {
          const [leftOne, rightOne] = a.x <= b.x ? [a, b] : [b, a];
          leftOne.pairSide = 'left';
          rightOne.pairSide = 'right';
        } else {
          a.pairSide = 'single';
        }
      }
      specs.forEach((s) => {
        if (s.forcedPairSide) s.pairSide = s.forcedPairSide;
      });

      specs.forEach((s, idx) => {
        created.push({ ...base, id: `m-${timestamp}-${idx}`, label: s.label, x: s.x, pairSide: s.pairSide ?? 'single' });
      });
    }

    onChange([...layout, ...created]);
    setSelectedIds(new Set(created.map((m) => m.id)));
  };

  const distanceM = (a: Point, b: Point) => Math.hypot(b.x - a.x, b.y - a.y) / pixelsPerMeter;
  const measureSegments = measurement
    ? measurement.points.slice(0, -1).map((from, i) => {
        const to = measurement.points[i + 1];
        return { from, to, distance: distanceM(from, to) };
      })
    : [];
  const measureLastPoint = measurement && measurement.points.length > 0 ? measurement.points[measurement.points.length - 1] : null;
  const measureLiveSegment =
    measurement && !measurement.done && measurePreview && measureLastPoint
      ? { from: measureLastPoint, to: measurePreview, distance: distanceM(measureLastPoint, measurePreview) }
      : null;
  const measureSegmentCount = measureSegments.length + (measureLiveSegment ? 1 : 0);
  const measureTotal = measureSegments.reduce((sum, s) => sum + s.distance, 0) + (measureLiveSegment?.distance ?? 0);
  const measureTotalAnchor = measureLiveSegment?.to ?? measureLastPoint;

  return (
    <Card
      ref={panelRef}
      className={isFullscreen ? 'layout-builder-fullscreen' : ''}
      title="Machine Layout"
      subtitle="Drag to pan, scroll to zoom. Click a machine to select (Shift+click/drag for multiple)."
      actions={
        <div className="toolbar">
          {!readOnly && (
            <>
              <input
                className="input input-sm"
                type="number"
                value={rows}
                min={1}
                onChange={(e) => setRows(parseInt(e.target.value) || 1)}
                title="Number of rows"
              />
              <span className="toolbar-x">x</span>
              <input
                className="input input-sm"
                type="number"
                value={cols}
                min={1}
                onChange={(e) => setCols(parseInt(e.target.value) || 1)}
                title="Number of columns"
              />
              <Button variant="secondary" onClick={generateGrid}>
                Generate Grid
              </Button>
              <Button variant="primary" onClick={addMachine}>
                + Add Machine
              </Button>
              <Button variant="secondary" onClick={() => setGroupOpen(true)}>
                + Add Group Machine
              </Button>
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={toggleType}
                disabled={selectedIds.size === 0}
                title="Toggle selected machine type between BF and X"
                aria-label="Toggle machine type between BF and X"
              >
                ⇄
              </Button>
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={toggleOrientation}
                disabled={selectedIds.size === 0}
                title="Flip selected machine orientation"
                aria-label="Flip machine orientation"
              >
                🔄
              </Button>
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={cyclePairSide}
                disabled={selectedIds.size === 0}
                title={soleSelected ? `Cycle pair side (current: ${soleSelected.pairSide})` : 'Cycle pair side'}
                aria-label="Cycle pair side"
              >
                ⟳
              </Button>
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={openResize}
                disabled={selectedIds.size === 0}
                title="Resize selected machine(s)"
                aria-label="Resize selected machines"
              >
                ⤢
              </Button>
              <Button
                variant="danger"
                className="toolbar-icon-button"
                onClick={removeSelected}
                disabled={selectedIds.size === 0}
                title={`Remove selected machine${selectedIds.size > 1 ? 's' : ''}`}
                aria-label={`Remove selected machine${selectedIds.size > 1 ? 's' : ''}`}
              >
                🗑
              </Button>
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={clearAll}
                title="Clear all machines from the layout"
                aria-label="Clear all machines"
              >
                🧹
              </Button>
              <span className="toolbar-divider" />
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={undo}
                disabled={history.length === 0}
                title="Undo (Ctrl+Z)"
                aria-label="Undo"
              >
                ↶
              </Button>
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={copySelection}
                disabled={selectedIds.size === 0}
                title="Copy selected machine(s) (Ctrl+C)"
                aria-label="Copy selected machines"
              >
                ⧉
              </Button>
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={pasteClipboard}
                disabled={!clipboard}
                title="Paste copied machine(s) (Ctrl+V)"
                aria-label="Paste copied machines"
              >
                📋
              </Button>
              <span className="toolbar-divider" />
            </>
          )}
          <Button
            variant="ghost"
            className="toolbar-icon-button"
            onClick={() => zoomAt({ x: viewSize.width / 2, y: viewSize.height / 2 }, zoom / 1.25)}
            title="Zoom out"
            aria-label="Zoom out"
          >
            🔍−
          </Button>
          <span className="toolbar-zoom-readout">{Math.round(zoom * 100)}%</span>
          <Button
            variant="ghost"
            className="toolbar-icon-button"
            onClick={() => zoomAt({ x: viewSize.width / 2, y: viewSize.height / 2 }, zoom * 1.25)}
            title="Zoom in"
            aria-label="Zoom in"
          >
            🔍+
          </Button>
          <Button
            variant="ghost"
            className="toolbar-icon-button"
            onClick={() => fitToPage()}
            title="Fit layout to page"
            aria-label="Fit layout to page"
          >
            ⊡
          </Button>
          <span className="toolbar-divider" />
          <Button
            variant={measureMode ? 'primary' : 'ghost'}
            className="toolbar-icon-button"
            onClick={toggleMeasureMode}
            title="Click points on the canvas to measure a bent path between them (Enter to finish, Esc to exit)"
            aria-label="Measure distance"
          >
            📏
          </Button>
          {measureMode && measurement && !measurement.done && (
            <Button
              variant="ghost"
              className="toolbar-icon-button"
              onClick={finishMeasuring}
              title="Finish this measurement (Enter)"
              aria-label="Finish measuring"
            >
              ✓
            </Button>
          )}
          {onOperatorStartChange && !readOnly && (
            <>
              <span className="toolbar-divider" />
              <Button
                variant={placingStart ? 'primary' : 'ghost'}
                className="toolbar-icon-button"
                onClick={togglePlacingStart}
                title="Click on the canvas to set where the operator stands before the simulation starts (Esc to cancel)"
                aria-label={operatorStart ? 'Move operator start point' : 'Set operator start point'}
              >
                📍
              </Button>
              {operatorStart && (
                <Button
                  variant="ghost"
                  className="toolbar-icon-button"
                  onClick={removeOperatorStart}
                  title="Remove the operator start point"
                  aria-label="Remove operator start point"
                >
                  ✕
                </Button>
              )}
            </>
          )}
          <span className="toolbar-divider" />
          <Button
            variant="ghost"
            className="toolbar-icon-button"
            onClick={toggleFullscreen}
            title={isFullscreen ? 'Exit fullscreen' : 'Open fullscreen'}
            aria-label={isFullscreen ? 'Exit fullscreen' : 'Open fullscreen'}
          >
            ⛶
          </Button>
        </div>
      }
    >
      {machHandled !== undefined && onAssignedChange && (
        <div className="toolbar layout-builder-edit-row layout-builder-assignment-row">
          <p className="hint-row" style={{ margin: 0 }}>
            Total machines: <strong>{layout.length}</strong> &middot; Assigned to operator:{' '}
            <strong>{assignedCount}</strong> / {machHandled}
            {assignedCount !== machHandled && (
              <span className="warning-text">
                {' '}
                &mdash; {assignedCount < machHandled
                  ? `select ${machHandled - assignedCount} more machine(s) and click Assign`
                  : `unassign ${assignedCount - machHandled} machine(s) to continue`}
              </span>
            )}
          </p>
          <Button
            variant="primary"
            className="toolbar-icon-button"
            onClick={assignSelection}
            disabled={selectedIds.size === 0 || assignCapacity <= 0}
            title={assignCapacity <= 0 ? 'Already at the machHandled limit — unassign some first' : 'Assign the selected machine(s) to this operator'}
            aria-label="Assign selected machines"
          >
            📌
          </Button>
          <Button
            variant="ghost"
            className="toolbar-icon-button"
            onClick={unassignSelection}
            disabled={selectedIds.size === 0}
            title="Unassign selected machine(s) from this operator"
            aria-label="Unassign selected machines"
          >
            ↩
          </Button>
        </div>
      )}
      {!readOnly && (
        <div className="toolbar layout-builder-edit-row">
          {soleSelected && (
            <>
              <span className="toolbar-x">Machine No.</span>
              <input
                className="input input-sm"
                style={{ width: 80 }}
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onBlur={commitRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    commitRename();
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                title="Change this machine's number/label"
              />
              <span className="toolbar-divider" />
            </>
          )}
          <span className="toolbar-x">Type</span>
          <select
            className="input input-sm"
            style={{ width: 80 }}
            value={pasteType}
            onChange={(e) => setPasteType(e.target.value as 'pair' | 'single')}
            title="Pair: paste as left/right pairs (default). Single: paste all as single machines."
          >
            <option value="pair">Pair</option>
            <option value="single">Single</option>
          </select>
          <span className="toolbar-x">Step</span>
          <input
            className="input input-sm"
            type="number"
            style={{ width: 60 }}
            value={rowExtendStep}
            onChange={(e) => setRowExtendStep(parseInt(e.target.value, 10) || 0)}
            title="Machine number offset per paste (can be negative, e.g. -1)"
          />
          <span className="toolbar-x">Count</span>
          <input
            className="input input-sm"
            type="number"
            min={1}
            style={{ width: 60 }}
            value={rowExtendCount}
            onChange={(e) => setRowExtendCount(Math.max(1, parseInt(e.target.value, 10) || 1))}
            title="How many times to repeat the paste"
          />
          <span className="toolbar-x">Jarak (m)</span>
          <input
            className="input input-sm"
            type="number"
            min={0}
            step={0.1}
            style={{ width: 70 }}
            value={pasteGapM}
            onChange={(e) => setPasteGapM(Math.max(0, parseFloat(e.target.value) || 0))}
            title={
              pasteType === 'pair'
                ? 'Distance (meters) between each pair of pasted machines'
                : 'Distance (meters) between each pasted machine'
            }
          />
          <Button
            variant="secondary"
            className="toolbar-icon-button"
            onClick={() => pasteRowExtend('left')}
            disabled={selectedIds.size === 0}
            title="Duplicate the selected machine(s) to the left, numbers shifted by Step, repeated Count times"
            aria-label="Paste repeated machines to the left"
          >
            ←
          </Button>
          <Button
            variant="secondary"
            className="toolbar-icon-button"
            onClick={() => pasteRowExtend('right')}
            disabled={selectedIds.size === 0}
            title="Duplicate the selected machine(s) to the right, numbers shifted by Step, repeated Count times"
            aria-label="Paste repeated machines to the right"
          >
            →
          </Button>
        </div>
      )}
      <div className="layout-canvas-wrap" ref={wrapperRef}>
        {isFullscreen && sidePanel && <div className="layout-builder-fullscreen-sidepanel">{sidePanel}</div>}
        <svg
          ref={svgRef}
          width="100%"
          height="100%"
          viewBox={`0 0 ${viewSize.width} ${viewSize.height}`}
          className={`layout-svg ${drag?.mode === 'pan' ? 'layout-svg-panning' : ''} ${measureMode || placingStart ? 'layout-svg-measuring' : ''}`}
          onPointerDown={handleCanvasPointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onContextMenu={(e) => e.preventDefault()}
        >
          <defs>
            <pattern id="machine-selection-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
              <line x1="0" y1="0" x2="0" y2="8" className="machine-selection-hatch-line" />
            </pattern>
            <filter id="machine-selection-glow" x="-50%" y="-50%" width="200%" height="200%">
              <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#fef08a" floodOpacity="0.95" />
            </filter>
          </defs>
          <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
            {layout.map((m, idx) => {
              const assigned = onAssignedChange
                ? assignedSet.has(m.id)
                : machHandled !== undefined
                  ? idx < machHandled
                  : true;
              const appearance = machineAppearance?.(m);
              const statusClass = appearance?.status ? `machine-plan-${appearance.status}` : '';
              const w = machineWidthPx(m, pixelsPerMeter);
              const h = machineHeightPx(m, pixelsPerMeter);
              return (
                <g
                  key={m.id}
                  transform={`translate(${m.x}, ${m.y})`}
                  onPointerDown={handleMachinePointerDown(m.id)}
                  onContextMenu={(e) => e.preventDefault()}
                  style={{ cursor: 'grab' }}
                >
                  {appearance?.tooltip && <title>{appearance.tooltip}</title>}
                  <rect
                    width={w}
                    height={h}
                    rx={6}
                    className={`machine-box ${m.type === 'bfx' ? 'machine-bfx' : ''} ${
                      !assigned ? 'machine-unassigned' : ''
                    } ${selectedIds.has(m.id) ? 'machine-selected' : ''} ${statusClass}`}
                    style={appearance?.borderColor && !selectedIds.has(m.id) ? { stroke: appearance.borderColor, strokeWidth: 2.5 } : undefined}
                  />
                  {selectedIds.has(m.id) && (
                    <rect width={w} height={h} rx={6} className="machine-selection-hatch" />
                  )}
                  <MachineZoneLabels orientation={m.orientation} pairSide={m.pairSide} width={w} height={h} />
                  <text x={w / 2} y={h / 2 + 4} textAnchor="middle" className="machine-label">
                    {m.label}
                  </text>
                </g>
              );
            })}
            {operatorStart && (
              <g
                transform={`translate(${operatorStart.x}, ${operatorStart.y})`}
                className="operator-start-marker"
                onPointerDown={handleStartPointerDown}
                style={{ cursor: readOnly || !onOperatorStartChange ? 'default' : 'grab' }}
              >
                <title>Operator start point — drag to move</title>
                <circle r={21} className="operator-start-halo" />
                <path
                  d="M 0 -15 C -9 -15 -14 -9 -14 -1 C -14 9 0 21 0 21 C 0 21 14 9 14 -1 C 14 -9 9 -15 0 -15 Z"
                  className="operator-start-pin"
                />
                <circle r={4} className="operator-start-core" />
                <path d="M 0 -16 L 0 -29" className="operator-start-stem" />
                <rect x={7} y={-41} width={51} height={19} rx={9.5} className="operator-start-label-bg" />
                <text x={32.5} y={-28} textAnchor="middle" className="operator-start-label">
                  START
                </text>
              </g>
            )}
            {measurement && (
              <g className="layout-measure">
                {measureSegments.map((seg, i) => (
                  <g key={`measure-seg-${i}`}>
                    <line x1={seg.from.x} y1={seg.from.y} x2={seg.to.x} y2={seg.to.y} className="layout-measure-line" />
                    <text
                      x={(seg.from.x + seg.to.x) / 2}
                      y={(seg.from.y + seg.to.y) / 2 - 8}
                      textAnchor="middle"
                      className="layout-measure-label"
                    >
                      {seg.distance.toFixed(2)} m
                    </text>
                  </g>
                ))}
                {measureLiveSegment && (
                  <g>
                    <line
                      x1={measureLiveSegment.from.x}
                      y1={measureLiveSegment.from.y}
                      x2={measureLiveSegment.to.x}
                      y2={measureLiveSegment.to.y}
                      className="layout-measure-line layout-measure-line-preview"
                    />
                    <text
                      x={(measureLiveSegment.from.x + measureLiveSegment.to.x) / 2}
                      y={(measureLiveSegment.from.y + measureLiveSegment.to.y) / 2 - 8}
                      textAnchor="middle"
                      className="layout-measure-label layout-measure-label-preview"
                    >
                      {measureLiveSegment.distance.toFixed(2)} m
                    </text>
                  </g>
                )}
                {measurement.points.map((p, i) => (
                  <circle key={`measure-pt-${i}`} cx={p.x} cy={p.y} r={4} className="layout-measure-point" />
                ))}
                {measureTotalAnchor && measureSegmentCount > 1 && (
                  <text x={measureTotalAnchor.x} y={measureTotalAnchor.y - 20} textAnchor="middle" className="layout-measure-total">
                    Total: {measureTotal.toFixed(2)} m
                  </text>
                )}
              </g>
            )}
          </g>
          {drag?.mode === 'select' && (
            <rect
              x={Math.min(drag.startVb.x, drag.currentVb.x)}
              y={Math.min(drag.startVb.y, drag.currentVb.y)}
              width={Math.abs(drag.currentVb.x - drag.startVb.x)}
              height={Math.abs(drag.currentVb.y - drag.startVb.y)}
              className="layout-select-box"
            />
          )}
        </svg>
      </div>
      {resizeOpen && (
        <div className="modal-overlay" onClick={() => setResizeOpen(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Resize Mesin{selectedIds.size > 1 ? ` (${selectedIds.size} mesin)` : ''}</h3>
            <div className="modal-field">
              <label htmlFor="resize-length">Panjang (m)</label>
              <input
                id="resize-length"
                className="input"
                type="number"
                min={0.1}
                step={0.1}
                value={resizeLengthM}
                onChange={(e) => setResizeLengthM(e.target.value)}
                autoFocus
              />
            </div>
            <div className="modal-field">
              <label htmlFor="resize-width">Lebar (m)</label>
              <input
                id="resize-width"
                className="input"
                type="number"
                min={0.1}
                step={0.1}
                value={resizeWidthM}
                onChange={(e) => setResizeWidthM(e.target.value)}
              />
            </div>
            <div className="modal-actions">
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={() => setResizeOpen(false)}
                title="Cancel resize"
                aria-label="Cancel resize"
              >
                ✕
              </Button>
              <Button
                variant="primary"
                className="toolbar-icon-button"
                onClick={applyResize}
                title="Apply resize"
                aria-label="Apply resize"
              >
                ✓
              </Button>
            </div>
          </div>
        </div>
      )}
      {groupOpen && (
        <div className="modal-overlay" onClick={() => setGroupOpen(false)}>
          <div className="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <h3>Add Group Machine</h3>
            <div className="modal-field">
              <label htmlFor="group-length">Panjang mesin (m)</label>
              <input id="group-length" className="input" type="number" min={0.1} step={0.1} value={groupLengthM} onChange={(e) => setGroupLengthM(e.target.value)} autoFocus />
            </div>
            <div className="modal-field">
              <label htmlFor="group-width">Lebar mesin (m)</label>
              <input id="group-width" className="input" type="number" min={0.1} step={0.1} value={groupWidthM} onChange={(e) => setGroupWidthM(e.target.value)} />
            </div>
            <div className="modal-field">
              <label htmlFor="group-count">Jumlah mesin</label>
              <input id="group-count" className="input" type="number" min={2} step={1} value={groupCount} onChange={(e) => setGroupCount(e.target.value)} />
            </div>
            <p className="hint-row">Mesin dalam group akan selalu dipilih dan dipindahkan bersama.</p>
            <div className="modal-actions">
              <Button
                variant="ghost"
                className="toolbar-icon-button"
                onClick={() => setGroupOpen(false)}
                title="Cancel adding machine group"
                aria-label="Cancel adding machine group"
              >
                ✕
              </Button>
              <Button variant="primary" onClick={addMachineGroup}>Buat Group</Button>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
}
