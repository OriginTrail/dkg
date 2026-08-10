import { captureStructuredMutationSnapshot } from '../src/index.js';

const snapshot = captureStructuredMutationSnapshot({
  kind: 'replace-subject-predicates',
  input: {
    graphUri: 'urn:test:graph',
    subject: 'urn:test:subject',
    predicates: ['urn:test:predicate'],
    replacementQuads: [{
      subject: 'urn:test:subject',
      predicate: 'urn:test:predicate',
      object: '"value"',
      graph: 'urn:test:graph',
    }],
  },
});

if (snapshot.mutation.kind === 'replace-subject-predicates') {
  // @ts-expect-error snapshot input fields are immutable
  snapshot.mutation.input.graphUri = 'urn:test:redirected';
  // @ts-expect-error snapshot arrays are immutable
  snapshot.mutation.input.predicates[0] = 'urn:test:redirected';
  // @ts-expect-error snapshot quad fields are immutable
  snapshot.mutation.input.replacementQuads[0].object = '"redirected"';
  // @ts-expect-error snapshot arrays cannot be extended
  snapshot.mutation.input.replacementQuads.push({
    subject: 'urn:test:subject',
    predicate: 'urn:test:predicate',
    object: '"extra"',
    graph: 'urn:test:graph',
  });
}

// @ts-expect-error snapshot mutation tags are immutable
snapshot.mutation.kind = 'delete-subjects';
