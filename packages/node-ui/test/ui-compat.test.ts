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
  it('App.tsx includes redirects for /network, /operations/*, /wallet, /integrations', () => {
    const app = readFile('App.tsx');
    expect(app).toContain('path="/network"');
    expect(app).toContain('path="/operations/*"');
    expect(app).toContain('path="/wallet"');
    expect(app).toContain('path="/integrations"');
    for (const route of ['/network', '/operations/\\*', '/wallet', '/integrations']) {
      const pattern = new RegExp(`path="${route}"[^>]*element=\\{<Navigate`);
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
  const app = readFile('App.tsx');
  const agentHub = readFile('pages/AgentHub.tsx');

  it('NotificationBell uses useNavigate for navigation', () => {
    const bellSection = app.slice(
      app.indexOf('function NotificationBell'),
      app.indexOf('export function App'),
    );
    expect(bellSection).toContain('useNavigate()');
  });

  it('notification items with peer field navigate to /agent?tab=peers&peer=', () => {
    expect(app).toContain("navigate(`/agent?tab=peers&peer=");
    expect(app).toContain('encodeURIComponent(n.peer');
  });

  it('notification items without peer are not clickable', () => {
    expect(app).toContain("const clickable = !!n.peer");
    expect(app).toContain("cursor: clickable ? 'pointer' : 'default'");
  });

  it('clickable notification shows "Open chat" hint', () => {
    expect(app).toContain('Open chat');
    expect(app).toContain('clickable &&');
  });

  it('notification dropdown closes on click-through', () => {
    const navSection = app.slice(
      app.indexOf("navigate(`/agent?tab=peers") - 200,
      app.indexOf("navigate(`/agent?tab=peers") + 100,
    );
    expect(navSection).toContain('setOpen(false)');
  });

  it('notification items have data-peer attribute for testability', () => {
    expect(app).toContain('data-peer={n.peer');
  });

  it('clickable notifications are keyboard-accessible', () => {
    expect(app).toContain('tabIndex={clickable ? 0 : undefined}');
    expect(app).toContain("e.key === 'Enter'");
    expect(app).toContain("e.key === ' '");
    expect(app).toContain('onKeyDown={clickable');
  });

  it('AgentHub reads tab and peer from URL search params', () => {
    expect(agentHub).toContain('useSearchParams');
    expect(agentHub).toMatch(/searchParams\.get\(['"]tab['"]\)/);
    expect(agentHub).toMatch(/searchParams\.get\(['"]peer['"]\)/);
  });

  it('AgentHub sets initial mode to peers when tab=peers in URL', () => {
    expect(agentHub).toMatch(/urlTab === ['"]peers['"].*['"]peers['"].*['"]agent['"]/);
  });

  it('AgentHub clears only tab/peer URL params with proper dependencies', () => {
    expect(agentHub).toContain("next.delete('tab')");
    expect(agentHub).toContain("next.delete('peer')");
    expect(agentHub).toContain('setSearchParams(next, { replace: true })');
  });

  it('PeerChatView accepts initialPeerId and onPeerSelected props', () => {
    expect(agentHub).toMatch(/function PeerChatView\(\s*\{\s*initialPeerId\s*,\s*onPeerSelected/);
    expect(agentHub).toContain('initialPeerId?: string');
    expect(agentHub).toContain('onPeerSelected?: () => void');
  });

  it('PeerChatView auto-selects initial peer from prop', () => {
    expect(agentHub).toContain('peers.find(p => p.peerId === initialPeerId)');
    expect(agentHub).toContain('onPeerSelected?.()');
  });

  it('AgentHub captures deep-link peer in stable state before clearing URL', () => {
    expect(agentHub).toContain('deepLinkPeer');
    expect(agentHub).toMatch(/useState[\s\S]*urlPeer/);
    expect(agentHub).toMatch(/PeerChatView\s+initialPeerId=\{deepLinkPeer/);
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
    expect(agentHub).toMatch(/sendChatMessage|streamChatMessage/);
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

describe('AgentHub initialization-order safety', () => {
  const agentHub = readFile('pages/AgentHub.tsx');

  it('declares graphRenderTriples before searchMatchedNodeIds', () => {
    const renderIdx = agentHub.indexOf('const graphRenderTriples = useMemo');
    const searchIdx = agentHub.indexOf('const searchMatchedNodeIds = useMemo');
    expect(renderIdx).toBeGreaterThanOrEqual(0);
    expect(searchIdx).toBeGreaterThanOrEqual(0);
    expect(renderIdx).toBeLessThan(searchIdx);
  });

  it('uses ref dispatch for stored-turn graph updates to avoid TDZ callback deps', () => {
    expect(agentHub).toContain('applyStoredTurnGraphUpdateRef.current(');
    expect(agentHub).not.toContain('}, [applyStoredTurnGraphUpdate]);');
  });
});
