import { useState } from 'react';
import type { UserRole } from '../../context/AuthContext';
import { MENU, type AppPage } from './menu';

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
