// SPDX-License-Identifier: Apache-2.0
import {
  createOperationContext, decodeGossipEnvelope, GOSSIP_TYPE_WORKSPACE_PUBLISH_CHUNKED,
  type Logger,
} from '@origintrail-official/dkg-core';
import type { GossipSession } from '../../gossip-session.js';

interface HostModeHandlerPorts {
  ingestSwmCiphertextChunkEnvelope(contextGraphId: string, data: Uint8Array, from: string, admissionCurrent: () => boolean): Promise<unknown>;
  ingestSwmHostModeEnvelope(contextGraphId: string, data: Uint8Array, from: string, admissionCurrent: () => boolean): Promise<unknown>;
}

/** Registration owns admission; both ingestion paths retain its captured fence. */
export function createSwmHostModeHandler(
  ports: HostModeHandlerPorts,
  log: Pick<Logger, 'debug' | 'warn'>,
  session: GossipSession,
  contextGraphId: string,
  captureAdmissionCurrent: () => () => boolean,
  refreshAdmission?: () => Promise<void>,
): (topic: string, data: Uint8Array, from: string) => void {
  const dispatch = (_topic: string, data: Uint8Array, from: string) => {
    const admissionCurrent = captureAdmissionCurrent();
    if (!session.active || !admissionCurrent()) return;
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
      ports.ingestSwmCiphertextChunkEnvelope(contextGraphId, data, from, admissionCurrent).catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        log.warn(
          createOperationContext('system'),
          `LU-11: chunked SWM ingest failed for "${contextGraphId}": ${msg}`,
        );
      });
      return;
    }
    ports.ingestSwmHostModeEnvelope(contextGraphId, data, from, admissionCurrent).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn(
        createOperationContext('system'),
        `Host-mode SWM ingest failed for "${contextGraphId}": ${msg}`,
      );
    });
  };
  return (topic, data, from) => {
    if (!session.active) return;
    if (!captureAdmissionCurrent()() && refreshAdmission !== undefined) {
      // A canonical alias handoff gets a new policy admission; a retired
      // callback never replaces the capture of an already-running ingest.
      void refreshAdmission().then(() => dispatch(topic, data, from)).catch((error: unknown) => {
        log.warn(createOperationContext('system'), `Host-mode admission refresh failed for "${contextGraphId}": ${String(error)}`);
      });
      return;
    }
    dispatch(topic, data, from);
  };
}
