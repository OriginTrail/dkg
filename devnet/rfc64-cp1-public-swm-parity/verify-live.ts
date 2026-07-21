import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { verifyCp1PublicSwmParity } from './verifier.ts';

const path = process.env.DKG_RFC64_CP1_ARTIFACT
  ?? join(import.meta.dirname, 'artifacts/cp1-public-swm-parity.json');
verifyCp1PublicSwmParity(JSON.parse(readFileSync(path, 'utf8')));
process.stdout.write(`[rfc64-cp1] PASS ${path}\n`);

