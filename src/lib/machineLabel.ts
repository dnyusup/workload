/** Shifts the LAST number inside a machine label by `delta`, keeping any prefix/suffix and the
 * digit count: NDE01 +1 → NDE02, NDE09 +1 → NDE10, 12 −1 → 11, A-099B +1 → A-100B. A label with
 * no digits gets "-n" appended instead (n = |delta|); results never go below 0. */
export function shiftMachineLabel(label: string, delta: number): string {
  const match = /^(.*?)(\d+)(\D*)$/.exec(label);
  if (!match) return `${label}-${Math.abs(delta)}`;
  const [, prefix, digits, suffix] = match;
  const next = Math.max(0, parseInt(digits, 10) + delta);
  return `${prefix}${String(next).padStart(digits.length, '0')}${suffix}`;
}
