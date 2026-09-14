import { EVMChainAdapter } from '../dist/index.js';

// Compile against the published declarations: subclasses can inspect a
// read-only binding snapshot, but cannot split installation across mutations.
export class CustomContractAdapter extends EVMChainAdapter {
  hasToken(): boolean {
    return this.contracts.token !== undefined;
  }

  mutationIsRejected(): void {
    // @ts-expect-error Hub bindings are getter-only and must be installed atomically.
    this.contracts.token = this.contracts.hub;
  }
}
