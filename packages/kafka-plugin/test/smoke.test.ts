import { describe, it, expect } from 'vitest';
import plugin, { createKafkaPlugin } from '../src/index.js';
describe('kafka-plugin skeleton', () => {
  it('default export exposes name and handle', () => {
    expect(plugin).toBeDefined();
    expect(typeof plugin.name).toBe('string');
    expect(plugin.name.length).toBeGreaterThan(0);
    expect(typeof plugin.handle).toBe('function');
  });
  it('createKafkaPlugin() returns an object with name and handle', () => {
    const p = createKafkaPlugin();
    expect(typeof p.name).toBe('string');
    expect(p.name.length).toBeGreaterThan(0);
    expect(typeof p.handle).toBe('function');
  });
  it('handle() ignores requests outside the plugin basePath without writing a response', async () => {
    const ctx = {
      req: { method: 'GET', url: '/unrelated/path', headers: { host: 'localhost' } },
      res: { writeHead: () => { throw new Error('should not write'); } },
      path: '/unrelated/path',
    } as never;
    await expect(Promise.resolve(plugin.handle(ctx))).resolves.toBeUndefined();
  });
});
