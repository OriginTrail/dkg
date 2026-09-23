// Node identity Profile nodeId (identity -> libp2p peer id).
//
//   GET  /api/identity/node-id       — this node's on-chain nodeId next to its
//                                      libp2p peer id, and whether the deployed
//                                      Profile contract can update it.
//   POST /api/identity/node-id/sync  — point the on-chain nodeId at this node's
//                                      peer id via Profile.updateNodeId (signed
//                                      by the node's operational key, or its
//                                      admin key when only that is accepted).
//
// A sync that cannot proceed is an answer, not a server error: the body's
// `outcome` says why (unsupported Profile, peer id taken, no profile). The
// write only ever sets THIS node's own peer id; it takes no input. Chain RPC
// failures map to 503 through the shared transport classifier.

import {
  describeProfileNodeIdSync,
  type ProfileNodeIdStatus,
  type ProfileNodeIdSyncResult,
} from '@origintrail-official/dkg-agent';
import type { ServerResponse } from 'node:http';
import { canAdministerNode } from '../../auth.js';
import type { ProfileNodeIdStatusWire, ProfileNodeIdSyncWire } from '../../profile-node-id-wire.js';
import { jsonResponse, respondIfChainRpcTransportError } from '../http-utils.js';
import type { RequestContext } from './context.js';

const NODE_ID_PATH = '/api/identity/node-id';
const SYNC_PATH = '/api/identity/node-id/sync';

const FEATURE_UNAVAILABLE_503 = {
  error: 'The chain adapter has no Profile nodeId surface — not available on this deployment',
  code: 'PROFILE_NODE_ID_UNAVAILABLE',
};

export function serializeProfileNodeIdStatus(status: ProfileNodeIdStatus): ProfileNodeIdStatusWire {
  return {
    identityId: status.identityId.toString(),
    peerId: status.peerId,
    expectedNodeId: status.expectedNodeId,
    onChainNodeId: status.onChainNodeId,
    onChainPeerId: status.onChainPeerId,
    state: status.state,
    expectedNodeIdTaken: status.expectedNodeIdTaken,
    expectedNodeIdHolder: status.expectedNodeIdHolder === null ? null : status.expectedNodeIdHolder.toString(),
    profile: {
      address: status.support.profileAddress,
      version: status.support.profileVersion,
      updateNodeIdSupported: status.support.supported,
      requiredVersion: status.support.requiredVersion,
    },
  };
}

export function serializeProfileNodeIdSync(result: ProfileNodeIdSyncResult): ProfileNodeIdSyncWire {
  return {
    outcome: result.outcome,
    message: describeProfileNodeIdSync(result),
    status: serializeProfileNodeIdStatus(result.status),
    txHash: result.tx?.hash ?? null,
    blockNumber: result.tx?.blockNumber ?? null,
    signer: result.signer ?? null,
  };
}

function respondError(res: ServerResponse, err: unknown, label: string): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/No blockchain configured/i.test(msg)) {
    jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
    return;
  }
  if (respondIfChainRpcTransportError(res, err)) return;
  jsonResponse(res, 500, { error: `${label} failed: ${msg}` });
}

export async function handleIdentityNodeIdRoutes(ctx: RequestContext): Promise<void> {
  const { req, res, agent, path, authentication } = ctx;

  if (req.method === 'GET' && path === NODE_ID_PATH) {
    try {
      const status = await agent.getProfileNodeIdStatus();
      if (status === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, serializeProfileNodeIdStatus(status));
    } catch (err) {
      return respondError(res, err, 'profile nodeId status');
    }
  }

  if (req.method === 'POST' && path === SYNC_PATH) {
    // Signs an on-chain identity mutation with the daemon's own keys, so the
    // bearer token is the only caller gate: require the node-level token, as
    // the operational-wallet routes do.
    if (!canAdministerNode(authentication)) {
      return jsonResponse(res, 403, {
        error: 'Node-admin token required (~/.dkg/auth.token) to change the node identity; agent-scoped tokens cannot.',
      });
    }
    try {
      const result = await agent.syncProfileNodeId('manual');
      if (result === null) return jsonResponse(res, 503, FEATURE_UNAVAILABLE_503);
      return jsonResponse(res, 200, serializeProfileNodeIdSync(result));
    } catch (err) {
      return respondError(res, err, 'profile nodeId sync');
    }
  }
}
