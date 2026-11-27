import { parseContextGraphAssertionStorageUri } from '@origintrail-official/dkg-core/dist/constants.js';

/** Decode lifecycle identities and legacy storage aliases for one known CG. */
export function decodeAssertionIdentity(graph: string, contextGraphId: string): { name: string; subGraph?: string } | undefined {
  const coordinate = parseContextGraphAssertionStorageUri(graph);
  if (coordinate) {
    if (coordinate.scope === contextGraphId) return { name: coordinate.name };
    const prefix = `${contextGraphId}/`;
    if (coordinate.scope.startsWith(prefix)) {
      const subGraph = coordinate.scope.slice(prefix.length);
      if (subGraph && !subGraph.includes('/')) return { name: coordinate.name, subGraph };
    }
    return undefined;
  }
  const prefix = `urn:dkg:assertion:${contextGraphId}:`;
  if (!graph.startsWith(prefix)) return undefined;
  const rest = graph.slice(prefix.length);
  const root = /^(0x[0-9a-fA-F]{40}):(.+)$/.exec(rest);
  if (root) return { name: root[2] };
  const scoped = /^([^:]+):(0x[0-9a-fA-F]{40}):(.+)$/.exec(rest);
  if (scoped) return { name: scoped[3], subGraph: scoped[1] };
}
