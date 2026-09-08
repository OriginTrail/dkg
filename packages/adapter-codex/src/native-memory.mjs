import { readFileSync, readdirSync, unlinkSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { memoryContext } from './memory.mjs';
const contentId = (text) => createHash('sha256').update(text).digest('hex').slice(0, 20);

export class NativeMemory {
  constructor(memory) {
    this.memory = memory; this.turns = new Map();
    this.dir = join(memory.dir, 'native-turns');
    this.outbox = join(memory.dir, 'native-outbox');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    mkdirSync(this.outbox, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(this.dir)) {
      if (!name.endsWith('.json')) continue;
      try { const turn = JSON.parse(readFileSync(join(this.dir, name), 'utf8')); this.turns.set(turn.key, turn); } catch {}
    }
  }
  save(turn) {
    this.turns.set(turn.key, turn);
    if (this.memory.enabled('native', 'Capture')) this.memory.atomic(join(this.dir, turn.key + '.json'), turn);
  }
  async handle(input, retry = false) {
    if (input.surface === 'dkg') return {};
    const threadId = input.session_id; const turnId = input.turn_id;
    if (![threadId, turnId].every((s) => typeof s === 'string' && /^[\w-]{1,100}$/.test(s))) throw new Error('Invalid Codex hook session or turn ID.');
    const key = `${threadId}_${turnId}`;
    let turn = this.turns.get(key) || { key, threadId, turnId, trace: [] };
    const event = input.hook_event_name;
    if (event === 'UserPromptSubmit') {
      if (typeof input.prompt !== 'string' || input.prompt.length > 200000) throw new Error('Invalid Codex prompt.');
      const promptId = contentId(input.prompt);
      if (!turn.recall || turn.promptId !== promptId) turn.recall = retry ? { status: 'failed', hits: [], searched: [], errors: ['Recall was unavailable when this question was sent.'], durationMs: 0 } : await this.memory.recall(input.prompt, 'native');
      turn.promptId = promptId;
      this.save(turn);
      const captured = await this.memory.capture({ threadId, turnId, messageId: `user:${turnId}:${contentId(input.prompt)}`, role: 'user', text: input.prompt,
        surface: 'native', recall: turn.recall });
      const context = memoryContext(turn.recall);
      return { ...(context ? { hookSpecificOutput: { hookEventName: event, additionalContext: context } } : {}),
        ...(captured?.status === 'pending' ? { systemMessage: 'DKG message capture is queued locally; the node has not confirmed storage yet.' } : {}) };
    }
    if (event === 'PostToolUse') {
      if (!this.memory.enabled('native', 'Capture')) return {};
      if (!turn.trace.some((t) => t.itemId === input.tool_use_id)) turn.trace.push({
        label: String(input.tool_name || 'tool').slice(0, 180), itemId: String(input.tool_use_id || ''),
        status: input.tool_failed ? 'failed' : 'completed' });
      this.save(turn); return {};
    }
    if (event === 'Stop') {
      if (typeof input.last_assistant_message === 'string' && input.last_assistant_message) {
        const captured = await this.memory.capture({ threadId, turnId, messageId: `assistant:${turnId}:final:${contentId(input.last_assistant_message)}`, role: 'assistant',
          text: input.last_assistant_message, surface: 'native', recall: turn.recall, trace: turn.trace });
        if (captured?.status === 'pending') return { systemMessage: 'DKG reply capture is queued locally; the node has not confirmed storage yet.' };
      }
      return {};
    }
    return {};
  }
  async retry() {
    for (const file of readdirSync(this.outbox).filter((f) => f.endsWith('.json')).sort()) {
      try {
        await this.handle(JSON.parse(readFileSync(join(this.outbox, file), 'utf8')), true);
        unlinkSync(join(this.outbox, file));
      } catch { break; }
    }
  }
}
