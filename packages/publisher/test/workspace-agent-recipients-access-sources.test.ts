import { describe, expect, it } from 'vitest';
import { ethers } from 'ethers';
import { OxigraphStore } from '@origintrail-official/dkg-storage';
import { DKG_ONTOLOGY, SYSTEM_CONTEXT_GRAPHS, contextGraphDataUri } from '@origintrail-official/dkg-core';
import { resolveWorkspaceAgentRecipients } from '../src/index.js';
import {
  AGENTS_GRAPH,
  CONTEXT_GRAPH_ID,
  DATA_GRAPH,
  insertAgentEncryptionKey,
  insertAgentGate,
} from './_helpers/workspace-agent-recipient-store.js';

describe('resolveWorkspaceAgentRecipients across the sources of access metadata', () => {
  it('takes a private declaration from the AGENTS graph, and its recipients from the graph\'s own metadata', async () => {
    const store = new OxigraphStore();
    const member = ethers.Wallet.createRandom();
    const unlisted = ethers.Wallet.createRandom();
    const accessRows = (graph: string) => [
      { subject: DATA_GRAPH, predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT, object: `"${unlisted.address}"`, graph },
      { subject: DATA_GRAPH, predicate: DKG_ONTOLOGY.DKG_PARTICIPANT_AGENT, object: `"${unlisted.address}"`, graph },
      { subject: DATA_GRAPH, predicate: DKG_ONTOLOGY.DKG_REVOKED_AGENT, object: `"${member.address}"`, graph },
    ];
    await store.insert([
      {
        subject: DATA_GRAPH,
        predicate: DKG_ONTOLOGY.DKG_ACCESS_POLICY,
        object: '"private"',
        graph: AGENTS_GRAPH,
      },
      ...accessRows(AGENTS_GRAPH),
      ...accessRows(contextGraphDataUri(SYSTEM_CONTEXT_GRAPHS.ONTOLOGY)),
    ]);
    await insertAgentEncryptionKey(store, member);
    await insertAgentEncryptionKey(store, unlisted);

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .rejects.toThrow(/declares no DKG_ALLOWED_AGENT or DKG_PARTICIPANT_AGENT recipients/u);

    await insertAgentGate(store, DKG_ONTOLOGY.DKG_ALLOWED_AGENT, member.address);
    const resolution = await resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID });

    expect(resolution.requiresEncryption).toBe(true);
    expect(resolution.recipients.map((recipient) => recipient.agentAddress)).toEqual([ethers.getAddress(member.address)]);
  });

  it('requires no encryption for a graph that only the AGENTS graph gates', async () => {
    const store = new OxigraphStore();
    await store.insert([{
      subject: DATA_GRAPH,
      predicate: DKG_ONTOLOGY.DKG_ALLOWED_AGENT,
      object: `"${ethers.Wallet.createRandom().address}"`,
      graph: AGENTS_GRAPH,
    }]);

    await expect(resolveWorkspaceAgentRecipients(store, { contextGraphId: CONTEXT_GRAPH_ID }))
      .resolves.toMatchObject({ requiresEncryption: false, recipients: [] });
  });
});
