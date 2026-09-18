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

/** Resolves a machine's actual on-screen/in-simulation width in px from its stored `widthM`
 * (falling back to the default footprint when unset, e.g. layouts saved before Resize existed). */
export function machineWidthPx(m: { widthM?: number }, pixelsPerMeter = DEFAULT_PIXELS_PER_METER): number {
  const widthM = m.widthM && m.widthM > 0 ? m.widthM : DEFAULT_MACHINE_WIDTH_M;
  return widthM * pixelsPerMeter;
}

/** Same as `machineWidthPx`, for the machine's length (its `y`-axis extent in the layout). */
export function machineHeightPx(m: { lengthM?: number }, pixelsPerMeter = DEFAULT_PIXELS_PER_METER): number {
  const lengthM = m.lengthM && m.lengthM > 0 ? m.lengthM : DEFAULT_MACHINE_LENGTH_M;
  return lengthM * pixelsPerMeter;
}
