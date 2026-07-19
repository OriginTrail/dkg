import assert from 'node:assert/strict';
import { test } from 'node:test';

import { canonicalDocument } from '../src/canonical.ts';
import { generateConsistentEvidence } from '../src/generate.ts';
import {
  GATE1_CHECK_KEYS,
  parseRawEvidence,
  type Gate1ChecksV1,
  type RawEvidenceV1,
} from '../src/schema.ts';
import { verifyEvidence } from '../src/verify.ts';

const COUNT = 6;

/** Deep structural clone via JSON, so mutations cannot alias the frozen source. */
function mutableEvidence(): Record<string, any> {
  return JSON.parse(JSON.stringify(generateConsistentEvidence(COUNT)));
}

/**
 * The core mutation assertion: apply `mutate`, then require that the artifact
 * STILL PARSES (so the failure is the targeted invariant, not a schema
 * rejection), that the fixture is rejected, and that `check` specifically
 * flipped to false.
 *
 * It deliberately does NOT assert that every other check stayed true: some
 * mutations legitimately trip more than one invariant (splicing a duplicate
 * quad also changes the array length, so `quadsUnique` and `quadCountExact`
 * both fail). The teeth come from pinning the TARGETED check — verified by
 * mutating the verifier itself, where neutering any single check fails the
 * tests that pin it.
 */
function expectCheckFails(check: keyof Gate1ChecksV1, mutate: (doc: any) => void): void {
  const doc = mutableEvidence();
  mutate(doc);
  assert.notEqual(
    parseRawEvidence(doc),
    undefined,
    `mutation for ${check} must still parse structurally, otherwise it proves nothing`,
  );
  const verdict = verifyEvidence(doc);
  assert.equal(verdict.fixtureConsistent, false, `${check}: mutated fixture must be rejected`);
  assert.equal(verdict.checks[check], false, `${check}: the targeted check must be false`);
  assert.ok(
    verdict.rejectReasons.length > 0,
    `${check}: a rejection must carry at least one reason`,
  );
  // The boundary markers are stamped by the verifier and can never be flipped.
  assert.equal(verdict.productBoundary, 'not-connected');
  assert.equal(verdict.gateEvaluation, 'not-evaluated');
}

test('a generated fixture is internally consistent and every check passes', () => {
  const verdict = verifyEvidence(generateConsistentEvidence(COUNT));
  assert.equal(verdict.fixtureConsistent, true, JSON.stringify(verdict.rejectReasons));
  for (const key of GATE1_CHECK_KEYS) {
    assert.equal(verdict.checks[key], true, `check ${key} must pass on a clean fixture`);
  }
  assert.deepEqual(verdict.rejectReasons, []);
});

test('the verifier stamps the boundary markers itself and never trusts input', () => {
  const doc = mutableEvidence();
  // A doctored artifact claiming a real evaluation must not parse at all...
  doc.productBoundary = 'connected';
  doc.gateEvaluation = 'passed';
  assert.equal(parseRawEvidence(doc), undefined);
  const verdict = verifyEvidence(doc);
  // ...and the verdict it yields still carries the honest markers.
  assert.equal(verdict.productBoundary, 'not-connected');
  assert.equal(verdict.gateEvaluation, 'not-evaluated');
  assert.equal(verdict.fixtureConsistent, false);
  assert.equal(verdict.checks.schemaWellFormed, false);
});

test('the verifier is fail-closed on arbitrary input and never throws', () => {
  for (const bad of [undefined, null, 0, '', 'x', [], {}, { schema: 'other' }, Object.create(null)]) {
    const verdict = verifyEvidence(bad);
    assert.equal(verdict.fixtureConsistent, false);
    assert.equal(verdict.checks.schemaWellFormed, false);
    for (const key of GATE1_CHECK_KEYS) assert.equal(verdict.checks[key], false);
  }
});

// --- dimension 1: peer IDs -------------------------------------------------

test('rejects an empty producer peer id', () => {
  // peerIdsPresent is structurally guarded too; assert via the parse boundary.
  const doc = mutableEvidence();
  doc.producer.peerId = '';
  assert.equal(parseRawEvidence(doc), undefined);
  assert.equal(verifyEvidence(doc).checks.peerIdsPresent, false);
});

test('rejects a single-process fixture where both peers are the same', () => {
  expectCheckFails('peerIdsDistinct', (doc) => {
    doc.receiver.peerId = doc.producer.peerId;
  });
});

test('rejects a forged-author peer that is really the producer', () => {
  expectCheckFails('forgedAuthorPeerDistinct', (doc) => {
    doc.receiver.forgedAuthorAttempt.forgedAuthorPeerId = doc.producer.peerId;
  });
});

// --- dimension 2: UAL ------------------------------------------------------

test('rejects a non-canonical UAL', () => {
  expectCheckFails('ualCanonical', (doc) => {
    // Checksummed (non-lowercase) address: a real-looking but non-canonical UAL.
    doc.producer.ual = 'did:dkg:base:8453/0x2222222222222222222222222222222222222222/042';
    doc.receiver.appliedInventory.ual = doc.producer.ual;
  });
});

// --- dimension 3: exact quad set and count --------------------------------

test('rejects a complete but misordered quad set', () => {
  expectCheckFails('quadsCanonicalOrder', (doc) => {
    const quads = doc.producer.quads;
    [quads[0], quads[1]] = [quads[1], quads[0]];
  });
});

test('rejects duplicate quads on the raw array before any set collapse', () => {
  expectCheckFails('quadsUnique', (doc) => {
    // Duplicate in place so canonical order is preserved and only uniqueness
    // (plus the derived count) is under test.
    doc.producer.quads.splice(1, 0, JSON.parse(JSON.stringify(doc.producer.quads[0])));
  });
});

test('rejects a declared quadCount that disagrees with the array', () => {
  expectCheckFails('quadCountExact', (doc) => {
    doc.producer.quadCount = COUNT + 1;
  });
});

// --- dimension 4: head / row / bundle / content digests --------------------

test('rejects a declared contentDigest that does not match the recomputed one', () => {
  expectCheckFails('contentDigestMatches', (doc) => {
    doc.producer.contentDigest = 'a'.repeat(64);
  });
});

test('rejects a declared bundleDigest that does not match the recomputed one', () => {
  expectCheckFails('bundleDigestMatches', (doc) => {
    doc.producer.bundleDigest = 'b'.repeat(64);
  });
});

test('rejects a declared rowDigest that does not match the recomputed one', () => {
  expectCheckFails('rowDigestMatches', (doc) => {
    doc.producer.rowDigest = 'c'.repeat(64);
  });
});

test('rejects a declared headDigest that does not match the recomputed one', () => {
  expectCheckFails('headDigestMatches', (doc) => {
    doc.producer.headDigest = 'd'.repeat(64);
  });
});

test('a changed quad body invalidates the whole recomputed digest chain', () => {
  // Proves the digests genuinely bind the content: mutate one object term and
  // every downstream declared digest must fall out of agreement at once.
  const doc = mutableEvidence();
  doc.producer.quads[0].object = '"999"^^http://www.w3.org/2001/XMLSchema#integer';
  const verdict = verifyEvidence(doc);
  assert.equal(verdict.fixtureConsistent, false);
  assert.equal(verdict.checks.contentDigestMatches, false);
  assert.equal(verdict.checks.bundleDigestMatches, false);
  assert.equal(verdict.checks.rowDigestMatches, false);
  assert.equal(verdict.checks.headDigestMatches, false);
});

test('a replayed row at a different sequence changes the head digest', () => {
  expectCheckFails('headDigestMatches', (doc) => {
    doc.producer.headSequence = 2;
    doc.receiver.appliedInventory.headSequence = 2;
  });
});

test('bundleLength is bound into the bundle digest', () => {
  expectCheckFails('bundleDigestMatches', (doc) => {
    doc.producer.bundleLength = doc.producer.bundleLength + 1;
  });
});

// --- dimension 5: applied inventory readback ------------------------------

test('rejects a receiver readback that disagrees with the producer head', () => {
  expectCheckFails('appliedInventoryMatchesProducer', (doc) => {
    doc.receiver.appliedInventory.headDigest = 'e'.repeat(64);
  });
});

test('rejects a receiver readback with the wrong quad count', () => {
  expectCheckFails('appliedInventoryMatchesProducer', (doc) => {
    doc.receiver.appliedInventory.quadCount = COUNT - 1;
  });
});

test('rejects a receiver that applied no row at all', () => {
  expectCheckFails('appliedRowCountExact', (doc) => {
    doc.receiver.appliedInventory.appliedRowCount = 0;
    // Keep the restart record self-consistent so ONLY the readback count fails.
    doc.receiver.restartRepair.appliedRowCountBeforeRestart = 0;
    doc.receiver.restartRepair.appliedRowCountAfterRestart = 0;
  });
});

test('a receiver colluding with a forged producer digest is still rejected', () => {
  // Both sides agree, but they agree on a value that is not the recomputed one:
  // cross-peer agreement alone must never satisfy the verifier.
  const doc = mutableEvidence();
  const forgedContent = 'f'.repeat(64);
  doc.producer.contentDigest = forgedContent;
  doc.receiver.appliedInventory.contentDigest = forgedContent;
  const verdict = verifyEvidence(doc);
  assert.equal(verdict.fixtureConsistent, false);
  assert.equal(verdict.checks.contentDigestMatches, false);
  assert.equal(verdict.checks.appliedInventoryMatchesProducer, false);
});

// --- dimension 6: forged-author zero activation ---------------------------

test('rejects a forged author that activated a row', () => {
  expectCheckFails('forgedAuthorZeroActivation', (doc) => {
    doc.receiver.forgedAuthorAttempt.activatedRowCount = 1;
  });
});

test('rejects a forged author that staged a bundle', () => {
  expectCheckFails('forgedAuthorZeroActivation', (doc) => {
    doc.receiver.forgedAuthorAttempt.stagedBundleCount = 1;
  });
});

test('rejects a forged-author rejection with no rejection code', () => {
  const doc = mutableEvidence();
  doc.receiver.forgedAuthorAttempt.rejectionCode = '';
  // An empty code is structurally invalid; assert the fail-closed disposition.
  assert.equal(parseRawEvidence(doc), undefined);
  assert.equal(verifyEvidence(doc).fixtureConsistent, false);
});

test('rejects a forged-author attempt that moved the applied head', () => {
  expectCheckFails('forgedAuthorHeadUnchanged', (doc) => {
    doc.receiver.forgedAuthorAttempt.appliedHeadDigestAfter = '1'.repeat(64);
  });
});

test('rejects a forged-author record that holds steady at the wrong head', () => {
  // Before === after, but pinned to a head that is not the applied one.
  expectCheckFails('forgedAuthorHeadUnchanged', (doc) => {
    const wrong = '2'.repeat(64);
    doc.receiver.forgedAuthorAttempt.appliedHeadDigestBefore = wrong;
    doc.receiver.forgedAuthorAttempt.appliedHeadDigestAfter = wrong;
  });
});

// --- dimension 7: restart repair ------------------------------------------

test('rejects a restart that recovered to a different head', () => {
  expectCheckFails('restartHeadStable', (doc) => {
    doc.receiver.restartRepair.appliedHeadDigestAfterRestart = '3'.repeat(64);
  });
});

test('rejects a restart that holds steady at the wrong head', () => {
  expectCheckFails('restartHeadStable', (doc) => {
    const wrong = '4'.repeat(64);
    doc.receiver.restartRepair.appliedHeadDigestBeforeRestart = wrong;
    doc.receiver.restartRepair.appliedHeadDigestAfterRestart = wrong;
  });
});

test('rejects a restart that double-applied the row', () => {
  expectCheckFails('restartNoDoubleApply', (doc) => {
    doc.receiver.restartRepair.appliedRowCountAfterRestart = 2;
  });
});

test('rejects a restart that lost quads', () => {
  expectCheckFails('restartQuadCountStable', (doc) => {
    doc.receiver.restartRepair.quadCountAfterRestart = COUNT - 1;
  });
});

test('rejects a restart that duplicated quads', () => {
  expectCheckFails('restartQuadCountStable', (doc) => {
    doc.receiver.restartRepair.quadCountAfterRestart = COUNT * 2;
  });
});

// --- determinism -----------------------------------------------------------

test('generation is a pure function of the quad count', () => {
  const first = canonicalDocument(generateConsistentEvidence(COUNT));
  const second = canonicalDocument(generateConsistentEvidence(COUNT));
  assert.equal(first, second);
  assert.notEqual(first, canonicalDocument(generateConsistentEvidence(COUNT + 1)));
  assert.ok(first.endsWith('}\n'), 'canonical document ends with exactly one trailing LF');
  assert.equal(first.indexOf('\n'), first.length - 1, 'no interior newlines');
});

test('a canonical document round-trips through parse and verify unchanged', () => {
  const evidence: RawEvidenceV1 = generateConsistentEvidence(COUNT);
  const roundTripped = JSON.parse(canonicalDocument(evidence));
  assert.equal(verifyEvidence(roundTripped).fixtureConsistent, true);
  assert.deepEqual(parseRawEvidence(roundTripped), parseRawEvidence(evidence));
});

test('the check list is closed and fixtureConsistent is derived from all of it', () => {
  // Guards against a check being added to the type but silently left out of the
  // conjunction that decides the verdict.
  const verdict = verifyEvidence(generateConsistentEvidence(COUNT));
  assert.equal(Object.keys(verdict.checks).length, GATE1_CHECK_KEYS.length);
  assert.deepEqual(Object.keys(verdict.checks).sort(), [...GATE1_CHECK_KEYS].sort());
});
