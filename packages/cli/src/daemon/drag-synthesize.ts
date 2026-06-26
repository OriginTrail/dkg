// daemon/drag-synthesize.ts
//
// OPTIONAL grounded prose synthesis for dRAG (OT-RFC-55). Opt-in only.
//
// Synthesis is a human-convenience layer ON TOP of the verifiable answer — it
// NEVER mutates the facts or citations, which remain the authoritative,
// machine-readable result. The model is instructed to use ONLY the supplied
// verified facts and to add nothing, so the prose stays grounded in what was
// already proven against the chain. Best-effort: any failure returns null and
// the caller keeps the structured digest.

import type { LlmConfig } from '../config.js';
import type { DragFact } from '@origintrail-official/dkg-agent';

const SYSTEM =
  'You answer strictly and only from a list of VERIFIED facts supplied by the user. ' +
  'Do not use any outside knowledge. Do not infer or add anything not present in the facts. ' +
  'If the facts do not answer the question, say so plainly. Be concise (1–3 sentences). ' +
  'Do not fabricate citations — the system attaches the verifiable citations separately.';

export async function synthesizeAnswer(
  question: string,
  facts: DragFact[],
  llm: LlmConfig,
  timeoutMs = 20_000,
): Promise<string | null> {
  if (!facts.length) return null;
  const baseURL = (llm.baseURL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const model = llm.model ?? 'gpt-4o-mini';
  const factLines = facts
    .map((f, i) => `${i + 1}. ${localName(f.subject)} — ${localName(f.predicate)}: ${literal(f.object)}`)
    .join('\n');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseURL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(llm.apiKey ? { Authorization: `Bearer ${llm.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: 'system', content: SYSTEM },
          { role: 'user', content: `Question: ${question}\n\nVERIFIED FACTS:\n${factLines}` },
        ],
      }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = json.choices?.[0]?.message?.content?.trim();
    return text && text.length > 0 ? text : null;
  } catch {
    return null; // best-effort — caller keeps the structured answer
  } finally {
    clearTimeout(timer);
  }
}

function localName(uri: string): string {
  const s = uri.replace(/^<|>$/g, '');
  const m = s.match(/[/#:]([^/#:]+)$/);
  return m ? m[1] : s;
}

function literal(o: string): string {
  const m = o.match(/^"((?:[^"\\]|\\.)*)"/);
  return m ? m[1].replace(/\\"/g, '"') : localName(o);
}
