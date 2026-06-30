import type { Quad } from '@origintrail-official/dkg-storage';
import type { LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import { normalizeLiftPublishInput } from './async-lift-publish-input.js';
import type {
  LiftJobValidationMetadata,
  LiftPublishRequestMetadata,
  LiftPublishSnapshotRequest,
  LiftRequest,
} from './lift-job.js';

export interface LiftValidationInput {
  readonly request: LiftPublishSnapshotRequest;
  readonly metadata?: LiftPublishRequestMetadata;
  readonly resolved: LiftResolvedPublishSlice;
}

export interface ValidatedLiftPublishPayload {
  readonly validation: LiftJobValidationMetadata;
  readonly resolved: LiftResolvedPublishSlice;
}

export function validateLiftPublishPayload(input: LiftValidationInput): ValidatedLiftPublishPayload {
  const { metadata } = normalizeLiftPublishInput(input, 'Lift validation');
  const authorityProofRef = metadata.authority.proofRef.trim();
  if (authorityProofRef.length === 0) {
    throw new Error('Lift validation requires a non-empty authority proof reference');
  }

  const priorVersion = normalizePriorVersion(input.request.priorVersion);
  validatePriorVersion(metadata.transitionType, priorVersion);

  const requestedRoots = normalizeRoots(input.request.roots);
  if (requestedRoots.length === 0) {
    throw new Error('Lift validation requires at least one valid root');
  }

  const swmQuadCount = input.resolved.quads.length + (input.resolved.privateQuads?.length ?? 0);
  if (swmQuadCount === 0) {
    throw new Error('Lift validation requires at least one resolved shared-memory quad');
  }

  assertSubjectsBelongToRoots(input.resolved.quads, requestedRoots);
  assertSubjectsBelongToRoots(input.resolved.privateQuads ?? [], requestedRoots);

  const canonicalRootMap = Object.fromEntries(requestedRoots.map((root) => [root, canonicalRootIri(input.request, root)]));
  assertNoCanonicalRootCollisions(canonicalRootMap);
  const canonicalRoots = requestedRoots.map((root) => canonicalRootMap[root] as string);

  const resolved: LiftResolvedPublishSlice = {
    ...input.resolved,
    quads: canonicalizeQuads(input.resolved.quads, canonicalRootMap),
    privateQuads: input.resolved.privateQuads
      ? canonicalizeQuads(input.resolved.privateQuads, canonicalRootMap)
      : undefined,
  };

  return {
    validation: {
      canonicalRoots,
      canonicalRootMap,
      swmQuadCount,
      authorityProofRef,
      transitionType: metadata.transitionType,
      priorVersion,
    },
    resolved,
  };
}

function validatePriorVersion(transitionType: LiftRequest['transitionType'], priorVersion?: string): void {
  if (transitionType === 'CREATE' && priorVersion) {
    throw new Error('Lift validation rejects priorVersion for CREATE transitions');
  }

  if ((transitionType === 'MUTATE' || transitionType === 'REVOKE') && !priorVersion) {
    throw new Error(`Lift validation requires priorVersion for ${transitionType} transitions`);
  }
}

function canonicalizeQuads(quads: readonly Quad[], canonicalRootMap: Record<string, string>): Quad[] {
  return quads.map((quad) => ({
    ...quad,
    subject: canonicalizeTerm(quad.subject, canonicalRootMap),
    object: canonicalizeObject(quad.object, canonicalRootMap),
  }));
}

function canonicalizeObject(object: string, canonicalRootMap: Record<string, string>): string {
  if (object.startsWith('"')) {
    return object;
  }
  return canonicalizeTerm(object, canonicalRootMap);
}

function canonicalizeTerm(term: string, canonicalRootMap: Record<string, string>): string {
  for (const [root, canonicalRoot] of Object.entries(canonicalRootMap)) {
    if (term === root) {
      return canonicalRoot;
    }
    const skolemPrefix = `${root}/.well-known/genid/`;
    if (term.startsWith(skolemPrefix)) {
      return `${canonicalRoot}${term.slice(root.length)}`;
    }
  }
  return term;
}

/**
 * GH #1122 — async/sync publish root-canonicalization parity.
 *
 * The async lift used to rewrite caller-provided root IRIs to a generated
 * `dkg:<cg>:<ns>:<scope>/<name>-<hash>` form, while the SYNCHRONOUS publish path
 * (`canonicalPublishPayload` → `skolemizeByEntity`) keeps the caller's
 * `rootEntity` IRIs verbatim and stores private data at that caller root. That
 * divergence broke stable IRI linking: the same domain payload produced
 * different RDF subjects depending on sync vs async, so VM graphs rendered
 * disconnected and integrations couldn't follow caller-IRI references.
 *
 * The fix is parity: the async lift now PRESERVES the caller root IRI (identity)
 * exactly like sync. Because every downstream consumer reads
 * `validation.canonicalRootMap` symmetrically, an identity map propagates
 * cleanly — quad rewriting becomes a no-op, private data is stored at the caller
 * root, and the canonical-vs-source `privateDataAnchor` bridge (an async-only
 * artifact of the old rewrite that sync never created) is correctly skipped.
 */
export function canonicalRootIri(_request: LiftPublishSnapshotRequest, root: string): string {
  return root;
}

function normalizeRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => root.trim()).filter(Boolean))];
}

function normalizePriorVersion(priorVersion: string | undefined): string | undefined {
  const normalized = priorVersion?.trim();
  return normalized ? normalized : undefined;
}

function assertSubjectsBelongToRoots(quads: readonly Quad[], roots: readonly string[]): void {
  for (const quad of quads) {
    if (isRootOrSkolemDescendant(quad.subject, roots)) {
      continue;
    }
    throw new Error(`Lift validation found subject outside requested roots: ${quad.subject}`);
  }
}

function isRootOrSkolemDescendant(subject: string, roots: readonly string[]): boolean {
  return roots.some((root) => subject === root || subject.startsWith(`${root}/.well-known/genid/`));
}

function assertNoCanonicalRootCollisions(canonicalRootMap: Record<string, string>): void {
  const reverse = new Map<string, string>();
  for (const [sourceRoot, canonicalRoot] of Object.entries(canonicalRootMap)) {
    const existing = reverse.get(canonicalRoot);
    if (existing && existing !== sourceRoot) {
      throw new Error(
        `Lift validation canonical root collision: ${sourceRoot} and ${existing} both map to ${canonicalRoot}`,
      );
    }
    reverse.set(canonicalRoot, sourceRoot);
  }
}
