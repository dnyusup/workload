import { useState } from 'react';
import { AppConfigProvider, useAppConfig } from './context/AppConfigContext';
import { AuthProvider, useAuth } from './context/AuthContext';
import { syncAutoActivityValues } from './lib/calculations';
import { SetupWizard } from './components/setup/SetupWizard';
import { SimulationView } from './SimulationView';
import { Sidebar, pagesForRole, iconForPage, labelForPage, type AppPage } from './components/layout/Sidebar';
import { ProductsManager } from './components/data/ProductsManager';
import { ActivitiesManager } from './components/data/ActivitiesManager';
import { OutputModelsManager } from './components/data/OutputModelsManager';
import { LayoutManagerPage } from './components/layouts/LayoutManagerPage';
import { ProductionSimulationPage } from './components/production/ProductionSimulationPage';
import { UsersManagerPage } from './components/users/UsersManagerPage';
import './App.css';

const ROLE_LABEL: Record<string, string> = { admin: 'Admin', contribute: 'Contribute', guest: 'Guest' };
const PAGE_DESCRIPTION: Record<AppPage, string> = {
  simulator: 'Configure and run operator task simulations across the machine layout',
  layouts: 'Create and manage reusable machine layouts',
  production: 'Configure multi-operator production setups and run production simulations',
  products: 'Manage WL product and machine specifications',
  activities: 'Configure machine activity times and rules',
  outputModels: 'Review saved workload simulation outputs',
  users: 'Manage user access and roles',
};

function AppShell() {
  const { config, setConfig } = useAppConfig();
  const { user, loading: authLoading } = useAuth();
  const [stage, setStage] = useState<'setup' | 'simulation'>('setup');
  const [page, setPage] = useState<AppPage>('simulator');
  const [activitiesConstructionFilter, setActivitiesConstructionFilter] = useState('');
  const [outputModelNotice, setOutputModelNotice] = useState<string | null>(null);

  // If the current role cannot see the selected page, render Simulator without triggering a
  // synchronous state update from an effect. The stored page remains available if access returns.
  const activePage = authLoading || pagesForRole(user.role).includes(page) ? page : 'simulator';

  const handleStart = () => {
    setConfig((prev) => ({
      ...prev,
      activities: syncAutoActivityValues(prev.activities, prev.spec),
    }));
    setStage('simulation');
  };

  return (
    <div className="app-shell-with-sidebar">
      <Sidebar
        page={activePage}
        role={user.role}
        onNavigate={(nextPage) => {
          setOutputModelNotice(null);
          setPage(nextPage);
        }}
      />
      <div className="app-shell">
        <header className="app-header">
          <div className="app-title">
            <span className="app-logo">{iconForPage(activePage)}</span>
            <div>
              <h1>{labelForPage(activePage)}</h1>
              <p>{PAGE_DESCRIPTION[activePage]}</p>
            </div>
          </div>
          {activePage === 'simulator' && (
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
          {outputModelNotice && <p className="construction-selector-error">{outputModelNotice}</p>}
          {activePage === 'simulator' &&
            (stage === 'setup' ? (
              <SetupWizard onStart={handleStart} />
            ) : (
              <SimulationView config={config} setConfig={setConfig} onBack={() => setStage('setup')} />
            ))}
          {activePage === 'layouts' && <LayoutManagerPage />}
          {activePage === 'production' && <ProductionSimulationPage />}
          {activePage === 'products' && (
            <ProductsManager
              onOpenActivitiesForConstruction={(construction) => {
                setActivitiesConstructionFilter(construction);
                setPage('activities');
              }}
            />
          )}
          {activePage === 'activities' && <ActivitiesManager initialConstructionFilter={activitiesConstructionFilter} />}
          {activePage === 'outputModels' && (
            <OutputModelsManager
              onUseStartCondition={(row, conditions) => {
                setConfig((prev) => ({
                  ...prev,
                  selectedConstructionDetail: row.mpp_constructiondetailcode?.trim() || prev.selectedConstructionDetail,
                  initialMachineConditions: conditions,
                }));
                setOutputModelNotice(
                  `Inherited machine condition from version ${row.mpp_version ?? '0001'} loaded. The simulator is ready to play.`,
                );
                setPage('simulator');
                setStage('simulation');
              }}
            />
          )}
          {activePage === 'users' && <UsersManagerPage />}
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
