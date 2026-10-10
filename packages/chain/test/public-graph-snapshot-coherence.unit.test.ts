import { describe, expect, it, vi } from 'vitest';
import { Interface, ethers } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MULTICALL3_RUNTIME_CODE } from './fixtures/multicall3-runtime-code.js';

const hub = `0x${'1'.repeat(40)}`, cg = `0x${'2'.repeat(40)}`, ka = `0x${'3'.repeat(40)}`;
const mc = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
function fixture(aggregate: boolean, reorg: boolean) {
  const reads: {name:string,tag:unknown}[] = [];
  let head = 10, anchorReads = 0;
  const interfaces: Record<string, Interface> = { [hub]:new Interface(loadAbi('Hub')), [cg]:new Interface(loadAbi('ContextGraphStorage')), [ka]:new Interface(loadAbi('DKGKnowledgeAssets')) };
  function reply(to: string, data: string, tag: unknown): string {
    const iface = interfaces[to]!; const call = iface.parseTransaction({ data })!;
    reads.push({name:call.name, tag});
    // The head moves during inventory collection. Every contract read must still use block 10.
    if(call.name === 'getContextGraphKaAt') head = 11;
    const v: Record<string, unknown[]> = {
      getAssetStorageAddress:[call.args[0] === 'ContextGraphStorage' ? cg : ka],
      getNameHash:[ethers.id('coherent-snapshot')], getContextGraphKaCount:[1n], getContextGraphKaAt:[1n],
      getLatestMerkleRoot:[`0x${(tag === 10 ? 'a' : 'b').repeat(64)}`], kaToContextGraph:[1n],
    };
    if(call.name === 'getContextGraph') {
      const outputs = iface.getFunction(call.name)!.outputs;
      const defaults = (p: any): any => p.baseType === 'tuple' ? p.components.map(defaults) : p.baseType === 'array' ? [] : p.type === 'bool' ? true : p.type === 'address' ? ethers.ZeroAddress : p.type === 'string' ? '' : p.type.startsWith('bytes') ? ethers.ZeroHash : 0n;
      return iface.encodeFunctionResult(call.name,outputs.map(defaults));
    }
    if(call.name === 'getKnowledgeAssetUpdateContext') {
      const outputs = iface.getFunction(call.name)!.outputs;
      const defaults = (p: any): any => p.baseType === 'tuple' ? p.components.map(defaults) : p.type === 'address' ? ethers.ZeroAddress : p.type === 'bool' ? false : p.type.startsWith('bytes') ? ethers.ZeroHash : p.name.toLowerCase().includes('rootscount') ? 1n : 0n;
      return iface.encodeFunctionResult(call.name,outputs.map(defaults));
    }
    return iface.encodeFunctionResult(call.name,v[call.name]!);
  }
  const provider: any = {
    send: async () => '0x7a69',
    getBlock: async (tag: unknown) => ({number:tag === 'latest' ? head : tag, hash:`0x${(reorg && tag !== 'latest' && ++anchorReads > 1 ? 'c' : 'd').repeat(64)}`}),
    getCode: async (_:unknown, tag:unknown) => { reads.push({name:'getCode',tag}); return aggregate ? MULTICALL3_RUNTIME_CODE : '0x'; },
    call: async (tx:any) => {
      if(interfaces[tx.to]) return reply(tx.to,tx.data,tx.blockTag);
      const parsed = mc.parseTransaction({data:tx.data})!;
      return mc.encodeFunctionResult('aggregate3',[parsed.args[0].map((c:any) => [true,reply(c.target,c.callData,tx.blockTag)])]);
    },
    resolveName: async (name:string) => name,
  };
  const a: any = new EVMChainAdapter({rpcUrl:'http://127.0.0.1:59998',chainId:'evm:31337',hubAddress:hub,privateKey:ethers.Wallet.createRandom().privateKey,finalityConfirmations:1});
  a.init=vi.fn(async()=>{}); a.providers=[provider];
  return {a, reads};
}
describe('public snapshot coherent provider reads', () => {
  it.each([true,false])('keeps moving-head reads anchored (aggregate=%s)', async aggregate => {
    const {a,reads} = fixture(aggregate,false);
    const snapshot=await a.readPublicGraphSnapshot('coherent-snapshot','1');
    expect(snapshot.blockNumber).toBe('10'); expect(snapshot.assets[0].root).toBe(`0x${'a'.repeat(64)}`);
    expect(reads.length).toBeGreaterThan(8); expect(reads.every(r=>r.tag===10)).toBe(true);
  });
  it.each([true,false])('rejects anchor replacement (aggregate=%s)', async aggregate => {
    const {a} = fixture(aggregate,true);
    await expect(a.readPublicGraphSnapshot('coherent-snapshot','1')).rejects.toThrow();
  });
});
