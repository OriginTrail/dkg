// Compatibility exports for the original ACK capability module.
// The generic P2P registry owns peer roles and protocol evidence.
export {
  PeerCapabilityRegistry as ACKCapabilityRegistry,
  PeerCapabilityRound as ACKCapabilityRound,
  type PeerCapabilitySnapshot as ACKCapabilitySnapshot,
} from './peer-capability.js';
