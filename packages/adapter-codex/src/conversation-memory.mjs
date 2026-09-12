import { EventEmitter } from 'node:events';

const INJECTED_MEMORY_PREFIX = 'DKG memory evidence for this question.';
const TOOL_ITEM_TYPES = new Set([
  'commandExecution', 'mcpToolCall', 'fileChange', 'webSearch', 'dynamicToolCall',
]);

/** Owns the conversation-memory lifecycle at a narrow bridge boundary. */
export class ConversationMemoryCoordinator extends EventEmitter {
  constructor(memory) {
    super();
    this.backend = memory;
    this.turns = new Map();
    memory.on('update', (event) => this.emit('update', event));
  }

  snapshot(threadId) { return this.backend.snapshot(threadId); }
  configure(input) { return this.backend.configure(input); }
  retry() { return this.backend.retry(); }

  async prepareTurn({ threadId, requestId, text }) {
    const messageId = `user:${requestId}`;
    const recall = await this.backend.recall(text, 'dkg');
    this.backend.stageCapture({
      threadId, messageId, role: 'user', text, surface: 'dkg', recall,
      awaitingTurn: true,
    });
    this.turns.set(threadId, {
      requestId, messageId, recall, trace: [], text, turnId: null, completed: false,
    });
    return { recall };
  }

  async startTurn(threadId, requestId, turnId) {
    const turn = this.turns.get(threadId);
    if (!turn || turn.requestId !== requestId) return;
    turn.turnId = turnId;
    this.backend.bindTurn(threadId, turn.messageId, turnId);
    await this.backend.commitCapture(threadId, turn.messageId);
    if (turn.completed) this.turns.delete(threadId);
  }

  observeItem(method, params) {
    const turn = this.turns.get(params.threadId);
    if (!turn || !params.item) return params.item;
    const item = { ...params.item };
    const turnId = params.turnId ?? turn.turnId;
    if (turnId && !turn.turnId) {
      turn.turnId = turnId;
      this.backend.bindTurn(params.threadId, turn.messageId, turnId);
      void this.backend.commitCapture(params.threadId, turn.messageId);
    }
    if (item.type === 'userMessage') {
      return {
        ...item,
        memoryRecordId: this.backend.recordId(params.threadId, turn.messageId),
        content: [{ type: 'text', text: turn.text }],
      };
    }
    if (method !== 'item/completed') return item;
    if (item.type === 'agentMessage' && item.text && turnId) {
      const messageId = `assistant:${turnId}:${item.id}`;
      item.memoryRecordId = this.backend.recordId(params.threadId, messageId);
      void this.backend.capture({
        threadId: params.threadId, turnId, messageId, itemId: item.id,
        role: 'assistant', phase: item.phase || 'final', text: item.text, surface: 'dkg',
        recall: turn.recall, trace: item.phase === 'commentary' ? [] : [...turn.trace],
      }).catch(() => {});
    } else if (TOOL_ITEM_TYPES.has(item.type)) {
      turn.trace.push({
        label: item.type === 'mcpToolCall' ? `${item.server} · ${item.tool}` : item.tool || item.type,
        status: item.status || 'completed', itemId: item.id,
      });
    }
    return item;
  }

  finishTurn(threadId, turnId) {
    const turn = this.turns.get(threadId);
    if (!turn || (turn.turnId && turn.turnId !== turnId)) return;
    turn.completed = true;
    if (turn.turnId) this.turns.delete(threadId);
  }

  decorateThread(thread) {
    const visible = {
      ...thread,
      turns: (thread.turns ?? []).map((turn) => ({
        ...turn,
        items: (turn.items ?? []).map((item) => item.type === 'userMessage'
          ? { ...item, content: (item.content || []).filter((part, index) => (
            index === 0 || !part.text?.startsWith(INJECTED_MEMORY_PREFIX)
          )) }
          : item),
      })),
    };
    for (const turn of visible.turns) {
      const records = this.backend.receiptCandidates(visible.id, turn.id);
      const used = new Set();
      turn.items = turn.items.map((item) => {
        const role = item.type === 'userMessage' ? 'user'
          : item.type === 'agentMessage' ? 'assistant' : null;
        if (!role) return item;
        const text = role === 'user'
          ? (item.content || []).map((part) => part.text || '').join('\n')
          : item.text;
        const record = records.find((candidate) => (
          !used.has(candidate.id) && candidate.role === role && (
            candidate.itemId === item.id
            || candidate.text === text
            || (role === 'user' && (
              text.startsWith(candidate.text + '\n\nAttached local files:\n')
              || text.startsWith(candidate.text + INJECTED_MEMORY_PREFIX)
            ))
          )
        ));
        if (!record) return item;
        used.add(record.id);
        return {
          ...item,
          memoryRecordId: record.id,
          ...(role === 'user' ? { content: [{ type: 'text', text: record.text }] } : {}),
        };
      });
    }
    return visible;
  }
}
