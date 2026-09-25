import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProductionMachineAssignment, ProductionSetup, ProductionSimulationState } from '../../types';
import type { ResolvedConstruction } from '../../lib/productionConstructionResolver';
import { useProductionSimulation } from '../../hooks/useProductionSimulation';
import { useAuth } from '../../context/auth';

const HIDDEN_SPOOL_LABEL_AREAS = new Set(['WW', 'IS', 'IP', 'BA', 'CA']);
import { MachineZoneLabels } from '../ui/MachineZoneLabels';
import { MachineDonut } from '../simulation/MachineDonut';
import {
  machineZoneColors,
  operatorFacing,
  ordinal,
  timelineKinds,
  machineTimelineColor,
  summarizeMachineTimelineGroups,
  summarizeOperatorTimelineGroups,
} from '../simulation/timelineDisplay';
import { buildSetupConstructionColorMap } from '../../lib/constructionColors';
import { isFinishProductSpoolType } from '../../lib/productType';
import { estimateProductionEvents } from '../../lib/productionEstimate';
import { buildCanvasLegendData, type LegendHover } from '../../lib/canvasLegend';
import { CanvasLegendPanel } from './CanvasLegendPanel';
import { useFillToWindowBottom } from '../../hooks/useFillToWindowBottom';
import { useTimelineZoomScroll } from '../../hooks/useTimelineZoom';
import { TimelineRuler, TimelineZoomControl } from '../ui/TimelineZoom';
import { ShiftStartField } from '../ui/ShiftStartField';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { ShiftTimeCard } from '../simulation/ShiftTimeCard';

const LABEL_MARGIN = 24;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 4;
const FIT_MARGIN = 60;
/** Operator timeline tracks are indented by .layout-operator-timeline (see App.css). */
const OPERATOR_TIMELINE_INDENT_PX = 80;
/** Machine timeline rows: label column (72px) + grid gap (8px) before the track starts. */
const MACHINE_TIMELINE_LABEL_PX = 80;
const OPERATOR_COLORS = ['#38bdf8', '#f472b6', '#facc15', '#4ade80', '#a78bfa', '#fb923c', '#22d3ee', '#f87171'];
const ROUTE_HOLD_MS = 5000;

type Point = { x: number; y: number };

function fmtTime(min: number) {
  const totalMinutes = Math.round(min);
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${h}h ${m}m`;
}

function fmt(v: number) {
  return Math.round(v * 10) / 10;
}

function calculateRunningOutput(
  machines: ProductionSimulationState['machines'],
  isFinishProductMachine: (machine: ProductionSimulationState['machines'][number]) => boolean,
) {
  return machines.reduce(
    (summary, machine) => {
      const runningMinutes = machine.timeline.reduce((total, segment) => {
        const isRunning = segment.kind === 'running' || segment.kind.startsWith('running:');
        return isRunning ? total + Math.max(0, segment.endMin - segment.startMin) : total;
      }, 0);
      const runtimePerSpool = machine.runtimePerSpool > 0 ? machine.runtimePerSpool : 0;
      const spools = runtimePerSpool > 0 ? runningMinutes / runtimePerSpool : 0;
      const machineTonageKg = spools * Math.max(0, machine.spoolWeight);
      return {
        runningMinutes: summary.runningMinutes + runningMinutes,
        spools: summary.spools + spools,
        tonageKg: summary.tonageKg + machineTonageKg,
        fpTonageKg: summary.fpTonageKg + (isFinishProductMachine(machine) ? machineTonageKg : 0),
      };
    },
    { runningMinutes: 0, spools: 0, tonageKg: 0, fpTonageKg: 0 },
  );
}

const downtimeLabels: Record<string, string> = {
  doffing: 'Doffing',
  loading: 'Loading',
  fractureRepairing: 'Fracture Repairing',
  waiting: 'Waiting for Operator',
};

const downtimePalette = ['#38bdf8', '#a78bfa', '#f87171', '#c084fc', '#2dd4bf', '#fb923c', '#facc15'];
function colorForDowntime(label: string, index: number) {
  const known: Record<string, string> = {
    Doffing: '#38bdf8',
    Loading: '#a78bfa',
    'Fracture Repairing': '#f87171',
    'Waiting for Operator': '#fbbf24',
  };
  return known[label] ?? downtimePalette[index % downtimePalette.length];
}

function verdictFor(utilization: number): { text: string; className: string } {
  if (utilization >= 100) return { text: 'Overload — consider adding operators or reducing machines.', className: 'verdict-bad' };
  if (utilization >= 95) return { text: 'High workload — approaching capacity limit.', className: 'verdict-warn' };
  if (utilization < 75) return { text: 'Needs optimization — operator is underutilized.', className: 'verdict-info' };
  return { text: 'Operator capacity is sufficient.', className: 'verdict-ok' };
}

const NON_SERVICE_KINDS = new Set(['walking', 'lunch', 'meeting', 'idle']);

/** Same detail level as the single-operator Simulator's Man Occupation card (Man Occupation %,
 * Walking, Total service, per-activity service breakdown, Idle) — derived straight from the
 * timeline segments of whichever operator(s) are passed in, so the same function covers both the
 * "all operators combined" default view and a single filtered operator. */
function summarizeOperatorTimelines(
  ops: ProductionSimulationState['operators'],
  timelineDuration: number,
  activityLabel: (key: string) => string,
) {
  const segments = ops.flatMap((op) => op.timeline);
  const minutesWhere = (pred: (kind: string) => boolean) =>
    segments
      .filter((s) => pred(s.kind))
      .reduce((total, s) => total + Math.max(0, Math.min(s.endMin, timelineDuration) - s.startMin), 0);

  const walking = minutesWhere((k) => k === 'walking');
  const breakMin = minutesWhere((k) => k === 'lunch' || k === 'meeting');
  const idle = minutesWhere((k) => k === 'idle');

  const serviceLabelTotals = new Map<string, number>();
  segments
    .filter((s) => !NON_SERVICE_KINDS.has(s.kind))
    .forEach((s) => {
      const label = activityLabel(s.kind);
      const minutes = Math.max(0, Math.min(s.endMin, timelineDuration) - s.startMin);
      serviceLabelTotals.set(label, (serviceLabelTotals.get(label) ?? 0) + minutes);
    });
  const serviceBreakdown = Array.from(serviceLabelTotals.entries()).map(([label, minutes]) => ({ label, minutes }));
  const totalService = serviceBreakdown.reduce((total, s) => total + s.minutes, 0);

  const elapsed = timelineDuration * ops.length - breakMin;
  const busy = walking + totalService;
  const utilization = elapsed > 0 ? (busy / elapsed) * 100 : 0;

  return { walking, totalService, serviceBreakdown, idle, elapsed, utilization };
}

function operatorStatusLabel(op: ProductionSimulationState['operators'][number]) {
  if (op.phase === 'break') return `${op.breakLabel} (${Math.ceil(op.breakRemainingMin)}m)`;
  if (op.phase === 'walking') return `→ Machine ${op.targetMachineLabel}`;
  if (op.phase === 'servicing') return op.currentZoneLabel ?? `Handling ${op.targetMachineLabel}`;
  return 'Idle';
}

export function ProductionRunView({
  setup,
  resolved,
  resolveErrors,
  allProductIds,
  onBack,
}: {
  setup: ProductionSetup;
  resolved: Map<string, ResolvedConstruction>;
  resolveErrors: string[];
  /** Every WL_Products id, in the same stable order the Production Setup editor uses to build its
   * Construction border-color legend — keeps a Construction's color consistent between the setup
   * screen and this run view. */
  allProductIds: string[];
  onBack: () => void;
}) {
  const { user } = useAuth();
  const { state, playing, speed, controls } = useProductionSimulation(setup, resolved, resolveErrors);
  const isAdmin = user.role === 'admin';
  const { machines, operators, metrics } = state;
  const [targetUtilization, setTargetUtilization] = useState(85);
  // Reject % = the OEE Quality loss. Display-only (the engine is unchanged): it scales tonnage down
  // to GOOD tonnage and multiplies into every OEE figure. Plain state — back to 0 per page visit.
  const [rejectPercent, setRejectPercent] = useState(0);
  const quality = 1 - Math.min(100, Math.max(0, rejectPercent)) / 100;
  // Same colors as the machine bodies on the Production Setup canvas (Construction Detail View).
  const constructionColorMap = useMemo(
    () => buildSetupConstructionColorMap(setup.assignments.map((a) => a.constructionDetailId), allProductIds),
    [setup.assignments, allProductIds],
  );
  const assignmentByMachineId = useMemo(() => new Map(setup.assignments.map((a) => [a.machineId, a])), [setup.assignments]);
  const areaByConstructionId = useMemo(
    () => new Map([...resolved].map(([id, construction]) => [id, construction.spec.area.trim().toUpperCase()])),
    [resolved],
  );
  const operatorLabelMap = useMemo(() => new Map(setup.operators.map((o) => [o.id, o.label])), [setup.operators]);
  const operatorLabelById = useCallback((id?: string) => (id ? operatorLabelMap.get(id) ?? '—' : '—'), [operatorLabelMap]);

  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [viewSize, setViewSize] = useState({ width: 800, height: 520 });
  // Lets the canvas be dragged taller/shorter (see the resize handle below the SVG) instead of
  // being stuck at a fixed height — the ResizeObserver already watching wrapperRef (below) picks
  // up the new size automatically and updates the SVG viewBox, so no extra wiring is needed for
  // the canvas content itself to react to it.
  const [canvasHeight, setCanvasHeight] = useState(420);
  const canvasResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [resizingCanvas, setResizingCanvas] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStartRef = useRef<{ vb: Point; pan: Point } | null>(null);
  const hasAutoFitRef = useRef(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const onSelectMachine = useCallback((id: string) => setSelectedMachineId((prev) => (prev === id ? null : id)), []);
  // A boolean, not the raw zoom value — passed to the memoized machine layer below so panning/
  // zooming WITHIN one detail tier never invalidates its memo (only crossing the threshold does).
  // At real-factory scale (~1300+ machines) the donut/sub-labels are unreadable at low zoom anyway,
  // so skipping them there also cuts per-machine DOM nodes roughly in half while zoomed out.
  const isDetailed = zoom >= 0.4;
  const [machineTimelineSearch, setMachineTimelineSearch] = useState('');
  // At real-factory scale (~1300+ machines) this list alone is a heavy render (each row can carry
  // many timeline segments) and, being part of the same component as the canvas, would otherwise
  // re-render on every pan/zoom tick too — letting it be hidden entirely removes that cost when
  // you just want to look at the canvas, not scroll through the table.
  const [showMachineTimeline, setShowMachineTimeline] = useState(false);
  const [showOperatorTimeline, setShowOperatorTimeline] = useState(false);
  const {
    zoom: operatorTimelineZoom,
    scrollRef: operatorTimelineScrollRef,
    scrollStyle: operatorTimelineScrollStyle,
  } = useTimelineZoomScroll();
  const { zoom: machineTimelineZoom, scrollRef: machineTimelineScrollRef } = useTimelineZoomScroll();
  const [operatorTimelineSearch, setOperatorTimelineSearch] = useState('');
  const [selectedOperatorHighlight, setSelectedOperatorHighlight] = useState<{ operatorId: string; index: number } | null>(null);
  /** Clicking an operator's name in the Operator Timeline filters the Man Occupation card
   * down to just that operator — independent of selectedOperatorHighlight above, which highlights
   * one specific timeline SEGMENT against the Machine Timeline instead. */
  const [utilFilterOperatorId, setUtilFilterOperatorId] = useState<string | null>(null);
  type OperatorSortColumn = 'label' | 'walking' | 'totalService' | 'idle' | 'utilization';
  const [operatorSort, setOperatorSort] = useState<{ column: OperatorSortColumn; direction: 'asc' | 'desc' }>({
    column: 'utilization',
    direction: 'desc',
  });
  const operatorListPanelRef = useRef<HTMLDivElement>(null);
  const [isOperatorListFullscreen, setIsOperatorListFullscreen] = useState(false);

  useEffect(() => {
    const handleFullscreenChange = () => {
      setIsOperatorListFullscreen(document.fullscreenElement === operatorListPanelRef.current);
    };
    document.addEventListener('fullscreenchange', handleFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', handleFullscreenChange);
  }, []);

  const toggleOperatorListFullscreen = () => {
    if (document.fullscreenElement === operatorListPanelRef.current) {
      document.exitFullscreen();
    } else {
      operatorListPanelRef.current?.requestFullscreen();
    }
  };

  const toggleOperatorSort = (column: OperatorSortColumn) => {
    setOperatorSort((prev) =>
      prev.column === column ? { column, direction: prev.direction === 'asc' ? 'desc' : 'asc' } : { column, direction: 'desc' },
    );
  };

  const toViewBoxPoint = (clientX: number, clientY: number): Point => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const rect = svg.getBoundingClientRect();
    const scaleX = rect.width > 0 ? viewSize.width / rect.width : 1;
    const scaleY = rect.height > 0 ? viewSize.height / rect.height : 1;
    return { x: (clientX - rect.left) * scaleX, y: (clientY - rect.top) * scaleY };
  };

  const zoomAt = (vb: Point, newZoomRaw: number) => {
    const newZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, newZoomRaw));
    const worldX = (vb.x - pan.x) / zoom;
    const worldY = (vb.y - pan.y) / zoom;
    setPan({ x: vb.x - worldX * newZoom, y: vb.y - worldY * newZoom });
    setZoom(newZoom);
  };

  const fitToPage = (size = viewSize) => {
    if (machines.length === 0) return;
    const minX = Math.min(...machines.map((m) => m.x - m.widthPx / 2));
    const minY = Math.min(...machines.map((m) => m.y - m.heightPx / 2));
    const maxX = Math.max(...machines.map((m) => m.x + m.widthPx / 2));
    const maxY = Math.max(...machines.map((m) => m.y + m.heightPx / 2));
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

  useEffect(() => {
    const el = wrapperRef.current;
    if (!el) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      setViewSize({ width, height });
      if (!hasAutoFitRef.current && machines.length > 0) {
        hasAutoFitRef.current = true;
        fitToPage({ width, height });
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [machines.length > 0]);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    const handleWheel = (e: WheelEvent) => {
      if (e.target instanceof Element && e.target.closest('[data-canvas-overlay]')) return;
      e.preventDefault();
      const vb = toViewBoxPoint(e.clientX, e.clientY);
      const factor = e.deltaY < 0 ? 1.1 : 1 / 1.1;
      zoomAt(vb, zoom * factor);
    };
    wrapper.addEventListener('wheel', handleWheel, { passive: false });
    return () => wrapper.removeEventListener('wheel', handleWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [zoom, pan, viewSize]);

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
    if (document.fullscreenElement) document.exitFullscreen();
    else panelRef.current?.requestFullscreen();
  };

  const handleCanvasPointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    panStartRef.current = { vb: toViewBoxPoint(e.clientX, e.clientY), pan };
    setPanning(true);
  };
  const handleCanvasPointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!panStartRef.current) return;
    const vb = toViewBoxPoint(e.clientX, e.clientY);
    const { vb: startVb, pan: startPan } = panStartRef.current;
    setPan({ x: startPan.x + (vb.x - startVb.x), y: startPan.y + (vb.y - startVb.y) });
  };
  const handleCanvasPointerUp = () => {
    panStartRef.current = null;
    setPanning(false);
  };

  const MIN_CANVAS_HEIGHT = 240;
  const MAX_CANVAS_HEIGHT = 1400;

  const handleResizeHandlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    canvasResizeRef.current = { startY: e.clientY, startHeight: canvasHeight };
    setResizingCanvas(true);
  };
  const handleResizeHandlePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!canvasResizeRef.current) return;
    const delta = e.clientY - canvasResizeRef.current.startY;
    setCanvasHeight(Math.min(MAX_CANVAS_HEIGHT, Math.max(MIN_CANVAS_HEIGHT, canvasResizeRef.current.startHeight + delta)));
  };
  const handleResizeHandlePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
    canvasResizeRef.current = null;
    setResizingCanvas(false);
  };

  const operatorColor = (index: number) => OPERATOR_COLORS[index % OPERATOR_COLORS.length];

  // Legend (top-left of the canvas): Construction tab = machine border colors, Operator tab = the
  // operator marker colors drawn on this canvas. Built from the setup only, so it doesn't change
  // while the simulation runs.
  const legendData = useMemo(
    () =>
      buildCanvasLegendData({
        machineIds: setup.layout.map((m) => m.id),
        assignmentByMachineId,
        constructionColors: constructionColorMap,
        constructionLabel: (id) => resolved.get(id)?.label ?? setup.assignments.find((a) => a.constructionDetailId === id)?.constructionDetailLabel ?? id,
        operators: setup.operators.map((o, index) => ({ id: o.id, label: o.label, color: OPERATOR_COLORS[index % OPERATOR_COLORS.length] })),
        unassignedColor: '#334155',
      }),
    [setup.layout, setup.assignments, setup.operators, assignmentByMachineId, constructionColorMap, resolved],
  );
  const [legendHover, setLegendHover] = useState<LegendHover>(null);

  // Dashboard reaches the bottom of the window even when the canvas column is shorter.
  const { ref: dashboardOuterRef, minHeight: dashboardMinHeight } = useFillToWindowBottom<HTMLDivElement>();
  // Dashboard column width, draggable from its left edge. Plain component state, so it's back to
  // the default every time this page is opened.
  const [dashboardWidth, setDashboardWidth] = useState(DEFAULT_DASHBOARD_WIDTH);
  const dashboardResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  const [resizingDashboard, setResizingDashboard] = useState(false);
  const startDashboardResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    dashboardResizeRef.current = { startX: e.clientX, startWidth: dashboardWidth };
    setResizingDashboard(true);
  };
  const moveDashboardResize = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dashboardResizeRef.current;
    if (!drag) return;
    // Dragging the left edge leftwards widens the panel.
    const maxWidth = Math.max(MIN_DASHBOARD_WIDTH, window.innerWidth * MAX_DASHBOARD_WIDTH_RATIO);
    setDashboardWidth(Math.min(maxWidth, Math.max(MIN_DASHBOARD_WIDTH, drag.startWidth - (e.clientX - drag.startX))));
  };
  const endDashboardResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.currentTarget.releasePointerCapture(e.pointerId);
    dashboardResizeRef.current = null;
    setResizingDashboard(false);
  };
  const highlightedMachineIds = useMemo(() => legendData.highlightFor(legendHover), [legendData, legendHover]);

  // Sub-activity keys are unique per WL_Activities row (loading-sub-<guid>) so they don't collide
  // across different Constructions in the same setup — but that also means they're not human
  // readable on their own. Build a key→label lookup from every resolved Construction's own
  // activities so cards below can show "Loading Partial1" instead of the raw key.
  const activityLabelByKey = useMemo(() => {
    const map: Record<string, string> = {};
    resolved.forEach((construction) => {
      construction.activities.forEach((activity) => {
        map[activity.key] = activity.label;
      });
    });
    return map;
  }, [resolved]);
  const activityLabel = (key: string) => downtimeLabels[key] ?? activityLabelByKey[key] ?? key;

  /** Groups by LABEL rather than raw key — two Constructions can each have their own
   * loading-sub-<guid> key that both mean "Loading Partial1", and those should show as one row. */
  function groupByLabel(record: Record<string, number>): [string, number][] {
    const totals = new Map<string, number>();
    Object.entries(record).forEach(([key, value]) => {
      const label = activityLabel(key);
      totals.set(label, (totals.get(label) ?? 0) + value);
    });
    return Array.from(totals.entries());
  }

  const completedByLabel = groupByLabel(metrics.completedByActivity).sort((a, b) => b[1] - a[1]);
  // Theoretical full-shift estimate per activity (same formula as the Workload Simulator), grouped
  // by label like the completed counts so both line up row for row.
  const expectedEvents = useMemo(() => estimateProductionEvents(setup, resolved), [setup, resolved]);
  const expectedByLabel = new Map(groupByLabel(expectedEvents));
  const completedRows: [string, number][] = [
    ...completedByLabel,
    // Activities expected this shift but not done yet still get a row (0 / ~N).
    ...[...expectedByLabel.entries()]
      .filter(([label, expected]) => expected > 0 && !completedByLabel.some(([done]) => done === label))
      .map(([label]): [string, number] => [label, 0]),
  ];

  const downtimeEntries = groupByLabel(metrics.downtimeByReason)
    .map(([label, value], index) => ({ key: label, label, value, color: colorForDowntime(label, index) }))
    .filter((d) => d.value > 0)
    .sort((a, b) => b.value - a.value);
  const maxDowntime = downtimeEntries[0]?.value ?? 0;

  // Machines nobody bothered to plan (no Construction assigned) never produce anything and would
  // just be dead rows in the Machine Timeline. Operators assigned to zero machines for every
  // activity likewise never do anything for the whole shift — counting them in Manhour/ton would
  // understate the real per-ton labor cost, and they'd only clutter the operator list/timeline.
  const plannedMachines = machines.filter((m) => m.status !== 'unassigned');
  const assignedOperatorIds = useMemo(() => {
    const ids = new Set<string>();
    setup.assignments.forEach((a) => {
      if (a.doffingOperatorId) ids.add(a.doffingOperatorId);
      if (a.loadingOperatorId) ids.add(a.loadingOperatorId);
      if (a.fractureRepairingOperatorId) ids.add(a.fractureRepairingOperatorId);
      if (a.diesChangeOperatorId) ids.add(a.diesChangeOperatorId);
      if (a.defectRepairingOperatorId) ids.add(a.defectRepairingOperatorId);
    });
    return ids;
  }, [setup.assignments]);
  const displayedOperators = operators.filter((op) => assignedOperatorIds.has(op.id));
  const colorByOperatorId = new Map(operators.map((op, index) => [op.id, operatorColor(index)]));

  // Output: aggregated using each machine's OWN spool weight / runtime-per-spool (accumulated in
  // the engine as tonageKg/producedMachineMin), since a Production Setup can mix Constructions —
  // unlike the single-operator Simulator's Output card, which only ever has one shared spec.
  const totalSpools = metrics.completedByActivity.doffing ?? 0;
  const grossTonage = metrics.tonageKg / 1000;
  const tonage = grossTonage * quality;
  const rejectTonage = grossTonage - tonage;
  const shiftHours = metrics.shiftTimeMin / 60;
  const manHourPerTon = tonage > 0 ? (displayedOperators.length * shiftHours) / tonage : 0;
  const scheduledMachineMin = metrics.assignedMachineCount * metrics.shiftTimeMin;
  const outputOee = scheduledMachineMin > 0 ? (metrics.producedMachineMin / scheduledMachineMin) * 100 * quality : 0;
  const scheduledMachineHours = metrics.assignedMachineCount * shiftHours;
  const machHoursPerTon = tonage > 0 ? scheduledMachineHours / tonage : 0;
  const totalFractureCount = Object.entries(metrics.completedByActivity)
    .filter(([key]) => key === 'fractureRepairing' || key.startsWith('fractureRepairing-'))
    .reduce((sum, [, count]) => sum + count, 0);
  const actualFracturePerTon = tonage > 0 ? totalFractureCount / tonage : 0;
  const actualDiesPerTon = tonage > 0 ? metrics.diesChanged / tonage : 0;
  const totalDefectRepairingCount = Object.entries(metrics.completedByActivity)
    .filter(([key]) => key === 'defectRepairing' || key.startsWith('defectRepairing-'))
    .reduce((sum, [, count]) => sum + count, 0);
  const actualDefectPerTon = tonage > 0 ? totalDefectRepairingCount / tonage : 0;
  // Finish Product (SpoolType BS…) vs Semi Finish Product tonnage, and the per-ton figures again
  // with FP tonnage as the divisor.
  const isFinishProductConstruction = (constructionId: string | null | undefined) =>
    !!constructionId && isFinishProductSpoolType(resolved.get(constructionId)?.spoolType);
  const tonageFp =
    (Object.entries(metrics.tonageKgByConstruction ?? {})
      .filter(([constructionId]) => isFinishProductConstruction(constructionId))
      .reduce((sum, [, kg]) => sum + kg, 0) /
      1000) *
    quality;
  const tonageSfp = Math.max(0, tonage - tonageFp);
  const perTonFp = (numerator: number) => (tonageFp > 0 ? numerator / tonageFp : 0);
  const runningOutput = calculateRunningOutput(machines, (machine) =>
    isFinishProductConstruction(assignmentByMachineId.get(machine.id)?.constructionDetailId),
  );
  const runningTimeGrossTonage = runningOutput.tonageKg / 1000;
  const runningTimeTonage = runningTimeGrossTonage * quality;
  const runningTimeRejectTonage = runningTimeGrossTonage - runningTimeTonage;
  const runningTimeOee = scheduledMachineMin > 0
    ? (runningOutput.runningMinutes / scheduledMachineMin) * 100 * quality
    : 0;
  const runningTimeManHourPerTon = runningTimeTonage > 0
    ? (displayedOperators.length * shiftHours) / runningTimeTonage
    : 0;
  const runningTimeMachHoursPerTon = runningTimeTonage > 0
    ? scheduledMachineHours / runningTimeTonage
    : 0;
  const runningTimeFracturePerTon = runningTimeTonage > 0 ? totalFractureCount / runningTimeTonage : 0;
  const runningTimeDiesPerTon = runningTimeTonage > 0 ? metrics.diesChanged / runningTimeTonage : 0;
  const runningTimeDefectPerTon = runningTimeTonage > 0 ? totalDefectRepairingCount / runningTimeTonage : 0;
  const runningTimeTonageFp = (runningOutput.fpTonageKg / 1000) * quality;
  const runningTimeTonageSfp = Math.max(0, runningTimeTonage - runningTimeTonageFp);
  const runningPerTonFp = (numerator: number) => (runningTimeTonageFp > 0 ? numerator / runningTimeTonageFp : 0);
  const manHours = displayedOperators.length * shiftHours;

  const plannedProductionMin = metrics.assignedMachineCount * metrics.clockMin;
  const totalDowntimeMin = Object.values(metrics.downtimeByReason).reduce((a, b) => a + b, 0);
  const availability = plannedProductionMin > 0 ? ((plannedProductionMin - totalDowntimeMin) / plannedProductionMin) * 100 : 100;
  const oee = Math.max(0, Math.min(100, availability * quality));

  const queue = machines.filter((m) => m.status === 'needs-service');
  const operatorsOnBreak = operators.filter((op) => op.phase === 'break');

  const timelineDuration = Math.max(0, Math.min(metrics.clockMin, metrics.shiftTimeMin));

  const utilOperators = utilFilterOperatorId ? operators.filter((op) => op.id === utilFilterOperatorId) : displayedOperators;
  const utilFilterLabel = utilFilterOperatorId ? operators.find((op) => op.id === utilFilterOperatorId)?.label ?? null : null;
  const utilSummary = summarizeOperatorTimelines(utilOperators, timelineDuration, activityLabel);
  const utilVerdict = verdictFor(utilSummary.utilization);

  // Observed utilization depends on how this ONE simulated run happened to play out — routing
  // detours, queue order, which operator got assigned too many machines, etc. That's exactly the
  // kind of noise the recommendation should look past: instead it's computed straight from each
  // PLANNED machine's own Construction (cycle lengths + activity times), the same numbers the
  // engine itself uses to decide when work is due — so "operator assigned to too many machines"
  // shows up directly as too much theoretical demand for the team size, regardless of how the
  // queueing/waiting actually unfolded. Machines with no Construction assigned are excluded
  // entirely (unplanned = not real workload yet).
  const theoreticalRequiredMinutes = useMemo(() => {
    if (utilFilterOperatorId) return null; // a fleet-wide demand total isn't meaningful for one person
    let total = 0;
    setup.assignments.forEach((a) => {
      if (!a.constructionDetailId) return;
      const construction = resolved.get(a.constructionDetailId);
      if (!construction) return;
      const runtimePerSpool = construction.runtimePerSpool || 1;
      const theoreticalSpools = timelineDuration / runtimePerSpool;
      (['doffing', 'loading', 'fractureRepairing'] as const).forEach((prefix) => {
        construction.activities
          .filter((act) => act.key === prefix || act.key.startsWith(`${prefix}-`))
          .forEach((act) => {
            const cycle = construction.cycleLengths[act.key];
            if (!Number.isFinite(cycle) || cycle <= 0) return;
            total += (theoreticalSpools / cycle) * act.timeMinutes;
          });
      });
    });
    return total;
  }, [utilFilterOperatorId, setup.assignments, resolved, timelineDuration]);

  // Headcount recommendation, not a machine count: how many operators (fractional — no need to
  // wait for a whole extra person) it'd take to cover the theoretical demand above at the target
  // utilization. Uses the WHOLE team (not just displayedOperators) as the current baseline, since
  // an operator with zero tasks assigned is still a body on the floor the recommendation should
  // subtract against. Falls back to the plain utilization-ratio calc when filtered to one operator.
  const allOperatorsSummary = summarizeOperatorTimelines(operators, timelineDuration, activityLabel);
  const perOperatorAvailableMin = operators.length > 0 ? allOperatorsSummary.elapsed / operators.length : 0;
  const requiredOperators =
    theoreticalRequiredMinutes !== null && perOperatorAvailableMin > 0
      ? theoreticalRequiredMinutes / (perOperatorAvailableMin * (targetUtilization / 100))
      : 0;
  const operatorRecommendation = utilFilterOperatorId
    ? utilOperators.length > 0 && utilSummary.utilization > 0
      ? utilOperators.length * (utilSummary.utilization / targetUtilization) - utilOperators.length
      : 0
    : operators.length > 0
      ? requiredOperators - operators.length
      : 0;

  const operatorUtilRows = displayedOperators.map((op) => ({
    id: op.id,
    label: op.label,
    color: colorByOperatorId.get(op.id) ?? '#94a3b8',
    ...summarizeOperatorTimelines([op], timelineDuration, activityLabel),
  }));
  // Operator legend shows each operator's current man occupation (same value as the operator table).
  const utilizationByOperatorId = new Map(operatorUtilRows.map((row) => [row.id, row.utilization]));
  const legendOperatorEntries = legendData.operatorEntries.map((entry) => {
    const utilization = utilizationByOperatorId.get(entry.id);
    return utilization === undefined ? entry : { ...entry, detail: `${fmt(utilization)}%` };
  });
  const sortedOperatorRows = [...operatorUtilRows].sort((a, b) => {
    const dir = operatorSort.direction === 'asc' ? 1 : -1;
    if (operatorSort.column === 'label') return a.label.localeCompare(b.label) * dir;
    return (a[operatorSort.column] - b[operatorSort.column]) * dir;
  });

  const selectedMachine = machines.find((m) => m.id === selectedMachineId) ?? null;
  // Timeline summaries (the percentages under each timeline) — grouped by activity NAME so a
  // sub-activity shared by many Constructions ("Doffing ScanMES", "Loading Partial1", …) is one
  // row, and computed in a single pass over the segments.
  const totalMachineSummary = useMemo(
    () => summarizeMachineTimelineGroups(machines.map((m) => m.timeline), timelineDuration),
    [machines, timelineDuration],
  );
  const operatorTimelineSummary = summarizeOperatorTimelineGroups(displayedOperators.map((op) => op.timeline), timelineDuration);

  const selectedOperator = selectedOperatorHighlight ? operators.find((op) => op.id === selectedOperatorHighlight.operatorId) : null;
  const selectedOperatorRange = selectedOperator && selectedOperatorHighlight
    ? selectedOperator.timeline[selectedOperatorHighlight.index] ?? null
    : null;

  // Clicking a segment on an operator's timeline doesn't just mark the matching time range on
  // every machine row (selectedOperatorRange above) — it also narrows the Machine Timeline list
  // down to only the machines that operator is actually assigned to handle (any activity), so a
  // busy operator's own slice of the line is easy to isolate out of hundreds of machines.
  const machinesForSelectedOperator = selectedOperator
    ? new Set(
        setup.assignments
          .filter(
            (a) =>
              a.doffingOperatorId === selectedOperator.id ||
              a.loadingOperatorId === selectedOperator.id ||
              a.fractureRepairingOperatorId === selectedOperator.id,
          )
          .map((a) => a.machineId),
      )
    : null;
  const machineTimelineRows = (machinesForSelectedOperator ? plannedMachines.filter((m) => machinesForSelectedOperator.has(m.id)) : plannedMachines).filter(
    (m) => m.label.toLowerCase().includes(machineTimelineSearch.trim().toLowerCase()),
  );

  const shownMachineSummary = selectedMachine
    ? summarizeMachineTimelineGroups([selectedMachine.timeline], timelineDuration)
    : machinesForSelectedOperator
      ? summarizeMachineTimelineGroups(machineTimelineRows.map((m) => m.timeline), timelineDuration)
      : totalMachineSummary;

  const operatorTimelineList = displayedOperators.filter((op) => op.label.toLowerCase().includes(operatorTimelineSearch.trim().toLowerCase()));

  const renderProductionControls = () => (
    <div className="controls-bar production-run-toolbar">
      <Button variant="ghost" onClick={onBack}>
        ← Back to Setup
      </Button>
      <ShiftTimeCard
        elapsedMinutes={metrics.clockMin}
        totalMinutes={metrics.shiftTimeMin}
        availableMinutes={Math.max(0, setup.shiftTime - setup.lunchTime - setup.meetingTime)}
        breakMessage={
          operatorsOnBreak.length > 0
            ? `☕ ${operatorsOnBreak.map((op) => op.label).join(', ')} on break — ${Math.ceil(
                Math.max(...operatorsOnBreak.map((op) => op.breakRemainingMin)),
              )} minutes remaining`
            : undefined
        }
      />
      {state.finished && <span className="finished-badge">Shift complete</span>}
      <ShiftStartField />
      {!playing ? (
        <Button variant="primary" onClick={controls.play} disabled={state.finished}>
          ▶ Play
        </Button>
      ) : (
        <Button variant="secondary" onClick={controls.pause}>
          ⏸ Pause
        </Button>
      )}
      <div className="speed-group">
        {[0.5, 1, 2, 4, 8].map((s) => (
          <button
            key={s}
            className={`speed-btn ${speed === s ? 'active' : ''}`}
            onClick={() => controls.setSpeed(s)}
          >
            {s}x
          </button>
        ))}
      </div>
      <Button variant="secondary" onClick={controls.reset}>
        ⟲ Reset
      </Button>
    </div>
  );

  return (
    <div className="production-run-view">
      {renderProductionControls()}

      {state.warnings.length > 0 && (
        <div className="production-run-warnings">
          {state.warnings.slice(0, 6).map((w, i) => (
            <div key={i}>{w}</div>
          ))}
          {state.warnings.length > 6 && <div>…and {state.warnings.length - 6} more.</div>}
        </div>
      )}

      <div className="simulation-body" style={{ '--dashboard-width': `${dashboardWidth}px` } as React.CSSProperties}>
        <div className={`sim-canvas-wrap ${isFullscreen ? 'sim-canvas-fullscreen' : ''}`} ref={panelRef}>
          {isFullscreen && <div className="sim-canvas-fullscreen-controls">{renderProductionControls()}</div>}
          <div className="toolbar sim-canvas-toolbar">
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
              variant="ghost"
              className="toolbar-icon-button"
              onClick={toggleFullscreen}
              title={isFullscreen ? 'Exit fullscreen' : 'Open fullscreen'}
              aria-label={isFullscreen ? 'Exit fullscreen' : 'Open fullscreen'}
            >
              ⛶
            </Button>
          </div>
          <div className="sim-svg-wrap production-run-canvas" ref={wrapperRef} style={!isFullscreen ? { height: canvasHeight } : undefined}>
            <div className="layout-canvas-overlay" data-canvas-overlay onPointerDown={(e) => e.stopPropagation()}>
              <CanvasLegendPanel
                constructionEntries={legendData.constructionEntries}
                operatorEntries={legendOperatorEntries}
                initialTab="construction"
                onHover={setLegendHover}
                hints={{
                  construction: 'Machine border color = Construction Detail. Hover an entry to highlight its machines.',
                  operator: 'Operator marker colors on this canvas. Hover an entry to highlight the machines that operator is assigned to.',
                }}
              />
            </div>
            <svg
              ref={svgRef}
              width="100%"
              height="100%"
              viewBox={`0 0 ${viewSize.width} ${viewSize.height}`}
              className={`layout-svg ${panning ? 'layout-svg-panning' : ''}`}
              onPointerDown={handleCanvasPointerDown}
              onPointerMove={handleCanvasPointerMove}
              onPointerUp={handleCanvasPointerUp}
            >
              <defs>
                {/* Glow for legend-hovered machines (.machine-highlighted). */}
                <filter id="machine-selection-glow" x="-50%" y="-50%" width="200%" height="200%">
                  <feDropShadow dx="0" dy="0" stdDeviation="3" floodColor="#fef08a" floodOpacity="0.95" />
                </filter>
              </defs>
              <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
                <g transform={`translate(${LABEL_MARGIN}, ${LABEL_MARGIN})`}>
                  <MachinesLayer
                    machines={machines}
                    operators={operators}
                    clockMin={metrics.clockMin}
                    selectedMachineId={selectedMachineId}
                    onSelectMachine={onSelectMachine}
                    assignmentByMachineId={assignmentByMachineId}
                    areaByConstructionId={areaByConstructionId}
                    constructionColorMap={constructionColorMap}
                    operatorLabelById={operatorLabelById}
                    isDetailed={isDetailed}
                    highlightedMachineIds={highlightedMachineIds}
                  />

                  <OperatorRoutesLayer operators={operators} />

                  {operators.map((op, index) => {
                    const isMovingBetween = op.phase === 'walking';
                    const isMovingWithin = op.phase === 'servicing' && op.serviceSubPhase === 'moving';
                    const isMoving = isMovingBetween || isMovingWithin;
                    const targetMachine = machines.find((m) => m.id === op.targetMachineId) ?? null;
                    return (
                      <g key={op.id} transform={`translate(${op.x}, ${op.y})`} className="operator-token">
                        {isMoving && <circle r={16} className="operator-walk-ring" style={{ stroke: operatorColor(index) }} />}
                        <g transform={`rotate(${operatorFacing(op.currentZoneLabel, op.x, targetMachine)})`}>
                          <circle cy={-6} r={3} className="operator-head" />
                          <ellipse cy={1.5} rx={6} ry={4.5} className={`operator-shoulders operator-${op.phase}`} style={{ fill: operatorColor(index) }} />
                          <path d="M-4.5,-1 L-7,-6.5 M4.5,-1 L7,-6.5" className="operator-arms" />
                        </g>
                        <g transform="translate(0, 24)">
                          <rect x={-72} y={-11} width={144} height={18} rx={9} className="operator-label-bg" />
                          <text textAnchor="middle" y={2} className="operator-label-text">
                            {op.label}: {operatorStatusLabel(op)}
                          </text>
                        </g>
                      </g>
                    );
                  })}
                </g>
              </g>
            </svg>
          </div>
          {!isFullscreen && (
            <div
              className={`production-canvas-resize-handle ${resizingCanvas ? 'active' : ''}`}
              onPointerDown={handleResizeHandlePointerDown}
              onPointerMove={handleResizeHandlePointerMove}
              onPointerUp={handleResizeHandlePointerUp}
              title="Drag to resize the canvas height"
            >
              <span />
            </div>
          )}
          <div className="legend">
            <span className="legend-item"><span className="legend-swatch sim-machine-running" /> Running</span>
            <span className="legend-item"><span className="legend-swatch sim-machine-stopped" /> Needs service / stopped</span>
            <span className="legend-item"><span className="legend-swatch sim-machine-unassigned" /> Unassigned Construction</span>
          </div>

          {/* One zoom for both the Operator and the Machine timeline below. */}
          <div className="timeline-zoom-bar">
            <TimelineZoomControl />
          </div>

          <div className="timeline-heading">
            <strong>Operator Timeline</strong>
            <span className="production-timeline-heading-actions">
              <button
                type="button"
                className="production-timeline-toggle"
                onClick={() => setShowOperatorTimeline((prev) => !prev)}
              >
                {showOperatorTimeline ? 'Hide list' : `Show list (${operatorTimelineList.length})`}
              </button>
            </span>
          </div>
          {showOperatorTimeline && (
            <>
              <div className="timeline-list-toolbar">
                <input
                  className="input input-sm production-timeline-search"
                  placeholder="Search operator…"
                  value={operatorTimelineSearch}
                  onChange={(e) => setOperatorTimelineSearch(e.target.value)}
                />
              </div>
              <div
                className="production-operator-timeline-list timeline-zoom-scroll"
                ref={operatorTimelineScrollRef}
                style={operatorTimelineScrollStyle}
              >
                <TimelineRuler shiftTimeMin={metrics.shiftTimeMin} zoom={operatorTimelineZoom} offsetPx={OPERATOR_TIMELINE_INDENT_PX} />
                {operatorTimelineList.length === 0 && <p className="empty-hint">No operators match.</p>}
                {operatorTimelineList.map((op) => (
                  <div className="operator-timeline layout-operator-timeline production-operator-timeline" key={op.id}>
                    <div className="timeline-heading">
                      <button
                        type="button"
                        className="production-operator-name-btn"
                        style={{ color: colorByOperatorId.get(op.id) ?? '#94a3b8' }}
                        onClick={() => setUtilFilterOperatorId(utilFilterOperatorId === op.id ? null : op.id)}
                        title="Click to filter the Man Occupation card to this operator"
                      >
                        {utilFilterOperatorId === op.id ? '● ' : ''}
                        {op.label}
                      </button>
                      <span>{operatorStatusLabel(op)}</span>
                    </div>
                    <div className="operator-timeline-track">
                      {op.timeline.map((segment, segIndex) => {
                        const width = ((Math.min(segment.endMin, metrics.shiftTimeMin) - segment.startMin) / (metrics.shiftTimeMin || 1)) * 100;
                        const item = timelineKinds.find((entry) => entry.kind === segment.kind);
                        const isSelected = selectedOperatorHighlight?.operatorId === op.id && selectedOperatorHighlight.index === segIndex;
                        return (
                          <button
                            key={`${segment.startMin}-${segIndex}`}
                            type="button"
                            className={`operator-timeline-segment ${isSelected ? 'selected' : ''}`}
                            title={`${segment.label}: ${Math.round((segment.endMin - segment.startMin) * 10) / 10} min — click to highlight machines`}
                            onClick={() => setSelectedOperatorHighlight(isSelected ? null : { operatorId: op.id, index: segIndex })}
                            style={{ width: `${Math.max(0, width)}%`, background: item?.color ?? '#c084fc' }}
                          />
                        );
                      })}
                      {metrics.clockMin < metrics.shiftTimeMin && (
                        <div className="operator-timeline-current" style={{ left: `${(timelineDuration / (metrics.shiftTimeMin || 1)) * 100}%` }} />
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
          <div className="timeline-summary">
            {operatorTimelineSummary.groups.map(({ key, label, color }) => {
              const minutes = operatorTimelineSummary.minutesByKey.get(key) ?? 0;
              const denominator = timelineDuration * (displayedOperators.length || 1);
              const percentage = denominator > 0 ? (minutes / denominator) * 100 : 0;
              return (
                <div key={key} className="timeline-summary-item">
                  <span className="legend-dot" style={{ background: color }} />
                  <span>{label}</span>
                  <strong>{Math.round(percentage * 10) / 10}%</strong>
                </div>
              );
            })}
          </div>

          <div className="machine-timelines">
            <div className="timeline-heading">
              <strong>Machine Timeline{selectedOperator ? ` — ${selectedOperator.label} (${machineTimelineRows.length} machines)` : ''}</strong>
              <span className="production-timeline-heading-actions">
                {!showMachineTimeline
                  ? ''
                  : selectedOperator
                    ? 'Click the operator segment again to return to all machines'
                    : 'Click a bar to view the machine summary'}
                <button
                  type="button"
                  className="production-timeline-toggle"
                  onClick={() => setShowMachineTimeline((prev) => !prev)}
                >
                  {showMachineTimeline ? 'Hide list' : `Show list (${machineTimelineRows.length})`}
                </button>
              </span>
            </div>
            {showMachineTimeline && (
              <>
                <div className="timeline-list-toolbar">
                  <input
                    className="input input-sm production-timeline-search"
                    placeholder="Search machine number…"
                    value={machineTimelineSearch}
                    onChange={(e) => setMachineTimelineSearch(e.target.value)}
                  />
                </div>
                <MachineTimelineRows
                  zoom={machineTimelineZoom}
                  scrollRef={machineTimelineScrollRef}
                  machines={machineTimelineRows}
                  selectedMachineId={selectedMachineId}
                  onSelectMachine={onSelectMachine}
                  shiftTimeMin={metrics.shiftTimeMin}
                  selectedOperatorRange={selectedOperatorRange}
                />
              </>
            )}
            <div className="timeline-summary machine-summary">
              {totalMachineSummary.groups.map(({ key, label, color }) => {
                const minutes = shownMachineSummary.minutesByKey.get(key) ?? 0;
                const denominator = selectedMachine ? timelineDuration : timelineDuration * machineTimelineRows.length;
                return (
                  <div key={key} className="timeline-summary-item">
                    <span className="legend-dot" style={{ background: color }} />
                    <span>{label}</span>
                    <strong>{denominator > 0 ? Math.round((minutes / denominator) * 1000) / 10 : 0}%</strong>
                  </div>
                );
              })}
            </div>
            {selectedMachine && <div className="selected-machine-caption">Machine {selectedMachine.label} summary</div>}
            {selectedOperatorRange && selectedOperator && (
              <div className="selected-machine-caption">
                {selectedOperator.label} highlight: {selectedOperatorRange.label} ({Math.round(selectedOperatorRange.startMin * 10) / 10}–{Math.round(selectedOperatorRange.endMin * 10) / 10} min)
              </div>
            )}
          </div>
        </div>

        <div className="dashboard-scroll-outer" ref={dashboardOuterRef} style={dashboardMinHeight ? { minHeight: dashboardMinHeight } : undefined}>
          <div
            className={`dashboard-resize-handle${resizingDashboard ? ' active' : ''}`}
            onPointerDown={startDashboardResize}
            onPointerMove={moveDashboardResize}
            onPointerUp={endDashboardResize}
            onPointerCancel={endDashboardResize}
            title="Drag to resize the panel"
            aria-hidden="true"
          />
          <div className="dashboard">
            <Card
              title="Output (Running Time)"
              subtitle="Estimated from total machine running time; spool quantity can be decimal"
            >
              <OutputMetricsTable
                rows={[
                  { label: '#Spool (running time)', value: fmt(runningOutput.spools) },
                  { label: 'Total running time', value: `${fmt(runningOutput.runningMinutes)} min` },
                  { label: rejectPercent > 0 ? 'Tonage (good)' : 'Tonage', value: `${fmt(runningTimeTonage)} ton` },
                  ...(rejectPercent > 0
                    ? [{ label: 'Reject', value: `${fmt(runningTimeRejectTonage)} ton (${fmt(rejectPercent)}%)`, sub: true, title: 'Gross running-time tonnage × Reject %' }]
                    : []),
                  { label: 'Ton FP', value: `${fmt(runningTimeTonageFp)} ton`, sub: true, title: 'Finish Product — SpoolType starts with BS' },
                  { label: 'Ton SFP', value: `${fmt(runningTimeTonageSfp)} ton`, sub: true, title: 'Semi Finish Product — every other SpoolType' },
                  { label: 'OEE (running time)', value: `${fmt(runningTimeOee)}%` },
                ]}
                perTonRows={[
                  { label: 'Manhour/ton', value: fmt(runningTimeManHourPerTon), fpValue: fmt(runningPerTonFp(manHours)) },
                  { label: 'Machhours/ton', value: fmt(runningTimeMachHoursPerTon), fpValue: fmt(runningPerTonFp(scheduledMachineHours)) },
                  {
                    label: 'Fracture/Ton',
                    value: fmt(runningTimeFracturePerTon),
                    fpValue: fmt(runningPerTonFp(totalFractureCount)),
                    title: 'Total Fracture Repairing dibagi tonage dari running time',
                  },
                  {
                    label: 'Dies/Ton',
                    value: fmt(runningTimeDiesPerTon),
                    fpValue: fmt(runningPerTonFp(metrics.diesChanged)),
                    title: 'Total Dies Change dibagi tonage dari running time',
                  },
                  {
                    label: 'Defect/Ton',
                    value: fmt(runningTimeDefectPerTon),
                    fpValue: fmt(runningPerTonFp(totalDefectRepairingCount)),
                    title: 'Total Defect Repairing dibagi tonage dari running time',
                  },
                ]}
              />
            </Card>

            <Card title="Output" subtitle="Total finished spools across all machines this shift">
              <OutputMetricsTable
                rows={[
                  { label: '#Spool', value: String(totalSpools) },
                  { label: rejectPercent > 0 ? 'Tonage (good)' : 'Tonage', value: `${fmt(tonage)} ton` },
                  ...(rejectPercent > 0
                    ? [{ label: 'Reject', value: `${fmt(rejectTonage)} ton (${fmt(rejectPercent)}%)`, sub: true, title: 'Gross tonnage × Reject %' }]
                    : []),
                  { label: 'Ton FP', value: `${fmt(tonageFp)} ton`, sub: true, title: 'Finish Product — SpoolType starts with BS' },
                  { label: 'Ton SFP', value: `${fmt(tonageSfp)} ton`, sub: true, title: 'Semi Finish Product — every other SpoolType' },
                  { label: 'OEE (finished spool)', value: `${fmt(outputOee)}%` },
                ]}
                perTonRows={[
                  { label: 'Manhour/ton', value: fmt(manHourPerTon), fpValue: fmt(perTonFp(manHours)) },
                  { label: 'Machhours/ton', value: fmt(machHoursPerTon), fpValue: fmt(perTonFp(scheduledMachineHours)) },
                  { label: 'Fracture/Ton (actual)', value: fmt(actualFracturePerTon), fpValue: fmt(perTonFp(totalFractureCount)), title: 'Total Fracture Repairing ÷ Tonage' },
                  { label: 'Dies/Ton (actual)', value: fmt(actualDiesPerTon), fpValue: fmt(perTonFp(metrics.diesChanged)), title: 'Total Dies Change events ÷ Tonage' },
                  { label: 'Defect/Ton (actual)', value: fmt(actualDefectPerTon), fpValue: fmt(perTonFp(totalDefectRepairingCount)), title: 'Total Defect Repairing events ÷ Tonage' },
                ]}
              />
            </Card>

            <Card
              title="Man Occupation"
              subtitle={
                utilFilterLabel
                  ? `Filtered to ${utilFilterLabel} — click the operator name again in the timeline to return to the combined view`
                  : 'Combined across all operators — click an operator name in the timeline to filter to just one'
              }
            >
              {displayedOperators.length === 0 ? (
                <p className="empty-hint">No operators with any assigned task yet.</p>
              ) : (
                <>
                  <div className="util-bar">
                    <div className="util-segment util-walk" style={{ width: `${(utilSummary.walking / (utilSummary.elapsed || 1)) * 100}%` }} />
                    <div className="util-segment util-service" style={{ width: `${(utilSummary.totalService / (utilSummary.elapsed || 1)) * 100}%` }} />
                  </div>
                  <div className="metric-row">
                    <span>Man Occupation</span>
                    <strong>{fmt(utilSummary.utilization)}%</strong>
                  </div>
                  <div className="metric-row small">
                    <span>Walking</span>
                    <span>
                      {fmtTime(utilSummary.walking)} ({fmt((utilSummary.walking / (utilSummary.elapsed || 1)) * 100)}%)
                    </span>
                  </div>
                  <div className="metric-row small">
                    <span>Total handle</span>
                    <span>
                      {fmtTime(utilSummary.totalService)} ({fmt((utilSummary.totalService / (utilSummary.elapsed || 1)) * 100)}%)
                    </span>
                  </div>
                  {utilSummary.serviceBreakdown.map((s) => (
                    <div className="metric-row small" key={s.label}>
                      <span>Handle: {s.label}</span>
                      <span>
                        {fmtTime(s.minutes)} ({fmt((s.minutes / (utilSummary.elapsed || 1)) * 100)}%)
                      </span>
                    </div>
                  ))}
                  <div className="metric-row small">
                    <span>Idle</span>
                    <span>
                      {fmtTime(utilSummary.idle)} ({fmt((utilSummary.idle / (utilSummary.elapsed || 1)) * 100)}%)
                    </span>
                  </div>
                  <div className={`verdict ${utilVerdict.className}`}>{utilVerdict.text}</div>
                  <label className="target-utilization-field">
                    <span>Target Man Occupation</span>
                    <span className="target-utilization-input-group">
                      <input
                        className="input input-sm"
                        type="number"
                        min={1}
                        max={100}
                        value={targetUtilization}
                        onChange={(e) => {
                          const value = parseFloat(e.target.value);
                          if (Number.isFinite(value)) setTargetUtilization(Math.min(100, Math.max(1, value)));
                        }}
                      />
                      <span>%</span>
                    </span>
                  </label>
                  {isAdmin && Math.abs(operatorRecommendation) >= 0.05 && (
                    <div className="verdict-recommendation">
                      #Operator Recommendation: {operatorRecommendation > 0 ? '+' : ''}
                      {fmt(operatorRecommendation)} operator (target ~{targetUtilization}% man occupation)
                      {!utilFilterOperatorId && theoreticalRequiredMinutes !== null && (
                        <>
                          <br />
                          Based on {fmtTime(theoreticalRequiredMinutes)} of theoretical demand per shift across all planned machines'
                          Constructions (not on how this run happened to play out)
                        </>
                      )}
                    </div>
                  )}
                </>
              )}
            </Card>

            <Card
              ref={operatorListPanelRef}
              className={isOperatorListFullscreen ? 'production-operator-list-fullscreen' : ''}
              title="Operator List"
              subtitle="Click a column header to sort ascending/descending"
              actions={
                <Button variant="ghost" onClick={toggleOperatorListFullscreen}>
                  {isOperatorListFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                </Button>
              }
            >
              {displayedOperators.length === 0 ? (
                <p className="empty-hint">No operators with any assigned task yet.</p>
              ) : (
                <div className="machine-timeline-rows production-operator-list-rows">
                  <table className="table">
                    <thead>
                      <tr>
                        {(
                          [
                            ['label', 'Operator'],
                            ['walking', 'Walking'],
                            ['totalService', 'Handling'],
                            ['idle', 'Idle'],
                            ['utilization', 'Utilization'],
                          ] as [OperatorSortColumn, string][]
                        ).map(([column, label]) => (
                          <th
                            key={column}
                            className="production-sortable-th"
                            onClick={() => toggleOperatorSort(column)}
                            title="Click to sort ascending/descending"
                          >
                            {label} {operatorSort.column === column ? (operatorSort.direction === 'asc' ? '▲' : '▼') : ''}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {sortedOperatorRows.map((row) => (
                        <tr
                          key={row.id}
                          className={utilFilterOperatorId === row.id ? 'production-operator-row-active' : ''}
                          onClick={() => setUtilFilterOperatorId(utilFilterOperatorId === row.id ? null : row.id)}
                          style={{ cursor: 'pointer' }}
                        >
                          <td>
                            <span className="legend-dot" style={{ background: row.color }} /> {row.label}
                          </td>
                          <td>{fmtTime(row.walking)}</td>
                          <td>{fmtTime(row.totalService)}</td>
                          <td>{fmtTime(row.idle)}</td>
                          <td>{fmt(row.utilization)}%</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </Card>

            <Card className="dashboard-reject-card">
              <label className="reject-field" title="Share of produced tonnage rejected — the OEE Quality factor (Quality = 100% − Reject%).">
                <span>%Reject</span>
                <input
                  className="input"
                  type="number"
                  min={0}
                  max={100}
                  step={0.1}
                  value={rejectPercent}
                  onChange={(e) => {
                    const next = parseFloat(e.target.value);
                    setRejectPercent(Number.isFinite(next) ? Math.min(100, Math.max(0, next)) : 0);
                  }}
                />
                <span className="reject-field-hint">Quality {fmt(quality * 100)}%</span>
              </label>
            </Card>

            <Card
              title="OEE & Downtime"
              className="dashboard-oee-card"
              subtitle="OEE = Availability × Quality (Quality = 100% − %Reject; Performance assumed at 100%)"
            >
              <div className="oee-gauge-row">
                <div className="oee-gauge">
                  <span className="oee-value">{fmt(oee)}%</span>
                  <span className="oee-caption">OEE</span>
                </div>
                <div className="metric-col">
                  <div className="metric-row small">
                    <span>Availability</span>
                    <span>{fmt(Math.max(0, Math.min(100, availability)))}%</span>
                  </div>
                  <div className="metric-row small">
                    <span>Quality</span>
                    <span>{fmt(quality * 100)}%</span>
                  </div>
                  <div className="metric-row small">
                    <span>Planned production</span>
                    <span>{fmt(plannedProductionMin)} machine-minutes</span>
                  </div>
                  <div className="metric-row small">
                    <span>Total downtime</span>
                    <span>{fmt(totalDowntimeMin)} machine-minutes</span>
                  </div>
                </div>
              </div>
              <div className="downtime-bars">
                {downtimeEntries.map((d) => {
                  const pct = plannedProductionMin > 0 ? (d.value / plannedProductionMin) * 100 : 0;
                  const barPct = maxDowntime > 0 ? (d.value / maxDowntime) * 100 : 0;
                  return (
                    <div key={d.key} className="downtime-row">
                      <span className="downtime-label">{d.label}</span>
                      <div className="downtime-bar-track">
                        <div className="downtime-bar-fill" style={{ width: `${barPct}%`, background: d.color }} />
                      </div>
                      <span className="downtime-value">
                        {fmt(d.value)}m ({fmt(pct)}%)
                      </span>
                    </div>
                  );
                })}
              </div>
            </Card>

            <Card title="Completed Activities" subtitle="vs theoretical full-shift estimate (same formula as the Workload Simulator)">
              {completedRows.length === 0 && <p className="empty-hint">Nothing completed yet.</p>}
              {completedRows.map(([label, value]) => (
                <div className="metric-row" key={label}>
                  <span>{label}</span>
                  <strong>
                    {value}
                    {expectedByLabel.has(label) && <span className="metric-est"> / ~{expectedByLabel.get(label)}</span>}
                  </strong>
                </div>
              ))}
            </Card>

            <Card title={`Queue (${queue.length})`}>
              {queue.length === 0 && <p className="empty-hint">No machines waiting.</p>}
              <ul className="queue-list">
                {queue.map((m) => (
                  <li key={m.id}>
                    <span>Machine {m.label}</span>
                    <span className="queue-tasks">{m.pendingTasks.map((t) => t.label).join(', ')}</span>
                  </li>
                ))}
              </ul>
            </Card>

            {selectedMachine && (
              <Card title={`Machine ${selectedMachine.label}`}>
                <div className="metric-row">
                  <span>Status</span>
                  <strong>{selectedMachine.status}</strong>
                </div>
                <div className="metric-row">
                  <span>Spools this shift</span>
                  <strong>{selectedMachine.shiftSpoolsCompleted}</strong>
                </div>
                <div className="metric-row">
                  <span>Downtime</span>
                  <strong>{Math.round(selectedMachine.downtimeMin * 10) / 10} min</strong>
                </div>
              </Card>
            )}

            <Card title="Activity Log">
              <div className="event-log">
                {[...state.log].reverse().slice(0, 40).map((e) => (
                  <div key={e.id} className="log-row">
                    <span className="log-time">{fmtTime(e.timeMin)}</span>
                    <span>{e.message}</span>
                  </div>
                ))}
              </div>
            </Card>
          </div>
        </div>
      </div>
    </div>
  );
}

/** Renders every machine — the single biggest chunk of DOM in this view at real-factory scale
 * (~1300+ machines × ~7 SVG nodes each). Wrapped in `memo` so panning/zooming, which only changes
 * the parent `<g transform>` and none of these props, skips reconciling this subtree entirely
 * instead of re-diffing every machine on every wheel/drag event. `isDetailed` is a boolean (not
 * the raw zoom level) specifically so it only flips — and only then invalidates this memo — once
 * per LOD threshold crossing, not continuously while zooming. */
const MachinesLayer = memo(function MachinesLayer({
  machines,
  operators,
  clockMin,
  selectedMachineId,
  onSelectMachine,
  assignmentByMachineId,
  areaByConstructionId,
  constructionColorMap,
  operatorLabelById,
  isDetailed,
  highlightedMachineIds,
}: {
  machines: ProductionSimulationState['machines'];
  operators: ProductionSimulationState['operators'];
  clockMin: number;
  selectedMachineId: string | null;
  onSelectMachine: (id: string) => void;
  assignmentByMachineId: Map<string, ProductionMachineAssignment>;
  areaByConstructionId: Map<string, string>;
  constructionColorMap: Map<string, string>;
  operatorLabelById: (id?: string) => string;
  isDetailed: boolean;
  /** Hovered legend entry's machines — highlighted, every other machine dimmed. */
  highlightedMachineIds: Set<string> | null;
}) {
  // Only machines actually mid-service can have a non-trivial zoneColors/progress display, and at
  // 1300+ machines scanning `operators` per machine (O(machines × operators)) would itself be a
  // hot spot — build the "who's servicing what" lookup once per render instead.
  const servicingByMachineId = new Map(
    operators.filter((op) => op.phase === 'servicing' && op.targetMachineId).map((op) => [op.targetMachineId as string, op]),
  );

  return (
    <>
      {machines.map((m) => {
        const runtime = m.runtimePerSpool ?? 0;
        const isStopped = m.status === 'needs-service' || m.status === 'being-serviced';
        const progress = runtime > 0
          ? isStopped
            ? m.runtimePaused && m.runtimeRemainingMin != null
              ? 1 - m.runtimeRemainingMin / runtime
              : 1
            : 1 - (m.nextCompletionAt - clockMin) / runtime
          : 0;
        const servicingOperator = servicingByMachineId.get(m.id);
        const zoneColors = machineZoneColors(m, servicingOperator?.serviceTasks ?? [], servicingOperator?.targetMachineId ?? null);
        const assignment = assignmentByMachineId.get(m.id);
        const area = assignment?.constructionDetailId ? areaByConstructionId.get(assignment.constructionDetailId) : undefined;
        const tooltip = isDetailed
          ? [
              `Machine ${m.label}`,
              `Construction: ${assignment?.constructionDetailLabel ?? '—'}`,
              `Doffing: ${operatorLabelById(assignment?.doffingOperatorId)}`,
              `Loading: ${operatorLabelById(assignment?.loadingOperatorId)}`,
              `Fracture Repairing: ${operatorLabelById(assignment?.fractureRepairingOperatorId)}`,
            ].join('\n')
          : undefined;
        return (
          <MachineNode
            key={m.id}
            id={m.id}
            label={m.label}
            x={m.x}
            y={m.y}
            w={m.widthPx}
            h={m.heightPx}
            orientation={m.orientation}
            pairSide={m.pairSide}
            isBfx={m.type === 'bfx'}
            status={m.status}
            // Rounded to 2% steps so a running machine's donut doesn't force a re-render on
            // every single snapshot — only when the visible fill actually moves.
            progressStep={Math.round(Math.min(1, Math.max(0, progress)) * PROGRESS_STEPS)}
            payoffColor={zoneColors.payoff}
            takeupColor={zoneColors.takeup}
            isSelected={selectedMachineId === m.id}
            borderColor={assignment?.constructionDetailId ? constructionColorMap.get(assignment.constructionDetailId) : undefined}
            showSpoolLabels={!HIDDEN_SPOOL_LABEL_AREAS.has(area ?? '')}
            spoolsSinceLoading={m.spoolsSinceLoading}
            shiftSpoolsCompleted={m.shiftSpoolsCompleted}
            tooltip={tooltip}
            isDetailed={isDetailed}
            highlight={highlightedMachineIds ? highlightedMachineIds.has(m.id) : null}
            onSelect={onSelectMachine}
          />
        );
      })}
    </>
  );
});

type OutputRow = { label: string; value: string | number; sub?: boolean; title?: string };
type PerTonRow = { label: string; value: string | number; fpValue: string | number; title?: string };

/** Output card body: plain metrics first (Ton FP / Ton SFP indented under Tonage), then the
 * per-ton metrics in two columns — divided by total tonnage and by Finish Product tonnage. */
function OutputMetricsTable({ rows, perTonRows }: { rows: OutputRow[]; perTonRows: PerTonRow[] }) {
  return (
    <div className="output-metrics">
      {rows.map((row) => (
        <div key={row.label} className={`output-metrics-row${row.sub ? ' is-sub' : ''}`}>
          <span title={row.title}>{row.label}</span>
          <strong className="output-metrics-span">{row.value}</strong>
        </div>
      ))}
      <div className="output-metrics-row output-metrics-head">
        <span />
        <span title="Divided by total tonnage">÷ Ton</span>
        <span title="Divided by Finish Product tonnage (SpoolType BS…)">÷ Ton FP</span>
      </div>
      {perTonRows.map((row) => (
        <div key={row.label} className="output-metrics-row">
          <span title={row.title}>{row.label}</span>
          <strong>{row.value}</strong>
          <strong className="output-metrics-fp">{row.fpValue}</strong>
        </div>
      ))}
    </div>
  );
}

const DEFAULT_DASHBOARD_WIDTH = 340;
const MIN_DASHBOARD_WIDTH = 280;
const MAX_DASHBOARD_WIDTH_RATIO = 0.6;

const PROGRESS_STEPS = 50;
/** How often expired routes are cleared — one batched update instead of a timer per walk. */
const ROUTE_EXPIRY_CHECK_MS = 500;

/** Walking routes on the canvas. Each operator's whole planned route is captured the moment a
 * walk starts and held on screen for at least ROUTE_HOLD_MS of real (wall-clock) time, regardless
 * of sim speed. Owns its own state so route changes and expiries only re-render this layer: they
 * used to live in ProductionRunView, where every walk start and every per-walk expiry timer
 * re-rendered the WHOLE page — at ~1300 machines / 8× that was dozens of extra full renders per
 * second on top of the throttled snapshots. */
const OperatorRoutesLayer = memo(function OperatorRoutesLayer({
  operators,
}: {
  operators: ProductionSimulationState['operators'];
}) {
  const [routes, setRoutes] = useState<Record<string, { points: Point[]; expiresAt: number }>>({});
  const routeKeysRef = useRef<Record<string, string>>({});

  useEffect(() => {
    const now = performance.now();
    operators.forEach((op) => {
      const route = op.plannedRoute;
      if (!route || route.length < 2) return;
      const key = route.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('|');
      if (key === routeKeysRef.current[op.id]) return;
      routeKeysRef.current[op.id] = key;
      setRoutes((prev) => ({ ...prev, [op.id]: { points: route, expiresAt: now + ROUTE_HOLD_MS } }));
    });
  }, [operators]);

  useEffect(() => {
    const interval = setInterval(() => {
      const now = performance.now();
      setRoutes((prev) => {
        const expired = Object.keys(prev).filter((id) => prev[id].expiresAt <= now);
        if (expired.length === 0) return prev;
        const next = { ...prev };
        expired.forEach((id) => delete next[id]);
        return next;
      });
    }, ROUTE_EXPIRY_CHECK_MS);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      {operators.map((op, index) => {
        const route = routes[op.id];
        return route ? (
          <polyline
            key={`route-${op.id}`}
            points={route.points.map((p) => `${p.x},${p.y}`).join(' ')}
            className="operator-path"
            fill="none"
            style={{ stroke: OPERATOR_COLORS[index % OPERATOR_COLORS.length] }}
          />
        ) : null;
      })}
    </>
  );
});

/** One machine on the Production Run canvas. Memoized on plain values only: each UI snapshot
 * hands every machine a fresh object, so the old single-layer render re-diffed all ~1300
 * machines (≈10 SVG nodes each) every time; now React skips every machine whose visible state
 * didn't change since the last snapshot. */
const MachineNode = memo(function MachineNode({
  id,
  label,
  x,
  y,
  w,
  h,
  orientation,
  pairSide,
  isBfx,
  status,
  progressStep,
  payoffColor,
  takeupColor,
  isSelected,
  borderColor,
  showSpoolLabels,
  spoolsSinceLoading,
  shiftSpoolsCompleted,
  tooltip,
  isDetailed,
  highlight,
  onSelect,
}: {
  id: string;
  label: string;
  x: number;
  y: number;
  w: number;
  h: number;
  orientation: ProductionSimulationState['machines'][number]['orientation'];
  pairSide: ProductionSimulationState['machines'][number]['pairSide'];
  isBfx: boolean;
  status: ProductionSimulationState['machines'][number]['status'];
  progressStep: number;
  payoffColor: string | null;
  takeupColor: string | null;
  isSelected: boolean;
  borderColor: string | undefined;
  showSpoolLabels: boolean;
  spoolsSinceLoading: number;
  shiftSpoolsCompleted: number;
  tooltip: string | undefined;
  isDetailed: boolean;
  /** true = legend-highlighted, false = dimmed, null = no legend hover. */
  highlight: boolean | null;
  onSelect: (id: string) => void;
}) {
  const payoffY = orientation === 'flipped' ? h * 0.7 : 0;
  const takeupY = orientation === 'flipped' ? 0 : h * 0.7;
  const takeupProgressY = takeupY + (orientation === 'flipped' ? 8 : 20);
  const payoffTextY = payoffY + h * 0.2;
  const takeupTextY = takeupY + (orientation === 'flipped' ? 20 : 10);
  return (
    <g
      transform={`translate(${x - w / 2}, ${y - h / 2})`}
      onClick={() => onSelect(id)}
      style={{ cursor: 'pointer' }}
      className={highlight === null ? undefined : highlight ? 'machine-highlighted' : 'machine-dimmed'}
    >
      {tooltip && <title>{tooltip}</title>}
      <rect
        width={w}
        height={h}
        rx={6}
        className={`machine-box ${status === 'running' ? 'sim-machine-running' : status === 'unassigned' ? 'sim-machine-unassigned' : 'sim-machine-stopped'} ${
          isBfx ? 'machine-bfx-outline' : ''
        } ${isSelected ? 'production-machine-selected' : ''}`}
        style={borderColor && !isSelected ? { stroke: borderColor, strokeWidth: 2.5 } : undefined}
      />
      {payoffColor && <rect x={1} y={payoffY} width={w - 2} height={h * 0.3 - 1} rx={4} fill={payoffColor} opacity={0.9} />}
      {takeupColor && <rect x={1} y={takeupY} width={w - 2} height={h * 0.3 - 1} rx={4} fill={takeupColor} opacity={0.9} />}
      {isDetailed && (
        <>
          <MachineZoneLabels orientation={orientation} pairSide={pairSide} width={w} height={h} />
          {status !== 'unassigned' && (
            <g transform={`translate(${w / 2}, ${takeupProgressY})`}>
              <MachineDonut progress={progressStep / PROGRESS_STEPS} />
            </g>
          )}
        </>
      )}
      <text x={w / 2} y={h / 2 + 10} textAnchor="middle" className="machine-label">
        {label}
      </text>
      {isDetailed && status !== 'unassigned' && (
        <>
          {showSpoolLabels && (
            <text x={w / 2} y={payoffTextY} textAnchor="middle" className="machine-sublabel">
              {ordinal(spoolsSinceLoading)} spl
            </text>
          )}
          <text x={w / 2} y={takeupTextY} textAnchor="middle" className="machine-sublabel">
            {shiftSpoolsCompleted} spl
          </text>
        </>
      )}
    </g>
  );
});

/** The Machine Timeline table — the other big chunk of DOM at real-factory scale (each of
 * ~1300+ rows can carry many timeline segments). Memoized for the same reason as MachinesLayer:
 * this list lives in the same component as the canvas, so without memoization every pan/zoom
 * tick would also re-diff this entire table. Can also be hidden outright (see showMachineTimeline
 * in the parent) when even the memoized render is more than needed. */
const MachineTimelineRows = memo(function MachineTimelineRows({
  zoom,
  scrollRef,
  machines,
  selectedMachineId,
  onSelectMachine,
  shiftTimeMin,
  selectedOperatorRange,
}: {
  zoom: number;
  scrollRef: React.RefObject<HTMLDivElement | null>;
  machines: ProductionSimulationState['machines'];
  selectedMachineId: string | null;
  onSelectMachine: (id: string) => void;
  shiftTimeMin: number;
  selectedOperatorRange: { startMin: number; endMin: number } | null;
}) {
  if (machines.length === 0) return <p className="empty-hint">No machines match.</p>;
  return (
    <div className="machine-timeline-rows timeline-zoom-scroll" ref={scrollRef} style={{ '--timeline-zoom': zoom } as React.CSSProperties}>
      <TimelineRuler shiftTimeMin={shiftTimeMin} zoom={zoom} offsetPx={MACHINE_TIMELINE_LABEL_PX} />
      {machines.map((machine) => (
        <button
          key={machine.id}
          type="button"
          className={`machine-timeline-row ${selectedMachineId === machine.id ? 'selected' : ''}`}
          onClick={() => onSelectMachine(machine.id)}
        >
          <span className="machine-timeline-label">{machine.label}</span>
          <span className="operator-timeline-track">
            {selectedOperatorRange && (
              <span
                className="timeline-range-highlight"
                style={{
                  left: `${(selectedOperatorRange.startMin / (shiftTimeMin || 1)) * 100}%`,
                  width: `${((Math.min(selectedOperatorRange.endMin, shiftTimeMin) - selectedOperatorRange.startMin) / (shiftTimeMin || 1)) * 100}%`,
                }}
              />
            )}
            {machine.timeline.map((segment, index) => {
              const width = ((Math.min(segment.endMin, shiftTimeMin) - segment.startMin) / (shiftTimeMin || 1)) * 100;
              return (
                <span
                  key={`${segment.startMin}-${index}`}
                  className="operator-timeline-segment"
                  title={`${segment.label}: ${Math.round((segment.endMin - segment.startMin) * 10) / 10} min`}
                  style={{ width: `${Math.max(0, width)}%`, background: machineTimelineColor(segment.kind) }}
                />
              );
            })}
          </span>
        </button>
      ))}
    </div>
  );
});
