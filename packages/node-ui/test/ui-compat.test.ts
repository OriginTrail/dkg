import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UI_DIR = resolve(__dirname, '..', 'src', 'ui');

function readFile(rel: string): string {
  return readFileSync(resolve(UI_DIR, rel), 'utf-8');
}

describe('lobby API type contract', () => {
  it('gameApi.lobby() type uses openSwarms/mySwarms, not openWagons/myWagons', () => {
    const api = readFile('api.ts');
    expect(api).toContain('openSwarms');
    expect(api).toContain('mySwarms');
    expect(api).not.toMatch(/openWagons/);
    expect(api).not.toMatch(/myWagons/);
  });

  it('Apps.tsx consumes openSwarms/mySwarms from lobby', () => {
    const apps = readFile('pages/Apps.tsx');
    expect(apps).toContain('openSwarms');
    expect(apps).toContain('mySwarms');
    expect(apps).not.toMatch(/openWagons/);
    expect(apps).not.toMatch(/myWagons/);
  });
});

describe('backward-compatible route redirects', () => {
  it('App.tsx includes redirects for /network, /operations, /wallet, /integrations', () => {
    const app = readFile('App.tsx');
    expect(app).toContain('path="/network"');
    expect(app).toContain('path="/operations/*"');
    expect(app).toContain('path="/wallet"');
    expect(app).toContain('path="/integrations"');
    for (const route of ['/network', '/operations/*', '/wallet', '/integrations']) {
      const pattern = new RegExp(`path="${route.replace('*', '\\*')}"[^>]*element=\\{<Navigate`);
      expect(app).toMatch(pattern);
    }
  });

  it('Explorer.tsx includes redirects for /publish, /history, /saved', () => {
    const explorer = readFile('pages/Explorer.tsx');
    for (const sub of ['/publish', '/history', '/saved']) {
      expect(explorer).toContain(`path="${sub}"`);
      const pattern = new RegExp(`path="${sub}"[^>]*element=\\{<Navigate`);
      expect(explorer).toMatch(pattern);
    }
  });
});

describe('CSS compatibility selectors', () => {
  const css = readFile('styles.css');

  it('includes .tab-group selector', () => {
    expect(css).toMatch(/\.tab-group\s*\{/);
  });

  it('includes .tab-item selector', () => {
    expect(css).toMatch(/\.tab-item\s*\{/);
  });

  it('includes .chat-layout selector', () => {
    expect(css).toMatch(/\.chat-layout\s*\{/);
  });

  it('includes .chat-peers selector', () => {
    expect(css).toMatch(/\.chat-peers\s*\{/);
  });

  it('includes .chat-peers-header selector', () => {
    expect(css).toMatch(/\.chat-peers-header\s*\{/);
  });

  it('includes .chat-peers-empty selector', () => {
    expect(css).toMatch(/\.chat-peers-empty\s*\{/);
  });

  it('includes .chat-peer-item selector', () => {
    expect(css).toMatch(/\.chat-peer-item\s*\{/);
  });
});
