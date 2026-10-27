import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { STREAM_CHAIN_SCHEME, streamChainAccumulator, streamChainVerifier } from '../src/index.js';

const frames = ['data: {"a":1}\n\n', 'data: {"b":2}\n\n', 'data: [DONE]\n\n'].map((f) => Buffer.from(f, 'utf8'));
const sha = (...parts: Uint8Array[]) => {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest();
};

function claimFor(input: Uint8Array[]) {
  const acc = streamChainAccumulator();
  for (const frame of input) acc.push(frame);
  return { streamChainRoot: acc.root(), frameCount: acc.frameCount(), bytesDigest: acc.bytesDigest() };
}

describe('stream chain', () => {
  it('chains sha256(prev ‖ frame) from sha256(scheme) and digests the reassembly', () => {
    expect(STREAM_CHAIN_SCHEME).toBe('dkg-mkt:stream:v1');
    let chain = sha(Buffer.from(STREAM_CHAIN_SCHEME));
    for (const frame of frames) chain = sha(chain, frame);
    const acc = streamChainAccumulator();
    expect(acc.root()).toBe(`sha256:${sha(Buffer.from(STREAM_CHAIN_SCHEME)).toString('hex')}`);
    for (const frame of frames) acc.push(frame);
    expect(acc.root()).toBe(`sha256:${chain.toString('hex')}`);
    expect(acc.frameCount()).toBe(3);
    expect(acc.bytesDigest()).toBe(`sha256:${sha(Buffer.concat(frames)).toString('hex')}`);
    expect(Buffer.from(acc.bytes()).equals(Buffer.concat(frames))).toBe(true);
  });

  it('verifies an untouched stream and returns the reassembled bytes', () => {
    const verifier = streamChainVerifier();
    for (const frame of frames) verifier.push(frame);
    const outcome = verifier.finalize(claimFor(frames));
    expect(outcome.ok).toBe(true);
    if (outcome.ok) expect(Buffer.from(outcome.bytes).toString('utf8')).toBe(Buffer.concat(frames).toString('utf8'));
  });

  it('detects tampered, dropped and reordered frames', () => {
    const claim = claimFor(frames);
    const tampered = [frames[0], Buffer.from('data: {"b":3}\n\n'), frames[2]];
    const dropped = [frames[0], frames[2]];
    const reordered = [frames[1], frames[0], frames[2]];
    for (const [label, received] of [['tampered', tampered], ['dropped', dropped], ['reordered', reordered]] as const) {
      const verifier = streamChainVerifier();
      for (const frame of received) verifier.push(frame);
      const outcome = verifier.finalize(claim);
      expect(outcome.ok, label).toBe(false);
      expect(claimFor([...received]).streamChainRoot, label).not.toBe(claim.streamChainRoot);
    }
    // A split frame keeps the reassembled bytes but changes the chain.
    const split = claimFor([Buffer.from('data: {"a":1}'), Buffer.from('\n\n'), frames[1], frames[2]]);
    expect(split.bytesDigest).toBe(claim.bytesDigest);
    expect(split.streamChainRoot).not.toBe(claim.streamChainRoot);
    const verifier = streamChainVerifier();
    for (const frame of frames) verifier.push(frame);
    expect(verifier.finalize(split)).toMatchObject({ ok: false }); // frame count and root differ
    const again = streamChainVerifier();
    for (const frame of frames) again.push(frame);
    expect(again.finalize({ ...claim, bytesDigest: split.streamChainRoot })).toMatchObject({ ok: false });
  });
});
