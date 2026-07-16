// Scriptable mock EIP-6963 / EIP-1193 provider — the gating dependency for the HW unit + e2e tests
// (#5). A real static-test-key provider auto-signs and never prompts/rejects/switches, so it can't
// cover the device-specific safety states; this mock can: auto-respond, reject (4001), emit
// accountsChanged/chainChanged/disconnect mid-flow, and stub eth_sendTransaction. NOT shipped (test/).

import type {
  Eip1193Provider,
  Eip6963ProviderDetail,
  Eip6963ProviderInfo,
} from '../../src/ui/web3/eip6963.js';

export interface MockProviderOptions {
  accounts?: `0x${string}`[];
  /** Numeric chain id (serialized to hex for eth_chainId). */
  chainId?: number;
  rdns?: string;
  name?: string;
  /** Return true for a method to make it reject with EIP-1193 code 4001 (user rejected). */
  rejectRequest?: (method: string) => boolean;
  /** Per-method response overrides (win over the built-in defaults). */
  handlers?: Record<string, (params?: unknown) => Promise<unknown> | unknown>;
}

let mockProviderSequence = 0;

class UserRejected extends Error {
  readonly code = 4001;
  constructor(method: string) {
    super(`User rejected ${method}`);
    this.name = 'UserRejectedRequestError';
  }
}

export class MockEip6963Provider implements Eip1193Provider {
  accounts: `0x${string}`[];
  chainId: number;
  readonly info: Eip6963ProviderInfo;
  private readonly opts: MockProviderOptions;
  private readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();
  /** Every request() method that came through — handy for ordering assertions (e.g. inv-16). */
  readonly calls: string[] = [];

  constructor(opts: MockProviderOptions = {}) {
    this.opts = opts;
    this.accounts = opts.accounts ?? ['0x1111111111111111111111111111111111111111'];
    this.chainId = opts.chainId ?? 84532;
    mockProviderSequence += 1;
    this.info = {
      uuid: `mock-${opts.rdns ?? 'io.mock'}-${mockProviderSequence.toString(36)}`,
      name: opts.name ?? 'Mock Wallet',
      icon: 'data:,',
      rdns: opts.rdns ?? 'io.mock',
    };
  }

  async request(args: { method: string; params?: unknown[] | object }): Promise<unknown> {
    const { method, params } = args;
    this.calls.push(method);
    if (this.opts.rejectRequest?.(method)) throw new UserRejected(method);
    const override = this.opts.handlers?.[method];
    if (override) return override(params);
    switch (method) {
      case 'eth_requestAccounts':
      case 'eth_accounts':
        return this.accounts;
      case 'eth_chainId':
        return `0x${this.chainId.toString(16)}`;
      case 'eth_sendTransaction':
        return '0xmocktxhash000000000000000000000000000000000000000000000000000000';
      case 'wallet_switchEthereumChain': {
        const target = (params as [{ chainId: string }])?.[0]?.chainId;
        if (target) this.setChainId(parseInt(target, 16));
        return null;
      }
      default:
        throw new Error(`Mock provider: unhandled method "${method}"`);
    }
  }

  on(event: string, handler: (...args: unknown[]) => void): void {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event)!.add(handler);
  }

  removeListener(event: string, handler: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(handler);
  }

  /** Fire an EIP-1193 event to all bound handlers (drives mid-flow switch/disconnect tests). */
  emit(event: string, ...args: unknown[]): void {
    for (const fn of this.listeners.get(event) ?? []) fn(...args);
  }

  /** Simulate the user switching accounts in their wallet ([] = disconnect-all). */
  setAccounts(accounts: `0x${string}`[]): void {
    this.accounts = accounts;
    this.emit('accountsChanged', accounts);
  }

  /** Simulate the user switching networks in their wallet. */
  setChainId(chainId: number): void {
    this.chainId = chainId;
    this.emit('chainChanged', `0x${chainId.toString(16)}`);
  }

  detail(): Eip6963ProviderDetail {
    return { info: this.info, provider: this };
  }

  /** Broadcast this provider via EIP-6963 so the discovery layer picks it up. */
  announce(): void {
    window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: this.detail() }));
  }
}
