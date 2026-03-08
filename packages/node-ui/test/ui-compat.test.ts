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

  it('Apps.tsx embeds the game via iframe (lobby logic moved to standalone app)', () => {
    const apps = readFile('pages/Apps.tsx');
    expect(apps).toContain('iframe');
    expect(apps).toContain('/apps/origin-trail-game/');
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

  it('Import Memories modal is functional (no longer coming-soon)', () => {
    expect(dashboard).toMatch(/importMemories/);
    expect(dashboard).toMatch(/Import as Private Knowledge/);
  });

  it('paranet list uses id as React key, not name', () => {
    expect(dashboard).toMatch(/key=\{p\.id/);
    expect(dashboard).not.toMatch(/key=\{p\.name\}/);
  });

  it('status text uses live paranet count, not fallback data', () => {
    expect(dashboard).toMatch(/paranets\.length\s*\?.*participating in/);
    expect(dashboard).not.toMatch(/displayParanets\.length\s*\?.*participating in/);
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

  it('clears status to null on fetch failure so stale data is not shown', () => {
    expect(app).toMatch(/\.catch\(\(\)\s*=>\s*\{[^}]*setStatus\(null\)/);
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

  it('membership query uses same exact+prefix filter as main query', () => {
    const membershipSection = explorer.slice(explorer.indexOf('membershipSparql'));
    expect(membershipSection).toMatch(/FILTER\(\?g\s*=\s*</);
    expect(membershipSection).toMatch(/STRSTARTS\(STR\(\?g\),\s*".*\/"\)/);
  });
});

describe('Apps.tsx iframe embedding', () => {
  const apps = readFile('pages/Apps.tsx');

  it('omits allow-same-origin when separate-origin static server is used', () => {
    expect(apps).toContain("'allow-scripts allow-forms allow-popups'");
  });

  it('falls back to allow-same-origin only for same-origin path', () => {
    expect(apps).toContain("'allow-scripts allow-same-origin allow-forms allow-popups'");
    expect(apps).toContain('isSeparateOrigin');
  });

  it('uses onError fallback instead of CORS-blocked HEAD probe', () => {
    expect(apps).toContain('onError={handleIframeError}');
    expect(apps).toContain('triedStaticRef');
    expect(apps).not.toMatch(/fetch\(.*staticUrl.*HEAD/);
  });

  it('uses nonce handshake before sending token', () => {
    expect(apps).toContain('postMessage');
    expect(apps).toContain('dkg-nonce');
    expect(apps).toContain('randomUUID');
    expect(apps).toMatch(/nonceRef\.current\s*=\s*null/);
  });

  it('listens for dkg-token-request and validates nonce', () => {
    expect(apps).toContain('dkg-token-request');
    expect(apps).toContain('addEventListener');
    expect(apps).toContain('validateTokenRequest');
  });

  it('allows re-auth on legitimate reloads (no permanent handshake gate)', () => {
    expect(apps).not.toMatch(/handshakeCompleteRef/);
  });

  it('exports validateTokenRequest as a testable pure function', () => {
    expect(apps).toContain('export function validateTokenRequest');
  });
});

describe('validateTokenRequest (pure handshake logic)', () => {
  // The function is exported from Apps.tsx. Since that file imports React/DOM
  // which aren't available in this Node-only test, we extract and eval just
  // the pure function from the source to test the real implementation.
  let validateTokenRequest: (nonce: string | null, requestNonce: unknown) => boolean;

  const fnMatch = readFile('pages/Apps.tsx').match(
    /export function validateTokenRequest\([^)]*\)[^{]*\{([^}]+)\}/,
  );
  if (fnMatch) {
    validateTokenRequest = new Function('nonce', 'requestNonce', fnMatch[1]) as any;
  } else {
    throw new Error('Could not extract validateTokenRequest from Apps.tsx');
  }

  it('accepts matching nonce', () => {
    expect(validateTokenRequest('abc-123', 'abc-123')).toBe(true);
  });

  it('rejects wrong nonce', () => {
    expect(validateTokenRequest('abc-123', 'wrong')).toBe(false);
  });

  it('rejects when stored nonce is null (no pending handshake)', () => {
    expect(validateTokenRequest(null, 'abc-123')).toBe(false);
  });

  it('rejects non-string request nonce', () => {
    expect(validateTokenRequest('abc', 42)).toBe(false);
    expect(validateTokenRequest('abc', undefined)).toBe(false);
    expect(validateTokenRequest('abc', null)).toBe(false);
  });

  it('allows successive handshakes (each with new nonce)', () => {
    expect(validateTokenRequest('n1', 'n1')).toBe(true);
    expect(validateTokenRequest('n2', 'n2')).toBe(true);
    expect(validateTokenRequest('n3', 'n3')).toBe(true);
  });
});

describe('iframe app hosting', () => {
  const appHost = readFile('pages/AppHost.tsx');

  it('preflights staticUrl with fetch before setting iframe src', () => {
    expect(appHost).toContain('fetch(app.staticUrl');
    expect(appHost).toContain('triedStatic');
  });

  it('still handles onError as secondary fallback', () => {
    expect(appHost).toContain('onError');
    expect(appHost).toContain('handleError');
  });
});

describe('daemon.ts app token injection', () => {
  const daemon = readFileSync(resolve(CLI_DIR, 'daemon.ts'), 'utf-8');

  it('does not use req.socket.remoteAddress for localhost detection', () => {
    expect(daemon).not.toContain('req.socket.remoteAddress');
  });

  it('checks config.apiHost for loopback, not remote address', () => {
    expect(daemon).toContain('config.apiHost');
    expect(daemon).toMatch(/boundToLoopback/);
  });

  it('prefers verified bearer token over loopback fallback', () => {
    expect(daemon).toMatch(/extractBearerToken/);
    expect(daemon).toMatch(/validTokens\.has\(reqToken\)/);
  });

  it('only falls back to loopback injection for /apps/* paths', () => {
    expect(daemon).toMatch(/reqUrl\.pathname\.startsWith\(['"]\/apps\//);
  });
});

describe('app-loader token-injected HTML CORS', () => {
  it('omits Access-Control-Allow-Origin when authToken is present', () => {
    const loader = readFileSync(resolve(CLI_DIR, 'app-loader.ts'), 'utf-8');
    expect(loader).toMatch(/if\s*\(\s*!authToken\s*\)\s*headers\[['"]Access-Control-Allow-Origin['"]\]/);
  });
});

describe('x-forwarded-proto allowlist', () => {
  it('app-loader normalizes proto to http/https only', () => {
    const loader = readFileSync(resolve(CLI_DIR, 'app-loader.ts'), 'utf-8');
    expect(loader).toContain('ALLOWED_PROTOS');
    expect(loader).toMatch(/new Set\(\[['"]http['"],\s*['"]https['"]\]\)/);
  });

  it('app-loader does not claim apps get separate origins', () => {
    const loader = readFileSync(resolve(CLI_DIR, 'app-loader.ts'), 'utf-8');
    expect(loader).not.toMatch(/gives each app a different.*origin/);
    expect(loader).toContain('ALLOWED_PROTOS');
  });
});

describe('Agent Hub merged with messages and private memories', () => {
  const app = readFile('App.tsx');
  const agentHub = readFile('pages/AgentHub.tsx');
  const api = readFile('api.ts');

  it('App has no floating ChatPanel', () => {
    expect(app).not.toContain('ChatPanel');
    expect(app).not.toContain('chat-fab');
  });

  it('App redirects /messages to /agent', () => {
    expect(app).toContain('path="/messages"');
    expect(app).toContain('Navigate to="/agent"');
  });

  it('AgentHub has no mocked agents or canned responses', () => {
    expect(agentHub).not.toMatch(/AGENTS\s*=\s*\[/);
    expect(agentHub).not.toMatch(/CANNED\s*[:=]/);
    expect(agentHub).not.toMatch(/pickResponses/);
  });

  it('AgentHub uses real APIs for chat and memory', () => {
    expect(agentHub).toContain('fetchMemorySessions');
    expect(agentHub).toContain('fetchMemorySession');
    expect(agentHub).toContain('sendChatMessage');
    expect(agentHub).toContain('New Chat');
    expect(agentHub).toContain('openSession');
    expect(agentHub).toContain('visualizeSession');
  });

  it('AgentHub has graph visualization and timeline slider', () => {
    expect(agentHub).toContain('RdfGraph');
    expect(agentHub).toContain('timelineCursor');
    expect(agentHub).toContain('visualizeSession');
  });

  it('frontend api has memory sessions and sendChatMessage with sessionId', () => {
    expect(api).toContain('fetchMemorySessions');
    expect(api).toContain('sendChatMessage');
    expect(api).toContain('sessionId');
    expect(api).toContain('/api/memory/sessions');
  });
});
