// @vitest-environment happy-dom

// Behavioral coverage for the Admin page (keys / operational wallets / PCAs).
// Same happy-dom + react-dom/client createRoot idiom as settings-page.dom.test.ts.
// Mocks the api-client module; asserts rendered DOM + fired mock calls.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';

const fetchCurrentAgentMock = vi.fn();
const fetchOperationalWalletsMock = vi.fn();
const fetchPcasMock = vi.fn();
const fetchPcaContractsMock = vi.fn();
const fetchAgentEncryptionKeysMock = vi.fn();
const addOperationalWalletMock = vi.fn();

vi.mock('../src/ui/api.js', async () => {
  const actual = await vi.importActual<any>('../src/ui/api.js');
  return {
    ...actual,
    fetchCurrentAgent: fetchCurrentAgentMock,
    fetchOperationalWallets: fetchOperationalWalletsMock,
    fetchPcas: fetchPcasMock,
    fetchPcaContracts: fetchPcaContractsMock,
    fetchAgentEncryptionKeys: fetchAgentEncryptionKeysMock,
    addOperationalWallet: addOperationalWalletMock,
  };
});

const PRIMARY = '0x' + '1'.repeat(40);
const EXTERNAL = '0x' + 'e'.repeat(40);

async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

function cardTitles(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll('.card-title')).map((n) => (n.textContent ?? '').trim());
}

function buttonByText(container: HTMLElement, text: string): HTMLButtonElement | undefined {
  return Array.from(container.querySelectorAll('button')).find(
    (b) => (b.textContent ?? '').trim() === text,
  ) as HTMLButtonElement | undefined;
}

describe('AdminPage', () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    fetchCurrentAgentMock.mockResolvedValue({
      agentAddress: '0x' + 'a'.repeat(40),
      agentDid: 'did:dkg:agent:0x' + 'a'.repeat(40),
      name: 'node-agent',
      peerId: 'peer',
      nodeIdentityId: '5',
    });
    fetchOperationalWalletsMock.mockResolvedValue({
      identityId: '5',
      hasProfile: true,
      adminKeyConfigured: true,
      canManage: true,
      wallets: [{ address: PRIMARY, isAdmin: false, isPrimary: true, registered: true }],
    });
    fetchPcasMock.mockResolvedValue({ accounts: [] });
    fetchPcaContractsMock.mockResolvedValue({
      chainId: 31337,
      hubAddress: '0x' + '0'.repeat(40),
      nftAddress: '0x' + 'a'.repeat(40),
      tokenAddress: '0x' + 'b'.repeat(40),
    });
    fetchAgentEncryptionKeysMock.mockResolvedValue({
      agentAddress: '0x' + 'a'.repeat(40),
      agentDid: 'did:dkg:agent:0x' + 'a'.repeat(40),
      keys: [],
    });
    addOperationalWalletMock.mockResolvedValue({ address: EXTERNAL, added: true, txHash: '0xtx', blockNumber: 1 });
  });

  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    container = null;
  });

  async function render(): Promise<HTMLElement> {
    const { AdminPage } = await import('../src/ui/pages/Admin.js');
    container = document.createElement('div');
    document.body.appendChild(container);
    await act(async () => {
      root = createRoot(container!);
      root.render(React.createElement(AdminPage));
    });
    await flush();
    return container;
  }

  it('renders the three management sections and loads data', async () => {
    const c = await render();
    const titles = cardTitles(c);
    expect(titles).toContain('Operational Wallets');
    expect(titles).toContain('Publishing Conviction Accounts');
    expect(titles).toContain('Agent Encryption Keys');
    expect(fetchOperationalWalletsMock).toHaveBeenCalled();
    expect(fetchPcasMock).toHaveBeenCalled();
    // The loaded operational wallet renders (truncated address head is shown).
    expect(c.textContent).toContain('0x11111111');
    expect(c.textContent).toContain('primary');
  });

  it('authorize-wallet flow calls addOperationalWallet with the entered address', async () => {
    const c = await render();

    const openBtn = buttonByText(c, 'Authorize Wallet');
    expect(openBtn).toBeTruthy();
    await act(async () => openBtn!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    const input = c.querySelector('#opw-addr') as HTMLInputElement | null;
    expect(input).toBeTruthy();
    await act(async () => setInputValue(input!, EXTERNAL));
    await flush();

    const submit = buttonByText(c, 'Authorize');
    expect(submit).toBeTruthy();
    expect(submit!.disabled).toBe(false);
    await act(async () => submit!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    await flush();

    expect(addOperationalWalletMock).toHaveBeenCalledWith(EXTERNAL);
  });

  it('disables wallet management when canManage is false', async () => {
    fetchOperationalWalletsMock.mockResolvedValue({
      identityId: '0',
      hasProfile: false,
      adminKeyConfigured: false,
      canManage: false,
      wallets: [{ address: PRIMARY, isAdmin: false, isPrimary: true, registered: null }],
    });
    const c = await render();
    const openBtn = buttonByText(c, 'Authorize Wallet');
    expect(openBtn).toBeTruthy();
    expect(openBtn!.disabled).toBe(true);
  });
});
