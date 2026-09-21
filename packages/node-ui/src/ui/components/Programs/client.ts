import { GraphComputer, type AgentSigner } from '@origintrail-official/dkg-graph-computer';
import { bytesToHex, stringToHex } from 'viem';
import { fetchStatus } from '../../api.js';
import { useWalletStore } from '../../stores/wallet.js';

/** Snapshot the selected wallet; never fall back to the UI bearer or node identity. */
export function programSigner(): AgentSigner {
  const { provider, address } = useWalletStore.getState();
  if (!provider || !address) throw new Error('Connect the agent wallet first.');
  const check = () => {
    const current = useWalletStore.getState();
    if (current.provider !== provider || current.address?.toLowerCase() !== address.toLowerCase())
      throw new Error('Wallet changed. Reopen the Program editor.');
  };
  return {
    async getAddress() { check(); return address; },
    async signMessage(message) {
      check();
      const signature = await provider.request({ method: 'personal_sign',
        params: [typeof message === 'string' ? stringToHex(message) : bytesToHex(message), address] });
      check();
      if (typeof signature !== 'string') throw new Error('Wallet returned an invalid signature.');
      return signature;
    },
  };
}

export async function programClient(): Promise<GraphComputer> {
  const signer = programSigner();
  const status = await fetchStatus();
  if (typeof status.peerId !== 'string') throw new Error('Node identity is unavailable.');
  return new GraphComputer({ nodeUrl: window.location.origin, peerId: status.peerId, signer,
    // Each request is an explicit wallet action. Mutations and invocations are
    // never silently retried or signed again by the editor.
    retries: 0, timeoutMs: 150_000 });
}
