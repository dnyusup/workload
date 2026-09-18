/** Compact horizontal bar showing runtime-per-spool progress. */
export function MachineDonut({
  progress,
  size = 24,
}: {
  progress: number;
  size?: number;
}) {
  const pct = Math.max(0, Math.min(1, progress));
  const height = 4;

  return (
    <g>
      <rect x={-size / 2} y={-height / 2} width={size} height={height} rx={height / 2} className="runtime-bar-track" />
      <rect
        x={-size / 2}
        y={-height / 2}
        width={size * pct}
        height={height}
        rx={height / 2}
        className="runtime-bar-fill"
      />
    </g>
  );
}
