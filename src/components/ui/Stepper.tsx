export function Stepper({
  steps,
  current,
  onSelect,
  disabled = false,
}: {
  steps: string[];
  current: number;
  onSelect: (index: number) => void;
  disabled?: boolean;
}) {
  return (
    <div className="stepper">
      {steps.map((label, idx) => (
        <button
          key={label}
          className={`stepper-item ${idx === current ? 'active' : ''} ${idx < current ? 'done' : ''}`}
          onClick={() => onSelect(idx)}
          disabled={disabled}
        >
          <span className="stepper-index">{idx + 1}</span>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
