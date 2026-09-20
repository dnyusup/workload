import { useState } from 'react';
import type { UserRole } from '../../context/AuthContext';

export type AppPage = 'simulator' | 'layouts' | 'production' | 'products' | 'activities' | 'outputModels' | 'users';

const MENU: { page: AppPage; label: string; icon: string; roles: UserRole[] }[] = [
  { page: 'simulator', label: 'Work Load Simulator', icon: '▶️', roles: ['admin', 'contribute', 'guest'] },
  { page: 'layouts', label: 'Layout Builder', icon: '📐', roles: ['admin', 'contribute'] },
  { page: 'production', label: 'Production Simulation', icon: '🏭', roles: ['admin', 'contribute'] },
  { page: 'products', label: 'WL_Products', icon: '📦', roles: ['admin'] },
  { page: 'activities', label: 'WL_Activities', icon: '⏱️', roles: ['admin'] },
  { page: 'outputModels', label: 'WL_Outputmodels', icon: '📊', roles: ['admin'] },
  { page: 'users', label: 'Manage Users', icon: '👥', roles: ['admin'] },
];

/** Pages a given role is allowed to see — shared with App.tsx so the sidebar's visible menu and
 * the actual page-routing guard can never drift apart. */
export function pagesForRole(role: UserRole): AppPage[] {
  return MENU.filter((item) => item.roles.includes(role)).map((item) => item.page);
}

/** The same icon shown for a page in the sidebar — reused for the top header's logo badge so it
 * reflects whichever page is currently open instead of a static app initials. */
export function iconForPage(page: AppPage): string {
  return MENU.find((item) => item.page === page)?.icon ?? '▶️';
}

export function labelForPage(page: AppPage): string {
  return MENU.find((item) => item.page === page)?.label ?? 'Work Load Simulator';
}

export function Sidebar({ page, role, onNavigate }: { page: AppPage; role: UserRole; onNavigate: (page: AppPage) => void }) {
  const [collapsed, setCollapsed] = useState(true);
  const items = MENU.filter((item) => item.roles.includes(role));

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : 'sidebar-expanded'}`}>
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => setCollapsed((c) => !c)}
        title={collapsed ? 'Expand menu' : 'Collapse menu'}
      >
        {collapsed ? '»' : '«'}
      </button>
      <nav className="sidebar-nav">
        {items.map((item) => (
          <button
            key={item.page}
            type="button"
            className={`sidebar-item ${page === item.page ? 'active' : ''}`}
            onClick={() => onNavigate(item.page)}
            title={item.label}
          >
            <span className="sidebar-icon">{item.icon}</span>
            {!collapsed && <span className="sidebar-label">{item.label}</span>}
          </button>
        ))}
      </nav>
    </aside>
  );
}
