import { useMemo, useState, type ReactNode } from 'react';
import type { LayoutMachine, ProductionMachineAssignment } from '../../types';
import {
  machineOperatorIds,
  TASK_OPERATOR_FIELDS,
  TASK_OPERATOR_LABELS,
  type ProductionActivityFamily,
} from '../../lib/productionActivityRouting';
import { doffPriorityText } from '../ui/doffPriorityText';

export type MachineAssignmentsGroupBy = 'none' | 'construction' | 'groupName' | 'operator';

const GROUP_BY_OPTIONS: { value: MachineAssignmentsGroupBy; label: string }[] = [
  { value: 'none', label: 'None' },
  { value: 'construction', label: 'Construction' },
  { value: 'groupName', label: 'Group Name' },
  { value: 'operator', label: 'Operator' },
];

const FAMILIES = Object.keys(TASK_OPERATOR_FIELDS) as ProductionActivityFamily[];

/** Search box across every column, shown before Group by. */
export function MachineAssignmentsSearch({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  return (
    <input
      type="search"
      className="input assign-search"
      placeholder="Search…"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      aria-label="Search machine assignments"
      title="Machine, Construction, Group Name, any operator or Doff Priority"
    />
  );
}

/** The "Group by" picker, shown next to the table's CSV buttons. */
export function MachineAssignmentsGroupBySelect({
  value,
  onChange,
}: {
  value: MachineAssignmentsGroupBy;
  onChange: (value: MachineAssignmentsGroupBy) => void;
}) {
  return (
    <label className="assign-group-by">
      Group by
      <select className="input" value={value} onChange={(e) => onChange(e.target.value as MachineAssignmentsGroupBy)}>
        {GROUP_BY_OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}

type Row = { machine: LayoutMachine; assignment: ProductionMachineAssignment | undefined };

interface Group {
  key: string;
  label: string;
  machines: Row[];
}

/** Distinct values of each column across a set of machines. */
interface ColumnValues {
  constructions: string[];
  groupNames: string[];
  multiTask: string[];
  tasks: Record<ProductionActivityFamily, string[]>;
  operators: string[];
  ownDoffPriority: number;
}

function columnValues(assignments: (ProductionMachineAssignment | undefined)[]): ColumnValues {
  const distinct = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))];
  return {
    constructions: distinct(assignments.map((a) => a?.constructionDetailLabel ?? a?.constructionDetailId)),
    groupNames: distinct(assignments.map((a) => a?.groupName)),
    multiTask: distinct(assignments.flatMap((a) => a?.assignedOperatorIds ?? [])),
    tasks: Object.fromEntries(
      FAMILIES.map((family) => [family, distinct(assignments.flatMap((a) => a?.[TASK_OPERATOR_FIELDS[family]] ?? []))]),
    ) as Record<ProductionActivityFamily, string[]>,
    operators: distinct(assignments.flatMap((a) => machineOperatorIds(a))),
    ownDoffPriority: assignments.filter((a) => doffPriorityText(a) !== '—').length,
  };
}

/** One table column: its header, totals cell, body cell and the value it sorts by. */
interface Column<T> {
  key: string;
  header: string;
  title?: string;
  total: ReactNode;
  totalTitle?: string;
  cell: (item: T) => ReactNode;
  sortValue: (item: T) => string | number;
}

type Sort = { key: string; desc: boolean } | null;

const compareText = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** Machine Assignments table, optionally rolled up by Construction, Group Name or Operator, with a
 * totals row above the headers and every header sortable. */
export function MachineAssignmentsTable({
  layout,
  assignments,
  operatorLabel,
  groupBy,
  search,
}: {
  layout: LayoutMachine[];
  assignments: ProductionMachineAssignment[];
  operatorLabel: (id: string) => string;
  groupBy: MachineAssignmentsGroupBy;
  /** Keeps only machines with this text in any column (case-insensitive); grouping and totals
   * then cover just those. */
  search: string;
}) {
  const [sort, setSort] = useState<Sort>(null);
  const [sortedFor, setSortedFor] = useState(groupBy);
  // A sort only applies to the view it was picked in; regrouping starts unsorted again.
  if (sortedFor !== groupBy) {
    setSortedFor(groupBy);
    setSort(null);
  }

  const assignmentByMachine = useMemo(() => new Map(assignments.map((a) => [a.machineId, a])), [assignments]);
  const allRows = useMemo(
    () =>
      layout.map((machine) => {
        const assignment = assignmentByMachine.get(machine.id);
        const text = [
          machine.label,
          assignment?.constructionDetailLabel,
          assignment?.groupName,
          ...machineOperatorIds(assignment).map(operatorLabel),
          doffPriorityText(assignment),
        ];
        return { machine, assignment, text: text.filter(Boolean).join('\n').toLowerCase() };
      }),
    [layout, assignmentByMachine, operatorLabel],
  );
  const query = search.trim().toLowerCase();
  const rows = useMemo(
    (): Row[] => (query ? allRows.filter((row) => row.text.includes(query)) : allRows),
    [allRows, query],
  );
  const totals = useMemo(() => columnValues(rows.map((row) => row.assignment)), [rows]);

  const groups = useMemo((): (Group & { values: ColumnValues })[] => {
    if (groupBy === 'none') return [];
    const byKey = new Map<string, Group>();
    const add = (key: string, label: string, row: Row) => {
      const group = byKey.get(key) ?? { key, label, machines: [] };
      group.machines.push(row);
      byKey.set(key, group);
    };
    rows.forEach((row) => {
      const a = row.assignment;
      if (groupBy === 'construction') {
        add(a?.constructionDetailId ?? '', a?.constructionDetailLabel ?? a?.constructionDetailId ?? '(not planned)', row);
      } else if (groupBy === 'groupName') {
        add(a?.groupName ?? '', a?.groupName ?? '(no group)', row);
      } else {
        // A machine counts toward every operator working it.
        const ids = machineOperatorIds(a);
        if (ids.length === 0) add('', '(no operator)', row);
        ids.forEach((id) => add(id, operatorLabel(id), row));
      }
    });
    // Named groups A→Z, the "none" bucket last.
    return [...byKey.values()]
      .sort((x, y) => ((x.key === '') !== (y.key === '') ? (x.key === '' ? 1 : -1) : compareText(x.label, y.label)))
      .map((group) => ({ ...group, values: columnValues(group.machines.map((row) => row.assignment)) }));
  }, [groupBy, rows, operatorLabel]);

  const names = (ids: string[], label: (id: string) => string = operatorLabel) => ids.map(label).join('\n');
  const asIs = (value: string) => value;
  /** One value shows as itself; several as a count with the names on hover. */
  const countCell = (values: string[], noun: string, label: (value: string) => string = operatorLabel) =>
    values.length === 0 ? (
      '—'
    ) : values.length === 1 ? (
      label(values[0])
    ) : (
      <span className="production-operators-cell" title={names(values, label)}>
        {values.length} {noun}
      </span>
    );
  /** Machine view list cells sort by what they show: the name, or the count of several. */
  const listSortValue = (ids: string[]) => (ids.length === 0 ? '' : ids.length === 1 ? operatorLabel(ids[0]) : `${ids.length} operators`);
  const total = (count: number, noun: string) => (count > 0 ? `${count.toLocaleString()} ${noun}` : '—');

  const grouped = groupBy !== 'none';
  const groupLabel = GROUP_BY_OPTIONS.find((option) => option.value === groupBy)?.label ?? '';

  const machineColumns: Column<Row>[] = [
    { key: 'machine', header: 'Machine', total: total(rows.length, 'machines'), cell: (r) => r.machine.label, sortValue: (r) => r.machine.label },
    {
      key: 'construction',
      header: 'Construction',
      total: total(totals.constructions.length, 'constr.'),
      totalTitle: names(totals.constructions, asIs),
      cell: (r) => r.assignment?.constructionDetailLabel ?? '—',
      sortValue: (r) => r.assignment?.constructionDetailLabel ?? '',
    },
    {
      key: 'groupName',
      header: 'Group Name',
      total: total(totals.groupNames.length, 'groups'),
      totalTitle: names(totals.groupNames, asIs),
      cell: (r) => r.assignment?.groupName ?? '—',
      sortValue: (r) => r.assignment?.groupName ?? '',
    },
    {
      key: 'multiTask',
      header: 'Multi Task',
      title: 'Operators who may do every task on the machine',
      total: total(totals.multiTask.length, 'opr'),
      totalTitle: names(totals.multiTask),
      cell: (r) => countCell(r.assignment?.assignedOperatorIds ?? [], 'operators'),
      sortValue: (r) => listSortValue(r.assignment?.assignedOperatorIds ?? []),
    },
    ...FAMILIES.map(
      (family): Column<Row> => ({
        key: family,
        header: TASK_OPERATOR_LABELS[family],
        total: total(totals.tasks[family].length, 'opr'),
        totalTitle: names(totals.tasks[family]),
        cell: (r) => countCell(r.assignment?.[TASK_OPERATOR_FIELDS[family]] ?? [], 'operators'),
        sortValue: (r) => listSortValue(r.assignment?.[TASK_OPERATOR_FIELDS[family]] ?? []),
      }),
    ),
    {
      key: 'doffPriority',
      header: 'Doff Priority',
      title: "Machine's own Doff Priority; — = follows the setup",
      total: total(totals.ownDoffPriority, 'own'),
      totalTitle: 'Machines with their own Doff Priority',
      cell: (r) => doffPriorityText(r.assignment),
      sortValue: (r) => (doffPriorityText(r.assignment) === '—' ? '' : doffPriorityText(r.assignment)),
    },
  ];

  type GroupRow = (typeof groups)[number];
  const groupColumns: Column<GroupRow>[] = [
    { key: 'group', header: groupLabel, total: total(groups.length, groups.length === 1 ? 'group' : 'groups'), cell: (g) => g.label, sortValue: (g) => g.label },
    {
      key: 'machines',
      header: 'Machines',
      total: total(rows.length, 'machines'),
      cell: (g) => (
        <span className="production-operators-cell" title={g.machines.map((row) => row.machine.label).join(', ')}>
          {g.machines.length}
        </span>
      ),
      sortValue: (g) => g.machines.length,
    },
    ...(groupBy === 'construction'
      ? []
      : [
          {
            key: 'construction',
            header: 'Construction',
            total: total(totals.constructions.length, 'constr.'),
            totalTitle: names(totals.constructions, asIs),
            cell: (g: GroupRow) => countCell(g.values.constructions, 'constructions', asIs),
            sortValue: (g: GroupRow) => g.values.constructions.length,
          },
        ]),
    ...(groupBy === 'groupName'
      ? []
      : [
          {
            key: 'groupName',
            header: 'Group Name',
            total: total(totals.groupNames.length, 'groups'),
            totalTitle: names(totals.groupNames, asIs),
            cell: (g: GroupRow) => countCell(g.values.groupNames, 'groups', asIs),
            sortValue: (g: GroupRow) => g.values.groupNames.length,
          },
        ]),
    {
      key: 'operators',
      header: 'Operators',
      title: 'Everyone working these machines, Multi Task and Split Task',
      total: total(totals.operators.length, 'opr'),
      totalTitle: names(totals.operators),
      cell: (g) => countCell(g.values.operators, 'operators'),
      sortValue: (g) => g.values.operators.length,
    },
    {
      key: 'multiTask',
      header: 'Multi Task',
      title: 'Operators who may do every task on the machine',
      total: total(totals.multiTask.length, 'opr'),
      totalTitle: names(totals.multiTask),
      cell: (g) => countCell(g.values.multiTask, 'operators'),
      sortValue: (g) => g.values.multiTask.length,
    },
    ...FAMILIES.map(
      (family): Column<GroupRow> => ({
        key: family,
        header: TASK_OPERATOR_LABELS[family],
        total: total(totals.tasks[family].length, 'opr'),
        totalTitle: names(totals.tasks[family]),
        cell: (g) => countCell(g.values.tasks[family], 'operators'),
        sortValue: (g) => g.values.tasks[family].length,
      }),
    ),
  ];

  /** Sorted copy (blanks always last); unsorted keeps layout / group order. */
  const sorted = <T,>(items: T[], columns: Column<T>[]): T[] => {
    const column = sort ? columns.find((c) => c.key === sort.key) : undefined;
    if (!column || !sort) return items;
    return [...items].sort((x, y) => {
      const a = column.sortValue(x);
      const b = column.sortValue(y);
      if (a === '' || b === '') return a === b ? 0 : a === '' ? 1 : -1;
      const order = typeof a === 'number' && typeof b === 'number' ? a - b : compareText(String(a), String(b));
      return sort.desc ? -order : order;
    });
  };
  const toggleSort = (key: string) =>
    setSort((prev) => (prev?.key === key ? { key, desc: !prev.desc } : { key, desc: false }));

  const renderTable = <T,>(columns: Column<T>[], items: T[], rowKey: (item: T) => string) => (
    <table className="table assign-table">
      <thead>
        <tr className="assign-total-row">
          {columns.map((c) => (
            <th key={c.key} className="assign-total-cell" title={c.totalTitle || undefined}>
              {c.total}
            </th>
          ))}
        </tr>
        <tr>
          {columns.map((c) => (
            <th
              key={c.key}
              className="table-sortable-header"
              title={c.title}
              onClick={() => toggleSort(c.key)}
              aria-sort={sort?.key === c.key ? (sort.desc ? 'descending' : 'ascending') : undefined}
            >
              {c.header}
              <span className="table-sort-indicator">{sort?.key === c.key ? (sort.desc ? ' ▼' : ' ▲') : ''}</span>
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sorted(items, columns).map((item) => (
          <tr key={rowKey(item)}>
            {columns.map((c) => (
              <td key={c.key}>{c.cell(item)}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );

  if (query && rows.length === 0) return <p className="data-manager-hint">No machine matches "{search.trim()}".</p>;

  return (
    <div className="machine-timeline-rows">
      {grouped
        ? renderTable(groupColumns, groups, (g) => g.key || '__none__')
        : renderTable(machineColumns, rows, (r) => r.machine.id)}
    </div>
  );
}
