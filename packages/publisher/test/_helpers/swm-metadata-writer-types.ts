import {
  emitLegacySwmOperation, emitSwmHead, emitSwmPublicSlice, emitSwmOwnership,
  SWM_WORKSPACE_OPERATION, type SwmHeadTerms, type LegacySwmOperationTerms, type SwmPublicSliceTerms,
} from '../../src/index.js';
import { emitGraphSwmOperationHeader, emitGraphSwmSnapshotFragment } from '../../src/swm-metadata-schema.js';
// @ts-expect-error Incremental graph-operation fragments are internal to the publisher.
import { emitGraphSwmSnapshotFragment as publicFragment } from '../../src/index.js';
// @ts-expect-error An operation header is not a complete public record builder.
import { emitGraphSwmOperationHeader as publicHeader } from '../../src/index.js';
void publicFragment;
void publicHeader;

const head: SwmHeadTerms = {
  contentScopeVersion: '"2"', kaUal: 'urn:ka', assertionVersion: '"1"', assertionGraph: 'urn:graph', shareOperationId: '"op"',
};
const operation: LegacySwmOperationTerms = {
  type: SWM_WORKSPACE_OPERATION, contextGraphId: '"cg"', shareOperationId: '"op"',
  publisherPeerId: '"peer"', wasAttributedTo: '"peer"', publishedAt: '"time"', rootEntity: ['urn:root'],
};
const slice: SwmPublicSliceTerms = {
  contextGraphId: '"cg"', shareOperationId: '"op"', publisherPeerId: '"peer"', wasAttributedTo: '"peer"', publishedAt: '"time"',
  publicSliceRootEntity: 'urn:root', publicQuadsDigest: '"sha256:digest"', publicQuadsCount: '"1"',
};
emitSwmHead('urn:head', 'urn:meta', head);
emitLegacySwmOperation('urn:op', 'urn:meta', operation);
emitSwmPublicSlice('urn:slice', 'urn:meta', slice);
emitSwmOwnership('urn:root', 'urn:meta', { workspaceOwner: '"peer"' });

// @ts-expect-error A head requires its complete identity/version envelope.
emitSwmHead('urn:head', 'urn:meta', {});
// @ts-expect-error shareOperationId is singular, including on a complete head.
emitSwmHead('urn:head', 'urn:meta', { ...head, shareOperationId: ['"one"', '"two"'] });
// @ts-expect-error Ownership controls are not head fields.
emitSwmHead('urn:head', 'urn:meta', { ...head, workspaceOwner: '"peer"' });
// @ts-expect-error Legacy operations must state their repeated root members.
emitLegacySwmOperation('urn:op', 'urn:meta', { type: SWM_WORKSPACE_OPERATION, contextGraphId: '"cg"' });
// @ts-expect-error A repeated field cannot be emitted as an ambiguous scalar.
emitLegacySwmOperation('urn:op', 'urn:meta', { ...operation, rootEntity: 'urn:root' });
const historicalMember = { ...operation, entity: 'urn:root' };
// @ts-expect-error Historical fields are forbidden even on an existing variable.
emitLegacySwmOperation('urn:op', 'urn:meta', historicalMember);
// @ts-expect-error Snapshot slices require their commitment and identity envelope.
emitSwmPublicSlice('urn:slice', 'urn:meta', { publicSliceRootEntity: 'urn:root' });
// @ts-expect-error A snapshot root is singular.
emitSwmPublicSlice('urn:slice', 'urn:meta', { ...slice, publicSliceRootEntity: ['urn:root'] });
// @ts-expect-error Inline payloads are read-only compatibility fields.
emitSwmPublicSlice('urn:slice', 'urn:meta', { ...slice, publicStagedQuads: '"[]"' });
// @ts-expect-error Current snapshot writers use their digest as the store reference.
emitSwmPublicSlice('urn:slice', 'urn:meta', { ...slice, publicSnapshotRef: '"old-ref"' });
// @ts-expect-error Ownership requires its dedicated peer field.
emitSwmOwnership('urn:root', 'urn:meta', {});
// @ts-expect-error Ownership is singular.
emitSwmOwnership('urn:root', 'urn:meta', { workspaceOwner: ['"one"', '"two"'] });
// @ts-expect-error Current ownership writers do not emit legacy attribution rows.
emitSwmOwnership('urn:root', 'urn:meta', { workspaceOwner: '"peer"', wasAttributedTo: '"legacy"' });

const { rootEntity: _roots, ...common } = operation;
const header = { ...common, contentScopeVersion: head.contentScopeVersion, kaUal: head.kaUal, assertionVersion: head.assertionVersion, publicQuadsCount: '"1"', privateTripleCount: '"0"' };
emitGraphSwmOperationHeader('urn:op', 'urn:meta', { ...header, allowedPeer: ['"peer"'] });
// @ts-expect-error A header requires public and private counts.
emitGraphSwmOperationHeader('urn:op', 'urn:meta', common);
// @ts-expect-error Allowed peers are repeated; publisherPeerId remains singular.
emitGraphSwmOperationHeader('urn:op', 'urn:meta', { ...header, publisherPeerId: ['"peer"'] });
// @ts-expect-error Repeated peer fields cannot be written as a scalar.
emitGraphSwmOperationHeader('urn:op', 'urn:meta', { ...header, allowedPeer: '"peer"' });
emitGraphSwmSnapshotFragment('urn:op', 'urn:meta', { publicQuadsDigest: '"sha256:digest"' });
// @ts-expect-error Even an internal snapshot fragment requires its digest.
emitGraphSwmSnapshotFragment('urn:op', 'urn:meta', {});
// @ts-expect-error Fragments cannot reintroduce historical snapshot references.
emitGraphSwmSnapshotFragment('urn:op', 'urn:meta', { publicQuadsDigest: '"sha256:digest"', publicSnapshotRef: '"old-ref"' });
