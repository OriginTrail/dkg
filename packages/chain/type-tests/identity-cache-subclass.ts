import { EVMChainAdapter } from '../dist/index.js';

// Compile against the published declarations, including inherited protected API.
export class CustomAdapter extends EVMChainAdapter {
  static identityCacheTtls(): readonly [number, number] {
    return [this.IDENTITY_ID_POSITIVE_TTL_MS, this.SIGNER_IDENTITY_ID_ZERO_TTL_MS];
  }
}
