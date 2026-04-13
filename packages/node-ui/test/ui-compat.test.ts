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
  it('App.tsx routes /network as a lazy page and catch-all to AppShell', () => {
    const app = readFile('App.tsx');
    expect(app).toContain('path="/network"');
    expect(app).toContain('path="*"');
    expect(app).toContain('AppShell');
    expect(app).toContain('NetworkDebugPage');
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

describe('V10 CSS layout selectors', () => {
  const css = readFile('styles.css');

  it('includes .v10-center-tabs selector', () => {
    expect(css).toMatch(/\.v10-center-tabs\s*\{/);
  });

  it('includes .v10-center-tab selector', () => {
    expect(css).toMatch(/\.v10-center-tab\s*[\{,]/);
  });

  it('includes .v10-app and .v10-app-body selectors', () => {
    expect(css).toMatch(/\.v10-app\s*\{/);
    expect(css).toMatch(/\.v10-app-body\s*\{/);
  });

  it('includes .v10-panel-left and .v10-panel-right selectors', () => {
    expect(css).toMatch(/\.v10-panel-left\s*\{/);
    expect(css).toMatch(/\.v10-panel-right\s*\{/);
  });

  it('includes .v10-panel-center selector', () => {
    expect(css).toMatch(/\.v10-panel-center/);
  });

  it('includes .v10-chat-messages selector', () => {
    expect(css).toMatch(/\.v10-chat-messages\s*\{/);
  });

  it('includes .v10-agent-input-area selector', () => {
    expect(css).toMatch(/\.v10-agent-input-area\s*\{/);
  });

  it('includes .v10-agent-send-btn selector', () => {
    expect(css).toMatch(/\.v10-agent-send-btn\s*\{/);
  });

  it('includes .chat-bubble selector (legacy)', () => {
    expect(css).toMatch(/\.chat-bubble\s*\{/);
  });

  it('includes .v10-header-notif selectors', () => {
    expect(css).toMatch(/\.v10-header-notif/);
  });

  it('includes .dkg-btn selector', () => {
    expect(css).toMatch(/\.dkg-btn\s*\{/);
  });

  it('includes .v10-modal-btn selector', () => {
    expect(css).toMatch(/\.v10-modal-btn\s*\{/);
  });
});

describe('V10 font imports', () => {
  it('styles.css imports Google Fonts for Instrument Sans and JetBrains Mono', () => {
    const css = readFile('styles.css');
    expect(css).toMatch(/@import\s+url\s*\(/);
    expect(css).toContain('Instrument+Sans');
    expect(css).toContain('JetBrains+Mono');
  });
});

describe('dashboard uses runtime data', () => {
  const dashboard = readFile('pages/Dashboard.tsx');

  it('imports fetchContextGraphs and fetchAgents', () => {
    expect(dashboard).toContain('fetchContextGraphs');
    expect(dashboard).toContain('fetchAgents');
  });

  it('stat cards use live data with fallback', () => {
    expect(dashboard).toContain('totalKCs');
    expect(dashboard).toContain('peerCount');
    expect(dashboard).toContain('agentCount');
  });

  it('card is labeled Knowledge Collections, not Knowledge Assets', () => {
    expect(dashboard).toMatch(/Knowledge Collections/);
    expect(dashboard).not.toMatch(/['"]Knowledge Assets['"]/);
  });

  it('KC breakdown only renders when both confirmed and tentative are present', () => {
    expect(dashboard).toMatch(/confirmedKCs\s*!=\s*null\s*&&\s*tentativeKCs\s*!=\s*null/);
  });

  it('falls back to total_kcs, not total_triples, for KC count', () => {
    expect(dashboard).toMatch(/total_kcs/);
    expect(dashboard).not.toMatch(/total_triples/);
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

  it('context graph list uses id as React key, not name', () => {
    expect(dashboard).toMatch(/key=\{p\.id/);
    expect(dashboard).not.toMatch(/key=\{p\.name\}/);
  });

  it('status text uses live context graph count, not fallback data', () => {
    expect(dashboard).toMatch(/contextGraphs\.length\s*\?.*participating in/);
    expect(dashboard).not.toMatch(/displayParanets\.length\s*\?.*participating in/);
  });
});

describe('header uses live status', () => {
  const header = readFileSync(resolve(UI_DIR, 'components', 'Shell', 'Header.tsx'), 'utf-8');

  it('header health reads from nodeStatus, not hardcoded values', () => {
    expect(header).not.toMatch(/['"]14 peers['"]/);
    expect(header).toContain('nodeStatus');
    expect(header).toContain('connectedPeers');
  });

  it('App.tsx polls status via useLiveStatus and stores in agents store', () => {
    const app = readFile('App.tsx');
    expect(app).toContain('useLiveStatus');
    expect(app).toContain('setNodeStatus');
    expect(app).toContain('api.fetchStatus()');
  });

  it('header gracefully handles missing status data', () => {
    expect(header).toMatch(/nodeStatus\?\.connectedPeers\s*\?\?\s*nodeStatus\?\.peerCount/);
  });
});

describe('explorer graph query safety', () => {
  const explorer = readFile('pages/Explorer.tsx');

  it('validates context graph URI as safe IRI before interpolating', () => {
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

describe('SPARQL helper cards', () => {
  const explorer = readFile('pages/Explorer.tsx');

  it('includes required helper cards', () => {
    const helperBlockMatch = explorer.match(
      /const QUERY_HELPERS:\s*Array<\{[^}]+\}>\s*=\s*\[([\s\S]*?)\n\];/,
    );
    expect(helperBlockMatch).not.toBeNull();
    const helperBlock = helperBlockMatch?.[1] ?? '';
    expect(helperBlock).toContain("title: 'All triples + provenance'");
    expect(helperBlock).toContain("title: 'Agent Registry Snapshot'");
    expect(helperBlock).toContain("title: 'Ontology Context Graph Concepts'");
  });

  it('includes agents template as direct SPO query on agents context graph graph', () => {
    expect(explorer).toContain('GRAPH <did:dkg:context-graph:agents>');
    expect(explorer).toContain('SELECT ?s ?p ?o WHERE');
  });

  it('runs helper query immediately on card click', () => {
    expect(explorer).toContain('runQuery(helper.query)');
  });

  it('auto-runs default query on first page load', () => {
    expect(explorer).toContain('if (autoRan) return;');
    expect(explorer).toContain('runQuery(sparql)');
  });

  it('derives triples from executed query, not live editor text', () => {
    expect(explorer).toContain('const [executedQuery, setExecutedQuery] = useState(initialQuery);');
    expect(explorer).toContain('setExecutedQuery(query);');
    expect(explorer).toContain('deriveGraphTriples(result, executedQuery)');
  });

  it('uses token-aware SPARQL comment stripping (keeps # inside IRIs)', () => {
    expect(explorer).toContain("from '../sparql-utils.js'");
    expect(explorer).not.toContain("sparql.replace(/#[^\\n\\r]*/g, ' ')");
  });

  it('expands triples to one row per (s,p,o,g) when provenance exists', () => {
    expect(explorer).toContain('buildTripleRowsWithProvenance(triples, rows)');
    expect(explorer).not.toContain('No provenance metadata found in named graphs for these triples');
  });

  it('does not double-encode already serialized RDF terms in VALUES/N-Quads rendering', () => {
    expect(explorer).toContain('function isSerializedRdfTerm');
    expect(explorer).toContain('if (isSerializedRdfTerm(value)) return value;');
  });

  it('normalizes quoted source literals and keeps EVM addresses when present', () => {
    expect(explorer).toContain('const literalMatch = v.match(');
    expect(explorer).toContain('/^0x[a-fA-F0-9]{40}$/');
  });

  it('uses separate metadata source variables instead of reusing ?source', () => {
    expect(explorer).toContain('SELECT ?g ?metaGraph ?workspaceOwner ?creator ?publisherPeerId ?publisherAddress ?publisher ?ual ?txHash ?timestamp');
    expect(explorer).toContain('?workspaceOwner');
    expect(explorer).toContain('?publisherPeerId');
  });

  it('queries provenance from companion meta graphs mapped per data graph', () => {
    expect(explorer).toContain('metaGraphsForDataGraph');
    expect(explorer).toContain('VALUES (?g ?metaGraph)');
    expect(explorer).toContain('GRAPH ?metaGraph');
  });

  it('uses _shared_memory suffix when deriving companion meta graphs', () => {
    expect(explorer).toContain("g.endsWith('/_shared_memory')");
    expect(explorer).not.toContain("g.endsWith('/shared-memory')");
  });

  it('guards runQuery state updates against out-of-order responses', () => {
    expect(explorer).toContain('const runSeqRef = useRef(0);');
    expect(explorer).toContain('if (runSeq !== runSeqRef.current) return;');
  });

  it('falls back to generic row rendering for non-triple query results', () => {
    expect(explorer).toContain('function ResultBindingsFallback');
    expect(explorer).toContain('if (!triples.length) return <ResultBindingsFallback result={result} />;');
    expect(explorer).toContain('<ResultJsonLd triples={derivedTriples} rawResult={result} />');
    expect(explorer).toContain('<ResultNQuads triples={derivedTriples} rawResult={result} />');
  });

  it('parses serialized RDF literals for JSON-LD output', () => {
    expect(explorer).toContain('function parseSerializedRdfLiteral');
    expect(explorer).toContain("literalNode['@language']");
    expect(explorer).toContain("literalNode['@type']");
  });
});

describe('Apps.tsx iframe embedding', () => {
  const apps = readFile('pages/Apps.tsx');

  it('never uses allow-same-origin in sandbox policy', () => {
    expect(apps).toContain('sandbox="allow-scripts allow-forms allow-popups"');
    expect(apps).not.toMatch(/sandbox=.*allow-same-origin/);
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

  it('does not use req.socket.remoteAddress for localhost/auth detection (rate-limit use is OK)', () => {
    const authSection = daemon.slice(daemon.indexOf('boundToLoopback'), daemon.indexOf('boundToLoopback') + 500);
    expect(authSection).not.toContain('req.socket.remoteAddress');
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

describe('clickable notifications', () => {
  const header = readFileSync(resolve(UI_DIR, 'components', 'Shell', 'Header.tsx'), 'utf-8');

  it('Header has notification bell with dropdown', () => {
    expect(header).toContain('BELL_ICON');
    expect(header).toContain('v10-header-notif-dropdown');
    expect(header).toContain('setShowNotifs');
  });

  it('notifications are fetched and displayed', () => {
    expect(header).toContain('fetchNotifications');
    expect(header).toContain('setNotifications');
    expect(header).toContain('v10-header-notif-item');
  });

  it('notification dropdown shows unread badge', () => {
    expect(header).toContain('v10-header-notif-badge');
    expect(header).toContain('unread');
  });

  it('notification dropdown closes on outside click', () => {
    expect(header).toContain('notifRef');
    expect(header).toContain('setShowNotifs(false)');
    expect(header).toContain('mousedown');
  });

  it('notifications are marked as read when opened', () => {
    expect(header).toContain('markNotificationsRead');
    expect(header).toContain('setUnread(0)');
  });

  it('notification items show message and timestamp', () => {
    expect(header).toContain('n.message');
    expect(header).toContain('n.ts');
    expect(header).toContain('toLocaleTimeString');
  });

  it('empty state shown when no notifications', () => {
    expect(header).toContain('No notifications');
    expect(header).toContain('v10-header-notif-empty');
  });
});

describe('right-rail agent shell replaces Agent Hub', () => {
  const app = readFile('App.tsx');
  const panelLeft = readFile('components/Shell/PanelLeft.tsx');
  const panelCenter = readFile('components/Shell/PanelCenter.tsx');
  const panelRight = readFile('components/Shell/PanelRight.tsx');
  const api = readFile('api.ts');

  it('App has no floating ChatPanel', () => {
    expect(app).not.toContain('ChatPanel');
    expect(app).not.toContain('chat-fab');
  });

  it('App uses V10 shell with three-panel layout', () => {
    expect(app).toContain('v10-app');
    expect(app).toContain('v10-app-body');
    expect(app).toContain('PanelLeft');
    expect(app).toContain('PanelCenter');
    expect(app).toContain('PanelRight');
  });

  it('hides the duplicate left-nav Agent Hub entry while keeping the internal route alive', () => {
    expect(panelLeft).not.toContain("id: 'agent-hub'");
    expect(panelLeft).not.toContain('Agent Hub');
    expect(panelCenter).toContain("activeTabId === 'agent-hub'");
  });

  it('moves connected-agent chat into the right rail with Agents, Network, and Sessions tabs', () => {
    expect(panelRight).toContain("useState<'agents' | 'network' | 'sessions'>('agents')");
    expect(panelRight).toContain('function NetworkTab');
    expect(panelRight).toContain('function SessionsTab');
    expect(panelRight).not.toContain('Assistant');
  });

  it('frontend api keeps memory sessions and local-agent connect helpers', () => {
    expect(api).toContain('fetchMemorySessions');
    expect(api).toContain('connectLocalAgentIntegration');
    expect(api).toContain('streamLocalAgentChat');
    expect(api).not.toContain('/api/chat-assistant');
    expect(api).toContain('/api/memory/sessions');
  });
});

describe('backward-compatible URL redirects (V10 consolidation)', () => {
  const app = readFile('App.tsx');

  for (const path of ['/agent', '/explorer', '/apps/*', '/settings', '/messages']) {
    it(`redirects ${path} to /`, () => {
      expect(app).toContain(`path="${path}"`);
      const pattern = new RegExp(`path="${path.replace('*', '\\*')}".*element=\\{<Navigate to="/"`);
      expect(app).toMatch(pattern);
    });
  }

  it('uses replace to avoid pushing redirect onto history', () => {
    const redirectSection = app.slice(app.indexOf('path="/agent"'), app.indexOf('path="*"'));
    expect(redirectSection).toContain('replace');
  });
});

describe('synced status logic', () => {
  const header = readFileSync(resolve(UI_DIR, 'components', 'Shell', 'Header.tsx'), 'utf-8');

  it('uses statusLoaded guard before evaluating synced', () => {
    expect(header).toContain('const statusLoaded = nodeStatus != null');
    expect(header).toMatch(/const synced = statusLoaded && nodeStatus\?\.synced !== false/);
  });

  it('shows synced/syncing text based on synced state', () => {
    expect(header).toMatch(/synced \? ['"]synced['"] : ['"]syncing['"]/);
  });

  it('status dot uses online/offline class', () => {
    expect(header).toContain("synced ? 'online' : 'offline'");
  });
});

describe('clickable notification items', () => {
  const header = readFileSync(resolve(UI_DIR, 'components', 'Shell', 'Header.tsx'), 'utf-8');

  it('conditionally adds clickable class for peer notifications', () => {
    expect(header).toContain("n.peer ? 'clickable' : ''");
  });

  it('sets role=button and tabIndex for keyboard accessibility', () => {
    expect(header).toContain("role={n.peer ? 'button' : undefined}");
    expect(header).toContain("tabIndex={n.peer ? 0 : undefined}");
  });

  it('handles Enter and Space key events', () => {
    expect(header).toContain("e.key === 'Enter'");
    expect(header).toContain("e.key === ' '");
  });

  it('closes notification dropdown on peer click', () => {
    expect(header).toMatch(/onClick=\{.*setShowNotifs\(false\)/s);
    expect(header).toMatch(/onKeyDown=\{.*setShowNotifs\(false\)/s);
  });
});

describe('dashboard import target derived from cgData', () => {
  const dashboard = readFile('views/DashboardView.tsx');

  it('import memories checks cgData.contextGraphs, not projects store', () => {
    expect(dashboard).toContain("const cgs = cgData?.contextGraphs ?? []");
    expect(dashboard).toContain("cgs.length > 0");
  });

  it('ImportFilesModal target comes from cgData, not activeProjectId', () => {
    expect(dashboard).toMatch(/contextGraphId=\{\(cgData\?\.contextGraphs \?\? \[\]\)\[0\]\?\.id/);
    expect(dashboard).toMatch(/contextGraphName=\{\(cgData\?\.contextGraphs \?\? \[\]\)\[0\]\?\.name/);
  });

  it('shows create-project when no context graphs exist', () => {
    expect(dashboard).toContain('setShowCreateProject(true)');
  });
});

describe('file serving security (daemon)', () => {
  const daemon = readFileSync(resolve(CLI_DIR, 'daemon.ts'), 'utf-8');

  it('uses SAFE_PREVIEW_TYPES allowlist for content types', () => {
    expect(daemon).toContain('SAFE_PREVIEW_TYPES');
  });

  it('does NOT allow text/html inline (XSS vector)', () => {
    const safeTypesMatch = daemon.match(/SAFE_PREVIEW_TYPES = new Set\(\[([\s\S]*?)\]\)/);
    expect(safeTypesMatch).not.toBeNull();
    const safeTypes = safeTypesMatch![1];
    expect(safeTypes).not.toContain('text/html');
    expect(safeTypes).not.toContain('image/svg+xml');
  });

  it('sends nosniff header to prevent MIME sniffing', () => {
    expect(daemon).toContain("'X-Content-Type-Options': 'nosniff'");
  });

  it('uses private cache control', () => {
    expect(daemon).toContain("'Cache-Control': 'private, max-age=3600'");
  });

  it('forces attachment disposition for unsafe types', () => {
    expect(daemon).toMatch(/SAFE_PREVIEW_TYPES\.has\(rawCt\) \? 'inline' : 'attachment'/);
  });
});

describe('fileUrl hash handling', () => {
  const api = readFile('api.ts');

  it('preserves keccak256: prefix in file URLs', () => {
    expect(api).toContain("hash.startsWith('keccak256:')");
  });

  it('preserves sha256: prefix in file URLs', () => {
    expect(api).toContain("hash.startsWith('sha256:')");
  });

  it('defaults bare hashes to sha256: prefix', () => {
    expect(api).toContain('`${BASE}/api/file/sha256:${hash}');
  });
});

describe('listAssertions query path', () => {
  const api = readFile('api.ts');

  it('uses executeQuery without view param (avoids agentAddress requirement)', () => {
    expect(api).toMatch(/listAssertions[\s\S]*?executeQuery\(sparql, contextGraphId\)/);
    expect(api).not.toMatch(/listAssertions[\s\S]*?view:\s*'working-memory'/);
  });
});

describe('mock detection request fan-out guard', () => {
  const wrapper = readFile('api-wrapper.ts');

  it('deduplicates concurrent mock-mode detection through a shared promise', () => {
    expect(wrapper).toContain('let detectMockModePromise: Promise<boolean> | null = null;');
    expect(wrapper).toContain('if (detectMockModePromise) return detectMockModePromise;');
    expect(wrapper).toContain('detectMockModePromise = (async () => {');
  });
});

describe('memory layer custom query execution', () => {
  const memoryLayerView = readFile('views/MemoryLayerView.tsx');

  it('keeps draft query separate from the active query used by executeQuery', () => {
    expect(memoryLayerView).toContain("const [draftQuery, setDraftQuery] = useState('');");
    expect(memoryLayerView).toContain("const [activeQuery, setActiveQuery] = useState('');");
    expect(memoryLayerView).toContain('const sparql = activeQuery || defaultSparql;');
  });

  it('runs custom query on explicit Run or Enter instead of every keystroke', () => {
    expect(memoryLayerView).toContain('const runQuery = useCallback(() => {');
    expect(memoryLayerView).toContain('onChange={(e) => setDraftQuery(e.target.value)}');
    expect(memoryLayerView).toContain("onKeyDown={(e) => { if (e.key === 'Enter') runQuery(); }}");
    expect(memoryLayerView).toContain('<button className="v10-mlv-run-btn" onClick={runQuery}>');
  });
});
