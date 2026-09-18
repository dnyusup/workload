import type { ReactNode } from 'react';

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

export function SelectInput<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <select className="input" value={value} onChange={(e) => onChange(e.target.value as T)}>
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
  min,
}: {
  value: number;
  onChange?: (v: number) => void;
  step?: number | 'any';
  readOnly?: boolean;
  min?: number;
}) {
  return (
    <input
      type="number"
      className={`input ${readOnly ? 'input-readonly' : ''}`}
      value={Number.isFinite(value) ? value : 0}
      step={step}
      min={min}
      readOnly={readOnly}
      onChange={(e) => onChange?.(parseFloat(e.target.value))}
    />
  );
}
