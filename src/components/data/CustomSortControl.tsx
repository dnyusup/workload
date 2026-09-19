import { useEffect, useRef, useState } from 'react';

export type CustomSortDirection = 'asc' | 'desc';

export interface CustomSortLevel {
  key: string;
  dir: CustomSortDirection;
}

export interface CustomSortColumn {
  key: string;
  label: string;
}

interface CustomSortControlProps {
  columns: CustomSortColumn[];
  levels: CustomSortLevel[];
  onChange: (levels: CustomSortLevel[]) => void;
}

export function CustomSortControl({ columns, levels, onChange }: CustomSortControlProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleDocumentClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', handleDocumentClick);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleDocumentClick);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const addLevel = () => {
    const nextColumn = columns.find((column) => !levels.some((level) => level.key === column.key));
    if (!nextColumn) return;
    onChange([...levels, { key: nextColumn.key, dir: 'asc' }]);
  };

  const updateLevel = (index: number, changes: Partial<CustomSortLevel>) => {
    onChange(levels.map((level, levelIndex) => (levelIndex === index ? { ...level, ...changes } : level)));
  };

  const removeLevel = (index: number) => {
    onChange(levels.filter((_, levelIndex) => levelIndex !== index));
  };

  return (
    <div className="custom-sort-control" ref={containerRef}>
      <button
        type="button"
        className={`custom-sort-button${levels.length ? ' is-active' : ''}`}
        aria-label="Open custom multi-level sort"
        title={levels.length ? `Custom sort: ${levels.length} level${levels.length === 1 ? '' : 's'}` : 'Custom multi-level sort'}
        onClick={(event) => {
          event.stopPropagation();
          setOpen((value) => !value);
        }}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M4 6h16M4 12h11M4 18h6" />
          <path d="m17 14 3 3-3 3M20 17h-6" />
        </svg>
      </button>
      {open && (
        <div className="custom-sort-popover" role="dialog" aria-label="Custom multi-level sort" onClick={(event) => event.stopPropagation()}>
          <div className="custom-sort-heading">
            <strong>Custom sort</strong>
            <span>{levels.length ? `${levels.length} level${levels.length === 1 ? '' : 's'}` : 'No levels'}</span>
          </div>
          {levels.map((level, index) => (
            <div className="custom-sort-level" key={`${level.key}-${index}`}>
              <span className="custom-sort-index">{index + 1}</span>
              <select
                className="input"
                value={level.key}
                aria-label={`Sort level ${index + 1} column`}
                onChange={(event) => updateLevel(index, { key: event.target.value })}
              >
                {columns.map((column) => (
                  <option
                    key={column.key}
                    value={column.key}
                    disabled={levels.some((otherLevel, otherIndex) => otherIndex !== index && otherLevel.key === column.key)}
                  >
                    {column.label}
                  </option>
                ))}
              </select>
              <select
                className="input custom-sort-direction"
                value={level.dir}
                aria-label={`Sort level ${index + 1} direction`}
                onChange={(event) => updateLevel(index, { dir: event.target.value as CustomSortDirection })}
              >
                <option value="asc">A → Z / low → high</option>
                <option value="desc">Z → A / high → low</option>
              </select>
              <button
                type="button"
                className="custom-sort-remove"
                aria-label={`Remove sort level ${index + 1}`}
                title={`Remove sort level ${index + 1}`}
                onClick={() => removeLevel(index)}
              >
                ×
              </button>
            </div>
          ))}
          <div className="custom-sort-actions">
            <button type="button" className="btn btn-ghost custom-sort-add" onClick={addLevel} disabled={levels.length >= columns.length}>
              + Add level
            </button>
            <button type="button" className="btn btn-ghost custom-sort-clear" onClick={() => onChange([])} disabled={!levels.length}>
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
