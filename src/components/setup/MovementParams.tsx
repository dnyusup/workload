import type { MovementParams } from '../../types';
import { useAuth } from '../../context/AuthContext';
import { Card } from '../ui/Card';
import { Field, NumberInput } from '../ui/Field';

export function MovementParamsForm({
  movement,
  onChange,
}: {
  movement: MovementParams;
  onChange: (next: MovementParams) => void;
}) {
  const { user } = useAuth();
  const isAdmin = user.role === 'admin';
  const set = (key: keyof MovementParams) => (v: number) => onChange({ ...movement, [key]: v });

  return (
    <Card
      title="Operator Movement Parameters"
      subtitle="Dipakai untuk menghitung waktu jalan operator antar mesin di layout"
    >
      <div className="grid-2">
        <Field label="Walking Speed (meters/minute)">
          <NumberInput value={movement.walkingSpeed} min={0} onChange={set('walkingSpeed')} />
        </Field>
        <Field
          label="Layout Scale (pixels per meter)"
          hint={isAdmin ? 'Defines how many canvas pixels represent one real-world meter' : 'Only Admin can edit Layout Scale'}
        >
          <NumberInput value={movement.pixelsPerMeter} min={1} readOnly={!isAdmin} onChange={isAdmin ? set('pixelsPerMeter') : undefined} />
        </Field>
      </div>
    </Card>
  );
}
