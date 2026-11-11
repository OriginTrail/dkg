import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadAdapters } from '../src/adapters.js';

const folders: string[] = [];
afterEach(() => { vi.unstubAllEnvs(); for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'pinned-mcp-adapter-'));
  folders.push(folder);
  const file = join(folder, 'adapter.mjs');
  const server = { registerTool: vi.fn() };
  const approve = (source: string) => {
    writeFileSync(file, source);
    vi.stubEnv('DKG_ADAPTERS', file);
    vi.stubEnv('DKG_ADAPTER_HASHES', JSON.stringify([{ path: file, sha256: createHash('sha256').update(source).digest('hex') }]));
  };
  return { folder, file, server, approve, load: () => loadAdapters(server as any, {} as any, {} as any) };
}

describe('Program-pinned MCP adapter entry points', () => {
  it('imports verified bytes with relative dependencies and cleans up the sibling snapshot', async () => {
    const f = fixture();
    writeFileSync(join(f.folder, 'helper.mjs'), 'export const tool = "approved-tool";');
    f.approve(`import { tool } from './helper.mjs';
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(f.file)}, 'export function registerTools() { throw new Error("unapproved") }');
      export function registerTools(server) { server.registerTool(tool); }`);
    await f.load();
    expect(f.server.registerTool).toHaveBeenCalledWith('approved-tool');
    expect(readdirSync(f.folder).some(file => file.startsWith('.dkg-pinned-'))).toBe(false);
    // A subsequent session cannot reuse the changed entry point under the old pin.
    await expect(f.load()).rejects.toThrow('PINNED_ADAPTER_CONTENT_CHANGED');
    expect(f.server.registerTool).toHaveBeenCalledOnce();
  });

  it('fails session startup if approved adapter contents were replaced', async () => {
    const f = fixture();
    f.approve('export function registerTools(server) { server.registerTool("approved"); }');
    writeFileSync(f.file, 'export function registerTools(server) { server.registerTool("changed"); }');
    await expect(f.load()).rejects.toThrow('PINNED_ADAPTER_CONTENT_CHANGED');
    expect(f.server.registerTool).not.toHaveBeenCalled();
  });

  it('does not silently skip a required adapter whose registration fails', async () => {
    const f = fixture();
    f.approve('export function registerTools() { throw new Error("registration failed"); }');
    await expect(f.load()).rejects.toThrow('registration failed');
    expect(readdirSync(f.folder).some(file => file.startsWith('.dkg-pinned-'))).toBe(false);
  });
});
