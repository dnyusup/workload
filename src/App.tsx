import { useEffect, useState } from 'react';
import { AppConfigProvider, useAppConfig } from './context/AppConfigContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { deriveMachineSpec, fractureRepairingDenominator } from './lib/calculations';
import { SetupWizard } from './components/setup/SetupWizard';
import { SimulationView } from './SimulationView';
import { Sidebar, pagesForRole, iconForPage, type AppPage } from './components/layout/Sidebar';
import { ProductsManager } from './components/data/ProductsManager';
import { ActivitiesManager } from './components/data/ActivitiesManager';
import { LayoutManagerPage } from './components/layouts/LayoutManagerPage';
import { ProductionSimulationPage } from './components/production/ProductionSimulationPage';
import { UsersManagerPage } from './components/users/UsersManagerPage';
import './App.css';

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', contribute: 'Contribute', guest: 'Guest' };

function AppShell() {
  const { config, setConfig } = useAppConfig();
  const { user, loading: authLoading } = useAuth();
  const [stage, setStage] = useState<'setup' | 'simulation'>('setup');
  const [page, setPage] = useState<AppPage>('simulator');
  const [activitiesConstructionFilter, setActivitiesConstructionFilter] = useState('');

  // If the current role can't see whatever page is selected (e.g. a Guest's role only resolves
  // once the WL_Users lookup finishes, or an admin demotes themselves while on Manage Users),
  // fall back to Simulator — every role can reach that one.
  useEffect(() => {
    if (!authLoading && !pagesForRole(user.role).includes(page)) setPage('simulator');
  }, [authLoading, user.role, page]);

  const handleStart = () => {
    const derived = deriveMachineSpec(config.spec);
    setConfig((prev) => ({
      ...prev,
      activities: prev.activities.map((a) => ({
        ...a,
        numerator:
          a.key === 'diesChange'
            ? prev.spec.diesPerTon
            : a.key === 'defectRepairing'
              ? prev.spec.defectsPerTon
              : a.numeratorAuto
                ? prev.spec.fracturePerTon
                : a.numerator,
        denominator: a.denominatorAuto ? fractureRepairingDenominator(derived.spoolWeight) : a.denominator,
      })),
    }));
    setStage('simulation');
  };

  return (
    <div className="app-shell-with-sidebar">
      <Sidebar page={page} role={user.role} onNavigate={setPage} />
      <div className="app-shell">
        <header className="app-header">
          <div className="app-title">
            <span className="app-logo">{iconForPage(page)}</span>
            <div>
              <h1>{page === 'production' ? 'Production Simulator' : page === 'users' ? 'Manage Users' : 'WorkLoad Simulator'}</h1>
              <p>
                {page === 'production'
                  ? 'Multi-operator, multi-Construction production simulation across the machine layout'
                  : page === 'users'
                    ? 'Grant Admin/Contribute access by email — everyone else is a Guest'
                    : 'Simulator of operator Task accross the machine layout'}
              </p>
            </div>
          </div>
          {page === 'simulator' && (
            <div className="app-header-stage">
              <span className={`stage-pill ${stage === 'setup' ? 'active' : ''}`}>1. Setup</span>
              <span className={`stage-pill ${stage === 'simulation' ? 'active' : ''}`}>2. Simulation</span>
            </div>
          )}
          <div className="app-header-user">
            <span className="app-header-user-name">{authLoading ? 'Signing in…' : user.displayName}</span>
            <span className="app-header-user-role">{authLoading ? '' : ROLE_LABEL[user.role]}</span>
          </div>
        </header>

        <main className="app-main">
          {page === 'simulator' &&
            (stage === 'setup' ? (
              <SetupWizard onStart={handleStart} />
            ) : (
              <SimulationView config={config} setConfig={setConfig} onBack={() => setStage('setup')} />
            ))}
          {page === 'layouts' && <LayoutManagerPage />}
          {page === 'production' && <ProductionSimulationPage />}
          {page === 'products' && (
            <ProductsManager
              onOpenActivitiesForConstruction={(construction) => {
                setActivitiesConstructionFilter(construction);
                setPage('activities');
              }}
            />
          )}
          {page === 'activities' && <ActivitiesManager initialConstructionFilter={activitiesConstructionFilter} />}
          {page === 'users' && <UsersManagerPage />}
        </main>
      </div>
    </div>
  );
}

function App() {
  return (
    <AppConfigProvider>
      <AuthProvider>
        <AppShell />
      </AuthProvider>
    </AppConfigProvider>
  );
}

export default App;
