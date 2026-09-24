import type { MachineSpecInput } from '../../types';
import { deriveMachineSpec } from '../../lib/calculations';
import { WEIGHT_LOADING_AREAS } from '../../lib/productCatalog';
import { Card } from '../ui/Card';
import { PRODUCT_AREAS } from '../../types';
import { Field, NumberInput, SelectInput } from '../ui/Field';

export function SpecForm({
  spec,
  onChange,
  loadingLinked = false,
  loadingErrors = [],
}: {
  spec: MachineSpecInput;
  onChange: (next: MachineSpecInput) => void;
  /** True once a Construction Detail's Loading rows are loaded, i.e. POlength edits rebuild Loading. */
  loadingLinked?: boolean;
  loadingErrors?: string[];
}) {
  const derived = deriveMachineSpec(spec);
  const weightLoading = WEIGHT_LOADING_AREAS.includes(spec.area.trim().toUpperCase());
  const set = (key: keyof MachineSpecInput) => (v: number) => onChange({ ...spec, [key]: v });
  const setArea = (area: string) => onChange({ ...spec, area });

  return (
    <Card title="Product & Machine Specification" subtitle="Twisting process parameters per machine">
      <div className="grid-2">
        <Field label="Area">
          <SelectInput value={spec.area} options={PRODUCT_AREAS.map((area) => ({ value: area, label: area }))} onChange={setArea} />
        </Field>
        <Field label="Lay Length (mm)">
          <NumberInput value={spec.layLength} onChange={set('layLength')} />
        </Field>
        <Field label="No. Of Wires">
          <NumberInput value={spec.noOfWires} onChange={set('noOfWires')} />
        </Field>
        <Field label="Speed">
          <NumberInput value={spec.speed} onChange={set('speed')} />
        </Field>
        <Field label="Spool Length">
          <NumberInput value={spec.spoolLength} onChange={set('spoolLength')} />
        </Field>
        <Field label="Linear Density">
          <NumberInput value={spec.linearDensity} onChange={set('linearDensity')} />
        </Field>
        <Field label="Fracture / Ton">
          <NumberInput value={spec.fracturePerTon} onChange={set('fracturePerTon')} />
        </Field>
        <Field label="Dies / Ton">
          <NumberInput value={spec.diesPerTon} onChange={set('diesPerTon')} />
        </Field>
        <Field label="Defect / Ton">
          <NumberInput value={spec.defectsPerTon} onChange={set('defectsPerTon')} />
        </Field>
      </div>

      <div className="divider" />

      <div className="grid-2">
        {(['poLength1', 'poLength2', 'poLength3'] as const).map((key, i) => (
          <Field key={key} label={`POlength${i + 1}${weightLoading ? ' (kg)' : ''}`}>
            <NumberInput value={spec[key] ?? 0} min={0} onChange={set(key)} />
          </Field>
        ))}
      </div>
      <p className="field-hint">
        {!loadingLinked
          ? 'Select a Construction Detail to apply POlength to Loading.'
          : weightLoading
            ? 'Loading every POlength ÷ SpoolWeight spools (only the first filled POlength is used for this Area). 0 = not filled.'
            : 'Loading every ROUNDDOWN(max POlength ÷ SpoolLength) spools; the other filled POlengths become Partial1/Partial2. 0 = not filled.'}
      </p>
      {loadingErrors.length > 0 && <p className="construction-selector-error">{loadingErrors.join(' ')}</p>}

      <div className="divider" />

      <div className="grid-2">
        <Field label="Twist/min" hint="Speed*2 (0 for WW/CH/CR/BA/CA/IS/IP; = Speed for SP/CB)">
          <NumberInput value={derived.twistPerMin} readOnly />
        </Field>
        <Field label="Spool Weight" hint="= SpoolLength*LinearDensity*NoOfWires/1000">
          <NumberInput value={round(derived.spoolWeight)} readOnly />
        </Field>
        <Field label="Linear Speed" hint="= Speed for WW/CH/CR/BA/CA/IS/IP; else LayLength/1000*Twist/min">
          <NumberInput value={round(derived.linearSpeed)} readOnly />
        </Field>
        <Field label="Runtime/spool (min)" hint="= SpoolLength/LinearSpeed + 0.65">
          <NumberInput value={round(derived.runtimePerSpool)} readOnly />
        </Field>
      </div>
    </Card>
  );
}

function round(v: number) {
  return Math.round(v * 100) / 100;
}
