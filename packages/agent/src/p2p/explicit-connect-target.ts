import { NetworkAdmissionInvalidPeerIdError } from './network-admission-coordinator.js';
import {
  MultiaddrPeerTargetParseError,
  parseMultiaddrConnectTarget,
  type MultiaddrConnectTarget,
} from './multiaddr-peer-target.js';

export function parseExplicitConnectTarget(
  multiaddress: string,
  admissionEnabled: boolean,
): MultiaddrConnectTarget {
  try {
    const target = parseMultiaddrConnectTarget(multiaddress);
    if (admissionEnabled && !target.targetPeerId) {
      throw new MultiaddrPeerTargetParseError(
        'connect multiaddr must include a target /p2p/<peerId> for network admission',
        '<missing>',
      );
    }
    return target;
  } catch (err) {
    if (!admissionEnabled) throw err;
    throw new NetworkAdmissionInvalidPeerIdError(
      err instanceof MultiaddrPeerTargetParseError ? err.rawTarget ?? '<missing>' : '<missing>',
      err instanceof Error ? err.message : String(err),
    );
  }
}
