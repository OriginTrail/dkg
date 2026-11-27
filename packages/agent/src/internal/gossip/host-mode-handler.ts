// SPDX-License-Identifier: Apache-2.0
import {
  createOperationContext, decodeGossipEnvelope, GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  type Logger,
} from '@origintrail-official/dkg-core';
import type { GossipSession } from '../../gossip-session.js';

interface HostModeHandlerPorts {
  swmHostModeStripCiphertext(): boolean;
  ingestSwmCiphertextChunkEnvelope(contextGraphId: string, data: Uint8Array, from: string): Promise<unknown>;
  ingestSwmHostModeEnvelope(contextGraphId: string, data: Uint8Array, from: string): Promise<unknown>;
}

/** Dispatch only through the session and classification which own this handler. */
export function createSwmHostModeHandler(
  ports: HostModeHandlerPorts,
  log: Pick<Logger, 'debug' | 'warn'>,
  session: GossipSession,
  contextGraphId: string,
  wireCgId: string,
): (topic: string, data: Uint8Array, from: string) => void {
  return (_topic: string, data: Uint8Array, from: string) => {
    if (!session.active) return;
    // Fail closed when the classification is absent. Only an explicitly
    // non-curated manual subscription retains the public host-mode hatch.
    if (
      ports.swmHostModeStripCiphertext() &&
      session.swmHostModeCurated.get(wireCgId) !== false
    ) {
      log.debug(
        createOperationContext('share'),
        `Dropping host-mode envelope on cg=${contextGraphId} from=${from}: ` +
        `private-ciphertext strip is ON for a curated CG (OT-RFC-49 WS-A)`,
      );
      return;
    }
    // OT-RFC-38 LU-11: peek envelope type and dispatch. Chunked
    // envelopes (`type='share-write-chunked'`) take the V2 chunk
    // persistence path; everything else flows through the legacy
    // host-mode store unchanged. Failed decode falls through to
    // `ingestSwmHostModeEnvelope` which is also defensive — the
    // dispatch here is best-effort, not a security boundary.
    let envelopeType: string | undefined;
    try {
      const peek = decodeGossipEnvelope(data);
      envelopeType = peek?.type;
    } catch { /* drop into legacy path */ }
    if (envelopeType === GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED) {
      ports.ingestSwmCiphertextChunkEnvelope(contextGraphId, data, from).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          createOperationContext('system'),
          `LU-11: chunked SWM ingest failed for "${contextGraphId}": ${msg}`,
        );
      });
      return;
    }
    ports.ingestSwmHostModeEnvelope(contextGraphId, data, from).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        createOperationContext('system'),
        `Host-mode SWM ingest failed for "${contextGraphId}": ${msg}`,
      );
    });
  };
}
