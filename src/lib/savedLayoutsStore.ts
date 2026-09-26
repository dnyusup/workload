import type { LayoutMachine, LayoutWall, OperatorStartPoint } from '../types';
import { Mpp_wl_layoutsesService } from '../generated/services/Mpp_wl_layoutsesService';
import { fetchAllPages } from './dataversePaging';

export interface SavedLayout {
  id: string;
  name: string;
  machines: LayoutMachine[];
  /** Where the operator starts for this saved layout. Undefined for layouts saved before this
   * feature existed, or if the user never set one. */
  operatorStart?: OperatorStartPoint;
  walls?: LayoutWall[];
  updatedAt: number;
  createdAt: number;
  /** Who created this layout, by email — stamped from the signed-in user at creation time
   * (mpp_creator_email). Primary ownership key (edit/delete restricted to the creator for
   * Contribute users); falls back to `createdByName` for layouts created before this column
   * existed. */
  createdByEmail: string;
  /** Dataverse's own `createdbyname` — always populated, used for display and as the ownership
   * fallback when `createdByEmail` is empty (pre-existing layouts). */
  createdByName: string;
}

/** `mpp_machinesjson` stores `{ machines, operatorStart?, walls? }`. Layouts saved before the start-point
 * feature existed have a bare `LayoutMachine[]` in that column instead — still parsed correctly
 * here (just with no `operatorStart`), so old rows keep working unchanged. Also reused by
 * productionSetupsStore for its own layout-snapshot column, since it's the same wrapper shape. */
export function parseLayoutBlob(json: string | undefined): {
  machines: LayoutMachine[];
  operatorStart?: OperatorStartPoint;
  walls?: LayoutWall[];
} {
  if (!json) return { machines: [] };
  try {
    const parsed = JSON.parse(json);
    if (Array.isArray(parsed)) return { machines: parsed };
    if (parsed && typeof parsed === 'object' && Array.isArray(parsed.machines)) {
      const rawStart = parsed.operatorStart;
      const operatorStart =
        rawStart && typeof rawStart.x === 'number' && typeof rawStart.y === 'number' ? { x: rawStart.x, y: rawStart.y } : undefined;
      const walls = Array.isArray(parsed.walls)
        ? (parsed.walls as LayoutWall[]).filter(
            (w) => w && [w.x1, w.y1, w.x2, w.y2].every((v) => typeof v === 'number' && Number.isFinite(v)),
          )
        : undefined;
      return { machines: parsed.machines, operatorStart, walls: walls && walls.length > 0 ? walls : undefined };
    }
    return { machines: [] };
  } catch {
    return { machines: [] };
  }
}

export function serializeLayoutBlob(machines: LayoutMachine[], operatorStart?: OperatorStartPoint, walls?: LayoutWall[]): string {
  return JSON.stringify({
    machines,
    ...(operatorStart ? { operatorStart } : {}),
    ...(walls && walls.length > 0 ? { walls } : {}),
  });
}

export async function loadSavedLayouts(): Promise<SavedLayout[]> {
  const rows = await fetchAllPages(Mpp_wl_layoutsesService.getAll, { orderBy: ['modifiedon desc'] });
  return rows.map((row) => {
    const { machines, operatorStart, walls } = parseLayoutBlob(row.mpp_machinesjson);
    return {
      id: row.mpp_wl_layoutsid,
      name: row.mpp_name,
      machines,
      operatorStart,
      walls,
      updatedAt: row.modifiedon ? new Date(row.modifiedon).getTime() : Date.now(),
      createdAt: row.createdon ? new Date(row.createdon).getTime() : Date.now(),
      createdByEmail: row.mpp_creator_email ?? '',
      createdByName: row.createdbyname ?? '',
    };
  });
}

export async function createSavedLayout(
  name: string,
  machines: LayoutMachine[],
  creatorEmail = '',
  operatorStart?: OperatorStartPoint,
  walls?: LayoutWall[],
): Promise<SavedLayout> {
  const result = await Mpp_wl_layoutsesService.create({
    mpp_name: name,
    mpp_machinesjson: serializeLayoutBlob(machines, operatorStart, walls),
    mpp_creator_email: creatorEmail,
    statecode: 0,
  });
  if (!result.success || !result.data) throw new Error(result.error?.message ?? 'Failed to create Layout.');
  return {
    id: result.data.mpp_wl_layoutsid,
    name,
    machines,
    operatorStart,
    walls,
    updatedAt: Date.now(),
    createdAt: Date.now(),
    createdByEmail: creatorEmail,
    createdByName: result.data.createdbyname ?? '',
  };
}

/** `machines`, `operatorStart` and `walls` share a single Dataverse column, so whenever any one
 * changes the caller must pass ALL of them (the new value for the one that changed, plus the current value for
 * the other) — passing only one would overwrite the other with nothing. */
export async function updateSavedLayout(
  id: string,
  patch: Partial<Pick<SavedLayout, 'name' | 'machines' | 'operatorStart' | 'walls'>>,
): Promise<void> {
  const fields: { mpp_name?: string; mpp_machinesjson?: string } = {};
  if (patch.name !== undefined) fields.mpp_name = patch.name;
  if (patch.machines !== undefined || patch.operatorStart !== undefined || patch.walls !== undefined) {
    fields.mpp_machinesjson = serializeLayoutBlob(patch.machines ?? [], patch.operatorStart, patch.walls);
  }
  if (Object.keys(fields).length === 0) return;
  const result = await Mpp_wl_layoutsesService.update(id, fields);
  if (!result.success) throw new Error(result.error?.message ?? 'Failed to update Layout.');
}

export async function deleteSavedLayout(id: string): Promise<void> {
  await Mpp_wl_layoutsesService.delete(id);
}
