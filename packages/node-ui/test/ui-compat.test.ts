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

  it('Import Memories modal and its client helpers are absent (retired with /api/memory/import)', () => {
    // The Dashboard modal, the `importMemories` client helper, and the
    // "Import as Private Knowledge" button copy were all deleted as part
    // of the openclaw-dkg-primary-memory retire-and-replace work. Agents
    // write memory via the adapter's dkg_memory_import tool now, and file
    // imports go through /api/assertion/:name/import-file directly.
    expect(dashboard).not.toMatch(/importMemories/);
    expect(dashboard).not.toMatch(/Import as Private Knowledge/);
    expect(dashboard).not.toMatch(/ImportModal/);
    expect(dashboard).not.toMatch(/ImportResultView/);
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

describe('notification items are non-interactive until peer chat exists', () => {
  const header = readFileSync(resolve(UI_DIR, 'components', 'Shell', 'Header.tsx'), 'utf-8');

  it('does not add clickable class to notification items', () => {
    expect(header).not.toContain("'clickable'");
  });

  it('does not set role=button on notification items', () => {
    expect(header).not.toMatch(/role=\{.*'button'/);
  });

  it('renders notification text and timestamp', () => {
    expect(header).toContain('v10-header-notif-item-text');
    expect(header).toContain('v10-header-notif-item-time');
    expect(header).toContain('toLocaleTimeString');
  });
});

describe('dashboard import target uses explicit selection', () => {
  const dashboard = readFile('views/DashboardView.tsx');

  it('import memories resolves target from active project or cgData', () => {
    expect(dashboard).toContain('importTargetId');
    expect(dashboard).toContain('setImportTargetId');
  });

  it('prefers active project when selecting import target', () => {
    expect(dashboard).toContain('activeProject');
    expect(dashboard).toMatch(/cgs\.find.*activeProject/);
  });

  it('ImportFilesModal receives importTargetId, not hardcoded [0]', () => {
    expect(dashboard).toMatch(/contextGraphId=\{importTargetId/);
    expect(dashboard).not.toMatch(/contextGraphId=\{.*\[0\]/);
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

describe('FilePreviewModal types aligned with server', () => {
  const modal = readFileSync(resolve(UI_DIR, 'components', 'Modals', 'FilePreviewModal.tsx'), 'utf-8');

  it('does not treat text/html as previewable (XSS vector)', () => {
    const typesMatch = modal.match(/PREVIEWABLE_TYPES[^=]*=\s*\{([\s\S]*?)\}/);
    expect(typesMatch).not.toBeNull();
    const types = typesMatch![1];
    expect(types).not.toContain("'text/html'");
  });

  it('does not treat image/svg+xml as previewable (XSS vector)', () => {
    const typesMatch = modal.match(/PREVIEWABLE_TYPES[^=]*=\s*\{([\s\S]*?)\}/);
    expect(typesMatch).not.toBeNull();
    const types = typesMatch![1];
    expect(types).not.toContain("'image/svg+xml'");
  });

  it('includes safe image types', () => {
    expect(modal).toContain("'image/png': 'image'");
    expect(modal).toContain("'image/jpeg': 'image'");
    expect(modal).toContain("'image/webp': 'image'");
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
    expect(api).toContain('`${BASE}/api/file/${encodeURIComponent(normalizedHash)}${params}`');
  });
});

describe('listAssertions query path', () => {
  const api = readFile('api.ts');

  it('uses executeQuery without view param (avoids agentAddress requirement)', () => {
    expect(api).toMatch(/listAssertions[\s\S]*?executeQuery\(sparql, contextGraphId\)/);
    expect(api).not.toMatch(/listAssertions[\s\S]*?view:\s*'working-memory'/);
  });
});

describe('useMemoryEntities hook', () => {
  const hook = readFileSync(resolve(UI_DIR, 'hooks', 'useMemoryEntities.ts'), 'utf-8');

  it('exports TrustLevel type with three levels', () => {
    expect(hook).toContain("type TrustLevel = 'working' | 'shared' | 'verified'");
  });

  it('queries WM, SWM, and VM in parallel', () => {
    // Hook was refactored from `view: 'shared-working-memory' | 'verified-memory'`
    // to per-layer SPARQL builders that walk the named-graph space directly
    // (see the rationale comment in useMemoryEntities.ts) so per-sub-graph
    // SWM/VM partitions are covered and each triple carries its source `?g`.
    // The original intent of this test — that all three layers are fetched
    // in parallel — is still asserted, just against the new shape.
    expect(hook).toContain('Promise.all');
    expect(hook).toContain('wmSparql');
    expect(hook).toContain('swmSparql');
    expect(hook).toContain('vmSparql');
  });

  it('builds entity map grouped by subject URI', () => {
    expect(hook).toContain('buildEntities');
    expect(hook).toContain('Map<string, MemoryEntity>');
  });

  it('computes trust level from layer presence', () => {
    expect(hook).toContain("entity.layers.has('verified')");
    expect(hook).toContain("entity.layers.has('shared')");
  });

  it('resolves entity labels from name predicates', () => {
    expect(hook).toContain('schema.org/name');
    expect(hook).toContain('rdf-schema#label');
  });

  it('deduplicates triples across layers for graph data', () => {
    expect(hook).toContain('const seen = new Set<string>()');
  });
});

describe('EntityList component', () => {
  const el = readFileSync(resolve(UI_DIR, 'components', 'MemoryExplorer', 'EntityList.tsx'), 'utf-8');

  it('supports search filtering', () => {
    expect(el).toContain('v10-entity-search-input');
    expect(el).toContain("placeholder=\"Search entities...\"");
  });

  it('groups entities by type with filter chips', () => {
    expect(el).toContain('v10-entity-type-chip');
    expect(el).toContain('typeFilter');
  });

  it('shows trust badge on each entity', () => {
    expect(el).toContain('<TrustBadge');
    expect(el).toContain('entity.trustLevel');
  });
});

describe('EntityDetail component', () => {
  const ed = readFileSync(resolve(UI_DIR, 'components', 'MemoryExplorer', 'EntityDetail.tsx'), 'utf-8');

  it('shows trust description per level', () => {
    expect(ed).toContain('TRUST_DESCRIPTIONS');
    expect(ed).toContain('Draft');
    expect(ed).toContain('Verified');
    expect(ed).toContain('Shared');
  });

  it('renders properties section', () => {
    expect(ed).toContain('v10-entity-detail-props');
    expect(ed).toContain('entity.properties');
  });

  it('renders clickable connections that navigate', () => {
    expect(ed).toContain('v10-entity-detail-conn');
    expect(ed).toContain('onNavigate(conn.targetUri)');
  });

  it('shows entity URI for provenance', () => {
    expect(ed).toContain('v10-entity-detail-uri');
    expect(ed).toContain('entity.uri');
  });
});

describe('TrustIndicator components', () => {
  const ti = readFileSync(resolve(UI_DIR, 'components', 'MemoryExplorer', 'TrustIndicator.tsx'), 'utf-8');

  it('exports TrustBadge, TrustRing, and TrustSummaryBar', () => {
    expect(ti).toContain('export function TrustBadge');
    expect(ti).toContain('export function TrustRing');
    expect(ti).toContain('export function TrustSummaryBar');
  });

  it('uses semantic class names for trust levels', () => {
    expect(ti).toContain('trust-verified');
    expect(ti).toContain('trust-shared');
    expect(ti).toContain('trust-working');
  });

  it('renders proportional trust bar segments', () => {
    expect(ti).toContain('v10-trust-bar-seg');
    expect(ti).toContain('wmPct');
    expect(ti).toContain('swmPct');
    expect(ti).toContain('vmPct');
  });
});

describe('ActivityTimeline component', () => {
  const at = readFileSync(resolve(UI_DIR, 'components', 'MemoryExplorer', 'ActivityTimeline.tsx'), 'utf-8');

  it('fetches operations data', () => {
    expect(at).toContain('fetchOperationsWithPhases');
  });

  it('maps operations to timeline events', () => {
    expect(at).toContain('opToEvents');
    expect(at).toContain('v10-timeline-event');
  });

  it('shows semantic descriptions for DKG operations', () => {
    expect(at).toContain('Published to Verified Memory');
    expect(at).toContain('Shared to SWM');
    expect(at).toContain('Wrote to Working Memory');
  });
});

describe('AgentHub page renders PanelRight', () => {
  const agentHub = readFile('pages/AgentHub.tsx');

  it('wraps PanelRight for agent chat', () => {
    expect(agentHub).toContain('<PanelRight');
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

/* ══════════════════════════════════════════
   GRAPH VISUALIZATION
   ══════════════════════════════════════════ */

describe('MemoryLayerView graph visualization', () => {
  const mlv = readFile('views/MemoryLayerView.tsx');

  it('imports RdfGraph and NodePanel via lazy loading', () => {
    expect(mlv).toContain("lazy(() =>");
    expect(mlv).toContain("dkg-graph-viz/react");
    expect(mlv).toMatch(/RdfGraph/);
    expect(mlv).toMatch(/NodePanel/);
  });

  it('has table/graph view mode toggle with ViewMode type', () => {
    expect(mlv).toContain("type ViewMode = 'table' | 'graph'");
    expect(mlv).toContain("viewMode === 'table'");
    expect(mlv).toContain("viewMode === 'graph'");
  });

  it('defaults to graph view', () => {
    expect(mlv).toMatch(/useState<ViewMode>\('graph'\)/);
  });

  it('renders toggle buttons for table and graph', () => {
    expect(mlv).toContain("title=\"Table view\"");
    expect(mlv).toContain("title=\"Graph view\"");
    expect(mlv).toContain("setViewMode('table')");
    expect(mlv).toContain("setViewMode('graph')");
  });

  it('uses LIMIT 1000 for layer overview (not 200)', () => {
    expect(mlv).toContain('LIMIT 1000');
    expect(mlv).toContain('LIMIT 500');
  });

  it('converts SPARQL bindings to triple array for RdfGraph', () => {
    expect(mlv).toContain("format=\"triples\"");
    expect(mlv).toMatch(/subject:.*bv\(row\.s\)/);
    expect(mlv).toMatch(/predicate:.*bv\(row\.p\)/);
    expect(mlv).toMatch(/object:.*bv\(row\.o\)/);
  });

  it('wires onNodeClick to populate SPARQL query', () => {
    expect(mlv).toContain('handleNodeClick');
    expect(mlv).toContain('setActiveQuery');
    expect(mlv).toMatch(/DESCRIBE|SELECT.*\?p \?o WHERE/);
  });

  it('renders NodePanel inside RdfGraph for detail overlay', () => {
    expect(mlv).toContain('<NodePanel');
    expect(mlv).toContain('className="v10-mlv-node-panel"');
  });

  it('has a Reset button that clears custom queries', () => {
    expect(mlv).toContain("title=\"Reset to full layer overview\"");
    expect(mlv).toContain("setActiveQuery('')");
  });

  it('shows filtered badge when custom query is active', () => {
    expect(mlv).toContain('v10-mlv-graph-info-custom');
    expect(mlv).toContain('filtered');
  });

  it('wraps RdfGraph in Suspense with loading fallback', () => {
    expect(mlv).toContain('<Suspense');
    expect(mlv).toContain('v10-mlv-graph-loading');
  });
});

// NOTE: The "Memory Explorer" UI shape was rewritten — many of the source-text
// snapshots below refer to component names, view tabs, CSS classes, and helper
// constants (TimelineView, NarrativeCard, ProjectHome, TrustStatusBox,
// `useState<ViewTab>('timeline')`, `v10-me-tabs`, `v10-me-search`, …) that no
// longer exist in `views/ProjectView.tsx` or the matching `styles.css`. The
// behavioral coverage now lives in higher-fidelity component tests; these
// describes are skipped (rather than deleted) so the historical contract list
// is preserved for whoever rewrites the snapshots against the new component
// tree.
describe.skip('ProjectView as Memory Explorer', () => {
  const pv = readFile('views/ProjectView.tsx');

  it('imports RdfGraph lazily', () => {
    expect(pv).toContain("lazy(() =>");
    expect(pv).toContain("dkg-graph-viz/react");
  });

  it('uses useMemoryEntities hook for cross-layer data', () => {
    expect(pv).toContain('useMemoryEntities');
    expect(pv).toContain('memory.entities');
    expect(pv).toContain('memory.graphTriples');
  });

  it('has three view tabs: timeline, graph, knowledge (conversation merged into timeline)', () => {
    expect(pv).toContain("type ViewTab = 'timeline' | 'graph' | 'knowledge'");
    expect(pv).toContain("'timeline'");
    expect(pv).toContain("'graph'");
    expect(pv).toContain("'knowledge'");
  });

  it('defaults to timeline view', () => {
    expect(pv).toContain("useState<ViewTab>('timeline')");
  });

  it('has tab switcher UI', () => {
    expect(pv).toContain('v10-me-tabs');
    expect(pv).toContain('v10-me-tab');
    expect(pv).toContain('Timeline');
    expect(pv).toContain('Graph');
    expect(pv).toContain('Knowledge Assets');
  });

  it('has keyword search bar', () => {
    expect(pv).toContain('v10-me-search');
    expect(pv).toContain('Search memory');
    expect(pv).toContain('matchesSearch');
  });

  it('has TimelineView with date grouping', () => {
    expect(pv).toContain('TimelineView');
    expect(pv).toContain('v10-tl-date-group');
    expect(pv).toContain('v10-tl-date-label');
    expect(pv).toContain('v10-tl-type-group');
  });

  it('has NarrativeCard with rich relationship summaries', () => {
    expect(pv).toContain('NarrativeCard');
    expect(pv).toContain('v10-nc');
    expect(pv).toContain('v10-nc-rels');
    expect(pv).toContain('incoming');
    expect(pv).toContain('otherOut');
  });

  it('has clickable contributors with agent tool badges', () => {
    expect(pv).toContain('v10-nc-contributors');
    expect(pv).toContain('v10-nc-contributor');
    expect(pv).toContain('agentTool');
    expect(pv).toContain('v10-nc-contrib-tool');
    expect(pv).toContain('CONTRIBUTOR_PREDS');
  });

  it('shows timestamps on cards via getDate helper', () => {
    expect(pv).toContain('getDate');
  });

  it('has DrilldownPanel with 2-hop neighborhood graph', () => {
    expect(pv).toContain('DrilldownPanel');
    expect(pv).toContain('neighborhoodTriples');
    expect(pv).toContain('v10-dd-panel');
    expect(pv).toContain('v10-dd-graph');
    expect(pv).toContain('v10-dd-card');
  });

  it('drilldown shows incoming references', () => {
    expect(pv).toContain('Referenced by');
    expect(pv).toContain('incoming');
  });

  it('has ConversationTurnCard component for turn display within timeline', () => {
    expect(pv).toContain('ConversationTurnCard');
    expect(pv).toContain('v10-conv-turn');
    expect(pv).toContain('v10-conv-speaker');
    expect(pv).toContain('v10-conv-mentions');
    expect(pv).toContain('ConversationTurn');
  });

  it('has KnowledgeAssetsView (renamed from Entities, excludes conversation turns)', () => {
    expect(pv).toContain('KnowledgeAssetsView');
    expect(pv).toContain('isConversationTurn(e)) continue');
  });

  it('has TrustStatusBox component showing Verified/Shared/Private label', () => {
    expect(pv).toContain('TrustStatusBox');
    expect(pv).toContain('TRUST_LABELS');
    expect(pv).toContain("verified: 'Verified'");
    expect(pv).toContain("shared: 'Shared'");
    expect(pv).toContain("working: 'Private'");
    expect(pv).toContain('v10-trust-status-box');
  });

  it('has ProjectHome component with stats and participating agents', () => {
    expect(pv).toContain('ProjectHome');
    expect(pv).toContain('v10-ph');
    expect(pv).toContain('v10-ph-stats');
    expect(pv).toContain('v10-ph-agents');
    expect(pv).toContain('participants');
  });

  it('humanizes speaker names (DID to label)', () => {
    expect(pv).toContain('humanizeLabel');
    expect(pv).toContain('speakerName');
  });

  it('drilldown has Mentioned in section for conversation turns', () => {
    expect(pv).toContain('Mentioned in');
    expect(pv).toContain('mentionedIn');
  });

  it('drilldown has Source file link', () => {
    expect(pv).toContain('v10-dd-source-link');
    expect(pv).toContain('View source file');
    expect(pv).toContain('sourceFile');
  });

  it('drilldown has Similar entities from vector search', () => {
    expect(pv).toContain('/api/memory/search');
    expect(pv).toContain('v10-dd-conn-sim');
    expect(pv).toContain('Similar');
  });

  it('preserves full GraphView as a tab', () => {
    expect(pv).toContain('GraphView');
    expect(pv).toContain('v10-gv-container');
    expect(pv).toContain('v10-me-graph-legend');
  });

  it('colors graph nodes by trust level via nodeColors', () => {
    expect(pv).toContain('TRUST_COLORS');
    expect(pv).toContain("verified: '#22c55e'");
    expect(pv).toContain('nodeColors');
    expect(pv).toContain('TRUST_COLORS[entity.trustLevel]');
  });

  it('has empty state with import action', () => {
    expect(pv).toContain('v10-me-empty');
    expect(pv).toContain('No knowledge yet');
    expect(pv).toContain('Import Files');
  });
});

describe('Graph visualization CSS', () => {
  const css = readFile('styles.css');

  it('has .v10-mlv-view-toggle selector', () => {
    expect(css).toMatch(/\.v10-mlv-view-toggle\s*\{/);
  });

  it('has .v10-mlv-toggle-btn and active state', () => {
    expect(css).toMatch(/\.v10-mlv-toggle-btn\s*\{/);
    expect(css).toMatch(/\.v10-mlv-toggle-btn\.active\s*\{/);
  });

  it('has .v10-mlv-graph-container with height', () => {
    expect(css).toMatch(/\.v10-mlv-graph-container\s*\{/);
    expect(css).toMatch(/height:\s*500px/);
  });

  it('has .v10-mlv-node-panel positioned absolutely', () => {
    expect(css).toMatch(/\.v10-mlv-node-panel\s*\{/);
    expect(css).toContain('position: absolute');
  });

  it('has responsive rules for graph containers', () => {
    expect(css).toContain('@media (max-height: 700px)');
    expect(css).toContain('@media (max-width: 700px)');
  });

  it('has .v10-layer-card-count for triple counts on layer cards', () => {
    expect(css).toMatch(/\.v10-layer-card-count\s*\{/);
  });
});

// Skipped together with the ProjectView block above — the same
// Memory-Explorer rewrite removed the matching CSS selectors.
describe.skip('Memory Explorer CSS', () => {
  const css = readFile('styles.css');

  it('has .v10-memory-explorer layout', () => {
    expect(css).toMatch(/\.v10-memory-explorer\s*\{/);
  });

  it('has trust summary bar with segments', () => {
    expect(css).toMatch(/\.v10-trust-summary-bar\s*\{/);
    expect(css).toMatch(/\.v10-trust-bar-seg\.trust-verified/);
    expect(css).toMatch(/\.v10-trust-bar-seg\.trust-shared/);
    expect(css).toMatch(/\.v10-trust-bar-seg\.trust-working/);
  });

  it('has trust badges with per-level colors', () => {
    expect(css).toMatch(/\.v10-trust-badge\.trust-verified\s*\{/);
    expect(css).toMatch(/\.v10-trust-badge\.trust-shared\s*\{/);
    expect(css).toMatch(/\.v10-trust-badge\.trust-working\s*\{/);
  });

  it('has tab bar and search styles', () => {
    expect(css).toMatch(/\.v10-me-tabs\s*\{/);
    expect(css).toMatch(/\.v10-me-tab\.active\s*\{/);
    expect(css).toMatch(/\.v10-me-search\s*\{/);
  });

  it('has timeline view styles', () => {
    expect(css).toMatch(/\.v10-tl-scroll\s*\{/);
    expect(css).toMatch(/\.v10-tl-date-group\s*\{/);
    expect(css).toMatch(/\.v10-tl-date-label\s*\{/);
  });

  it('has narrative card styles', () => {
    expect(css).toMatch(/\.v10-nc\s*\{/);
    expect(css).toMatch(/\.v10-nc-rels\s*\{/);
    expect(css).toMatch(/\.v10-nc-desc\s*\{/);
  });

  it('has entities view styles', () => {
    expect(css).toMatch(/\.v10-ev-scroll\s*\{/);
    expect(css).toMatch(/\.v10-ev-group\s*\{/);
    expect(css).toMatch(/\.v10-ev-item\s*\{/);
  });

  it('has conversation view styles', () => {
    expect(css).toMatch(/\.v10-conv-scroll\s*\{/);
    expect(css).toMatch(/\.v10-conv-turn\s*\{/);
    expect(css).toMatch(/\.v10-conv-speaker\s*\{/);
    expect(css).toMatch(/\.v10-conv-mention\s*\{/);
  });

  it('has drilldown panel styles', () => {
    expect(css).toMatch(/\.v10-dd-panel\s*\{/);
    expect(css).toMatch(/\.v10-dd-graph\s*\{/);
    expect(css).toMatch(/\.v10-dd-card\s*\{/);
    expect(css).toMatch(/\.v10-dd-conn\s*\{/);
    expect(css).toMatch(/\.v10-dd-source-link\s*\{/);
    expect(css).toMatch(/\.v10-dd-conn-sim\s*\{/);
  });

  it('has graph legend overlay', () => {
    expect(css).toMatch(/\.v10-me-graph-legend\s*\{/);
    expect(css).toContain('backdrop-filter');
  });

  it('has responsive breakpoints', () => {
    expect(css).toContain('@media (max-width: 700px)');
  });

  it('has project home styles', () => {
    expect(css).toMatch(/\.v10-ph\s*\{/);
    expect(css).toMatch(/\.v10-ph-stats\s*\{/);
    expect(css).toMatch(/\.v10-ph-agents\s*\{/);
    expect(css).toMatch(/\.v10-ph-agent-chip\s*\{/);
  });

  it('uses left border on cards for trust indication', () => {
    expect(css).toMatch(/\.v10-nc\s*\{[^}]*border-left:\s*4px/);
    expect(css).toMatch(/\.v10-conv-turn\s*\{[^}]*border-left:\s*4px/);
  });

  it('has trust status box styles', () => {
    expect(css).toMatch(/\.v10-trust-status-box\s*\{/);
  });

  it('has entity item description and content layout', () => {
    expect(css).toMatch(/\.v10-ev-item-content\s*\{/);
    expect(css).toMatch(/\.v10-ev-item-desc\s*\{/);
  });
});
