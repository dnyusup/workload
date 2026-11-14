import { useState, useRef, useEffect, useMemo } from 'react';

export interface DatePickerProps {
  value: string;
  onChange: (val: string) => void;
  /** Fired ONLY when a specific date is committed (day clicked, today clicked, or Enter pressed). */
  onSelectDate?: (val: string) => void;
  disabled?: boolean;
  min?: string;
  max?: string;
  placeholder?: string;
  className?: string;
  id?: string;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const WEEKDAY_NAMES = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];

export function DatePicker({
  value,
  onChange,
  onSelectDate,
  disabled = false,
  min,
  max,
  placeholder = 'YYYY-MM-DD',
  className = '',
  id,
}: DatePickerProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Compute initial view year & month from current value or today
  const parsedValueDate = useMemo(() => {
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      const [y, m, d] = value.split('-').map(Number);
      return new Date(y, m - 1, d);
    }
    return null;
  }, [value]);

  const [prevValue, setPrevValue] = useState(value);
  const [viewYear, setViewYear] = useState(() => (parsedValueDate ? parsedValueDate.getFullYear() : new Date().getFullYear()));
  const [viewMonth, setViewMonth] = useState(() => (parsedValueDate ? parsedValueDate.getMonth() : new Date().getMonth()));

  if (value !== prevValue) {
    setPrevValue(value);
    if (parsedValueDate) {
      setViewYear(parsedValueDate.getFullYear());
      setViewMonth(parsedValueDate.getMonth());
    }
  }

  // Click outside listener to close popup
  useEffect(() => {
    if (!isOpen) return;

    const handleMouseDown = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsOpen(false);
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const handlePrevMonth = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (viewMonth === 0) {
      setViewYear((y) => y - 1);
      setViewMonth(11);
    } else {
      setViewMonth((m) => m - 1);
    }
  };

  const handleNextMonth = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (viewMonth === 11) {
      setViewYear((y) => y + 1);
      setViewMonth(0);
    } else {
      setViewMonth((m) => m + 1);
    }
  };

  const handleSelectDay = (day: number) => {
    const formatted = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    onChange(formatted);
    setIsOpen(false);
    onSelectDate?.(formatted);
  };

  const handleSelectToday = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const today = new Date();
    const formatted = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
    onChange(formatted);
    setViewYear(today.getFullYear());
    setViewMonth(today.getMonth());
    setIsOpen(false);
    onSelectDate?.(formatted);
  };

  // Calendar math
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  const startDayOfWeek = new Date(viewYear, viewMonth, 1).getDay(); // 0 is Sunday
  const todayStr = useMemo(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }, []);

  // Year options for fast jump
  const yearOptions = useMemo(() => {
    const current = new Date().getFullYear();
    const years: number[] = [];
    for (let y = current - 10; y <= current + 5; y++) {
      years.push(y);
    }
    return years;
  }, []);

  return (
    <div ref={containerRef} className="custom-datepicker-wrap" style={{ position: 'relative', width: '100%' }}>
      <div className="custom-datepicker-input-group" style={{ position: 'relative', width: '100%', display: 'flex', alignItems: 'center' }}>
        <input
          id={id}
          type="text"
          className={`input ${className}`}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            const val = e.target.value.trim();
            onChange(val);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
                setIsOpen(false);
                onSelectDate?.(value);
              }
            }
          }}
          onClick={() => {
            if (!disabled) setIsOpen((prev) => !prev);
          }}
          style={{
            cursor: disabled ? 'not-allowed' : 'pointer',
            paddingRight: '34px',
            boxSizing: 'border-box',
          }}
        />
        <button
          type="button"
          tabIndex={-1}
          aria-label="Toggle calendar popup"
          disabled={disabled}
          onClick={(e) => {
            e.preventDefault();
            if (!disabled) setIsOpen((prev) => !prev);
          }}
          style={{
            position: 'absolute',
            right: 8,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'none',
            border: 'none',
            color: isOpen ? '#38bdf8' : '#94a3b8',
            cursor: disabled ? 'not-allowed' : 'pointer',
            padding: 4,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            transition: 'color 0.15s ease',
          }}
          onMouseEnter={(e) => {
            if (!disabled) e.currentTarget.style.color = '#38bdf8';
          }}
          onMouseLeave={(e) => {
            if (!disabled) e.currentTarget.style.color = isOpen ? '#38bdf8' : '#94a3b8';
          }}
        >
          <svg viewBox="0 0 24 24" width="16" height="16" stroke="currentColor" strokeWidth="2" fill="none">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
        </button>
      </div>

      {isOpen && (
        <div
          className="custom-datepicker-popover"
          role="dialog"
          aria-label="Choose Date"
          style={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 1000,
            background: '#0b1220',
            border: '1px solid #1e293b',
            borderRadius: '8px',
            boxShadow: '0 16px 36px rgba(0, 0, 0, 0.7), 0 4px 12px rgba(0, 0, 0, 0.5)',
            padding: '12px',
            width: '270px',
            userSelect: 'none',
          }}
        >
          {/* Header: Month/Year navigation */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '10px' }}>
            <button
              type="button"
              onClick={handlePrevMonth}
              title="Previous Month"
              style={{
                background: '#1e293b',
                border: '1px solid #334155',
                color: '#cbd5e1',
                borderRadius: '4px',
                width: '26px',
                height: '26px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              ◀
            </button>

            <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
              <select
                value={viewMonth}
                onChange={(e) => setViewMonth(Number(e.target.value))}
                style={{
                  background: '#1e293b',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  borderRadius: '4px',
                  padding: '2px 4px',
                  cursor: 'pointer',
                }}
              >
                {MONTH_NAMES.map((m, idx) => (
                  <option key={m} value={idx}>
                    {m}
                  </option>
                ))}
              </select>

              <select
                value={viewYear}
                onChange={(e) => setViewYear(Number(e.target.value))}
                style={{
                  background: '#1e293b',
                  border: '1px solid #334155',
                  color: '#f8fafc',
                  fontSize: '0.78rem',
                  fontWeight: 600,
                  borderRadius: '4px',
                  padding: '2px 4px',
                  cursor: 'pointer',
                }}
              >
                {yearOptions.map((y) => (
                  <option key={y} value={y}>
                    {y}
                  </option>
                ))}
              </select>
            </div>

            <button
              type="button"
              onClick={handleNextMonth}
              title="Next Month"
              style={{
                background: '#1e293b',
                border: '1px solid #334155',
                color: '#cbd5e1',
                borderRadius: '4px',
                width: '26px',
                height: '26px',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                cursor: 'pointer',
              }}
            >
              ▶
            </button>
          </div>

          {/* Weekday headers */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px', textAlign: 'center', marginBottom: '6px' }}>
            {WEEKDAY_NAMES.map((w) => (
              <span key={w} style={{ fontSize: '0.72rem', color: '#64748b', fontWeight: 600 }}>
                {w}
              </span>
            ))}
          </div>

          {/* Days grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: '2px' }}>
            {/* Blank padding cells */}
            {Array.from({ length: startDayOfWeek }).map((_, i) => (
              <div key={`blank-${i}`} style={{ height: '28px' }} />
            ))}

            {/* Day buttons */}
            {Array.from({ length: daysInMonth }).map((_, i) => {
              const day = i + 1;
              const dateStr = `${viewYear}-${String(viewMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
              const isSelected = value === dateStr;
              const isToday = dateStr === todayStr;
              const isDisabled = (min && dateStr < min) || (max && dateStr > max);

              return (
                <button
                  key={day}
                  type="button"
                  disabled={Boolean(isDisabled)}
                  onClick={() => handleSelectDay(day)}
                  style={{
                    height: '28px',
                    width: '100%',
                    background: isSelected ? '#0284c7' : 'transparent',
                    color: isSelected ? '#ffffff' : isToday ? '#38bdf8' : isDisabled ? '#475569' : '#e2e8f0',
                    border: isToday && !isSelected ? '1px solid #0284c7' : 'none',
                    borderRadius: '4px',
                    fontSize: '0.78rem',
                    fontWeight: isSelected || isToday ? 600 : 400,
                    cursor: isDisabled ? 'not-allowed' : 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    padding: 0,
                    transition: 'background 0.1s ease',
                  }}
                  onMouseEnter={(e) => {
                    if (!isSelected && !isDisabled) {
                      e.currentTarget.style.background = '#334155';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (!isSelected && !isDisabled) {
                      e.currentTarget.style.background = 'transparent';
                    }
                  }}
                >
                  {day}
                </button>
              );
            })}
          </div>

          {/* Footer buttons */}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginTop: '10px', paddingTop: '8px', borderTop: '1px solid #1e293b' }}>
            <button
              type="button"
              onClick={handleSelectToday}
              style={{
                background: 'none',
                border: 'none',
                color: '#38bdf8',
                fontSize: '0.74rem',
                fontWeight: 600,
                cursor: 'pointer',
                padding: '2px 4px',
              }}
            >
              Today
            </button>
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              style={{
                background: 'none',
                border: 'none',
                color: '#94a3b8',
                fontSize: '0.74rem',
                cursor: 'pointer',
                padding: '2px 4px',
              }}
            >
              Close
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

