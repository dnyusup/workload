import type { MachineOrientation, MachinePairSide } from '../../types';
import { MACHINE_W, MACHINE_H } from '../../lib/layoutConstants';

/**
 * Renders the Pay Off / Cradle / Take Up zone labels for a machine box drawn at local (0,0).
 * Two machines are usually paired side-by-side sharing one divider — the touching inner side
 * has no Cradle access, only the pair's two outer edges do.
 */
export function MachineZoneLabels({
  orientation,
  pairSide = 'single',
  width = MACHINE_W,
  height = MACHINE_H,
}: {
  orientation: MachineOrientation;
  pairSide?: MachinePairSide;
  width?: number;
  height?: number;
}) {
  const topLabel = orientation === 'flipped' ? 'TU' : 'PO';
  const bottomLabel = orientation === 'flipped' ? 'PO' : 'TU';
  return (
    <>
      <text x={width / 2} y={-4} textAnchor="middle" className="zone-label zone-label-h">
        {topLabel}
      </text>
      <text x={width / 2} y={height + 12} textAnchor="middle" className="zone-label zone-label-h">
        {bottomLabel}
      </text>
      {pairSide !== 'single' && (
        <rect
          x={pairSide === 'left' ? width - 2 : -2}
          y={0}
          width={4}
          height={height}
          className="machine-pair-divider"
        />
      )}
    </>
  );
}
