export function Stepper({
  steps,
  current,
  onSelect,
}: {
  steps: string[];
  current: number;
  onSelect: (index: number) => void;
}) {
  return (
    <div className="stepper">
      {steps.map((label, idx) => (
        <button
          key={label}
          className={`stepper-item ${idx === current ? 'active' : ''} ${idx < current ? 'done' : ''}`}
          onClick={() => onSelect(idx)}
        >
          <span className="stepper-index">{idx + 1}</span>
          <span>{label}</span>
        </button>
      ))}
    </div>
  );
}
