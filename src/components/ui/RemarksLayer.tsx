import type { LayoutRemark } from '../../types';
import { REMARK_LINE_HEIGHT, remarkLines } from '../../lib/layoutRemarks';

/** One remark's text, one tspan per line, hanging down from (x, y). */
export function RemarkText({ remark }: { remark: LayoutRemark }) {
  const { fontSize } = remark;
  return (
    <text x={remark.x} y={remark.y} className="layout-remark-text" style={{ fontSize }} pointerEvents="none">
      {remarkLines(remark).map((line, index) => (
        <tspan key={index} x={remark.x} dy={index === 0 ? fontSize : fontSize * REMARK_LINE_HEIGHT}>
          {line || ' '}
        </tspan>
      ))}
    </text>
  );
}

/** Read-only remarks on a simulation canvas — same coordinates as the machines, so render it inside
 * the same transformed group. Never interactive, and never an obstacle for walking. */
export function RemarksLayer({ remarks }: { remarks: LayoutRemark[] | undefined }) {
  if (!remarks || remarks.length === 0) return null;
  return (
    <g className="layout-remarks" pointerEvents="none">
      {remarks.map((remark) => (
        <RemarkText key={remark.id} remark={remark} />
      ))}
    </g>
  );
}
