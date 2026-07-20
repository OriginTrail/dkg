// SPDX-License-Identifier: Apache-2.0

import { stripLiteral } from './dkg-agent-utils.js';

export type ContextGraphAccessPolicy = 'public' | 'private';

/**
 * Resolve every persisted access-policy declaration for a context graph.
 *
 * Registration is an authority-changing operation, so it must not choose an
 * arbitrary row when ONTOLOGY and root `_meta` disagree. Callers must collect
 * all declarations from both graphs and use this resolver before mutating
 * creator, curator, or public-proof metadata.
 */
export function resolveContextGraphAccessPolicyDeclarations(
  contextGraphId: string,
  rawValues: readonly string[],
): ContextGraphAccessPolicy {
  if (rawValues.length === 0) {
    throw new Error(
      `Context graph "${contextGraphId}" has no explicit access-policy declaration; refusing registration.`,
    );
  }

  const policies = new Set<ContextGraphAccessPolicy>();
  for (const rawValue of rawValues) {
    if (!rawValue.startsWith('"')) {
      throw invalidAccessPolicyDeclarations(contextGraphId);
    }
    const normalized = stripLiteral(rawValue).trim().toLowerCase();
    if (normalized !== 'public' && normalized !== 'private') {
      throw invalidAccessPolicyDeclarations(contextGraphId);
    }
    policies.add(normalized);
  }

  if (policies.size !== 1) {
    throw invalidAccessPolicyDeclarations(contextGraphId);
  }
  return policies.values().next().value!;
}

function invalidAccessPolicyDeclarations(contextGraphId: string): Error {
  return new Error(
    `Context graph "${contextGraphId}" has conflicting or invalid access-policy declarations ` +
    'across ONTOLOGY and root metadata; refusing registration.',
  );
}
