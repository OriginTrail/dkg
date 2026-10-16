import { describe, expect, it } from 'vitest';
import { encodeBulkGraphFrame, decodeBulkGraphFrames, BULK_GRAPH_KIND as K } from '../src/bulk-graph-wire.js';
async function decode(bytes: Uint8Array, width: number) {
  async function* source() { for(let n=0;n<bytes.length;n+=width) yield bytes.subarray(n,n+width); }
  const result=[]; for await(const frame of decodeBulkGraphFrames(source())) result.push(frame); return result;
}
describe('versioned bulk graph wire', () => {
  it('preserves credit versus commit semantics and indices beyond the old ten-asset bound', async () => {
    const frames=[{kind:K.META,index:565,sequence:0,payload:new TextEncoder().encode('{}')},
      {kind:K.CREDIT,index:565,sequence:4096,payload:new Uint8Array()},
      {kind:K.COMMIT,index:565,sequence:4096,payload:new Uint8Array()}];
    const bytes=Buffer.concat(frames.map(encodeBulkGraphFrame));
    for(const size of [1,7,20,1024]) expect(await decode(bytes,size)).toEqual(frames);
  });
  it('rejects old wire magic, reserved bits, excessive lengths and truncated data', async () => {
    const good=encodeBulkGraphFrame({kind:K.DATA,index:0,sequence:0,payload:new Uint8Array([1])});
    for(const offset of [0,5]) { const bad=good.slice(); bad[offset]=255; await expect(decode(bad,7)).rejects.toThrow(); }
    const big=good.slice(0,20); new DataView(big.buffer).setUint32(16,0xffffffff);
    await expect(decode(big,20)).rejects.toThrow('length');
    await expect(decode(good.slice(0,20),20)).rejects.toThrow('Truncated');
  });
});
