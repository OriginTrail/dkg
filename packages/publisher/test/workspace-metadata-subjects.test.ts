import { expect, it } from 'vitest';
import { generateShareMetadata } from '../src/metadata.js';
import { formatUncheckedWorkspaceOperationSubject, workspaceOperationSubject } from '../src/workspace-metadata-subjects.js';

it('normalizes identifiers through the canonical checked constructor', () => {
  expect(workspaceOperationSubject(' cg ', ' op ')).toBe('urn:dkg:share:cg:op');
});
it.each([['', 'op'], ['cg', ''], ['cg', ' '], ['cg', 'a b'], ['cg<', 'op'], ['cg', 'a\\b']])(
  'rejects unsafe or empty identifiers %s / %s', (cg, operation) => {
    expect(() => workspaceOperationSubject(cg, operation)).toThrow();
  },
);
it('keeps raw low-level generator formatting explicitly unchecked', () => {
  const subject = formatUncheckedWorkspaceOperationSubject(' cg ', ' op ');
  expect(subject).toBe('urn:dkg:share: cg : op ');
  const rows = generateShareMetadata({ contextGraphId: ' cg ', shareOperationId: ' op ',
    rootEntities: ['urn:root'], publisherPeerId: 'peer', timestamp: new Date(0) }, 'urn:meta');
  expect(rows.every(row => row.subject === subject)).toBe(true);
});
