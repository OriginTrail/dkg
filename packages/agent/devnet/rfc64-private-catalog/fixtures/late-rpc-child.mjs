// SPDX-License-Identifier: Apache-2.0

import { createInterface } from 'node:readline';

const role = process.env.DKG_RFC64_PRIVATE_ROLE ?? 'late-rpc';

function emit(event, requestId, fields = {}, callback) {
  process.stdout.write(`RFC64_PRIVATE_EVENT ${JSON.stringify({
    event,
    role,
    ...(requestId === undefined ? {} : { requestId }),
    ...fields,
  })}\n`, callback);
}

emit('ready');
createInterface({ input: process.stdin }).on('line', (line) => {
  const command = JSON.parse(line);
  if (command.cmd === 'inspect') {
    emit('inspection', command.requestId, { rpcCallCounts: {} });
    return;
  }
  if (command.cmd === 'stop') {
    emit('stopping', command.requestId, {
      executedRuntimeManifest: {},
      rpcCallCounts: { eth_call: 97 },
    }, () => process.exit(0));
  }
});
