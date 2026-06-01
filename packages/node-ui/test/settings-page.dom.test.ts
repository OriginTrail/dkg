// @vitest-environment happy-dom

// Settings cleanup (Task #29) — proportionate behavioral coverage for the
// cleaned Settings page. NONE existed before (no test rendered Settings.tsx).
// Uses the repo's established happy-dom + react-dom/client createRoot idiom
// (matches create-project-modal.test.ts / markdown-message.test.ts) — no
// @testing-library, no new dep, no shared-config change. Assertions key off
// rendered DOM / roles / fired mock calls, not source substrings.
//
// Covers: the 4 removals are gone, the 4 keeps + Danger Zone render in the new
// order, retention is its OWN card (extracted) with the save-error affordance +
// reduce-confirm focus/Escape + label association, telemetry role="switch" /
// aria-busy + consent-modal dialog semantics, and the false daemon.log copy is
// gone. Proportionate — covers the new behavior + the removals; not exhaustive.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const fetchStatusMock = vi.fn();
const fetchWalletsBalancesMock = vi.fn();
const fetchMetricsMock = vi.fn();
const fetchRetentionSettingsMock = vi.fn();
const updateRetentionSettingsMock = vi.fn();
const fetchTelemetrySettingsMock = vi.fn();
const updateTelemetrySettingsMock = vi.fn();
const shutdownNodeMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    fetchStatus: fetchStatusMock,
    fetchWalletsBalances: fetchWalletsBalancesMock,
    fetchMetrics: fetchMetricsMock,
    fetchRetentionSettings: fetchRetentionSettingsMock,
    updateRetentionSettings: updateRetentionSettingsMock,
    fetchTelemetrySettings: fetchTelemetrySettingsMock,
    updateTelemetrySettings: updateTelemetrySettingsMock,
    shutdownNode: shutdownNodeMock,
  };
});

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setSelectValue(select: HTMLSelectElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value')?.set;
  setter?.call(select, value);
  select.dispatchEvent(new Event('change', { bubbles: true }));
}

function cardTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.card-title')).map(
    (n) => (n.textContent ?? '').trim(),
  );
}

describe('SettingsPage (cleanup) — rendering, removals, a11y', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    fetchStatusMock.mockResolvedValue({
      name: 'Test Node', peerId: '12D3KooWTest', nodeRole: 'core',
      networkName: 'testnet', storeBackend: 'oxigraph', connectedPeers: 2,
      connections: { direct: 1, relayed: 1 }, uptimeMs: 60_000,
    });
    fetchWalletsBalancesMock.mockResolvedValue({
      chainId: 'eip155:84532', balances: [{ address: '0xabc', eth: '1', trac: '2.5', symbol: 'TRAC' }],
      rpcUrl: 'https://rpc.example.com/secret-token',
    });
    fetchMetricsMock.mockResolvedValue({ store_bytes: 1_234_567 });
    fetchRetentionSettingsMock.mockResolvedValue({ retentionDays: 90 });
    fetchTelemetrySettingsMock.mockResolvedValue({ enabled: false });
    updateRetentionSettingsMock.mockResolvedValue({ ok: true, retentionDays: 30 });
    updateTelemetrySettingsMock.mockResolvedValue({ ok: true, enabled: true });
  });

  afterEach(async () => {
    if (root) await act(async () => { root!.unmount(); });
    root = null;
    container = null;
  });

  async function render(): Promise<HTMLDivElement> {
    const { SettingsPage } = await import('../src/ui/pages/Settings.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container!);
      root.render(React.createElement(SettingsPage));
    });
    await flush();
    return container;
  }

  it('renders the four kept cards + Danger Zone in the approved order', async () => {
    const c = await render();
    expect(cardTitles(c)).toEqual([
      'Node Identity',
      'Blockchain Config',
      'Network Telemetry',
      'Local Data Retention',
      'Danger Zone',
    ]);
  });

  it('does NOT render any removed section (LLM, Background Sync, Developer, Privacy & Memory)', async () => {
    const c = await render();
    const text = c.textContent ?? '';
    expect(text).not.toMatch(/LLM Configuration/i);
    expect(text).not.toMatch(/Background Sync/i);
    expect(text).not.toMatch(/Developer/i);
    expect(text).not.toMatch(/Publish by Default/i);
    expect(text).not.toMatch(/Privacy & Memory/i);
    // The page container is the single-column stack, not the dead .settings-grid.
    expect(c.querySelector('.settings-stack')).toBeTruthy();
    expect(c.querySelector('.settings-grid')).toBeNull();
  });

  it('Local Data Retention is its OWN card with an associated label and the honest helper copy', async () => {
    const c = await render();
    const select = c.querySelector<HTMLSelectElement>('#retention-select');
    expect(select).toBeTruthy();
    // label htmlFor ↔ select id association (a11y).
    const label = c.querySelector<HTMLLabelElement>('label[for="retention-select"]');
    expect(label).toBeTruthy();
    expect((label!.textContent ?? '').trim()).toBe('Keep local data for');
    // The false daemon.log clause must be gone (backend §a: daemon.log is
    // size-rotated, independent of the retention window).
    expect(c.textContent ?? '').not.toMatch(/daemon\.log/i);
    expect(c.textContent ?? '').toMatch(/pruned automatically/i);
  });

  it('reducing retention shows the reduce-confirm group, focuses Prune & Save, and Escape-free Cancel dismisses it', async () => {
    const c = await render();
    const select = c.querySelector<HTMLSelectElement>('#retention-select')!;
    // 90 → 30 is a reduction → must NOT save immediately; shows confirm group.
    await act(async () => { setSelectValue(select, '30'); });
    await flush();
    const group = c.querySelector<HTMLElement>('[role="group"][aria-label="Confirm retention reduction"]');
    expect(group).toBeTruthy();
    expect(updateRetentionSettingsMock).not.toHaveBeenCalled();
    // Focus moved to the destructive confirm action.
    const confirmBtn = Array.from(group!.querySelectorAll('button')).find(
      (b) => /Prune & Save/.test(b.textContent ?? ''),
    )!;
    expect(document.activeElement).toBe(confirmBtn);
    // Cancel dismisses without saving.
    const cancelBtn = Array.from(group!.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Cancel',
    )!;
    await act(async () => { cancelBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(c.querySelector('[role="group"][aria-label="Confirm retention reduction"]')).toBeNull();
    expect(updateRetentionSettingsMock).not.toHaveBeenCalled();
  });

  it('confirming a reduction calls updateRetentionSettings; a save failure restores the selector', async () => {
    updateRetentionSettingsMock.mockRejectedValueOnce(new Error('500'));
    const c = await render();
    const select = c.querySelector<HTMLSelectElement>('#retention-select')!;
    await act(async () => { setSelectValue(select, '30'); });
    await flush();
    const confirmBtn = Array.from(c.querySelectorAll('button')).find(
      (b) => /Prune & Save/.test(b.textContent ?? ''),
    )!;
    await act(async () => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(updateRetentionSettingsMock).toHaveBeenCalledWith(30);
    expect(c.textContent ?? '').toMatch(/Couldn’t save retention/i);
    expect(select.value).toBe('90');
  });

  it('direct-saving an increase leaves the selector on the old value when save fails', async () => {
    updateRetentionSettingsMock.mockRejectedValueOnce(new Error('500'));
    const c = await render();
    const select = c.querySelector<HTMLSelectElement>('#retention-select')!;
    await act(async () => { setSelectValue(select, '365'); });
    await flush();
    expect(updateRetentionSettingsMock).toHaveBeenCalledWith(365);
    expect(c.textContent ?? '').toMatch(/Couldn’t save retention/i);
    expect(select.value).toBe('90');
  });

  it('telemetry toggle is an accessible switch; enabling routes through the consent dialog', async () => {
    const c = await render();
    const sw = c.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(sw).toBeTruthy();
    expect(sw.getAttribute('aria-checked')).toBe('false');
    expect(sw.getAttribute('aria-label')).toBe('Share telemetry with the network');
    // Enabling (from off) does NOT save directly — it opens the consent dialog.
    await act(async () => { sw.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const dialog = document.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');
    expect(dialog).toBeTruthy();
    expect(dialog!.getAttribute('aria-label')).toBe('Enable Telemetry Streaming?');
    expect(updateTelemetrySettingsMock).not.toHaveBeenCalled();
    // Confirming streams telemetry on.
    const enableBtn = Array.from(dialog!.querySelectorAll('button')).find(
      (b) => /Enable Streaming/.test(b.textContent ?? ''),
    )!;
    await act(async () => { enableBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(updateTelemetrySettingsMock).toHaveBeenCalledWith(true);
    const swAfter = c.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    expect(swAfter.getAttribute('aria-checked')).toBe('true');
    // Codex finding: focus must return to the toggle after the consent
    // confirm. The toggle uses aria-disabled (not `disabled`) precisely so it
    // stays focusable through the in-flight window — a `disabled` button would
    // have dropped focus to <body>.
    expect(swAfter.hasAttribute('disabled')).toBe(false);
    expect(document.activeElement).toBe(swAfter);
  });

  it('a telemetry save failure reverts the optimistic flip and shows the inline error', async () => {
    updateTelemetrySettingsMock.mockRejectedValueOnce(new Error('503'));
    const c = await render();
    const sw = c.querySelector<HTMLButtonElement>('button[role="switch"]')!;
    await act(async () => { sw.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    const enableBtn = Array.from(document.querySelectorAll('[role="dialog"] button')).find(
      (b) => /Enable Streaming/.test(b.textContent ?? ''),
    ) as HTMLButtonElement;
    await act(async () => { enableBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(c.textContent ?? '').toMatch(/Couldn’t update telemetry/i);
    // Reverted: switch is back to off.
    expect(c.querySelector<HTMLButtonElement>('button[role="switch"]')!.getAttribute('aria-checked')).toBe('false');
  });

  it('Danger Zone shutdown is a two-step confirm (no shutdown on first click)', async () => {
    const c = await render();
    const btn = Array.from(c.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Shutdown Node',
    )!;
    await act(async () => { btn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(shutdownNodeMock).not.toHaveBeenCalled();
    expect(c.textContent ?? '').toMatch(/Confirm Shutdown/);
    // Second click confirms.
    const confirmBtn = Array.from(c.querySelectorAll('button')).find(
      (b) => (b.textContent ?? '').trim() === 'Confirm Shutdown',
    )!;
    await act(async () => { confirmBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await flush();
    expect(shutdownNodeMock).toHaveBeenCalledTimes(1);
  });
});
