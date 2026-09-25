import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { MachineTimelineKind, OperatorTimelineKind, SimulationState } from '../../types';
import { MachineZoneLabels } from '../ui/MachineZoneLabels';
import { MachineDonut } from './MachineDonut';
import { Button } from '../ui/Button';
import { TimelineRuler, TimelineZoomControl } from '../ui/TimelineZoom';
import { useTimelineZoomScroll } from '../../hooks/useTimelineZoom';
import {
  machineZoneColors,
  operatorFacing,
  ordinal,
  timelineKinds,
  machineTimelineKinds,
  machineTimelineColor,
  machineTimelineLabel,
} from './timelineDisplay';

const LABEL_MARGIN = 24;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 3;
const FIT_MARGIN = 60;

type Point = { x: number; y: number };

function operatorLabel(state: SimulationState): string {
  const { operator } = state;
  if (operator.phase === 'break') return `${operator.breakLabel} (${Math.ceil(operator.breakRemainingMin)}m remaining)`;
  if (operator.phase === 'walking') return `Moving to Machine ${operator.targetMachineLabel}`;
  if (operator.phase === 'servicing') {
    return operator.currentZoneLabel ?? `Handling Machine ${operator.targetMachineLabel}`;
  }
  return 'Idle';
}

const HIDDEN_SPOOL_LABEL_AREAS = new Set(['WW', 'IS', 'IP', 'BA', 'CA']);

export function LayoutCanvas({
  state,
  area,
  fullscreenControls,
}: {
  state: SimulationState;
  area?: string;
  fullscreenControls?: ReactNode;
}) {
  const { machines, operator, metrics } = state;
  const showSpoolLabels = !HIDDEN_SPOOL_LABEL_AREAS.has(area?.trim().toUpperCase() ?? '');
  const [selectedMachineId, setSelectedMachineId] = useState<string | null>(null);
  const [selectedOperatorSegment, setSelectedOperatorSegment] = useState<number | null>(null);
  const isMovingBetweenMachines = operator.phase === 'walking';
  const isMovingWithinMachine = operator.phase === 'servicing' && operator.serviceSubPhase === 'moving';
  const isMoving = isMovingBetweenMachines || isMovingWithinMachine;

  // At higher sim speeds a whole walk (every corridor hop, arrival, and service start) can complete
  // within a single animation frame — React never renders an in-between state, so sampling
  // isMoving/fromX/toX per frame can miss the walk entirely and show a stale line. Instead, capture
  // the WHOLE planned route the moment a walk begins (fixed for that walk, see plannedRoute) and
  // hold it on screen for at least 5 real (wall-clock) seconds regardless of how fast it played out.
  const [displayedRoute, setDisplayedRoute] = useState<Point[] | null>(null);
  const displayedRouteKeyRef = useRef<string | null>(null);
  const holdTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    const route = operator.plannedRoute;
    if (!route || route.length < 2) return;
    const key = route.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('|');
    if (key === displayedRouteKeyRef.current) return;
    displayedRouteKeyRef.current = key;
    setDisplayedRoute(route);
    if (holdTimeoutRef.current) clearTimeout(holdTimeoutRef.current);
    holdTimeoutRef.current = setTimeout(() => {
      setDisplayedRoute(null);
      holdTimeoutRef.current = null;
    }, 5000);
  }, [operator.plannedRoute]);
  useEffect(() => () => {
    if (holdTimeoutRef.current) clearTimeout(holdTimeoutRef.current);
  }, []);

  // Pan/zoom lets the layout be inspected while the sim is running or paused — the world content
  // (machine positions) never changes mid-run, so bounds/fit are computed once machines are known.
  const wrapperRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [viewSize, setViewSize] = useState({ width: 800, height: 520 });
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<Point>({ x: 0, y: 0 });
  const [panning, setPanning] = useState(false);
  const panStartRef = useRef<{ vb: Point; pan: Point } | null>(null);
  const hasAutoFitRef = useRef(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Lets the canvas be dragged taller/shorter (see the resize handle below the SVG) instead of
  // being stuck at a fixed height — the ResizeObserver already watching wrapperRef picks up the
  // new size automatically and updates the SVG viewBox, so nothing else needs to react to this.
  const [canvasHeight, setCanvasHeight] = useState(420);
  const {
    zoom: operatorTimelineZoom,
    scrollRef: operatorTimelineScrollRef,
    scrollStyle: operatorTimelineScrollStyle,
  } = useTimelineZoomScroll();
  const {
    zoom: machineTimelineZoom,
    scrollRef: machineTimelineScrollRef,
    scrollStyle: machineTimelineScrollStyle,
  } = useTimelineZoomScroll();
  const canvasResizeRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const [resizingCanvas, setResizingCanvas] = useState(false);
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
    if (machines.length === 0) {
      setZoom(1);
      setPan({ x: 0, y: 0 });
      return;
    }
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

  // Track the wrapper's actual rendered size so viewBox always matches it 1:1, and fit the layout
  // into view once we know both that size and the machine layout.
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

  // Re-frame the layout once the browser has actually resized the wrapper for fullscreen —
  // the ResizeObserver above only auto-fits once, so entering/exiting fullscreen needs its own nudge.
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

  const timelineDuration = Math.max(0, Math.min(metrics.clockMin, metrics.shiftTimeMin));
  const allOperatorTimelineKinds = useMemo(
    () => [
      ...timelineKinds,
      ...operator.timeline
        .filter((segment) => !timelineKinds.some((item) => item.kind === segment.kind))
        .reduce<{ kind: OperatorTimelineKind; label: string; color: string }[]>((items, segment) => {
          if (!items.some((item) => item.kind === segment.kind)) {
            items.push({ kind: segment.kind, label: segment.label.split(' — ')[0], color: '#c084fc' });
          }
          return items;
        }, []),
    ],
    [operator.timeline],
  );
  const timelineTotals = allOperatorTimelineKinds.map(({ kind }) => ({
    kind,
    minutes: operator.timeline
      .filter((segment) => segment.kind === kind)
      .reduce((total, segment) => total + Math.max(0, Math.min(segment.endMin, timelineDuration) - segment.startMin), 0),
  }));
  const selectedMachine = machines.find((machine) => machine.id === selectedMachineId) ?? null;
  // Machine Timeline only lists machines actually assigned to the operator — unassigned machines
  // never run/queue tasks, so they'd only ever show an empty bar.
  const plannedMachines = useMemo(() => machines.filter((m) => m.status !== 'unassigned'), [machines]);
  const allMachineTimelineKinds = useMemo(
    () => [
      ...machineTimelineKinds,
      ...plannedMachines
        .flatMap((machine) => machine.timeline)
        .filter((segment) => !machineTimelineKinds.some((item) => item.kind === segment.kind))
        .reduce<{ kind: MachineTimelineKind; label: string; color: string }[]>((items, segment) => {
          if (!items.some((item) => item.kind === segment.kind)) {
            items.push({ kind: segment.kind, label: machineTimelineLabel(segment.kind, segment.label), color: machineTimelineColor(segment.kind) });
          }
          return items;
        }, []),
    ],
    [plannedMachines],
  );
  const selectedOperatorRange =
    selectedOperatorSegment == null ? null : operator.timeline[selectedOperatorSegment] ?? null;
  const machineSummary = useCallback(
    (timeline: typeof machines[number]['timeline']) =>
      allMachineTimelineKinds.map(({ kind }) => ({
        kind,
        minutes: timeline
          .filter((segment) => segment.kind === kind)
          .reduce((total, segment) => total + Math.max(0, Math.min(segment.endMin, timelineDuration) - segment.startMin), 0),
      })),
    [allMachineTimelineKinds, timelineDuration],
  );
  const totalMachineSummary = useMemo(
    () =>
      allMachineTimelineKinds.map(({ kind }) => ({
        kind,
        minutes: plannedMachines.reduce(
          (total, machine) => total + machineSummary(machine.timeline).find((item) => item.kind === kind)!.minutes,
          0,
        ),
      })),
    [allMachineTimelineKinds, plannedMachines, machineSummary],
  );

  return (
    <div className={`sim-canvas-wrap ${isFullscreen ? 'sim-canvas-fullscreen' : ''}`} ref={panelRef}>
      {isFullscreen && fullscreenControls && <div className="sim-canvas-fullscreen-controls">{fullscreenControls}</div>}
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
      <div className="sim-svg-wrap" ref={wrapperRef} style={!isFullscreen ? { height: canvasHeight } : undefined}>
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
        <g transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}>
        <g transform={`translate(${LABEL_MARGIN}, ${LABEL_MARGIN})`}>
          {machines.map((m) => {
            const runtime = metrics.runtimePerSpoolMin;
            const isStopped = m.status === 'needs-service' || m.status === 'being-serviced';
            const progress = runtime > 0
              ? isStopped
                ? m.runtimePaused && m.runtimeRemainingMin != null
                  ? 1 - m.runtimeRemainingMin / runtime
                  : 1
                : 1 - (m.nextCompletionAt - metrics.clockMin) / runtime
              : 0;
            const zoneColors = machineZoneColors(m, operator.serviceTasks, operator.targetMachineId);
            const w = m.widthPx;
            const h = m.heightPx;
            const payoffY = m.orientation === 'flipped' ? h * 0.7 : 0;
            const takeupY = m.orientation === 'flipped' ? 0 : h * 0.7;
            const takeupProgressY = takeupY + (m.orientation === 'flipped' ? 8 : 20);
            const payoffTextY = payoffY + h * 0.2;
            const takeupTextY = takeupY + (m.orientation === 'flipped' ? 20 : 10);
            return (
              <g key={m.id} transform={`translate(${m.x - w / 2}, ${m.y - h / 2})`}>
                <rect
                  width={w}
                  height={h}
                  rx={6}
                  className={`machine-box ${m.status === 'running' ? 'sim-machine-running' : 'sim-machine-stopped'} ${
                    m.type === 'bfx' ? 'machine-bfx-outline' : ''
                  }`}
                />
                {zoneColors.payoff && (
                  <rect
                    x={1}
                    y={payoffY}
                    width={w - 2}
                    height={h * 0.3 - 1}
                    rx={4}
                    fill={zoneColors.payoff}
                    opacity={0.9}
                  />
                )}
                {zoneColors.takeup && (
                  <rect
                    x={1}
                    y={takeupY}
                    width={w - 2}
                    height={h * 0.3 - 1}
                    rx={4}
                    fill={zoneColors.takeup}
                    opacity={0.9}
                  />
                )}
                <MachineZoneLabels orientation={m.orientation} pairSide={m.pairSide} width={w} height={h} />
                {m.status !== 'unassigned' && (
                  <g transform={`translate(${w / 2}, ${takeupProgressY})`}>
                    <MachineDonut progress={progress} />
                  </g>
                )}
                <text x={w / 2} y={h / 2 + 10} textAnchor="middle" className="machine-label">
                  {m.label}
                </text>
                {showSpoolLabels && (
                  <text x={w / 2} y={payoffTextY} textAnchor="middle" className="machine-sublabel">
                    {ordinal(m.spoolsSinceLoading)} spl
                  </text>
                )}
                <text x={w / 2} y={takeupTextY} textAnchor="middle" className="machine-sublabel">
                  {m.shiftSpoolsCompleted} spl
                </text>
              </g>
            );
          })}

          {displayedRoute && (
            <polyline points={displayedRoute.map((p) => `${p.x},${p.y}`).join(' ')} className="operator-path" fill="none" />
          )}

          <g transform={`translate(${operator.x}, ${operator.y})`} className="operator-token">
            {isMoving && <circle r={16} className="operator-walk-ring" />}
            <g
              transform={`rotate(${operatorFacing(
                operator.currentZoneLabel,
                operator.x,
                machines.find((machine) => machine.id === operator.targetMachineId) ?? null,
              )})`}
            >
              <circle cy={-6} r={3} className="operator-head" />
              <ellipse cy={1.5} rx={6} ry={4.5} className={`operator-shoulders operator-${operator.phase}`} />
              <path d="M-4.5,-1 L-7,-6.5 M4.5,-1 L7,-6.5" className="operator-arms" />
            </g>
            <g transform="translate(0, 24)">
              <rect x={-72} y={-11} width={144} height={18} rx={9} className="operator-label-bg" />
              <text textAnchor="middle" y={2} className="operator-label-text">
                {operatorLabel(state)}
              </text>
            </g>
          </g>
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
        <LegendItem colorClass="sim-machine-running" label="Running" />
        <LegendItem colorClass="sim-machine-stopped" label="Stopped / Waiting" />
      </div>
      {/* One zoom for both the Operator and the Machine timeline below. */}
      <div className="timeline-zoom-bar">
        <TimelineZoomControl />
      </div>
      <div className="operator-timeline layout-operator-timeline">
        <div className="timeline-heading">
          <strong>Operator Timeline</strong>
          <span>Real-time activity during the shift</span>
        </div>
        <div
          className="timeline-zoom-scroll layout-operator-timeline-scroll"
          ref={operatorTimelineScrollRef}
          style={operatorTimelineScrollStyle}
        >
        <TimelineRuler shiftTimeMin={metrics.shiftTimeMin} zoom={operatorTimelineZoom} />
        <div className="operator-timeline-track">
          {operator.timeline.map((segment, index) => {
            const width = ((Math.min(segment.endMin, metrics.shiftTimeMin) - segment.startMin) / (metrics.shiftTimeMin || 1)) * 100;
            const item = timelineKinds.find((entry) => entry.kind === segment.kind);
            return (
              <button
                key={`${segment.startMin}-${index}`}
                type="button"
                className={`operator-timeline-segment ${selectedOperatorSegment === index ? 'selected' : ''}`}
                title={`${segment.label}: ${Math.round((segment.endMin - segment.startMin) * 10) / 10} min — click to highlight machines`}
                onClick={() => setSelectedOperatorSegment(selectedOperatorSegment === index ? null : index)}
                style={{ width: `${Math.max(0, width)}%`, background: item?.color ?? '#c084fc' }}
              />
            );
          })}
          {metrics.clockMin < metrics.shiftTimeMin && (
            <div className="operator-timeline-current" style={{ left: `${(timelineDuration / (metrics.shiftTimeMin || 1)) * 100}%` }} />
          )}
        </div>
        </div>
        <div className="timeline-summary">
          {timelineTotals.map(({ kind, minutes }) => {
            const item = allOperatorTimelineKinds.find((entry) => entry.kind === kind)!;
            const percentage = timelineDuration > 0 ? (minutes / timelineDuration) * 100 : 0;
            return (
              <div key={kind} className="timeline-summary-item">
                <span className="legend-dot" style={{ background: item.color }} />
                <span>{item.label}</span>
                <strong>{Math.round(percentage * 10) / 10}%</strong>
              </div>
            );
          })}
        </div>
      </div>
      <div className="machine-timelines">
        <div className="timeline-heading">
          <strong>Machine Timeline</strong>
          <span>Click a bar to view the machine summary</span>
        </div>
        <div
          className="machine-timeline-rows timeline-zoom-scroll"
          ref={machineTimelineScrollRef}
          style={machineTimelineScrollStyle}
        >
        <TimelineRuler shiftTimeMin={metrics.shiftTimeMin} zoom={machineTimelineZoom} offsetPx={80} />
        {plannedMachines.map((machine) => (
          <button
            key={machine.id}
            type="button"
            className={`machine-timeline-row ${selectedMachineId === machine.id ? 'selected' : ''}`}
            onClick={() => setSelectedMachineId(selectedMachineId === machine.id ? null : machine.id)}
          >
            <span className="machine-timeline-label">Machine {machine.label}</span>
            <span className="operator-timeline-track">
              {selectedOperatorRange && (
                <span
                  className="timeline-range-highlight"
                  style={{
                    left: `${(selectedOperatorRange.startMin / (metrics.shiftTimeMin || 1)) * 100}%`,
                    width: `${((Math.min(selectedOperatorRange.endMin, metrics.shiftTimeMin) - selectedOperatorRange.startMin) / (metrics.shiftTimeMin || 1)) * 100}%`,
                  }}
                />
              )}
              {machine.timeline.map((segment, index) => {
                const item = allMachineTimelineKinds.find((entry) => entry.kind === segment.kind);
                const width = ((Math.min(segment.endMin, metrics.shiftTimeMin) - segment.startMin) / (metrics.shiftTimeMin || 1)) * 100;
                return (
                  <span
                    key={`${segment.startMin}-${index}`}
                    className="operator-timeline-segment"
                    title={`${segment.label}: ${Math.round((segment.endMin - segment.startMin) * 10) / 10} min`}
                    style={{ width: `${Math.max(0, width)}%`, background: item?.color ?? machineTimelineColor(segment.kind) }}
                  />
                );
              })}
            </span>
          </button>
        ))}
        </div>
        <div className="timeline-summary machine-summary">
          {allMachineTimelineKinds.map(({ kind, label, color }) => {
            const minutes = (selectedMachine ? machineSummary(selectedMachine.timeline) : totalMachineSummary).find(
              (item) => item.kind === kind,
            )!.minutes;
            const denominator = selectedMachine ? timelineDuration : timelineDuration * machines.filter((m) => m.status !== 'unassigned').length;
            return (
              <div key={kind} className="timeline-summary-item">
                <span className="legend-dot" style={{ background: color }} />
                <span>{label}</span>
                <strong>{denominator > 0 ? Math.round((minutes / denominator) * 1000) / 10 : 0}%</strong>
              </div>
            );
          })}
        </div>
        {selectedMachine && <div className="selected-machine-caption">Machine {selectedMachine.label} summary</div>}
        {selectedOperatorRange && (
          <div className="selected-machine-caption">
            Operator highlight: {selectedOperatorRange.label} ({Math.round(selectedOperatorRange.startMin * 10) / 10}–{Math.round(selectedOperatorRange.endMin * 10) / 10} min)
          </div>
        )}
      </div>
    </div>
  );
}

function LegendItem({ colorClass, label }: { colorClass: string; label: string }) {
  return (
    <span className="legend-item">
      <span className={`legend-swatch ${colorClass}`} />
      {label}
    </span>
  );
}
