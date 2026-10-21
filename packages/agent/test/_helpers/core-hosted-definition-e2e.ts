// SPDX-License-Identifier: Apache-2.0

/**
 * Steps shared by the end-to-end cases in which a Core hosts a public Context
 * Graph registered on chain, keeps the owner's definition of it and serves it
 * to a member that reaches the graph only through that Core.
 */
import { expect, vi } from 'vitest';
import type { DKGAgent } from '../../src/index.js';
import {
  hasPendingCoreHostedDefinitionRetry,
  pendingCoreHostedDefinitionHint,
  pendingCoreHostedDefinitionRefresh,
} from '../../src/core-hosted-definition.js';
import { pollUntil } from './real-chain-agent.js';

const NAME = 'http://schema.org/name';
/** The sub-graph the owner registers and the member writes into. */
export const REPORTS = 'reports';

/** Whether `from` holds a connection to `to` now, in either direction. */
export function isConnected(from: DKGAgent, to: DKGAgent): boolean {
  const remote = to.node.libp2p.peerId.toString();
  return from.node.libp2p.getConnections().some((connection) => connection.remotePeer.toString() === remote);
}

export async function subGraphNames(agent: DKGAgent, contextGraphId: string): Promise<string[]> {
  return (await agent.listSubGraphs(contextGraphId)).map((subGraph) => subGraph.name).sort();
}

/** Every info line `agent` logs from now on, as `log.info(ctx, line)` receives it. */
function infoLog(agent: DKGAgent): () => string[] {
  const info = vi.spyOn((agent as unknown as { log: { info(...args: unknown[]): void } }).log, 'info');
  return () => info.mock.calls.map((call) => String(call[1]));
}

/** The Core's info log lines about the graph's definition. */
export function definitionLog(core: DKGAgent, contextGraphId: string): () => string[] {
  const lines = infoLog(core);
  return () => lines().filter((line) => line.startsWith(`Hosted context graph "${contextGraphId}"`));
}

/** The Core's line for an install from the owner's node, by the attempt hosting started or by that node's own fetch. */
function isTiedOwnerInstall(line: string, ownerPeerId: string): boolean {
  return line.includes(`installed the owner's definition from owner node ${ownerPeerId.slice(-8)} (recorded)`)
    || line.includes(`installed the owner's definition from owner-tied node ${ownerPeerId.slice(-8)}`);
}

/**
 * Wait until the Core's work on the graph's definition has ended: the attempt
 * or refresh that runs and the tied node's fetch. The definition is in the
 * store before that work records it as held and logs how it came.
 */
export async function coreDefinitionWorkSettled(core: DKGAgent, contextGraphId: string): Promise<void> {
  await pendingCoreHostedDefinitionRefresh(core, contextGraphId);
  await pendingCoreHostedDefinitionHint(core, contextGraphId);
}

/**
 * How the Core came to hold the definition: from the owner's node it took
 * from the owner's signed word, by the attempt hosting started or by that
 * node's own fetch, and never after a miss that waits for a retry. Asserted
 * once the Core's work has settled and its install line is written.
 */
export async function expectFetchedFromTiedOwnerNode(
  core: DKGAgent,
  contextGraphId: string,
  log: () => string[],
  ownerPeerId: string,
): Promise<void> {
  await coreDefinitionWorkSettled(core, contextGraphId);
  const lines = await pollUntil(log, (current) => current.some((line) => isTiedOwnerInstall(line, ownerPeerId)), 10_000, 50);
  expect(lines.some((line) => isTiedOwnerInstall(line, ownerPeerId)), lines.join('\n')).toBe(true);
  expect(lines.filter((line) => line.includes('no definition from')), 'no attempt missed the definition').toEqual([]);
  expect(hasPendingCoreHostedDefinitionRetry(core, contextGraphId), 'no retry is pending').toBe(false);
}

/** The peers (last 8 characters of the id, as logged) a member's copy of the definition came from. */
interface DefinitionSources {
  /** One entry per line that registered `reports` from a peer's metadata. */
  readonly reportsRegisteredFrom: readonly string[];
  /** One entry per public declaration the metadata bootstrap installed from a connected peer. */
  readonly declarationInstalledFrom: readonly string[];
}

/**
 * The member's own log lines that name where its definition came from: the
 * sub-graph registrations it took from a peer's metadata
 * (`peer-sub-graph-registration.ts`) and the declarations its metadata
 * bootstrap installed (`dkg-agent-rfc64-meta-bootstrap.ts`).
 */
function definitionSourceLog(member: DKGAgent, contextGraphId: string): () => DefinitionSources {
  const lines = infoLog(member);
  const registered = 'Registered sub-graph(s) ';
  const registeredFrom = ` of context graph "${contextGraphId}" from the metadata of peer `;
  const installedFrom = `RFC-64 metadata bootstrap for "${contextGraphId}" installed the public `
    + 'declaration (chain binding excluded) from connected peer ';
  return () => {
    const reportsRegisteredFrom: string[] = [];
    const declarationInstalledFrom: string[] = [];
    for (const line of lines()) {
      const at = line.indexOf(registeredFrom);
      if (line.startsWith(registered) && at > 0) {
        if (line.slice(registered.length, at).split(', ').includes(`"${REPORTS}"`)) {
          reportsRegisteredFrom.push(line.slice(at + registeredFrom.length));
        }
      } else if (line.startsWith(installedFrom)) {
        declarationInstalledFrom.push(line.slice(installedFrom.length));
      }
    }
    return { reportsRegisteredFrom, declarationInstalledFrom };
  };
}

/**
 * A member that reaches only the Core subscribes, obtains the definition from
 * the Core and writes into the owner's sub-graph. Where the definition came
 * from is read from the member's own log, not from its connections: once
 * subscribed, a member may dial the owner's node by itself (a catalog replay
 * towards the graph's author), which says nothing about where it took the
 * definition.
 */
export async function memberWritesIntoReports(
  member: DKGAgent,
  peers: { readonly core: DKGAgent; readonly owner: DKGAgent },
  contextGraphId: string,
  onChainId: string,
): Promise<void> {
  const memberAddress = member.getDefaultAgentAddress()!.toLowerCase();
  const sources = definitionSourceLog(member, contextGraphId);
  const admission = await member.resolveContextGraphSubscriptionBootstrapAuthority(contextGraphId, {
    callerAgentAddress: memberAddress,
    allowSubscriptionFallback: false,
  });
  expect(admission).toMatchObject({ outcome: 'allowed', source: 'registered-chain' });
  member.subscribeToContextGraph(contextGraphId, { syncMode: 'always-on', onChainId });
  const fetched = await member.bootstrapRfc64CatalogContextGraphMetadataFromPeersV1(
    contextGraphId,
    undefined,
    { contextGraphId, onChainId },
  );
  expect(['fetched', 'already-confirmed'], 'how the member obtained the definition').toContain(fetched);
  expect(await subGraphNames(member, contextGraphId), 'the member lists the owner\'s sub-graph').toEqual([REPORTS]);

  // Sampled as the member holds the definition. `reports` is registered once,
  // and a held declaration is not installed again.
  const core = peers.core.peerId.slice(-8);
  const owner = peers.owner.peerId.slice(-8);
  const obtained = sources();
  expect(obtained.reportsRegisteredFrom, `the member registered "${REPORTS}" from the Core ${core}, not the owner ${owner}`)
    .toEqual([core]);
  expect([...new Set(obtained.declarationInstalledFrom)], `the member installed the declaration from the Core ${core}, not the owner ${owner}`)
    .toEqual([core]);

  const scope = { subGraphName: REPORTS };
  const name = `member-report-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  await member.assertion.create(contextGraphId, name, scope);
  await member.assertion.write(
    contextGraphId,
    name,
    [{ subject: `urn:e2e:member-report:${name}`, predicate: NAME, object: '"a report"' }],
    scope,
  );
  const promoted = await member.assertion.promote(contextGraphId, name, scope);
  expect(promoted.promotedCount).toBeGreaterThan(0);
}
