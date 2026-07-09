import {
  assertSafeIri,
  contextGraphSharedMemoryUri,
  MemoryLayer,
  parseContextGraphLayerUri,
  sparqlString,
  type PublishIntentMsg,
} from '@origintrail-official/dkg-core';
import type { TripleStore } from '@origintrail-official/dkg-storage';
import type { ChainAdapter } from '@origintrail-official/dkg-chain';
import { resolveAssetUalFromKaIdentity } from './ka-identity.js';

export interface StorageAckLifecycleAssetUalInput {
  store: TripleStore;
  chain: ChainAdapter;
  intent: PublishIntentMsg;
}

export async function resolveStorageAckLifecycleAssetUalFromLocalSwm(
  input: StorageAckLifecycleAssetUalInput,
): Promise<string | undefined> {
  const swmGraphId = input.intent.swmGraphId?.trim() || input.intent.contextGraphId?.trim();
  if (!swmGraphId) return undefined;
  const subGraphName = input.intent.subGraphName?.trim() || undefined;
  const baseSwmGraph = contextGraphSharedMemoryUri(swmGraphId, subGraphName);
  try {
    assertSafeIri(baseSwmGraph);
  } catch {
    return undefined;
  }

  const rootValues = (input.intent.rootEntities ?? [])
    .map((root) => {
      try {
        return `<${assertSafeIri(root)}>`;
      } catch {
        return undefined;
      }
    })
    .filter((root): root is string => root !== undefined);
  const graphPattern = rootValues.length > 0
    ? `VALUES ?s { ${rootValues.join(' ')} } ?s ?p ?o .`
    : '?s ?p ?o .';

  const result = await input.store.query(`
    SELECT DISTINCT ?g WHERE {
      GRAPH ?g { ${graphPattern} }
      FILTER(STRSTARTS(STR(?g), ${sparqlString(`${baseSwmGraph}/`)}))
      FILTER(!STRSTARTS(STR(?g), ${sparqlString(`${baseSwmGraph}/staging/`)}))
    }
  `, { source: 'agent.storageAckLifecycleAssetUal' });
  if (result.type !== 'bindings') return undefined;

  const identities = new Map<string, { agentAddress: string; kaNumber: bigint }>();
  for (const row of result.bindings) {
    const graphUri = normalizeBindingIri(row.g);
    if (!graphUri) continue;
    const identity = parseContextGraphLayerUri(graphUri);
    if (
      !identity ||
      identity.layer !== MemoryLayer.SharedWorkingMemory ||
      identity.contextGraphId !== swmGraphId ||
      identity.subGraphName !== subGraphName
    ) continue;
    const key = `${identity.agentAddress.toLowerCase()}/${identity.kaNumber.toString()}`;
    identities.set(key, identity);
  }
  if (identities.size !== 1) return undefined;

  const identity = [...identities.values()][0];
  return resolveAssetUalFromKaIdentity(input.chain, {
    agentAddress: identity.agentAddress,
    kaNumber: identity.kaNumber,
  });
}

function normalizeBindingIri(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('<') && trimmed.endsWith('>')) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}
