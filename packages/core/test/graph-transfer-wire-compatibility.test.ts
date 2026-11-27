import { expect, it } from 'vitest';
import { BULK_GRAPH_KIND, PUBLIC_CHECKPOINT_KIND, encodeBulkGraphFrame, decodeBulkGraphFrames } from '../src/bulk-graph-wire.js';
import { BULK_GRAPH_PROTOCOL } from '../src/bulk-graph-wire.js';
import { PUBLIC_CHECKPOINT_PROTOCOL } from '../src/bulk-graph-transport.js';

it('preserves the version-one final-ack bytes while keeping application and persistence protocols separate', async () => {
  const legacy = Buffer.from('444b473206000000000000070000000900000000', 'hex');
  for (const kind of [BULK_GRAPH_KIND.COMMIT, PUBLIC_CHECKPOINT_KIND.PERSISTED]) {
    expect(Buffer.from(encodeBulkGraphFrame({ kind, index: 7, sequence: 9, payload: new Uint8Array() }))).toEqual(legacy);
  }
  const frames = [];
  for await (const frame of decodeBulkGraphFrames((async function* () { yield legacy; })())) frames.push(frame);
  expect(frames).toEqual([{ kind: 6, index: 7, sequence: 9, payload: new Uint8Array() }]);
  expect(BULK_GRAPH_PROTOCOL).toBe('/dkg/experimental/bulk-graph/1.0.0');
  expect(PUBLIC_CHECKPOINT_PROTOCOL).toBe('/dkg/experimental/public-checkpoint/1.0.0');
});
