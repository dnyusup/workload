import { useEffect, useMemo, useRef, useState } from 'react';
import { Office365UsersService } from '../../generated/services/Office365UsersService';
import type { User } from '../../generated/models/Office365UsersModel';
import { Mpp_wl_usersesService } from '../../generated/services/Mpp_wl_usersesService';
import type { Mpp_wl_userses } from '../../generated/models/Mpp_wl_usersesModel';
import { fetchAllPages } from '../../lib/dataversePaging';
import { useDebouncedCallback } from '../../hooks/useDebouncedCallback';
import { useAuth } from '../../context/auth';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';

interface AccessRow {
  id: string;
  email: string;
  name: string;
  role: 'Admin' | 'Contribute';
}

function toAccessRow(row: Mpp_wl_userses): AccessRow {
  const normalizedRole = (row.mpp_role ?? '').trim().toLowerCase();
  return {
    id: row.mpp_wl_usersid,
    email: row.mpp_email ?? '',
    name: row.mpp_name ?? '',
    role: normalizedRole === 'admin' ? 'Admin' : 'Contribute',
  };
}

/** Manage Users — admin-only. Grants Admin/Contribute access by email (searched via the
 * Office365Users connector's people search, mirroring a native People Picker); anyone signed in
 * whose email has no row here falls back to Guest (see AuthContext.roleFromRow). */
export function UsersManagerPage() {
  const { user, refresh } = useAuth();
  const [rows, setRows] = useState<AccessRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<User[]>([]);
  const [searching, setSearching] = useState(false);
  const [picked, setPicked] = useState<{ email: string; name: string } | null>(null);
  const [roleToAdd, setRoleToAdd] = useState<'Admin' | 'Contribute'>('Contribute');
  const searchSeq = useRef(0);
  const sortedRows = useMemo(
    () =>
      [...rows].sort((a, b) => {
        const roleOrder = { Admin: 0, Contribute: 1 };
        const roleComparison = roleOrder[a.role] - roleOrder[b.role];
        if (roleComparison !== 0) return roleComparison;
        return (a.name || a.email).localeCompare(b.name || b.email, undefined, { sensitivity: 'base' });
      }),
    [rows],
  );

  // Split so the initial load (where `loading` already starts true) doesn't set state
  // synchronously inside the mount effect; reloads go through loadRows().
  const fetchRows = () => {
    fetchAllPages(Mpp_wl_usersesService.getAll, {})
      .then((result) => setRows(result.map(toAccessRow)))
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load user access list.'))
      .finally(() => setLoading(false));
  };

  const loadRows = () => {
    setLoading(true);
    setError(null);
    fetchRows();
  };

  useEffect(fetchRows, []);

  const runSearch = useDebouncedCallback((term: string) => {
    if (term.trim().length < 2) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    const seq = ++searchSeq.current;
    setSearching(true);
    Office365UsersService.SearchUser(term, 8)
      .then((result) => {
        if (searchSeq.current !== seq) return;
        setSearchResults(result.success ? result.data ?? [] : []);
      })
      .finally(() => {
        if (searchSeq.current === seq) setSearching(false);
      });
  }, 350);

  const onSearchChange = (value: string) => {
    setSearchTerm(value);
    setPicked(null);
    runSearch(value);
  };

  const pickResult = (person: User) => {
    const email = (person.Mail ?? person.UserPrincipalName ?? '').trim();
    if (!email) return;
    setPicked({ email, name: person.DisplayName?.trim() || email });
    setSearchTerm(person.DisplayName ?? email);
    setSearchResults([]);
  };

  const addUser = async () => {
    if (!picked) return;
    if (rows.some((r) => r.email.toLowerCase() === picked.email.toLowerCase())) {
      setError(`${picked.email} already has access.`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await Mpp_wl_usersesService.create({
        mpp_email: picked.email,
        mpp_name: picked.name,
        mpp_role: roleToAdd,
        statecode: 0,
      });
      if (!result.success || !result.data) throw new Error(result.error?.message ?? 'Failed to add user.');
      setRows((prev) => [...prev, toAccessRow(result.data!)]);
      setPicked(null);
      setSearchTerm('');
      if (picked.email.toLowerCase() === user.email.toLowerCase()) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add user.');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (id: string, role: 'Admin' | 'Contribute') => {
    const target = rows.find((r) => r.id === id);
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, role } : r)));
    try {
      const result = await Mpp_wl_usersesService.update(id, { mpp_role: role });
      if (!result.success) throw new Error(result.error?.message ?? 'Failed to update role.');
      if (target && target.email.toLowerCase() === user.email.toLowerCase()) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role.');
      loadRows();
    }
  };

  const removeUser = async (row: AccessRow) => {
    if (!window.confirm(`Remove access for ${row.name || row.email}? They will become a Guest.`)) return;
    setBusy(true);
    setError(null);
    try {
      await Mpp_wl_usersesService.delete(row.id);
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      if (row.email.toLowerCase() === user.email.toLowerCase()) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to remove user.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="layout-manager-grid">
      {error && (
        <div className="production-run-warnings" style={{ gridColumn: '1 / -1' }}>
          {error}
        </div>
      )}
      <Card title="Grant Access" subtitle="Search a person by name or email, choose a role, then add them.">
        <div className="user-picker">
          <input
            className="input"
            placeholder="Search name or email…"
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
          />
          {searching && <p className="data-manager-hint">Searching…</p>}
          {searchResults.length > 0 && (
            <ul className="user-picker-results">
              {searchResults.map((person) => (
                <li key={person.Id}>
                  <button type="button" onClick={() => pickResult(person)}>
                    <span className="user-picker-name">{person.DisplayName ?? person.Mail}</span>
                    <span className="user-picker-email">{person.Mail ?? person.UserPrincipalName}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="user-picker-add-row">
            <select className="input" value={roleToAdd} onChange={(e) => setRoleToAdd(e.target.value as 'Admin' | 'Contribute')}>
              <option value="Contribute">Contribute</option>
              <option value="Admin">Admin</option>
            </select>
            <Button variant="primary" onClick={addUser} disabled={!picked || busy}>
              + Add {picked ? picked.name : 'Selected Person'}
            </Button>
          </div>
          <p className="data-manager-hint">
            Anyone signed in whose email isn't listed below is treated as a Guest (Simulator access only).
          </p>
        </div>
      </Card>

      <Card title="Users with Access">
        {loading ? (
          <p className="data-manager-hint">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="data-manager-hint">No one has been granted Admin/Contribute access yet.</p>
        ) : (
          <ul className="user-access-list">
            {sortedRows.map((row) => (
              <li key={row.id} className="user-access-item">
                <div className="user-access-identity">
                  <span className="layout-list-name">{row.name || row.email}</span>
                  <span className="layout-list-count">{row.email}</span>
                </div>
                <div className="user-access-actions">
                  <select
                    className="input user-role-select"
                    value={row.role}
                    onChange={(e) => changeRole(row.id, e.target.value as 'Admin' | 'Contribute')}
                  >
                    <option value="Contribute">Contribute</option>
                    <option value="Admin">Admin</option>
                  </select>
                  <Button variant="danger" onClick={() => removeUser(row)} disabled={busy}>
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
