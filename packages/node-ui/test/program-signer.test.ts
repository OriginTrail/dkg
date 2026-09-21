// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { programSigner } from '../src/ui/components/Programs/client.js';
import { useWalletStore } from '../src/ui/stores/wallet.js';

const address = '0x0000000000000000000000000000000000000001';
afterEach(() => useWalletStore.setState({ address: null, provider: null }));

describe('Program editor wallet signer', () => {
  it('requires the connected agent wallet', () => {
    useWalletStore.setState({ address: null, provider: null });
    expect(programSigner).toThrow('Connect the agent wallet');
  });
  it('signs message bytes with personal_sign and never passes a private key', async () => {
    const request = vi.fn().mockResolvedValue('0xsigned');
    useWalletStore.setState({ address, provider: { request } });
    const signer = programSigner();
    await signer.signMessage('abc');
    expect(request).toHaveBeenLastCalledWith({ method: 'personal_sign', params: ['0x616263', address] });
    await signer.signMessage(new Uint8Array([1, 2, 255]));
    expect(request).toHaveBeenLastCalledWith({ method: 'personal_sign', params: ['0x0102ff', address] });
  });
  it('rejects a signature when the wallet changes while its prompt is open', async () => {
    let finish!: (signature: string) => void;
    useWalletStore.setState({ address, provider: { request: () => new Promise(resolve => { finish = resolve; }) } });
    const pending = programSigner().signMessage('abc');
    useWalletStore.setState({ address: '0x0000000000000000000000000000000000000002' });
    finish('0xsigned');
    await expect(pending).rejects.toThrow('Wallet changed');
  });
});
