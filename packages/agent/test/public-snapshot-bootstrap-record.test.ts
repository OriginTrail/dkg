import { expect, it } from 'vitest';
import { decodeSnapshotBootstrapRecord, encodeSnapshotBootstrapRecord, type SnapshotBootstrapRecord } from '../src/snapshot-bootstrap-record.js';

const record: SnapshotBootstrapRecord = { version: 1, chainId: 'base:84532', deploymentId: 'test',
  contextGraphId: 'graph', onChainId: '14', mode: 'rpc-only', initialJournalSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64),
  result: { current: true, completeAsOfSnapshot: true, assets: 3, committed: 3, inventoryDigest: 'c'.repeat(64) } };
it('shares the durable contract and accepts previous full runtime reports', () => {
  expect(decodeSnapshotBootstrapRecord(JSON.parse(encodeSnapshotBootstrapRecord(record)))).toEqual(record);
  expect(decodeSnapshotBootstrapRecord({ ...record, result: { ...record.result, alreadyPresent: 3, elapsedMs: 10 } })).toEqual(record);
});
it.each([null, [], {}, { ...record, version: 2 }, { ...record, mode: 'unverified' },
  { ...record, initialJournalSha256: false }, { ...record, chainId: 123 },
  ...[{ current: false }, { completeAsOfSnapshot: false }, { assets: -1 }, { committed: 4 }, { assets: 1.5 }, { inventoryDigest: null }]
    .map(change => ({ ...record, result: { ...record.result, ...change } })),
])('rejects malformed or incomplete completion evidence %#', value => {
  expect(() => decodeSnapshotBootstrapRecord(value)).toThrow('binding mismatch');
});
