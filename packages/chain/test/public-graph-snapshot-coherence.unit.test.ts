import { describe, expect, it, vi } from 'vitest';
import { Interface, ethers } from 'ethers';
import { EVMChainAdapter } from '../src/evm-adapter.js';
import { loadAbi } from '../src/evm-adapter-abi.js';
import { MULTICALL3_RUNTIME_CODE } from './fixtures/multicall3-runtime-code.js';

const hub = `0x${'1'.repeat(40)}`, cg = `0x${'2'.repeat(40)}`, ka = `0x${'3'.repeat(40)}`;
const mc = new Interface(['function aggregate3((address target,bool allowFailure,bytes callData)[] calls) payable returns ((bool success,bytes returnData)[])']);
function fixture(aggregate: boolean, reorg: boolean, depth: number) {
  const reads: {name:string,tag:unknown}[] = [];
  let head = 10, collected = false;
  const anchor = 11-depth;
  const blockReads: unknown[] = [];
  const interfaces: Record<string, Interface> = { [hub]:new Interface(loadAbi('Hub')), [cg]:new Interface(loadAbi('ContextGraphStorage')), [ka]:new Interface(loadAbi('DKGKnowledgeAssets')) };
  function reply(to: string, data: string, tag: unknown): string {
    const iface = interfaces[to]!; const call = iface.parseTransaction({ data })!;
    reads.push({name:call.name, tag});
    // The head moves during inventory collection. Every contract read must still use the originally selected anchor.
    if(call.name === 'getContextGraphKaAt') { head = 11; collected = true; }
    const v: Record<string, unknown[]> = {
      getAssetStorageAddress:[call.args[0] === 'ContextGraphStorage' ? cg : ka],
      getNameHash:[ethers.id('coherent-snapshot')], getContextGraphKaCount:[2n], getContextGraphKaAt:[call.name === 'getContextGraphKaAt' ? BigInt(call.args[1])+1n : 0n],
      getLatestMerkleRoot:[`0x${(tag === anchor ? (call.args[0] === 1n ? 'a' : 'b') : 'c').repeat(64)}`], kaToContextGraph:[1n],
    };
    if(call.name === 'getContextGraph') {
      const outputs = iface.getFunction(call.name)!.outputs;
      const defaults = (p: any): any => p.baseType === 'tuple' ? p.components.map(defaults) : p.baseType === 'array' ? [] : p.type === 'bool' ? true : p.type === 'address' ? ethers.ZeroAddress : p.type === 'string' ? '' : p.type.startsWith('bytes') ? ethers.ZeroHash : 0n;
      return iface.encodeFunctionResult(call.name,outputs.map(defaults));
    }
    if(call.name === 'getKnowledgeAssetUpdateContext') {
      const outputs = iface.getFunction(call.name)!.outputs;
      const defaults = (p: any): any => p.baseType === 'tuple' ? p.components.map(defaults) : p.type === 'address' ? ethers.ZeroAddress : p.type === 'bool' ? false : p.type.startsWith('bytes') ? ethers.ZeroHash : p.name.toLowerCase().includes('rootscount') ? BigInt(call.args[0]) : 0n;
      return iface.encodeFunctionResult(call.name,outputs.map(defaults));
    }
    return iface.encodeFunctionResult(call.name,v[call.name]!);
  }
  const provider: any = {
    send: async () => '0x7a69',
    getBlock: async (tag: unknown) => { blockReads.push(tag); return {number:tag === 'latest' ? head : tag, hash:`0x${(reorg && collected ? 'c' : 'd').repeat(64)}`}; },
    getCode: async (_:unknown, tag:unknown) => { reads.push({name:'getCode',tag}); return aggregate ? MULTICALL3_RUNTIME_CODE : '0x'; },
    call: async (tx:any) => {
      if(interfaces[tx.to]) return reply(tx.to,tx.data,tx.blockTag);
      const parsed = mc.parseTransaction({data:tx.data})!;
      return mc.encodeFunctionResult('aggregate3',[parsed.args[0].map((c:any) => [true,reply(c.target,c.callData,tx.blockTag)])]);
    },
    resolveName: async (name:string) => name,
  };
  const a: any = new EVMChainAdapter({rpcUrl:'http://127.0.0.1:59998',chainId:'evm:31337',hubAddress:hub,privateKey:ethers.Wallet.createRandom().privateKey,finalityConfirmations:depth});
  a.init=vi.fn(async()=>{}); a.providers=[provider];
  return {a, reads, blockReads, anchor};
}
describe('public snapshot coherent provider reads', () => {
  const cases = [true,false].flatMap(aggregate => [1,3].map(depth => ({aggregate,depth})));
  it.each(cases)('keeps moving-head reads anchored ($aggregate, depth=$depth)', async ({aggregate,depth}) => {
    const {a,reads,blockReads,anchor} = fixture(aggregate,false,depth);
    const snapshot=await a.readPublicGraphSnapshot('coherent-snapshot','1');
    expect(snapshot.blockNumber).toBe(String(anchor));
    expect(snapshot.assets).toEqual([{id:'1',root:`0x${'a'.repeat(64)}`,version:'1'},{id:'2',root:`0x${'b'.repeat(64)}`,version:'2'}]);
    expect(reads.length).toBeGreaterThan(8); expect(reads.every(r=>r.tag===anchor)).toBe(true);
    expect(blockReads).toEqual(depth===1 ? ['latest',anchor] : ['latest',anchor,anchor]);
  });
  it.each(cases)('rejects anchor replacement ($aggregate, depth=$depth)', async ({aggregate,depth}) => {
    const {a} = fixture(aggregate,true,depth);
    await expect(a.readPublicGraphSnapshot('coherent-snapshot','1')).rejects.toThrow();
  });
});
