import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertKaMatches, assertListContains } from '../lib/assertions.mjs';
import { pollUntilFinalized } from '../lib/poll.mjs';
const UAL = 'did:dkg:31337:0xfeed/123/0';
const body = { name: 'demo-stream', kafkaBootstrapUrl: 'kafka://broker:9092', kafkaTopicName: 'demo-topic' };
const ka = {
  '@id': UAL,
  '@type': 'dkg-streams:KafkaStream',
  'schema:name': body.name,
  'dkg-streams:kafkaBootstrapUrl': body.kafkaBootstrapUrl,
  'dkg-streams:kafkaTopicName': body.kafkaTopicName,
};
test('demo KA/list assertions validate the expected KafkaStream shape', () => {
  assert.doesNotThrow(() => assertKaMatches(ka, { ual: UAL, body }));
  assert.doesNotThrow(() => assertKaMatches({ ...ka, '@type': ['dkg-streams:KafkaStream', 'vendor:Stream'] }, { ual: UAL, body }));
  assert.doesNotThrow(() => assertListContains({ items: [{ '@id': UAL }] }, UAL));
  assert.throws(() => assertKaMatches({ ...ka, '@type': 'foo:Bar' }, { ual: UAL, body }), /@type/);
  assert.throws(() => assertListContains({ items: [] }, UAL), /not present/);
});
test('pollUntilFinalized handles terminal success and failure states', async () => {
  const ok = await pollUntilFinalized(async () => ({ state: 'finalized', ual: UAL }), { intervalMs: 1 });
  assert.deepEqual(ok, { state: 'finalized', ual: UAL });
  await assert.rejects(
    pollUntilFinalized(async () => ({ state: 'failed', error: 'boom' }), { intervalMs: 1 }),
    /failed.*boom/,
  );
});
