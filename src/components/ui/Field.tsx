import type { ReactNode } from 'react';

export function Field({
  label,
  hint,
  tooltip,
  children,
}: {
  label: string;
  hint?: string;
  /** Explanation shown on hover of an ⓘ next to the label, instead of a hint line below. */
  tooltip?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">
        {label}
        {tooltip && (
          <span className="field-info" title={tooltip} aria-label={tooltip}>
            ⓘ
          </span>
        )}
      </span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function SelectInput<T extends string>({
  value,
  options,
  onChange,
  disabled = false,
  title,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <select className="input" value={value} disabled={disabled} title={title} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((opt) => (
        <option key={opt.value} value={opt.value}>
          {opt.label}
        </option>
      ))}
    </select>
  );
}

export function NumberInput({
  value,
  onChange,
  step = 'any',
  readOnly = false,
  disabled = false,
  min,
  title,
}: {
  value: number;
  onChange?: (v: number) => void;
  step?: number | 'any';
  readOnly?: boolean;
  disabled?: boolean;
  min?: number;
  title?: string;
}) {
  return (
    <input
      type="number"
      className={`input ${readOnly || disabled ? 'input-readonly' : ''}`}
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      readOnly={readOnly}
      disabled={disabled}
      title={title}
      onChange={(e) => onChange?.(parseFloat(e.target.value))}
    />
  );
}

export function OptionalNumberInput({
  value,
  onChange,
  step = 'any',
  readOnly = false,
  disabled = false,
  min,
  placeholder = 'null',
  title,
}: {
  value: number | null;
  onChange?: (v: number | null) => void;
  step?: number | 'any';
  readOnly?: boolean;
  disabled?: boolean;
  min?: number;
  placeholder?: string;
  title?: string;
}) {
  return (
    <input
      type="number"
      className={`input ${readOnly || disabled ? 'input-readonly' : ''}`}
      value={value != null && Number.isFinite(value) ? value : ''}
      step={step}
      min={min}
      readOnly={readOnly}
      disabled={disabled}
      placeholder={placeholder}
      title={title}
      onChange={(e) => {
        const text = e.target.value.trim();
        if (text === '') {
          onChange?.(null);
        } else {
          const parsed = parseFloat(text);
          onChange?.(Number.isFinite(parsed) ? parsed : null);
        }
      }}
    />
  );
}

export function TextInput({
  value,
  onChange,
  placeholder,
  readOnly = false,
  disabled = false,
  className = '',
}: {
  value: string;
  onChange?: (v: string) => void;
  placeholder?: string;
  readOnly?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <input
      type="text"
      className={`input ${readOnly ? 'input-readonly' : ''} ${className}`}
      value={value ?? ''}
      placeholder={placeholder}
      readOnly={readOnly}
      disabled={disabled}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

export function DateInput({
  value,
  onChange,
  disabled = false,
  min,
  max,
  className = '',
}: {
  value: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
  min?: string;
  max?: string;
  className?: string;
}) {
  return (
    <input
      type="date"
      className={`input ${className}`}
      value={value ?? ''}
      disabled={disabled}
      min={min}
      max={max}
      onChange={(e) => onChange?.(e.target.value)}
    />
  );
}

