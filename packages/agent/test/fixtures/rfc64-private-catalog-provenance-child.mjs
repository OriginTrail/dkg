// SPDX-License-Identifier: Apache-2.0

import { createInterface } from 'node:readline';

import '@origintrail-official/dkg-agent';
import '@origintrail-official/dkg-chain';
import '@origintrail-official/dkg-core';
import '@origintrail-official/dkg-storage';

import { sealGate2ExecutedRuntimeManifestV1 } from '../../../../devnet/rfc64-gate2-multi-asset-completeness/runtime-load-hook.ts';

const marker = 'RFC64_PRIVATE_EVENT ';
const emit = (event, requestId, fields = {}, callback = () => {}) => {
  process.stdout.write(`${marker}${JSON.stringify({
    event,
    role: process.env.DKG_RFC64_PRIVATE_ROLE,
    ...(requestId === undefined ? {} : { requestId }),
    ...fields,
  })}\n`, callback);
};

emit('ready', undefined, {
  runtimeBuildManifestDigest: process.env.DKG_RFC64_GATE2_RUNTIME_MANIFEST_DIGEST,
});

createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.cmd !== 'stop') return;
  emit('stopping', command.requestId, {
    executedRuntimeManifest: sealGate2ExecutedRuntimeManifestV1(),
  }, () => process.exit(0));
});
