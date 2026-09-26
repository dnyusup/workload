import type { LayoutWall } from '../../types';

/** Read-only walls on a simulation canvas — same coordinates as the machines around them, so render
 * it inside the same transformed group. */
export function WallsLayer({ walls }: { walls: LayoutWall[] | undefined }) {
  if (!walls || walls.length === 0) return null;
  return (
    <g className="layout-walls" pointerEvents="none">
      {walls.map((wall) => (
        <line
          key={wall.id}
          x1={wall.x1}
          y1={wall.y1}
          x2={wall.x2}
          y2={wall.y2}
          className="layout-wall-line"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </g>
  );
}
