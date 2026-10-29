import type { UserRole } from '../../context/AuthContext';

export type AppPage = 'simulator' | 'layouts' | 'production' | 'products' | 'activities' | 'frequency' | 'actualOutput' | 'outputModels' | 'users' | 'settings' | 'guidance';

export interface MenuItem {
  page: AppPage;
  label: string;
  icon: string;
  roles: UserRole[];
}

export const MENU: MenuItem[] = [
  { page: 'simulator', label: 'Work Load Simulator', icon: '▶️', roles: ['admin', 'contribute', 'guest'] },
  { page: 'layouts', label: 'Layout Builder', icon: '📐', roles: ['admin', 'contribute'] },
  { page: 'production', label: 'Production Simulation', icon: '🏭', roles: ['admin', 'contribute'] },
  { page: 'frequency', label: 'MES_Frequency', icon: '📈', roles: ['admin', 'contribute'] },
  { page: 'actualOutput', label: 'MES_ActualOutput', icon: '⚡', roles: ['admin', 'contribute'] },
  { page: 'products', label: 'WL_Products', icon: '📦', roles: ['admin'] },
  { page: 'activities', label: 'WL_Activities', icon: '⏱️', roles: ['admin'] },
  { page: 'outputModels', label: 'WL_Outputmodels', icon: '📊', roles: ['admin'] },
  { page: 'users', label: 'Manage Users', icon: '👥', roles: ['admin'] },
  { page: 'settings', label: 'Setting', icon: '⚙️', roles: ['admin'] },
  { page: 'guidance', label: 'Guidance', icon: '📘', roles: ['admin', 'contribute', 'guest'] },
];

export interface MenuGroup {
  id: string;
  label: string;
  pages: AppPage[];
}

export const MENU_GROUPS: MenuGroup[] = [
  {
    id: 'planning',
    label: 'Planning & Simulation',
    pages: ['simulator', 'layouts', 'production'],
  },
  {
    id: 'mes',
    label: 'MES Data',
    pages: ['frequency', 'actualOutput'],
  },
  {
    id: 'catalogs',
    label: 'Master Catalogs',
    pages: ['products', 'activities', 'outputModels'],
  },
  {
    id: 'system',
    label: 'System & Guidance',
    pages: ['users', 'settings', 'guidance'],
  },
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
