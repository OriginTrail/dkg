import { describe, expect, it } from 'vitest';
import { canonicalModelId, inferModelFamily, MODEL_ID_PATTERN } from '../src/index.js';

describe('canonicalModelId', () => {
  it('normalizes NFC, trims and lowercases', () => {
    expect(canonicalModelId('  Stub-Chat ')).toBe('stub-chat');
    expect(canonicalModelId('Qwen/Qwen2.5-14B-Instruct:Q4_K_M')).toBe('qwen/qwen2.5-14b-instruct:q4_k_m');
    expect(canonicalModelId('gpt-5.1-codex@2026+preview')).toBe('gpt-5.1-codex@2026+preview');
    expect(canonicalModelId('a'.repeat(128))).toBe('a'.repeat(128));
  });

  it('returns undefined for anything that does not match the pattern', () => {
    for (const raw of ['', '   ', '-leading-dash', '.dot', 'has space', 'émodel', 'a'.repeat(129), 'x\ny', 'semi;colon']) {
      expect(canonicalModelId(raw), JSON.stringify(raw)).toBeUndefined();
    }
    for (const raw of [undefined, null, 42, {}, ['stub-chat']]) expect(canonicalModelId(raw)).toBeUndefined();
  });

  it('is idempotent and its outputs match MODEL_ID_PATTERN', () => {
    for (const raw of ['Stub-Chat', ' LLAMA-3 ', 'deepseek-r1']) {
      const canonical = canonicalModelId(raw)!;
      expect(MODEL_ID_PATTERN.test(canonical)).toBe(true);
      expect(canonicalModelId(canonical)).toBe(canonical);
    }
  });
});

describe('inferModelFamily', () => {
  it('ports the fork known-family table, first match wins', () => {
    expect(inferModelFamily('qwen2.5-14b-instruct')).toBe('qwen');
    expect(inferModelFamily('gpt-4o-mini')).toBe('openai');
    expect(inferModelFamily('gpt-5-codex')).toBe('openai');
    expect(inferModelFamily('o3')).toBe('openai');
    expect(inferModelFamily('deepseek-r1')).toBe('deepseek');
    expect(inferModelFamily('llama-3.1-8b')).toBe('meta');
    expect(inferModelFamily('mixtral-8x7b')).toBe('mistral');
    expect(inferModelFamily('stub-chat')).toBeUndefined();
  });
});
