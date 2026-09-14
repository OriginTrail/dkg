import { Contract } from 'ethers';
import { EVMChainAdapter } from '../dist/index.js';

// Compile against the published declarations: existing subclasses may still
// mutate individual protected cache slots during the compatibility window.
export class CustomContractAdapter extends EVMChainAdapter {
  seedToken(token: Contract): void {
    this.contracts.token = token;
  }

  clearToken(): void {
    delete this.contracts.token;
  }
}
