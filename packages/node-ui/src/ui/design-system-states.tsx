/**
 * State matrix for the design system reference page (development only, see
 * DESIGN.md). Each cell is the real component in one state.
 *
 * A browser can't hold an element in :hover or :focus, so each component's own
 * hover and focus rule also names a preview class (`.ds-btn:is(:hover, .dsp-hover)`
 * in 27-ds-components.css). A cell sets that class and gets the same declarations.
 */
import React from 'react';
import { Loader2, RefreshCw } from 'lucide-react';
import { Button, type ButtonVariant } from './components/ds/Button.js';
import { ContextGraphChip } from './components/ds/ContextGraphChip.js';
import { Toggle } from './components/ds/Toggle.js';

export const STATES = ['Default', 'Hover', 'Focus', 'Disabled', 'Loading', 'Error'] as const;
export type State = (typeof STATES)[number];

interface Cell {
  /** Forces the hover or focus look. */
  className?: string;
  disabled: boolean;
  loading: boolean;
  error: boolean;
  /** A name for the control, unique to this cell. */
  label: string;
}

interface MatrixRow {
  name: string;
  note?: string;
  states: readonly State[];
  render: (cell: Cell) => React.ReactNode;
}

const CONTROL: readonly State[] = ['Default', 'Hover', 'Focus', 'Disabled'];
const WITH_LOADING: readonly State[] = [...CONTROL, 'Loading'];
const FIELD: readonly State[] = ['Default', 'Focus', 'Disabled', 'Error'];

const buttonRow = (variant: ButtonVariant): MatrixRow => ({
  name: `Button · ${variant}`,
  states: WITH_LOADING,
  render: ({ className, disabled, loading }) => (
    <Button variant={variant} className={className} disabled={disabled || loading}>{loading ? 'Saving…' : 'Save'}</Button>
  ),
});

const pickRow = (name: string, selected: boolean, render: (cell: Cell, selected: boolean) => React.ReactNode): MatrixRow => ({
  name, states: CONTROL, render: (cell) => render(cell, selected),
});

const tab = ({ className, disabled }: Cell, selected: boolean) => (
  <button type="button" role="tab" className={['ds-tab', className].filter(Boolean).join(' ')} aria-selected={selected} disabled={disabled}>Overview</button>
);
const segment = ({ className, disabled }: Cell, selected: boolean) => (
  <span className="ds-seg"><button type="button" className={['ds-seg-item', className].filter(Boolean).join(' ')} aria-pressed={selected} disabled={disabled}>Agents</button></span>
);
const filter = ({ className, disabled }: Cell, selected: boolean) => (
  <button type="button" className={['ds-filter', className].filter(Boolean).join(' ')} aria-pressed={selected} disabled={disabled}>Tasks</button>
);

const ROWS: MatrixRow[] = [
  ...(['primary', 'secondary', 'ghost', 'danger', 'swm', 'vm'] as const).map(buttonRow),
  {
    name: 'Button · icon',
    states: WITH_LOADING,
    render: ({ className, disabled, loading, label }) => (
      <Button icon className={className} disabled={disabled || loading} aria-label={label}>
        {loading ? <Loader2 size={14} className="ds-spin" /> : <RefreshCw size={14} />}
      </Button>
    ),
  },
  {
    name: 'Input',
    states: FIELD,
    render: ({ className, disabled, error, label }) => (
      <input className={['ds-input', className].filter(Boolean).join(' ')} defaultValue="Climate" disabled={disabled} aria-invalid={error || undefined} aria-label={label} />
    ),
  },
  {
    name: 'Select',
    states: FIELD,
    render: ({ className, disabled, error, label }) => (
      <select className={['ds-input', className].filter(Boolean).join(' ')} disabled={disabled} aria-invalid={error || undefined} aria-label={label}><option>Newest first</option></select>
    ),
  },
  ...[false, true].map((checked): MatrixRow => ({
    name: `Toggle · ${checked ? 'on' : 'off'}`,
    states: ['Default', 'Focus', 'Disabled', 'Loading'],
    render: ({ className, disabled, loading, label }) => (
      <Toggle checked={checked} busy={loading} disabled={disabled} className={className} aria-label={label} />
    ),
  })),
  pickRow('Tab', false, tab),
  pickRow('Tab · selected', true, tab),
  pickRow('Segment', false, segment),
  pickRow('Segment · selected', true, segment),
  pickRow('Filter chip', false, filter),
  pickRow('Filter chip · on', true, filter),
  {
    name: 'Context graph chip',
    note: 'Not a form control: it has no disabled look',
    states: ['Default', 'Hover', 'Focus'],
    render: ({ className }) => <ContextGraphChip id="cg:climate-science" name="Climate science" onOpen={() => undefined} className={className} />,
  },
];

const cellFor = (row: MatrixRow, state: State): Cell => ({
  className: state === 'Hover' ? 'dsp-hover' : state === 'Focus' ? 'dsp-focus' : undefined,
  disabled: state === 'Disabled',
  loading: state === 'Loading',
  error: state === 'Error',
  label: `${row.name}, ${state}`,
});

export const StateMatrix: React.FC = () => (
  <div className="ds-table-scroll"><table className="dsp-matrix">
    <thead>
      <tr>
        <th scope="col">Component</th>
        {STATES.map((state) => <th key={state} scope="col">{state}</th>)}
      </tr>
    </thead>
    <tbody>
      {ROWS.map((row) => (
        <tr key={row.name}>
          <th scope="row"><b>{row.name}</b>{row.note ? <span>{row.note}</span> : null}</th>
          {STATES.map((state) => (
            <td key={state} data-state={state}>
              {row.states.includes(state) ? row.render(cellFor(row, state)) : <span className="dsp-none" title="This component has no such state">—</span>}
            </td>
          ))}
        </tr>
      ))}
    </tbody>
  </table></div>
);
