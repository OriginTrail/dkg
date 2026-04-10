import type { Quad } from '@origintrail-official/dkg-storage';
import { sha256 } from '@origintrail-official/dkg-core';
import type { LiftResolvedPublishSlice } from './async-lift-publish-options.js';
import type { LiftJobValidationMetadata, LiftRequest } from './lift-job.js';

export interface LiftValidationInput {
  readonly request: LiftRequest;
  readonly resolved: LiftResolvedPublishSlice;
}

export interface ValidatedLiftPublishPayload {
  readonly validation: LiftJobValidationMetadata;
  readonly resolved: LiftResolvedPublishSlice;
}

export function validateLiftPublishPayload(input: LiftValidationInput): ValidatedLiftPublishPayload {
  const authorityProofRef = input.request.authority.proofRef.trim();
  if (authorityProofRef.length === 0) {
    throw new Error('Lift validation requires a non-empty authority proof reference');
  }

  const priorVersion = normalizePriorVersion(input.request.priorVersion);
  validatePriorVersion(input.request.transitionType, priorVersion);

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
      transitionType: input.request.transitionType,
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

function canonicalRootIri(request: LiftRequest, root: string): string {
  const rootName = slugPart(rootTail(root));
  const rootHash = shortRootHash(root);
  return `dkg:${slugPart(request.contextGraphId)}:${slugPart(request.namespace)}:${slugPart(request.scope)}/${rootName}-${rootHash}`;
}

function normalizeRoots(roots: readonly string[]): string[] {
  return [...new Set(roots.map((root) => root.trim()).filter(Boolean))];
}

function rootTail(root: string): string {
  const trimmed = root.trim();
  const slashIndex = trimmed.lastIndexOf('/');
  const colonIndex = trimmed.lastIndexOf(':');
  const cutIndex = Math.max(slashIndex, colonIndex);
  return cutIndex >= 0 ? trimmed.slice(cutIndex + 1) : trimmed;
}

function slugPart(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || 'unknown';
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

function shortRootHash(root: string): string {
  const digest = sha256(new TextEncoder().encode(root));
  return Array.from(digest)
    .slice(0, 6)
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
