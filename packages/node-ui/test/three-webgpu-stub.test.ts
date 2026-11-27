import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WebGPURenderer } from '../src/ui/lib/three-webgpu-stub.js';

describe('three/webgpu stub', () => {
  it('says so if anything asks for the WebGPU renderer', () => {
    expect(() => new WebGPURenderer()).toThrow('The WebGPU renderer is not included in the node UI build.');
  });

  it('is what the node UI build resolves three/webgpu to', () => {
    const config = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');
    expect(config).toContain("find: /^three\\/webgpu$/");
    expect(config).toContain("'src/ui/lib/three-webgpu-stub.ts'");
  });
});
