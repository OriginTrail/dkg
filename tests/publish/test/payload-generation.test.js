import assert from 'node:assert/strict';
import test from 'node:test';

process.env.TEST_ENTITY_COUNT = '50';
process.env.TEST_CONTENT_SIZE_KB = '3072';

const {
  FILLER_LITERAL_BODY_BYTES,
  buildQuads,
} = await import('../src/v10-helpers.js');

const DKG_RDF_LITERAL_SAFE_MUTF8_BYTES = 60_000;
const DKG_GOSSIP_MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

test('3 MiB publish payload is real, unique, ordered, and literal-safe', () => {
  const targetBytes = 3 * 1024 * 1024;
  const { quads, rootEntity } = buildQuads('TestNode1', 1);

  const serializedBytes = Buffer.byteLength(JSON.stringify(quads), 'utf8');
  const fillers = quads.filter((quad) => quad.predicate.startsWith('urn:dkg:filler:'));

  assert.ok(fillers.length > 1, 'large payload must be distributed over multiple literals');
  assert.ok(
    targetBytes - serializedBytes < 256,
    `serialized payload must stay at the requested 3 MiB target (got ${serializedBytes} bytes)`,
  );
  assert.ok(serializedBytes <= targetBytes);
  assert.ok(serializedBytes < DKG_GOSSIP_MAX_MESSAGE_BYTES);

  assert.equal(
    new Set(quads.map((quad) => JSON.stringify(quad))).size,
    quads.length,
    'duplicate RDF quads would create a false payload-size signal',
  );
  assert.equal(
    new Set(fillers.map((quad) => quad.predicate)).size,
    fillers.length,
    'every filler chunk must have a unique indexed predicate',
  );

  fillers.forEach((quad, index) => {
    assert.equal(quad.subject, rootEntity, 'filler chunks must remain on the same root KA');
    assert.equal(quad.predicate, `urn:dkg:filler:${String(index).padStart(6, '0')}`);
    assert.ok(
      Buffer.byteLength(quad.object, 'utf8') <= DKG_RDF_LITERAL_SAFE_MUTF8_BYTES,
      'every ASCII filler literal must remain below the DKG safe limit',
    );
  });
});

test('filler chunk body has ample headroom below the DKG literal limit', () => {
  // Two quote bytes are added by literal(), and the generated body is ASCII,
  // for which UTF-8 and Java MUTF-8 sizes are identical.
  assert.ok(FILLER_LITERAL_BODY_BYTES + 2 < DKG_RDF_LITERAL_SAFE_MUTF8_BYTES);
});
