// SPDX-License-Identifier: Apache-2.0

import { decodePublishRequest, validateContextGraphId, createOperationContext, type OperationContext } from '@origintrail-official/dkg-core';
import type { GossipPhaseCallback } from '../gossip-publish-handler.js';

/** Admit one decoded publish frame only under its validated topic context graph. */
export function decodeGossipPublishForTopic(
  data: Uint8Array,
  contextGraphId: string,
  callbacks: Readonly<{
    phase?: GossipPhaseCallback;
    setContext: (context: OperationContext) => void;
    warn: (message: string) => void;
  }>,
): ReturnType<typeof decodePublishRequest> | null {
  const phase = callbacks.phase;
  if (!validateContextGraphId(contextGraphId).valid) return null;
  phase?.('decode', 'start');
  let request;
  try {
    request = decodePublishRequest(data);
    if (request.operationId) {
      callbacks.setContext(createOperationContext('gossip', request.operationId));
    }

    if (!request.contextGraphId) {
      request.contextGraphId = contextGraphId;
    } else if (request.contextGraphId !== contextGraphId) {
      // #1100: protobuf decoding is structurally permissive — agent-profile
      // and other non-publish gossip frames "successfully" decode as publish
      // requests with multi-KB RDF garbage in the contextGraphId field. The
      // old guard only skipped on non-printable characters, so any payload
      // that happened to be printable ASCII was dumped wholesale into the
      // log as a WARN, every few seconds, forever. A real cross-topic
      // mismatch always carries a *well-formed* CG id, so validate the
      // decoded value first and silently skip mis-decoded frames.
      if (!validateContextGraphId(request.contextGraphId).valid) return null;
      callbacks.warn(`Gossip: request contextGraphId "${request.contextGraphId.slice(0, 120)}" does not match topic "${contextGraphId}", ignoring`);
      return null;
    }
  } finally {
    phase?.('decode', 'end');
  }

  return request;
}
