/** Finish Product (FP) vs Semi Finish Product (SFP): a Construction is FP when its SpoolType
 * starts with "BS" (BS40, BS80, "BS 80", …); everything else is SFP. */
export function isFinishProductSpoolType(spoolType: string | undefined): boolean {
  return (spoolType ?? '').replace(/\s+/g, '').toUpperCase().startsWith('BS');
}
