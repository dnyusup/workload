import { useEffect, useMemo, useState } from 'react';
import { useAppConfig } from '../../context/appConfig';
import { useAuth } from '../../context/auth';
import { loadDefaultValuesOrBuiltIn } from '../../lib/defaultValuesStore';
import { deriveMachineSpec, syncAutoActivityValues } from '../../lib/calculations';
import { rebuildLoadingActivities } from '../../lib/productCatalog';
import {
  calculateSingleOperatorForecast,
  previewAssignedMachineIds,
  recommendedMachineCountForForecast,
} from '../../lib/singleOperatorUtilization';
import { Stepper } from '../ui/Stepper';
import { Button } from '../ui/Button';
import { SpecForm } from './SpecForm';
import { OperatorForm } from './OperatorForm';
import { AssignedMachinesControl } from './AssignedMachinesControl';
import { ActivityTable } from './ActivityTable';
import { OutputEstimate } from './OutputEstimate';
import { LayoutBuilder } from './LayoutBuilder';
import { ConstructionDetailSelector } from './ConstructionDetailSelector';
import { LayoutSelector } from './LayoutSelector';
import type { AppConfig, WaitingModel } from '../../types';

const STEPS = ['Setup', 'Machine Layout'];

export function SetupWizard({ onStart }: { onStart: () => void }) {
  const { config, setConfig } = useAppConfig();
  const [step, setStep] = useState(0);
  const [applyingConstruction, setApplyingConstruction] = useState(false);
  const [loadingErrors, setLoadingErrors] = useState<string[]>([]);
  const [constructionBaseline, setConstructionBaseline] = useState<AppConfig | null>(
    () => (config.selectedProductId ? config : null),
  );
  const { user, loading: authLoading } = useAuth();
  const isAdmin = user.role === 'admin';
  // Only an Admin picks the waiting model; everyone else follows Default Values — also for a setup
  // kept in the browser from before an Admin changed it.
  useEffect(() => {
    // Wait for sign-in: until then everyone looks like a guest, and an Admin's pick would be lost.
    if (authLoading || isAdmin) return;
    let cancelled = false;
    void loadDefaultValuesOrBuiltIn().then(({ waitingModel }) => {
      if (cancelled) return;
      setConfig((prev) => (prev.operator.waitingModel === waitingModel ? prev : { ...prev, operator: { ...prev.operator, waitingModel } }));
    });
    return () => {
      cancelled = true;
    };
  }, [authLoading, isAdmin, setConfig]);
  // Optimize's Step-Up threshold and Use Waiting Model are only set in Default Values — follow them
  // for a setup kept in the browser from before they changed.
  useEffect(() => {
    let cancelled = false;
    void loadDefaultValuesOrBuiltIn().then(({ optimizeStepUpBelow, useWaitingModel }) => {
      if (cancelled) return;
      setConfig((prev) =>
        prev.operator.optimizeStepUpBelow === optimizeStepUpBelow && (prev.operator.useWaitingModel ?? true) === useWaitingModel
          ? prev
          : { ...prev, operator: { ...prev.operator, optimizeStepUpBelow, useWaitingModel } },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [setConfig]);
  const derived = deriveMachineSpec(config.spec);
  const forecast = calculateSingleOperatorForecast(config);
  const optimizedConfig = (config: AppConfig): AppConfig => {
    const machineCount = recommendedMachineCountForForecast(config);
    return {
      ...config,
      operator: { ...config.operator, machHandled: machineCount },
      assignedMachineIds: previewAssignedMachineIds(config, machineCount),
    };
  };
  const optimizeUtilization = () => setConfig((prev) => optimizedConfig(prev));
  /** The waiting model changes what Optimize finds, so switching it re-optimizes right away. */
  const changeWaitingModel = (waitingModel: WaitingModel) =>
    setConfig((prev) => optimizedConfig({ ...prev, operator: { ...prev.operator, waitingModel } }));

  const layoutIds = new Set(config.layout.map((m) => m.id));
  const assignedCount = (config.assignedMachineIds ?? []).filter((id) => layoutIds.has(id)).length;
  const canStart = config.layout.length > 0 && config.operator.machHandled > 0 && assignedCount === config.operator.machHandled;
  const setupChanged = useMemo(
    () => constructionBaseline !== null && JSON.stringify(config) !== JSON.stringify(constructionBaseline),
    [config, constructionBaseline],
  );

  return (
    <div className="setup-wizard">
      <ConstructionDetailSelector
        onApplyingChange={setApplyingConstruction}
        onApplied={(applied) => {
          setConstructionBaseline(applied);
          setLoadingErrors([]);
        }}
      />
      <div className="setup-stepper-row">
        <Stepper steps={STEPS} current={step} onSelect={setStep} disabled={applyingConstruction} />
        <div className="setup-nav">
          <Button
            variant="ghost"
            className="setup-reset-button"
            disabled={applyingConstruction || !setupChanged}
            onClick={() => {
              if (constructionBaseline) setConfig(() => constructionBaseline);
            }}
            title="Reset setup to the selected Construction Detail"
            aria-label="Reset setup to the selected Construction Detail"
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M4 7v5h5" />
              <path d="M5.2 12a7 7 0 1 0 2-5" />
            </svg>
          </Button>
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
              <SpecForm
                spec={config.spec}
                loadingLinked={!!config.loadingActivityRows}
                loadingErrors={loadingErrors}
                onChange={(spec) => {
                  // POlength/SpoolLength/SpoolWeight all feed Loading's cycle, so rebuild it
                  // alongside the other auto-synced activity values on every spec edit.
                  const applySpec = (prev: AppConfig) => {
                    const synced = syncAutoActivityValues(prev.activities, spec);
                    return prev.loadingActivityRows
                      ? rebuildLoadingActivities(synced, spec, prev.loadingActivityRows)
                      : { activities: synced, errors: [] };
                  };
                  setLoadingErrors(applySpec(config).errors);
                  setConfig((prev) => ({ ...prev, spec, activities: applySpec(prev).activities }));
                }}
              />
              <OperatorForm
                operator={config.operator}
                onChange={(operator) => setConfig((prev) => ({ ...prev, operator }))}
                movement={config.movement}
                onMovementChange={(movement) => setConfig((prev) => ({ ...prev, movement }))}
              />
            </div>
            <div className="setup-column">
              <OutputEstimate
                config={config}
                forecast={forecast}
                headerControls={
                  <AssignedMachinesControl
                    config={config}
                    machHandled={config.operator.machHandled}
                    forecast={forecast}
                    onOptimize={optimizeUtilization}
                    onChange={(machHandled) =>
                      setConfig((prev) => ({ ...prev, operator: { ...prev.operator, machHandled } }))
                    }
                    onWaitingModelChange={changeWaitingModel}
                  />
                }
              />
              <ActivityTable
                activities={config.activities}
                spoolWeight={derived.spoolWeight}
                fracturePerTon={config.spec.fracturePerTon}
                diesPerTon={config.spec.diesPerTon}
                defectsPerTon={config.spec.defectsPerTon}
                rpcPercent={config.rpcPercent ?? 12}
                onChange={(activities) => setConfig((prev) => ({ ...prev, activities }))}
                onRpcPercentChange={(rpcPercent) => setConfig((prev) => ({ ...prev, rpcPercent }))}
              />
            </div>
          </div>
        )}
        {step === 1 && (
          <>
            <LayoutSelector
              onSelect={(layout, operatorStart, walls, remarks) =>
                setConfig((prev) => {
                  // A new layout starts from the default assignment (top-left, two facing rows at a time).
                  const next = { ...prev, layout, operatorStart, walls, remarks, assignedMachineIds: [] };
                  return { ...next, assignedMachineIds: previewAssignedMachineIds(next, prev.operator.machHandled) };
                })
              }
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
              walls={config.walls ?? []}
              onWallsChange={(walls) => setConfig((prev) => ({ ...prev, walls }))}
              remarks={config.remarks ?? []}
              onRemarksChange={(remarks) => setConfig((prev) => ({ ...prev, remarks }))}
            />
          </>
        )}
      </fieldset>

    </div>
  );
}
