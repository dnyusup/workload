// Layout geometry at the default scale of 20 pixels per meter:
// each machine is 1.5 m wide by 6 m long, and paired machines are 0.7 m apart.
export const MACHINE_W = 30;
export const MACHINE_H = 120;
export const MACHINE_CENTER_X = MACHINE_W / 2;
export const MACHINE_CENTER_Y = MACHINE_H / 2;

/** Default scale (px per meter) used to derive the default machine footprint in meters below —
 * matches the app-wide Movement Parameters default. */
export const DEFAULT_PIXELS_PER_METER = 20;
export const DEFAULT_MACHINE_WIDTH_M = MACHINE_W / DEFAULT_PIXELS_PER_METER;
export const DEFAULT_MACHINE_LENGTH_M = MACHINE_H / DEFAULT_PIXELS_PER_METER;

type MachineFootprint = { widthM?: number; lengthM?: number; axis?: 'vertical' | 'horizontal' };

function footprintM(m: MachineFootprint) {
  return {
    widthM: m.widthM && m.widthM > 0 ? m.widthM : DEFAULT_MACHINE_WIDTH_M,
    lengthM: m.lengthM && m.lengthM > 0 ? m.lengthM : DEFAULT_MACHINE_LENGTH_M,
  };
}

/** A machine's on-screen/in-simulation extent along x, in px, from its stored `widthM`/`lengthM`
 * (default footprint when unset, e.g. layouts saved before Resize existed). A horizontal machine
 * lies on its side, so its x extent is its LENGTH. */
export function machineWidthPx(m: MachineFootprint, pixelsPerMeter = DEFAULT_PIXELS_PER_METER): number {
  const { widthM, lengthM } = footprintM(m);
  return (m.axis === 'horizontal' ? lengthM : widthM) * pixelsPerMeter;
}

/** Same as `machineWidthPx`, for the extent along y (the length for a vertical machine). */
export function machineHeightPx(m: MachineFootprint, pixelsPerMeter = DEFAULT_PIXELS_PER_METER): number {
  const { widthM, lengthM } = footprintM(m);
  return (m.axis === 'horizontal' ? widthM : lengthM) * pixelsPerMeter;
}

/** Local drawing frame for a machine whose box spans `extentW` × `extentH` px from its top-left.
 * Zone graphics (PO/TU labels, zone blocks, donut) are always drawn as for a vertical machine of
 * `width` × `height`; for a horizontal machine `transform` rotates that drawing −90° into the box,
 * so Pay Off lands on the left, Take Up on the right, and the Cradle side on top. */
export function machineLocalFrame(axis: 'vertical' | 'horizontal' | undefined, extentW: number, extentH: number) {
  return axis === 'horizontal'
    ? { width: extentH, height: extentW, transform: `translate(0, ${extentH}) rotate(-90)` }
    : { width: extentW, height: extentH, transform: undefined };
}
