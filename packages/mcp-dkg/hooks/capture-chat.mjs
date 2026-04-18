#!/usr/bin/env node
/**
 * capture-chat.mjs
 *
 * Cursor / Claude Code hook script. Bridges coding-assistant chat turns
 * into a DKG project's `chat` sub-graph so teammates on the same CG can
 * see what your assistant is working on (and let their assistants query
 * it back via MCP).
 *
 * Event model
 * -----------
 * Cursor invokes this same script for four events, passing the event
 * payload on stdin as JSON:
 *
 *   sessionStart      — initialise session state + emit chat:Session triples
 *   beforeSubmitPrompt — stash the pending user prompt for the next turn
 *   afterAgentResponse — flush (user prompt + assistant response) as one chat:Turn
 *   sessionEnd        — close the session (soft — we don't delete state)
 *
 * The event name is passed as argv[2]:
 *
 *   node capture-chat.mjs <eventName>
 *
 * Design principles
 * -----------------
 * 1. FAIL OPEN. This script must never block the user's chat. Any error
 *    is logged to /tmp/dkg-capture.log and we still exit 0 with `{}`
 *    on stdout.
 * 2. DEFENSIVE PARSING. Cursor's event schema isn't fully documented;
 *    we try several common field names before giving up, and fall
 *    back to stashing the whole payload as `rawPayload` so no
 *    information is lost.
 * 3. CANONICAL DKG OPS. Writes go through the existing
 *    `POST /api/assertion/<name>/write` (JSON triples) and promotes
 *    through `POST /api/assertion/<name>/promote`, matching every
 *    other seeding script in the repo.
 * 4. NO NEW CONFIG SURFACE. Reads `.dkg/config.yaml` walking upward
 *    from cwd. See `22_AGENT_ONBOARDING §2.1` for the canonical shape.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

// ── Constants ─────────────────────────────────────────────────
const EVENT = process.argv[2] ?? 'unknown';
const LOG_FILE = process.env.DKG_CAPTURE_LOG ?? '/tmp/dkg-capture.log';
const STATE_DIR = path.join(os.homedir(), '.cache', 'dkg-mcp', 'sessions');
const DEFAULT_API = 'http://localhost:9201';

const NS = {
  rdf:     'http://www.w3.org/1999/02/22-rdf-syntax-ns#',
  rdfs:    'http://www.w3.org/2000/01/rdf-schema#',
  schema:  'http://schema.org/',
  dcterms: 'http://purl.org/dc/terms/',
  xsd:     'http://www.w3.org/2001/XMLSchema#',
  prov:    'http://www.w3.org/ns/prov#',
  chat:    'http://dkg.io/ontology/chat/',
};
const T = {
  Session: NS.chat + 'Session',
  Turn:    NS.chat + 'Turn',
};
const P = {
  type:      NS.rdf + 'type',
  label:     NS.rdfs + 'label',
  name:      NS.schema + 'name',
  created:   NS.dcterms + 'created',
  modified:  NS.dcterms + 'modified',
  attributed: NS.prov + 'wasAttributedTo',
  inSession: NS.chat + 'inSession',
  turnIndex: NS.chat + 'turnIndex',
  userPrompt: NS.chat + 'userPrompt',
  assistantResponse: NS.chat + 'assistantResponse',
  speakerTool: NS.chat + 'speakerTool',
  privacy:   NS.chat + 'privacy',
  contentHash: NS.chat + 'contentHash',
  aboutEntity: NS.chat + 'aboutEntity',
  summary:   NS.chat + 'summary',
  rawPayload: NS.chat + 'rawPayload',
};

// Cap any single literal to keep assertions reasonable; coding-agent
// responses can balloon to tens of KB, which isn't useful for search.
const LITERAL_CAP = 20_000;

// ── Logging ───────────────────────────────────────────────────
function log(msg) {
  try {
    fs.appendFileSync(
      LOG_FILE,
      `${new Date().toISOString()} [${EVENT}] ${msg}\n`,
    );
  } catch {
    // Cannot log → give up silently; the hook must stay non-blocking.
  }
}

// ── Config loader (walks upward for .dkg/config.yaml) ─────────
// We intentionally avoid a YAML dep here — the hook runs under Cursor's
// constrained environment and bundling `yaml` would slow every event.
// The config shape we care about is line-oriented enough that a tiny
// hand-rolled parser covers every realistic case.
function parseDotDkgConfig(yamlText) {
  const lines = yamlText.split(/\r?\n/);
  const cfg = { node: {}, agent: {}, capture: {} };
  let stack = [cfg];
  let indents = [-1];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').replace(/\s+$/, '');
    if (!line.trim()) continue;
    const indent = line.match(/^ */)[0].length;
    while (indents.length > 1 && indent <= indents[indents.length - 1]) {
      stack.pop();
      indents.pop();
    }
    const m = line.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1];
    const valRaw = m[2];
    const parent = stack[stack.length - 1];
    if (valRaw === '' || valRaw === undefined) {
      parent[key] = {};
      stack.push(parent[key]);
      indents.push(indent);
    } else {
      const val = valRaw
        .replace(/^["']|["']$/g, '')
        .trim();
      if (val === 'true') parent[key] = true;
      else if (val === 'false') parent[key] = false;
      else if (/^-?\d+$/.test(val)) parent[key] = parseInt(val, 10);
      else parent[key] = val;
    }
  }
  return cfg;
}

function findConfigFile(start) {
  let dir = path.resolve(start);
  const root = path.parse(dir).root;
  while (true) {
    const candidate = path.join(dir, '.dkg', 'config.yaml');
    if (fs.existsSync(candidate)) return candidate;
    if (dir === root) return null;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function loadConfig() {
  const envApi = process.env.DKG_API ?? process.env.DEVNET_API;
  const envToken = process.env.DKG_TOKEN ?? process.env.DEVNET_TOKEN;
  const envProject = process.env.DKG_PROJECT;
  const envAgent = process.env.DKG_AGENT_URI;

  const cwd = process.env.DKG_WORKSPACE ?? process.cwd();
  const cfgPath = findConfigFile(cwd);
  let fromFile = { node: {}, agent: {}, capture: {} };
  if (cfgPath) {
    try {
      fromFile = parseDotDkgConfig(fs.readFileSync(cfgPath, 'utf-8'));
    } catch (err) {
      log(`could not parse ${cfgPath}: ${err?.message ?? err}`);
    }
  }

  let token = envToken ?? fromFile.node?.token ?? '';
  if (!token && fromFile.node?.tokenFile && cfgPath) {
    try {
      const abs = path.isAbsolute(fromFile.node.tokenFile)
        ? fromFile.node.tokenFile
        : path.resolve(path.dirname(cfgPath), fromFile.node.tokenFile);
      const raw = fs.readFileSync(abs, 'utf-8');
      const line = raw.split('\n').find((l) => l.trim() && !l.startsWith('#'));
      token = (line ?? '').trim();
    } catch (err) {
      log(`token file unreadable: ${err?.message ?? err}`);
    }
  }

  return {
    api: envApi ?? fromFile.node?.api ?? DEFAULT_API,
    token,
    project: envProject ?? fromFile.contextGraph ?? fromFile.project ?? null,
    agent: envAgent ?? fromFile.agent?.uri ?? null,
    subGraph: fromFile.capture?.subGraph ?? 'chat',
    assertion: fromFile.capture?.assertion ?? 'chat-log',
    privacy: fromFile.capture?.privacy ?? 'team',
    autoShare: fromFile.autoShare !== false,
    tool: fromFile.capture?.tool ?? process.env.DKG_CAPTURE_TOOL ?? 'cursor',
    sourcePath: cfgPath,
  };
}

// ── Session state ─────────────────────────────────────────────
function sessionStatePath(sessionKey) {
  return path.join(STATE_DIR, `${sessionKey}.json`);
}

function loadSessionState(sessionKey) {
  try {
    const raw = fs.readFileSync(sessionStatePath(sessionKey), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSessionState(sessionKey, state) {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(sessionStatePath(sessionKey), JSON.stringify(state, null, 2));
}

// ── stdin / payload parsing ───────────────────────────────────
async function readStdinJson() {
  // Non-blocking drain of stdin. If stdin is a TTY (e.g. when debugging
  // by running the script by hand), fall back to an empty object.
  if (process.stdin.isTTY) return {};
  try {
    const chunks = [];
    for await (const c of process.stdin) chunks.push(c);
    const text = Buffer.concat(chunks).toString('utf-8').trim();
    if (!text) return {};
    try { return JSON.parse(text); }
    catch { return { rawPayload: text }; }
  } catch (err) {
    log(`stdin read failed: ${err?.message ?? err}`);
    return {};
  }
}

// Generic deep-search for the first matching key. Used to pluck prompt
// text / response text / conversation id from whatever shape Cursor uses
// without us having to know it exactly up front. The spike hook
// (dump-spike.mjs) tells us the real field names; this function lets us
// bridge that gap without breaking once we learn them.
function pick(obj, candidates, depth = 0) {
  if (depth > 4 || obj == null || typeof obj !== 'object') return undefined;
  for (const c of candidates) {
    if (Object.prototype.hasOwnProperty.call(obj, c)) {
      const v = obj[c];
      if (typeof v === 'string' && v.trim()) return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === 'object') {
      const nested = pick(v, candidates, depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

function extractText(payload) {
  // Prefer standalone "prompt" / "response" fields; fall back to deep
  // content / text. If all else fails, JSON-stringify the payload so
  // we capture *something*.
  const t =
    pick(payload, ['prompt', 'userPrompt', 'request', 'message', 'content', 'text', 'input', 'response', 'reply', 'completion', 'output', 'answer']);
  return t ?? '';
}

function extractSessionKey(payload) {
  const id =
    pick(payload, ['conversationId', 'chatId', 'sessionId', 'threadId', 'convId', 'id']) ??
    // No id from Cursor? Use the wall-clock hour, so we at least group
    // turns within the same hour into one session.
    `anon-${new Date().toISOString().slice(0, 13)}`;
  return sanitiseSlug(id);
}

function sanitiseSlug(s) {
  return String(s).replace(/[^A-Za-z0-9._-]+/g, '-').slice(0, 80);
}

// ── RDF helpers ───────────────────────────────────────────────
const LIT = (v, datatype) => {
  const capped = typeof v === 'string' && v.length > LITERAL_CAP
    ? v.slice(0, LITERAL_CAP) + `…[truncated ${v.length - LITERAL_CAP} chars]`
    : String(v);
  const esc = capped
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
  if (datatype) return `"${esc}"^^<${datatype}>`;
  return `"${esc}"`;
};
const URI = (u) => u; // daemon's /write expects bare URIs in subject/predicate

const sessionUri = (slug) => `urn:dkg:chat:session:${encodeURIComponent(slug)}`;
const turnUri = (slug, idx) => `urn:dkg:chat:session:${encodeURIComponent(slug)}#turn:${idx}`;

// ── Daemon calls ──────────────────────────────────────────────
async function postJson(api, route, token, body) {
  const res = await fetch(`${api}${route}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${route} → ${res.status}: ${text.slice(0, 300)}`);
  }
  return text ? JSON.parse(text) : {};
}

async function writeTriples(cfg, triples) {
  return postJson(cfg.api, `/api/assertion/${encodeURIComponent(cfg.assertion)}/write`, cfg.token, {
    contextGraphId: cfg.project,
    subGraphName: cfg.subGraph,
    quads: triples,
  });
}

async function promoteEntities(cfg, entities) {
  return postJson(cfg.api, `/api/assertion/${encodeURIComponent(cfg.assertion)}/promote`, cfg.token, {
    contextGraphId: cfg.project,
    subGraphName: cfg.subGraph,
    entities,
  });
}

// ── Ensure sub-graph exists (no-op if already registered) ─────
async function ensureSubGraph(cfg) {
  try {
    await postJson(cfg.api, `/api/sub-graph/create`, cfg.token, {
      contextGraphId: cfg.project,
      subGraphName: cfg.subGraph,
    });
  } catch (err) {
    // Already-exists is the 99% case; anything else we log + move on.
    const m = String(err?.message ?? err);
    if (!m.includes('already exists')) log(`ensureSubGraph: ${m}`);
  }
}

// ── Event handlers ────────────────────────────────────────────
async function handleSessionStart(cfg, payload) {
  const sessionKey = extractSessionKey(payload);
  const existing = loadSessionState(sessionKey);
  const now = new Date().toISOString();
  const state = existing ?? {
    sessionKey,
    sessionUri: sessionUri(sessionKey),
    startedAt: now,
    turnIndex: 0,
    pendingPrompt: null,
  };
  state.lastEventAt = now;
  saveSessionState(sessionKey, state);

  if (!cfg.project) { log('no project configured — skipping session write'); return; }
  await ensureSubGraph(cfg);

  const triples = [
    { subject: state.sessionUri, predicate: P.type, object: URI(T.Session) },
    { subject: state.sessionUri, predicate: P.name, object: LIT(`${cfg.tool} session ${sessionKey}`) },
    { subject: state.sessionUri, predicate: P.created, object: LIT(state.startedAt, NS.xsd + 'dateTime') },
    { subject: state.sessionUri, predicate: P.speakerTool, object: LIT(cfg.tool) },
    { subject: state.sessionUri, predicate: P.privacy, object: LIT(cfg.privacy) },
  ];
  if (cfg.agent) triples.push({ subject: state.sessionUri, predicate: P.attributed, object: URI(cfg.agent) });
  try {
    await writeTriples(cfg, triples);
    if (cfg.autoShare) {
      await promoteEntities(cfg, [state.sessionUri]).catch((e) => log(`promote session: ${e.message}`));
    }
  } catch (err) {
    log(`session start write: ${err?.message ?? err}`);
  }
}

async function handleBeforeSubmitPrompt(cfg, payload) {
  const sessionKey = extractSessionKey(payload);
  const state = loadSessionState(sessionKey) ?? {
    sessionKey,
    sessionUri: sessionUri(sessionKey),
    startedAt: new Date().toISOString(),
    turnIndex: 0,
    pendingPrompt: null,
  };
  state.pendingPrompt = extractText(payload) ?? '';
  state.pendingPromptAt = new Date().toISOString();
  saveSessionState(sessionKey, state);
  log(`queued prompt (${state.pendingPrompt.length} chars) for session ${sessionKey}`);
}

async function handleAfterAgentResponse(cfg, payload) {
  const sessionKey = extractSessionKey(payload);
  const state = loadSessionState(sessionKey) ?? {
    sessionKey,
    sessionUri: sessionUri(sessionKey),
    startedAt: new Date().toISOString(),
    turnIndex: 0,
    pendingPrompt: null,
  };
  state.turnIndex += 1;
  const idx = state.turnIndex;
  const turn = turnUri(sessionKey, idx);
  const now = new Date().toISOString();
  const userText = state.pendingPrompt ?? '';
  const asstText = extractText(payload) ?? '';
  const hash = crypto.createHash('sha256').update(userText + '\0' + asstText).digest('hex').slice(0, 32);

  if (!cfg.project) { log('no project configured — skipping turn write'); return; }
  await ensureSubGraph(cfg);

  const triples = [
    { subject: turn, predicate: P.type, object: URI(T.Turn) },
    { subject: turn, predicate: P.inSession, object: URI(state.sessionUri) },
    { subject: turn, predicate: P.turnIndex, object: LIT(idx, NS.xsd + 'integer') },
    { subject: turn, predicate: P.created, object: LIT(now, NS.xsd + 'dateTime') },
    { subject: turn, predicate: P.contentHash, object: LIT(hash) },
    { subject: turn, predicate: P.speakerTool, object: LIT(cfg.tool) },
  ];
  if (userText) triples.push({ subject: turn, predicate: P.userPrompt, object: LIT(userText) });
  if (asstText) triples.push({ subject: turn, predicate: P.assistantResponse, object: LIT(asstText) });
  if (cfg.agent) triples.push({ subject: turn, predicate: P.attributed, object: URI(cfg.agent) });
  // When nothing could be extracted (unfamiliar payload shape) stash
  // the raw JSON so we can post-hoc reconstruct turns once we see real
  // data. This is what unblocks us on day 0 before the spike tells us
  // the exact field names.
  if (!userText && !asstText) {
    try {
      triples.push({ subject: turn, predicate: P.rawPayload, object: LIT(JSON.stringify(payload)) });
    } catch {
      /* payload wasn't JSON-serialisable; give up */
    }
  }

  // Also keep session `modified` fresh so timelines sort correctly.
  triples.push({ subject: state.sessionUri, predicate: P.modified, object: LIT(now, NS.xsd + 'dateTime') });

  try {
    await writeTriples(cfg, triples);
    if (cfg.autoShare) {
      // Promote both the session and the individual turn so the team
      // sees the turn immediately and the aggregate Session is kept
      // in SWM.
      await promoteEntities(cfg, [turn, state.sessionUri]).catch((e) => log(`promote turn: ${e.message}`));
    }
    log(`wrote turn #${idx} for session ${sessionKey}`);
  } catch (err) {
    log(`turn write: ${err?.message ?? err}`);
  }

  state.pendingPrompt = null;
  state.lastEventAt = now;
  saveSessionState(sessionKey, state);
}

async function handleSessionEnd(cfg, payload) {
  const sessionKey = extractSessionKey(payload);
  const state = loadSessionState(sessionKey);
  if (!state) return;
  const now = new Date().toISOString();
  state.endedAt = now;
  saveSessionState(sessionKey, state);
  if (!cfg.project) return;
  try {
    await writeTriples(cfg, [
      { subject: state.sessionUri, predicate: P.modified, object: LIT(now, NS.xsd + 'dateTime') },
    ]);
  } catch (err) {
    log(`session end write: ${err?.message ?? err}`);
  }
}

// ── Entry point ───────────────────────────────────────────────
(async () => {
  const payload = await readStdinJson();
  const cfg = loadConfig();
  log(`cfg: api=${cfg.api} project=${cfg.project} agent=${cfg.agent} token=${cfg.token ? '[set]' : '[empty]'} autoShare=${cfg.autoShare}`);
  try {
    switch (EVENT) {
      case 'sessionStart':
        await handleSessionStart(cfg, payload);
        break;
      case 'beforeSubmitPrompt':
        await handleBeforeSubmitPrompt(cfg, payload);
        break;
      case 'afterAgentResponse':
        await handleAfterAgentResponse(cfg, payload);
        break;
      case 'sessionEnd':
        await handleSessionEnd(cfg, payload);
        break;
      default:
        log(`unknown event: ${EVENT}`);
    }
  } catch (err) {
    log(`handler error: ${err?.stack ?? err?.message ?? err}`);
  }
  process.stdout.write('{}\n');
  process.exit(0);
})();
