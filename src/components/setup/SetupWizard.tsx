import { useState } from 'react';
import { useAppConfig } from '../../context/AppConfigContext';
import { deriveMachineSpec } from '../../lib/calculations';
import {
  calculateSingleOperatorForecast,
  previewAssignedMachineIds,
  recommendedMachineCountForForecast,
} from '../../lib/singleOperatorUtilization';
import { Stepper } from '../ui/Stepper';
import { Button } from '../ui/Button';
import { SpecForm } from './SpecForm';
import { OperatorForm } from './OperatorForm';
import { ActivityTable } from './ActivityTable';
import { MovementParamsForm } from './MovementParams';
import { LayoutBuilder } from './LayoutBuilder';
import { ConstructionDetailSelector } from './ConstructionDetailSelector';
import { LayoutSelector } from './LayoutSelector';

const STEPS = ['Setup', 'Machine Layout'];

export function SetupWizard({ onStart }: { onStart: () => void }) {
  const { config, setConfig } = useAppConfig();
  const [step, setStep] = useState(0);
  const [applyingConstruction, setApplyingConstruction] = useState(false);
  const derived = deriveMachineSpec(config.spec);
  const forecast = calculateSingleOperatorForecast(config);
  const optimizeUtilization = () => {
    setConfig((prev) => {
      const machineCount = recommendedMachineCountForForecast(prev);
      return {
        ...prev,
        operator: { ...prev.operator, machHandled: machineCount },
        assignedMachineIds: previewAssignedMachineIds(prev, machineCount),
      };
    });
  };

  const layoutIds = new Set(config.layout.map((m) => m.id));
  const assignedCount = (config.assignedMachineIds ?? []).filter((id) => layoutIds.has(id)).length;
  const canStart = config.layout.length > 0 && config.operator.machHandled > 0 && assignedCount === config.operator.machHandled;

  return (
    <div className="setup-wizard">
      <ConstructionDetailSelector onApplyingChange={setApplyingConstruction} />
      <div className="setup-stepper-row">
        <Stepper steps={STEPS} current={step} onSelect={setStep} disabled={applyingConstruction} />
        <div className="setup-nav">
          <Button variant="ghost" disabled={step === 0 || applyingConstruction} onClick={() => setStep((s) => Math.max(0, s - 1))}>
            &larr; Previous
          </Button>
          {step < STEPS.length - 1 ? (
            <Button variant="primary" disabled={applyingConstruction} onClick={() => setStep((s) => Math.min(STEPS.length - 1, s + 1))}>
              Next &rarr;
            </Button>
          ) : (
            <Button variant="primary" onClick={onStart} disabled={applyingConstruction || !canStart}>
              Validate &amp; Start Simulation
            </Button>
          )}
        </div>
      </div>

      <fieldset className={`setup-step-body setup-form-disabled${applyingConstruction ? ' is-applying' : ''}`} disabled={applyingConstruction}>
        {step === 0 && (
          <div className="setup-columns">
            <div className="setup-column">
              <SpecForm spec={config.spec} onChange={(spec) => setConfig((prev) => ({ ...prev, spec }))} />
              <OperatorForm
                operator={config.operator}
                forecast={forecast}
                onOptimize={optimizeUtilization}
                onChange={(operator) => setConfig((prev) => ({ ...prev, operator }))}
              />
            </div>
            <div className="setup-column">
              <ActivityTable
                activities={config.activities}
                spoolWeight={derived.spoolWeight}
                fracturePerTon={config.spec.fracturePerTon}
                diesPerTon={config.spec.diesPerTon}
                defectsPerTon={config.spec.defectsPerTon}
                onChange={(activities) => setConfig((prev) => ({ ...prev, activities }))}
              />
              <MovementParamsForm
                movement={config.movement}
                onChange={(movement) => setConfig((prev) => ({ ...prev, movement }))}
              />
            </div>
          </div>
        )}
        {step === 1 && (
          <>
            <LayoutSelector
              onSelect={(layout, operatorStart) => setConfig((prev) => ({ ...prev, layout, operatorStart }))}
            />
            <LayoutBuilder
              layout={config.layout}
              machHandled={config.operator.machHandled}
              assignedMachineIds={config.assignedMachineIds ?? []}
              selectMachineGroups={false}
              onAssignedChange={(assignedMachineIds) => setConfig((prev) => ({ ...prev, assignedMachineIds }))}
              pixelsPerMeter={config.movement.pixelsPerMeter}
              onChange={(layout) => setConfig((prev) => ({ ...prev, layout }))}
              operatorStart={config.operatorStart ?? null}
              onOperatorStartChange={(operatorStart) =>
                setConfig((prev) => ({ ...prev, operatorStart: operatorStart ?? undefined }))
              }
            />
          </>
        )}
      </fieldset>

    </div>
  );
}
