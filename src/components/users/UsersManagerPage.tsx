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
  maxSetup?: number;
}

function toAccessRow(row: Mpp_wl_userses): AccessRow {
  const normalizedRole = (row.mpp_role ?? '').trim().toLowerCase();
  return {
    id: row.mpp_wl_usersid,
    email: row.mpp_email ?? '',
    name: row.mpp_name ?? '',
    role: normalizedRole === 'admin' ? 'Admin' : 'Contribute',
    maxSetup: typeof row.mpp_max_setup === 'number' ? row.mpp_max_setup : undefined,
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
  const [maxSetupToAdd, setMaxSetupToAdd] = useState<number | ''>(2);
  const searchSeq = useRef(0);

  // Search & Role filter for Users with Access
  const [userListSearch, setUserListSearch] = useState('');
  const [roleFilter, setRoleFilter] = useState<'All' | 'Admin' | 'Contribute'>('All');

  // Inline Max Setup edit & save states
  const [editingMaxSetup, setEditingMaxSetup] = useState<Record<string, number | ''>>({});
  const [savingMaxSetupId, setSavingMaxSetupId] = useState<string | null>(null);
  const [savedFeedbackId, setSavedFeedbackId] = useState<string | null>(null);

  const adminCount = useMemo(() => rows.filter((r) => r.role === 'Admin').length, [rows]);
  const contributeCount = useMemo(() => rows.filter((r) => r.role === 'Contribute').length, [rows]);

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

  const filteredRows = useMemo(() => {
    const q = userListSearch.trim().toLowerCase();
    return sortedRows.filter((row) => {
      if (roleFilter !== 'All' && row.role !== roleFilter) return false;
      if (!q) return true;
      return (row.name || '').toLowerCase().includes(q) || (row.email || '').toLowerCase().includes(q);
    });
  }, [sortedRows, userListSearch, roleFilter]);

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
    if (roleToAdd === 'Contribute' && (maxSetupToAdd === '' || Number(maxSetupToAdd) <= 0)) {
      setError('Max Setup is required for Contribute role (must be at least 1).');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await Mpp_wl_usersesService.create({
        mpp_email: picked.email,
        mpp_name: picked.name,
        mpp_role: roleToAdd,
        mpp_max_setup: roleToAdd === 'Contribute' ? (typeof maxSetupToAdd === 'number' ? maxSetupToAdd : 2) : undefined,
        statecode: 0,
      });
      if (!result.success || !result.data) throw new Error(result.error?.message ?? 'Failed to add user.');
      setRows((prev) => [...prev, toAccessRow(result.data!)]);
      setPicked(null);
      setSearchTerm('');
      setMaxSetupToAdd(2);
      if (picked.email.toLowerCase() === user.email.toLowerCase()) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add user.');
    } finally {
      setBusy(false);
    }
  };

  const changeRole = async (id: string, role: 'Admin' | 'Contribute') => {
    const target = rows.find((r) => r.id === id);
    const nextMaxSetup = role === 'Contribute' ? (target?.maxSetup ?? 2) : undefined;
    setRows((prev) => prev.map((r) => (r.id === id ? { ...r, role, maxSetup: nextMaxSetup } : r)));
    try {
      const patch: { mpp_role: string; mpp_max_setup?: number } = { mpp_role: role };
      if (role === 'Contribute') {
        patch.mpp_max_setup = nextMaxSetup;
      }
      const result = await Mpp_wl_usersesService.update(id, patch);
      if (!result.success) throw new Error(result.error?.message ?? 'Failed to update role.');
      if (target && target.email.toLowerCase() === user.email.toLowerCase()) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update role.');
      loadRows();
    }
  };

  const saveMaxSetup = async (id: string, customValue?: number) => {
    const target = rows.find((r) => r.id === id);
    if (!target) return;
    const pendingVal = customValue !== undefined ? customValue : editingMaxSetup[id];
    const finalVal = typeof pendingVal === 'number' && pendingVal > 0 ? pendingVal : (target.maxSetup ?? 2);

    setSavingMaxSetupId(id);
    setError(null);
    try {
      const result = await Mpp_wl_usersesService.update(id, { mpp_max_setup: finalVal });
      if (!result.success) throw new Error(result.error?.message ?? 'Failed to update Max Setup.');
      setRows((prev) => prev.map((r) => (r.id === id ? { ...r, maxSetup: finalVal } : r)));
      setEditingMaxSetup((prev) => {
        const next = { ...prev };
        delete next[id];
        return next;
      });
      setSavedFeedbackId(id);
      setTimeout(() => {
        setSavedFeedbackId((current) => (current === id ? null : current));
      }, 2000);
      if (target.email.toLowerCase() === user.email.toLowerCase()) await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update Max Setup.');
      loadRows();
    } finally {
      setSavingMaxSetupId(null);
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
          <div className="user-picker-add-row" style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            <select className="input" value={roleToAdd} onChange={(e) => setRoleToAdd(e.target.value as 'Admin' | 'Contribute')}>
              <option value="Contribute">Contribute</option>
              <option value="Admin">Admin</option>
            </select>
            {roleToAdd === 'Contribute' && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                <label style={{ fontSize: '0.8rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                  Max Setup <span style={{ color: '#ef4444' }}>*</span>:
                </label>
                <input
                  type="number"
                  min={1}
                  className="input"
                  style={{ width: '80px', height: '36px' }}
                  placeholder="e.g. 2"
                  value={maxSetupToAdd}
                  onChange={(e) => {
                    const val = e.target.value;
                    setMaxSetupToAdd(val === '' ? '' : Math.max(1, parseInt(val, 10) || 1));
                  }}
                  required
                />
              </div>
            )}
            <Button
              variant="primary"
              onClick={addUser}
              disabled={!picked || busy || (roleToAdd === 'Contribute' && (maxSetupToAdd === '' || Number(maxSetupToAdd) <= 0))}
            >
              + Add {picked ? picked.name : 'Selected Person'}
            </Button>
          </div>
          <p className="data-manager-hint">
            Anyone signed in whose email isn't listed below is treated as a Guest (Simulator access only).
          </p>
        </div>
      </Card>

      <Card
        title="Users with Access"
        actions={
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' }}>
            <input
              type="search"
              className="input"
              placeholder="Search by name or email…"
              value={userListSearch}
              onChange={(e) => setUserListSearch(e.target.value)}
              style={{ width: '200px', height: '34px', fontSize: '0.8rem' }}
              aria-label="Search users"
            />
            <select
              className="input"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value as 'All' | 'Admin' | 'Contribute')}
              style={{ width: '150px', height: '34px', fontSize: '0.8rem' }}
              aria-label="Filter users by role"
            >
              <option value="All">All Roles ({rows.length})</option>
              <option value="Admin">Admin ({adminCount})</option>
              <option value="Contribute">Contribute ({contributeCount})</option>
            </select>
          </div>
        }
      >
        {loading ? (
          <p className="data-manager-hint">Loading…</p>
        ) : rows.length === 0 ? (
          <p className="data-manager-hint">No one has been granted Admin/Contribute access yet.</p>
        ) : filteredRows.length === 0 ? (
          <p className="data-manager-hint">
            No users match "{userListSearch}"{roleFilter !== 'All' ? ` with ${roleFilter} role` : ''}.
          </p>
        ) : (
          <ul className="user-access-list">
            {filteredRows.map((row) => {
              const editVal = editingMaxSetup[row.id];
              const val = editVal !== undefined ? editVal : (row.maxSetup ?? '');
              const isDirty = editVal !== undefined && editVal !== '' && editVal !== row.maxSetup;
              const isSaving = savingMaxSetupId === row.id;
              const isJustSaved = savedFeedbackId === row.id;

              return (
                <li key={row.id} className="user-access-item">
                  <div className="user-access-identity">
                    <span className="layout-list-name">{row.name || row.email}</span>
                    <span className="layout-list-count">{row.email}</span>
                  </div>
                  <div className="user-access-actions" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                    {row.role === 'Contribute' && (
                      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
                        <label style={{ fontSize: '0.75rem', color: '#94a3b8', whiteSpace: 'nowrap' }}>
                          Max Setup:
                        </label>
                        <input
                          type="number"
                          min={1}
                          className="input"
                          style={{
                            width: '64px',
                            padding: '4px 6px',
                            height: '34px',
                            textAlign: 'center',
                            borderColor: isDirty ? '#38bdf8' : undefined,
                          }}
                          value={val}
                          placeholder="e.g. 2"
                          onChange={(e) => {
                            const raw = e.target.value;
                            setEditingMaxSetup((prev) => ({
                              ...prev,
                              [row.id]: raw === '' ? '' : Math.max(1, parseInt(raw, 10) || 1),
                            }));
                          }}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && isDirty) {
                              e.preventDefault();
                              void saveMaxSetup(row.id);
                            }
                          }}
                        />
                        {isDirty && (
                          <Button
                            variant="secondary"
                            style={{ padding: '2px 8px', height: '34px', fontSize: '0.75rem' }}
                            disabled={isSaving || val === ''}
                            onClick={() => void saveMaxSetup(row.id)}
                            title="Save Max Setup to Dataverse"
                          >
                            {isSaving ? 'Saving…' : 'Save'}
                          </Button>
                        )}
                        {isJustSaved && !isDirty && (
                          <span style={{ color: '#4ade80', fontSize: '0.75rem', fontWeight: 600, display: 'inline-flex', alignItems: 'center', gap: '2px' }}>
                            ✓ Saved
                          </span>
                        )}
                      </div>
                    )}
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
              );
            })}
          </ul>
        )}
      </Card>
    </div>
  );
}
