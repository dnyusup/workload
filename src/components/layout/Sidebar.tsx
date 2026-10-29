import { useMemo, useState } from 'react';
import type { UserRole } from '../../context/AuthContext';
import { MENU, MENU_GROUPS, type AppPage } from './menu';

export function Sidebar({
  page,
  role,
  onNavigate,
}: {
  page: AppPage;
  role: UserRole;
  onNavigate: (page: AppPage) => void;
}) {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);

  // Automatically expands on hover, minimizes when mouse leaves, or stays open if pinned
  const expanded = isPinned || isHovered;

  const visibleGroups = useMemo(() => {
    return MENU_GROUPS.map((group) => {
      const groupItems = MENU.filter(
        (item) => group.pages.includes(item.page) && item.roles.includes(role),
      );
      return { ...group, items: groupItems };
    }).filter((group) => group.items.length > 0);
  }, [role]);

  return (
    <aside
      className={`sidebar ${expanded ? 'sidebar-expanded' : 'sidebar-collapsed'}`}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <button
        type="button"
        className="sidebar-toggle"
        onClick={() => setIsPinned((p) => !p)}
        title={isPinned ? 'Unpin sidebar (auto-collapse on hover leave)' : 'Pin sidebar expanded'}
      >
        {expanded ? (isPinned ? '📌' : '«') : '»'}
      </button>

      <nav className="sidebar-nav">
        {visibleGroups.map((group, groupIdx) => (
          <div key={group.id} className="sidebar-group">
            {groupIdx > 0 && !expanded && <div className="sidebar-group-divider" />}
            {expanded && (
              <div className="sidebar-group-label">{group.label}</div>
            )}
            {group.items.map((item) => (
              <button
                key={item.page}
                type="button"
                className={`sidebar-item ${page === item.page ? 'active' : ''}`}
                onClick={() => onNavigate(item.page)}
                title={item.label}
              >
                <span className="sidebar-icon">{item.icon}</span>
                {expanded && <span className="sidebar-label">{item.label}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </aside>
  );
}
