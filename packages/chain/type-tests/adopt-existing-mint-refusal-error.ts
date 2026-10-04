import { AdoptExistingMintRefusalError, type AdoptExistingMintRefusalCode } from '../dist/index.js';

declare const caught: unknown;
if (caught instanceof AdoptExistingMintRefusalError) {
  const code: AdoptExistingMintRefusalCode = caught.code;
  const exhaustive = (value: never): never => value;
  switch (code) {
    case 'KA_ID_COLLISION':
    case 'KA_SUPERSEDED':
    case 'KA_CG_MISMATCH':
      break;
    default:
      exhaustive(code);
  }
}

// @ts-expect-error Provider failures are not definitive adoption refusals.
new AdoptExistingMintRefusalError('RPC_UNAVAILABLE', 'provider unavailable');
