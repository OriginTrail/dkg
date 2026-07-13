import { useState } from 'react';
import { MarkdownMessage } from '../components/chat/MarkdownMessage.js';
import { answerQuestion, type DragAnswer, type DragAnswerRequest } from '../api.js';
import { useProjectsStore } from '../stores/projects.js';

// dRAG Ask panel (OT-RFC-55). Type a question, get a grounded answer where every
// fact carries a chain-anchored citation; answer on this node or across the
// network; optionally derive conclusions over verified facts with EYE.

function Badge({ label, state }: { label: string; state: boolean | null }) {
  const cls = state === true ? 'ok' : state === false ? 'bad' : 'warn';
  const mark = state === true ? '✓' : state === false ? '✗' : '~';
  return <span className={`v10-drag-badge ${cls}`}>{mark} {label}</span>;
}

function short(s: string, head = 8, tail = 4): string {
  return s.length > head + tail + 1 ? `${s.slice(0, head)}…${s.slice(-tail)}` : s;
}
function shortKa(kaId: string): string {
  try {
    const v = BigInt(kaId);
    const a = '0x' + (v >> 96n).toString(16).padStart(40, '0');
    return `${a.slice(0, 6)}…${a.slice(-4)}/${(v & ((1n << 96n) - 1n)).toString()}`;
  } catch {
    return kaId.slice(0, 10);
  }
}
function displayObject(o: string): string {
  const m = o.match(/^"((?:[^"\\]|\\.)*)"/);
  return m ? m[1] : o;
}
function shortPred(p: string): string {
  const m = p.match(/[/#]([^/#]+)$/);
  return m ? m[1] : p;
}
/** Display an RDF object/term: the literal value, or an IRI's local name. */
function term(o: string): string {
  const m = o.match(/^"((?:[^"\\]|\\.)*)"/);
  if (m) return m[1];
  const seg = o.match(/[/#]([^/#]+)$/);
  return seg ? seg[1] : o;
}

function retrievalLabel(r: string): string {
  if (!r || r === 'none') return '';
  if (r === 'keyword') return '🔤 keyword';
  if (r.includes('hashing')) return '🔤 lexical';
  if (r.startsWith('vector:')) return '🧠 semantic';
  return r;
}

export function buildDragAskRequest(input: {
  question: string;
  contextGraphId: string;
  scope: 'local' | 'network';
  retrieval: '' | 'keyword' | 'semantic';
  reason: boolean;
  rules: string;
}): DragAnswerRequest {
  const localReasoning = input.scope === 'local' && input.reason;
  return {
    question: input.question,
    contextGraphId: input.contextGraphId.trim(),
    scope: input.scope,
    retrieval: input.scope === 'local' ? (input.retrieval || undefined) : undefined,
    reason: localReasoning,
    rules: localReasoning ? (input.rules.trim() || undefined) : undefined,
  };
}

export function DragAskView() {
  const activeProjectId = useProjectsStore((s) => s.activeProjectId);
  const [question, setQuestion] = useState('Which suppliers were flagged in the 2026 Q1 audit, and why?');
  const [cg, setCg] = useState(activeProjectId ?? '');
  const [scope, setScope] = useState<'local' | 'network'>('local');
  const [retrieval, setRetrieval] = useState<'' | 'keyword' | 'semantic'>(''); // '' = node default
  const [reason, setReason] = useState(false);
  const [rules, setRules] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DragAnswer | null>(null);

  const ask = async () => {
    setLoading(true);
    setError(null);
    try {
      setResult(
        await answerQuestion(buildDragAskRequest({
          question,
          contextGraphId: cg.trim(),
          scope,
          retrieval,
          reason,
          rules,
        })),
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  };

  // Preserve the daemon's answer verbatim. In particular, do not discard trust,
  // scope, or network warnings by parsing presentation headings.
  const answer = result?.answer ?? '';
  const allVerified = !!result && result.stats.factsCited > 0 && result.stats.verified === result.stats.factsCited;
  const isNetwork = result?.scope === 'network';
  const servingNodes = Number(result?.stats.servingNodes ?? result?.perNode?.length ?? 0);
  const nodesAnswered = Number(result?.stats.nodesAnswered ?? result?.perNode?.filter((p) => !p.error).length ?? 0);
  const rejected = Number(result?.stats.rejected ?? 0);
  const notEvaluated = Number(result?.stats.notEvaluated ?? 0);
  const peersSkipped = Number(result?.stats.peersSkipped ?? 0);
  const networkComplete = !isNetwork || (
    result?.stats.scopeVerified === true &&
    nodesAnswered === servingNodes &&
    notEvaluated === 0 &&
    peersSkipped === 0
  );
  const verdictOk = allVerified && networkComplete;

  return (
    <div className="v10-drag-ask">
      <div className="v10-drag-header">
        <div className="v10-drag-title">dRAG — ask anything, audit everything</div>
        <div className="v10-drag-sub">
          Natural-language answers where every fact is cryptographically verifiable against the chain.
        </div>
      </div>

      <div className="v10-drag-form">
        <textarea
          className="v10-drag-q"
          rows={2}
          maxLength={2000}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question…"
        />
        <div className="v10-drag-controls">
          <input
            className="v10-drag-cg"
            value={cg}
            onChange={(e) => setCg(e.target.value)}
            placeholder="context graph (e.g. demo-supply)"
          />
          <div className="v10-drag-seg">
            <button className={scope === 'local' ? 'active' : ''} onClick={() => setScope('local')}>This node</button>
            <button className={scope === 'network' ? 'active' : ''} onClick={() => setScope('network')}>Across network</button>
          </div>
          <select
            className="v10-drag-cg"
            style={{ flex: '0 0 auto', minWidth: 'auto' }}
            value={retrieval}
            onChange={(e) => setRetrieval(e.target.value as '' | 'keyword' | 'semantic')}
            title="Retrieval method (this node only)"
            disabled={scope === 'network'}
          >
            <option value="">retrieval: default</option>
            <option value="keyword">keyword (substring)</option>
            <option value="semantic">semantic (by meaning)</option>
          </select>
          <label className="v10-drag-option" title={scope === 'network' ? 'reasoning runs on this node only' : 'derive conclusions with verified supporting evidence'}>
            <input
              type="checkbox"
              checked={reason}
              disabled={scope === 'network'}
              onChange={(e) => setReason(e.target.checked)}
            />{' '}
            🧠 reason (EYE)
          </label>
          <button
            className="v10-drag-ask-btn"
            disabled={loading || !question.trim() || !cg.trim()}
            onClick={ask}
          >
            {loading ? 'Asking…' : 'Ask'}
          </button>
        </div>
        {reason && scope === 'local' && (
          <textarea
            className="v10-drag-rules"
            rows={2}
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            placeholder={'optional N3 rules — applied on top of any verifiable rule-KAs in the CG. e.g.  { ?c code:changes ?f . ?f code:inModule code:authModule } => { ?c code:touchesAuth "true" } .'}
          />
        )}
      </div>

      {error && <div className="v10-drag-error">⚠ {error}</div>}

      {result && (
        <div className="v10-drag-result">
          <div className={`v10-drag-verdict ${verdictOk ? 'ok' : 'warn'}`}>
            <span className="mark">{verdictOk ? '✓' : '⚠'}</span>
            <span>
              <strong>{result.stats.verified}/{result.stats.factsCited}</strong> facts verified against the chain
            </span>
            <span className="v10-drag-chip">
              {isNetwork
                ? `network · ${nodesAnswered}/${servingNodes} node(s)`
                : 'this node'}
            </span>
            {retrievalLabel(String(result.stats.retrieval ?? '')) && (
              <span className="v10-drag-chip">{retrievalLabel(String(result.stats.retrieval ?? ''))}</span>
            )}
          </div>

          {isNetwork && (
            <div className={`v10-drag-network-status ${networkComplete ? 'ok' : 'warn'}`}>
              <Badge label="public scope" state={result.stats.scopeVerified === true} />
              <span className="v10-drag-chip">{rejected} rejected</span>
              <span className={`v10-drag-chip ${notEvaluated > 0 ? 'warn' : ''}`}>
                {notEvaluated} not evaluated
              </span>
              <span className={`v10-drag-chip ${peersSkipped > 0 ? 'warn' : ''}`}>
                {peersSkipped} peers skipped
              </span>
              {!networkComplete && (
                <span className="v10-drag-network-note">Partial network coverage — treat this as verified evidence, not a complete network answer.</span>
              )}
            </div>
          )}

          {answer.trim() && (
            <div className="v10-drag-answer">
              <MarkdownMessage content={answer} />
            </div>
          )}

          {result.citations.length > 0 && (
            <div className="v10-drag-cites">
              <div className="v10-drag-cites-title">Citations · {result.citations.length}</div>
              {result.citations.map((c, i) => (
                <div key={i} className={`v10-drag-cite ${c.checks.verified ? 'ok' : 'bad'}`}>
                  <div className="v10-drag-cite-fact">
                    <span className="s">{shortPred(c.triple.predicate)}</span> {displayObject(c.triple.object)}
                  </div>
                  <div className="v10-drag-cite-badges">
                    <Badge label="author-sig" state={c.checks.authorSig} />
                    <Badge label="merkle" state={c.checks.merkle} />
                    <Badge label="on-chain" state={c.checks.onChain} />
                  </div>
                  <div className="v10-drag-cite-meta">
                    KA {shortKa(c.kaId)} · root {short(c.onChain.merkleRoot)} · @{c.servingNode.slice(0, 10)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {result.reasoning && result.reasoning.derived.length > 0 && (
            <div className="v10-drag-reason">
              <div className="v10-drag-cites-title">
                🧠 Derived · {result.reasoning.derived.length} conclusion{result.reasoning.derived.length === 1 ? '' : 's'} with verified supporting evidence
                <span className="v10-drag-chip">{result.reasoning.engine}</span>
                {result.reasoning.rules && result.reasoning.rules.length > 0 && (
                  <span className="v10-drag-chip">{result.reasoning.rules.length} verifiable rule{result.reasoning.rules.length === 1 ? '' : 's'}</span>
                )}
              </div>
              {result.reasoning.derived.map((d, i) => (
                <details key={i} className="v10-drag-derived" open={i < 3}>
                  <summary className="v10-drag-derived-concl">
                    <span className="s">{shortPred(d.conclusion.subject)}</span>
                    <span className="p">{shortPred(d.conclusion.predicate)}</span>
                    {term(d.conclusion.object) !== 'true' && <span className="o">{term(d.conclusion.object)}</span>}
                    <span className="cnt">evidence · {d.support.length} fact{d.support.length === 1 ? '' : 's'}</span>
                  </summary>
                  <div className="v10-drag-proof">
                    {d.support.map((c, j) => (
                      <div key={j} className={`v10-drag-proofleaf ${c.checks.verified ? 'ok' : 'bad'}`}>
                        <span className="mk">{c.checks.verified ? '✓' : '✗'}</span>
                        <span className="s">{shortPred(c.triple.subject)}</span>
                        <span className="p">{shortPred(c.triple.predicate)}</span>
                        <span className="o">{term(c.triple.object)}</span>
                      </div>
                    ))}
                  </div>
                </details>
              ))}
              <div className="v10-drag-reason-foot">
                derived ≠ published — EYE infers these over <strong>only chain-verified facts</strong>. The listed citations are verified supporting evidence, not an exact or minimal derivation proof.
              </div>
            </div>
          )}
          {result.reasoning?.note && <div className="v10-drag-note">🧠 {result.reasoning.note}</div>}

          {result.perNode && result.perNode.length > 0 && (
            <div className="v10-drag-nodes">
              <div className="v10-drag-cites-title">Serving nodes</div>
              {result.perNode.map((p, i) => (
                <div key={i} className={`v10-drag-node ${p.error ? 'bad' : ''}`}>
                  <span>@{p.peerId.slice(0, 12)}</span>
                  <span>{p.error ? `error: ${p.error}` : `${p.factsCited} offered · ${p.verified} verified`}</span>
                </div>
              ))}
            </div>
          )}

        </div>
      )}
    </div>
  );
}
