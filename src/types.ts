export interface MachineSpecInput {
  area: string;
  layLength: number;
  noOfWires: number;
  speed: number;
  spoolLength: number;
  linearDensity: number;
  fracturePerTon: number;
}

export const PRODUCT_AREAS = ['BU', 'CB', 'SP', 'CH', 'CR', 'WW', 'IS', 'IP', 'CA', 'BA'] as const;
export type ProductArea = (typeof PRODUCT_AREAS)[number];

export interface MachineSpecDerived {
  twistPerMin: number;
  spoolWeight: number;
  linearSpeed: number;
  runtimePerSpool: number;
}

export type TaskPriorityMode = 'nearest' | 'quickest';

export interface OperatorConfig {
  machHandled: number;
  shiftTime: number;
  lunchTime: number;
  lunchStartAt: number;
  meetingTime: number;
  meetingStartAt: number;
  taskPriority: TaskPriorityMode;
}

export type ActivityKey = string;

export type MachCondition = 'stop' | 'run';

export interface ActivityConfig {
  key: ActivityKey;
  parentKey?: ActivityKey;
  label: string;
  timeMinutes: number;
  numerator: number;
  numeratorAuto: boolean;
  denominator: number;
  denominatorAuto: boolean;
  machCondition: MachCondition;
  /** Locks the Time field in the Activity Table (display-only) — used for Loading rows whose Time
   * is sourced straight from WL_Activities via the POlength regulation, so it can't be silently
   * hand-edited and drift from that source. Unlike numeratorAuto/denominatorAuto this doesn't swap
   * in a live formula value, it just keeps whatever value was already computed read-only. */
  timeReadOnly?: boolean;
  /** Same idea as timeReadOnly, for Numerator — distinct from numeratorAuto (which is hardcoded to
   * the Fracture/Ton formula in the UI); this just locks whatever numeric value is already stored. */
  numeratorReadOnly?: boolean;
  /** Same idea as timeReadOnly, for Denominator — distinct from denominatorAuto (hardcoded to the
   * 1000/SpoolWeight formula); this just locks whatever numeric value is already stored. */
  denominatorReadOnly?: boolean;
  /** Marks a Loading sub-activity as Partial1, Partial2 or Partial3 for the "both partials due at
   * once" regulation: when Partial1 and Partial2 both come due on the same machine at the same
   * time, the simulation replaces them with a single Partial3 task instead of doing both in
   * sequence — see queueTasksForMachine in simulationEngine.ts. Partial3 itself never comes due on
   * its own (its numerator is 0, an infinite cycle) — it only exists as that substitution's source
   * for Time/MachCondition. */
  loadingPartialSlot?: 1 | 2 | 3;
  /** Loading is triggered from fractional production progress (weight) and may interrupt a spool. */
  loadingInterrupt?: boolean;
}

export interface MovementParams {
  walkingSpeed: number; // meter/min
  pixelsPerMeter: number; // canvas scale: how many px represent 1 meter
}

export type MachineType = 'normal' | 'bfx';
export type MachineOrientation = 'normal' | 'flipped';
export type MachineZone = 'payoff' | 'cradle' | 'takeup';
/** Two machines are typically paired side-by-side and share their Cradle access on the outer edges only. */
export type MachinePairSide = 'single' | 'left' | 'right';

export interface LayoutMachine {
  id: string;
  label: string;
  x: number;
  y: number;
  type: MachineType;
  orientation: MachineOrientation;
  pairSide: MachinePairSide;
  /** Machine footprint in meters — undefined means "use the default size" (see
   * DEFAULT_MACHINE_WIDTH_M/DEFAULT_MACHINE_LENGTH_M in layoutConstants.ts), which keeps every
   * layout saved before the Resize feature existed rendering/simulating exactly as before. */
  widthM?: number;
  lengthM?: number;
}

/** The single point on the layout canvas where the operator stands before the simulation starts.
 * Optional/backward-compatible: layouts saved before this feature existed have no start point, and
 * the simulation engine falls back to the first machine's position in that case. */
export interface OperatorStartPoint {
  x: number;
  y: number;
}

export interface AppConfig {
  spec: MachineSpecInput;
  operator: OperatorConfig;
  activities: ActivityConfig[];
  movement: MovementParams;
  layout: LayoutMachine[];
  /** Where the operator starts before the simulation begins. Undefined means "no start point set
   * yet" — the simulation falls back to the first machine's position. */
  operatorStart?: OperatorStartPoint;
  /** Which machines in `layout` the operator actually handles — explicitly chosen in the Machine
   * Layout step (Assign/Unassign on the current selection), capped at `operator.machHandled`. The
   * simulation only ever runs these machines; the rest sit idle ('unassigned'). */
  assignedMachineIds?: string[];
  /** WL_Products record (mpp_wl_productsid) currently selected via the Construction Detail
   * dropdown — spec/activities were auto-filled from it. Undefined until a user picks one. */
  selectedProductId?: string;
  /** Display text (mpp_constructiondetailcode) for `selectedProductId`, cached alongside it so the
   * UI (e.g. the Simulation controls bar) can show it without re-fetching WL_Products. */
  selectedConstructionDetail?: string;
}

export type MachineStatus = 'running' | 'needs-service' | 'being-serviced' | 'unassigned';

export interface PendingTask {
  activity: ActivityKey;
  label: string;
  timeMinutes: number;
  /** Production Simulation only: which ProductionOperator this specific task belongs to (resolved
   * from the machine's per-activity operator assignment). Undefined in the single-operator
   * Simulator, where every task implicitly belongs to the one shared operator. */
  assignedOperatorId?: string;
}

export type DowntimeReason = string;

export interface MachineRuntimeState {
  id: string;
  label: string;
  x: number;
  y: number;
  type: MachineType;
  orientation: MachineOrientation;
  pairSide: MachinePairSide;
  /** This machine's actual footprint in pixels, resolved once at simulation start from its
   * widthM/lengthM (or the default size if unset) and the run's pixelsPerMeter — used for zone
   * positioning and operator-routing clearance instead of the old fixed MACHINE_W/MACHINE_H. */
  widthPx: number;
  heightPx: number;
  status: MachineStatus;
  spoolsCompleted: number;
  shiftSpoolsCompleted: number;
  spoolsSinceLoading: number;
  nextCompletionAt: number;
  pendingTasks: PendingTask[];
  queuedSince: number | null;
  totalServiced: number;
  completedByActivity: Record<ActivityKey, number>;
  downtimeMin: number;
  downtimeByReason: Record<DowntimeReason, number>;
  timeline: MachineTimelineSegment[];
  runtimePaused: boolean;
  runtimeRemainingMin: number | null;
}

export type MachineTimelineKind = 'running' | 'waiting' | ActivityKey;

export interface MachineTimelineSegment {
  startMin: number;
  endMin: number;
  kind: MachineTimelineKind;
  label: string;
}

export type OperatorPhase = 'idle' | 'walking' | 'servicing' | 'break';
export type ServiceSubPhase = 'moving' | 'dwelling' | null;

export interface ServiceSegment {
  zone: MachineZone;
  label: string;
  dwellMin: number;
  x: number;
  y: number;
}

export interface OperatorRuntimeState {
  x: number;
  y: number;
  phase: OperatorPhase;
  targetMachineId: string | null;
  targetMachineLabel: string | null;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  walkProgress: number; // 0..1
  walkDurationMin: number;
  /** Remaining corridor waypoints (after the current fromX/fromY -> toX/toY hop) on the way to the
   * target machine's first service zone — see computeWalkingWaypoints. */
  pendingWaypoints: { x: number; y: number }[];
  /** The complete route (including the start point) planned for the current/most recent walk,
   * fixed once at walk start and left untouched as pendingWaypoints is consumed hop by hop. Lets
   * the UI show the whole bent path even if the sim runs fast enough to skip every intermediate
   * render of the walk itself. */
  plannedRoute: { x: number; y: number }[];
  serviceTasks: PendingTask[];
  serviceSegments: ServiceSegment[];
  serviceSubPhase: ServiceSubPhase;
  currentZoneLabel: string | null;
  zoneMoveFromX: number;
  zoneMoveFromY: number;
  zoneMoveToX: number;
  zoneMoveToY: number;
  zoneMoveProgress: number;
  zoneMoveDurationMin: number;
  zoneDwellRemainingMin: number;
  breakLabel: string | null;
  breakRemainingMin: number;
  timeline: OperatorTimelineSegment[];
}

export type OperatorTimelineKind = ActivityKey | 'walking' | 'lunch' | 'meeting' | 'idle';

export interface OperatorTimelineSegment {
  startMin: number;
  endMin: number;
  kind: OperatorTimelineKind;
  label: string;
}

export interface EventLogEntry {
  id: string;
  timeMin: number;
  message: string;
}

export interface SimMetrics {
  clockMin: number;
  shiftTimeMin: number;
  runtimePerSpoolMin: number;
  availableTimeMin: number;
  breakElapsedMin: number;
  walkingMin: number;
  servicingMin: number;
  servicingByActivity: Record<ActivityKey, number>;
  idleMin: number;
  completedByActivity: Record<ActivityKey, number>;
  totalWaitMin: number;
  totalWaitCount: number;
  queueLength: number;
  assignedMachineCount: number;
  downtimeByReason: Record<DowntimeReason, number>;
  theoreticalSpoolsPerShift: number;
  expectedEventsByActivity: Record<ActivityKey, number>;
}

export interface SimulationState {
  machines: MachineRuntimeState[];
  operator: OperatorRuntimeState;
  metrics: SimMetrics;
  log: EventLogEntry[];
  finished: boolean;
}

// --- Production Simulation (multi-operator, multi-Construction) -----------------------------
// A separate model from AppConfig/SimulationState above, which assume a single shared operator
// and a single shared Construction for the whole layout. A Production Setup instead snapshots a
// Layout and lets each machine run its own Construction, serviced per-activity-type by any of
// several named operators (e.g. Operator 1 does Doffing on machine X, Operator 2 does its Loading).

export interface ProductionOperator {
  id: string;
  label: string;
}

export interface ProductionMachineAssignment {
  /** Matches a LayoutMachine.id within the setup's layout snapshot. */
  machineId: string;
  constructionDetailId?: string;
  constructionDetailLabel?: string;
  doffingOperatorId?: string;
  loadingOperatorId?: string;
  fractureRepairingOperatorId?: string;
}

export interface ProductionSetup {
  id: string;
  name: string;
  /** Copied from the source Layout when the setup was created — later edits to that Layout don't
   * retroactively change this setup. */
  layout: LayoutMachine[];
  /** Where the operator(s) start standing at the beginning of the shift, copied from the source
   * Layout at creation time (same semantics as AppConfig.operatorStart). Undefined for setups
   * created before this feature existed, or if the source Layout never had one set — falls back
   * to the first machine's position in that case. */
  operatorStart?: OperatorStartPoint;
  operators: ProductionOperator[];
  assignments: ProductionMachineAssignment[];
  shiftTime: number;
  lunchTime: number;
  lunchStartAt: number;
  meetingTime: number;
  meetingStartAt: number;
  taskPriority: TaskPriorityMode;
  movement: MovementParams;
  updatedAt: number;
}

/** One independent operator's live state during a Production Simulation run — same FSM shape as
 * OperatorRuntimeState, tagged with which ProductionOperator it belongs to. */
export interface ProductionOperatorRuntimeState extends OperatorRuntimeState {
  id: string;
  label: string;
}

export interface ProductionSimMetrics {
  clockMin: number;
  shiftTimeMin: number;
  assignedMachineCount: number;
  completedByActivity: Record<ActivityKey, number>;
  downtimeByReason: Record<DowntimeReason, number>;
  /** Accumulated across every completed Doffing event, using each machine's OWN spool weight and
   * runtime-per-spool (which can differ per Construction) — unlike the single-operator Simulator's
   * Output card, which only ever has one shared spec to multiply against. */
  tonageKg: number;
  producedMachineMin: number;
  /** Per-operator summary, for a compact utilization table without re-deriving from timelines. */
  perOperator: {
    id: string;
    label: string;
    walkingMin: number;
    servicingMin: number;
    idleMin: number;
  }[];
}

/** Same shape as MachineRuntimeState, plus the per-machine runtime-per-spool a Production
 * Simulation machine carries (each machine can run a different Construction, so this isn't a
 * single shared value like SimMetrics.runtimePerSpoolMin in the single-operator Simulator). */
export interface ProductionMachineRuntimeState extends MachineRuntimeState {
  runtimePerSpool: number;
  spoolWeight: number;
}

export interface ProductionSimulationState {
  machines: ProductionMachineRuntimeState[];
  operators: ProductionOperatorRuntimeState[];
  metrics: ProductionSimMetrics;
  log: EventLogEntry[];
  finished: boolean;
  /** Surfaced once at construction time — e.g. a Construction missing a WL_Activities row, or a
   * machine with a due activity but no operator assigned to that activity type. */
  warnings: string[];
}
