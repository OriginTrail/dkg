import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const UI_DIR = resolve(__dirname, '..', 'src', 'ui');
const CLI_DIR = resolve(__dirname, '..', '..', 'cli', 'src');

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
      const escaped = route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const pattern = new RegExp(`path="${escaped}"[^>]*element=\\{<Navigate`);
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

  it('includes .chat-main selector', () => {
    expect(css).toMatch(/\.chat-main\s*\{/);
  });

  it('includes .chat-messages selector', () => {
    expect(css).toMatch(/\.chat-messages\s*\{/);
  });

  it('includes .chat-input-area selector', () => {
    expect(css).toMatch(/\.chat-input-area\s*\{/);
  });

  it('includes .chat-send-btn selector', () => {
    expect(css).toMatch(/\.chat-send-btn\s*\{/);
  });

  it('includes .chat-empty selector', () => {
    expect(css).toMatch(/\.chat-empty\s*\{/);
  });

  it('includes .chat-bubble selector', () => {
    expect(css).toMatch(/\.chat-bubble\s*\{/);
  });

  it('includes .chat-no-selection selector', () => {
    expect(css).toMatch(/\.chat-no-selection\s*\{/);
  });

  it('includes .chat-send-error selector', () => {
    expect(css).toMatch(/\.chat-send-error\s*\{/);
  });

  it('includes .chat-delivery selector', () => {
    expect(css).toMatch(/\.chat-delivery\s*\{/);
  });

  it('includes .chat-spinner animation', () => {
    expect(css).toMatch(/\.chat-spinner\s*\{/);
  });

  it('includes .badge, .badge-info, .badge-success selectors', () => {
    expect(css).toMatch(/\.badge\s*\{/);
    expect(css).toMatch(/\.badge-info\s*\{/);
    expect(css).toMatch(/\.badge-success\s*\{/);
  });

  it('includes .btn and .btn-primary selectors', () => {
    expect(css).toMatch(/\.btn\s*\{/);
    expect(css).toMatch(/\.btn-primary\s*\{/);
  });
});

describe('no external CDN font imports', () => {
  it('styles.css does not import from external CDN', () => {
    const css = readFile('styles.css');
    expect(css).not.toMatch(/@import\s+url\s*\(\s*['"]https?:\/\//);
  });
});

describe('dashboard uses runtime data', () => {
  const dashboard = readFile('pages/Dashboard.tsx');

  it('imports fetchParanets and fetchAgents', () => {
    expect(dashboard).toContain('fetchParanets');
    expect(dashboard).toContain('fetchAgents');
  });

  it('stat cards use live data with fallback', () => {
    expect(dashboard).toContain('totalAssets');
    expect(dashboard).toContain('peerCount');
    expect(dashboard).toContain('agentCount');
  });

  it('agentCount preserves zero (does not use || null)', () => {
    expect(dashboard).not.toMatch(/agents.*\)\.length\s*\|\|\s*null/);
    expect(dashboard).toMatch(/agentData\?\.agents\s*!=\s*null/);
  });

  it('activity feed is labeled DEMO, not LIVE', () => {
    expect(dashboard).not.toMatch(/['"]LIVE['"]/);
    expect(dashboard).toContain('DEMO');
  });

  it('publish CTA is disabled with coming-soon state', () => {
    expect(dashboard).toMatch(/coming soon/i);
  });
});

describe('sidebar uses live status', () => {
  const app = readFile('App.tsx');

  it('sidebar health reads from liveStatus, not hardcoded values', () => {
    expect(app).not.toMatch(/['"]14 peers['"]/);
    expect(app).toContain('liveStatus');
    expect(app).toContain('connectedPeers');
  });

  it('apps nav renders dynamic installedApps', () => {
    expect(app).toContain('installedApps');
    expect(app).toMatch(/installedApps\.filter/);
  });
});

describe('explorer graph query safety', () => {
  const explorer = readFile('pages/Explorer.tsx');

  it('validates paranet URI as safe IRI before interpolating', () => {
    expect(explorer).toContain('validateIri');
    expect(explorer).toContain('SAFE_IRI_RE');
  });

  it('uses single FILTER with exact + prefix match (no UNION double-count)', () => {
    expect(explorer).toMatch(/FILTER\(\?g\s*=\s*</);
    expect(explorer).toMatch(/STRSTARTS\(STR\(\?g\),\s*".*\/"\)/);
  });
});

describe('iframe onError fallback', () => {
  it('AppHostPage handles onError by falling back to app.path', () => {
    const appHost = readFile('pages/AppHost.tsx');
    expect(appHost).toContain('onError');
    expect(appHost).toContain('handleError');
    expect(appHost).toContain('triedStatic');
  });
});

describe('x-forwarded-proto allowlist', () => {
  it('app-loader normalizes proto to http/https only', () => {
    const loader = readFileSync(resolve(CLI_DIR, 'app-loader.ts'), 'utf-8');
    expect(loader).toContain('ALLOWED_PROTOS');
    expect(loader).toMatch(/new Set\(\[['"]http['"],\s*['"]https['"]\]\)/);
  });

  it('app-loader comment correctly states apps share one origin', () => {
    const loader = readFileSync(resolve(CLI_DIR, 'app-loader.ts'), 'utf-8');
    expect(loader).toContain('all apps');
    expect(loader).toContain('share a single static-server origin');
    expect(loader).not.toMatch(/gives each app a different.*origin/);
  });
});
