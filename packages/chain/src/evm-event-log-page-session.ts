import { Contract, ethers, type JsonRpcProvider } from 'ethers';

/** One reachable RPC backend paired with the latest head it reported. */
export type EvmEventLogScanProvider = {
  provider: JsonRpcProvider;
  backendHead: number;
};

type PageResult = {
  logs: ReadonlyArray<ethers.EventLog | ethers.Log>;
  provider: JsonRpcProvider;
};

type PageExecutor = (
  filter: unknown,
  lo: number,
  hi: number,
  scanProviders: ReadonlyArray<EvmEventLogScanProvider>,
  connected: Map<JsonRpcProvider, Contract>,
  preferred?: JsonRpcProvider,
) => Promise<PageResult>;

export interface EvmEventLogPageReader {
  query(filter: unknown, lo: number, hi: number): Promise<ReadonlyArray<ethers.EventLog | ethers.Log>>;
}

/**
 * One paging session owns provider affinity and connected contract bindings.
 * Domain scanners see only a narrow page query and cannot leak RPC internals.
 */
export class EvmEventLogPageSession implements EvmEventLogPageReader {
  private readonly connected = new Map<JsonRpcProvider, Contract>();
  private preferred: JsonRpcProvider | undefined;

  constructor(
    private readonly scanProviders: ReadonlyArray<EvmEventLogScanProvider>,
    private readonly execute: PageExecutor,
  ) {}

  async query(
    filter: unknown,
    lo: number,
    hi: number,
  ): Promise<ReadonlyArray<ethers.EventLog | ethers.Log>> {
    const page = await this.execute(
      filter,
      lo,
      hi,
      this.scanProviders,
      this.connected,
      this.preferred,
    );
    this.preferred = page.provider;
    return page.logs;
  }
}
