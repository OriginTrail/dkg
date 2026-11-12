// @vitest-environment happy-dom

/**
 * The create and join dialogs belong to the shell. Creating a Context Graph
 * opens its tab before the workspace wiring step, and on a narrow screen that
 * navigation closes the left panel that opened the dialog. The dialog, and
 * whatever the user has entered, must survive both.
 */
import React, { act, useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { useContextGraphDialogs } from '../src/ui/stores/contextGraphDialogs.js';

// Stand-ins with their own state, like the real dialogs' form and step.
function dialog(testId: string) {
  return ({ open, initialContextGraphId }: { open: boolean; initialContextGraphId?: string }) => {
    const [step, setStep] = useState('form');
    if (!open) return null;
    return React.createElement('div', { 'data-testid': testId, 'data-step': step, 'data-cg': initialContextGraphId ?? '' },
      React.createElement('button', { onClick: () => setStep('wiring') }, 'next'));
  };
}
vi.mock('../src/ui/components/Modals/CreateProjectModal.js', () => ({ CreateProjectModal: dialog('create') }));
vi.mock('../src/ui/components/Modals/JoinProjectModal.js', () => ({ JoinProjectModal: dialog('join') }));

const { ContextGraphDialogs } = await import('../src/ui/components/Shell/ContextGraphDialogs.js');

let navigate: ReturnType<typeof useNavigate>;
function Shell({ panelOpen }: { panelOpen: boolean }) {
  navigate = useNavigate();
  return React.createElement(React.Fragment, null,
    React.createElement(ContextGraphDialogs),
    panelOpen ? React.createElement('aside', { 'data-testid': 'panel' }) : null);
}

describe('Context Graph dialogs', () => {
  let root: Root;
  let container: HTMLDivElement;
  const render = (panelOpen: boolean) => act(async () => {
    root.render(React.createElement(MemoryRouter, null, React.createElement(Shell, { panelOpen })));
  });
  // The dialogs portal to document.body, outside the shell's container.
  const find = (id: string) => document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    useContextGraphDialogs.setState({ createOpen: false, joinOpen: false, joinContextGraphId: undefined });
    container = document.body.appendChild(document.createElement('div'));
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('keeps the create dialog and its step when the panel closes and the route changes', async () => {
    await render(true);
    await act(async () => { useContextGraphDialogs.getState().openCreate(); });
    await act(async () => { find('create')!.querySelector('button')!.click(); });
    expect(find('create')!.dataset.step).toBe('wiring');

    await act(async () => { navigate('/graph/new-graph'); });
    await render(false);
    expect(find('panel')).toBeNull();
    expect(find('create')!.dataset.step).toBe('wiring');

    await act(async () => { useContextGraphDialogs.getState().closeCreate(); });
    expect(find('create')).toBeNull();
  });

  it('opens join with the chosen Context Graph and clears it on close', async () => {
    await render(true);
    await act(async () => { useContextGraphDialogs.getState().openJoin('cg-42'); });
    await render(false);
    expect(find('join')!.dataset.cg).toBe('cg-42');
    await act(async () => { useContextGraphDialogs.getState().closeJoin(); });
    expect(find('join')).toBeNull();
    expect(useContextGraphDialogs.getState().joinContextGraphId).toBeUndefined();
  });
});
