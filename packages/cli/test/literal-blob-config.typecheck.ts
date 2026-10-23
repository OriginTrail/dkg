import type { DkgConfig, LargeLiteralStorageConfig } from '../src/config.js';
import type { LargeLiteralStorageConfig as CanonicalBlobConfig } from '@origintrail-official/dkg-storage';
const selected: Pick<DkgConfig, 'largeLiteralStorage'> = { largeLiteralStorage: { persistence: 'sqlite-wal' } };
const canonical: CanonicalBlobConfig = selected.largeLiteralStorage ?? {};
const compatible: LargeLiteralStorageConfig = canonical;
// @ts-expect-error Unsupported physical layouts remain rejected at the typed boundary.
const invalid: Pick<DkgConfig, 'largeLiteralStorage'> = { largeLiteralStorage: { persistence: 'sqlite' } };
void [compatible, invalid];
