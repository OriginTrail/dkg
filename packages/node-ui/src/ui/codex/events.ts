export type Item = { id: string; type: string; [key: string]: any };
export type Turn = { id: string; status: string; items: Item[]; error?: { message: string } };
export type Thread = { id: string; name?: string | null; preview?: string; cwd: string; model?: string | null; turns: Turn[]; status?: { type: string } };
export type BridgeEvent = { sequence: number; method: string; params: any };

// Item-completed replaces streamed text, avoiding duplicated final answers.
export function applyEvent(thread: Thread, event: BridgeEvent): Thread {
  const p = event.params;
  if (p.threadId && p.threadId !== thread.id) return thread;
  if (event.method === 'thread/name/updated') return { ...thread, name: p.threadName };
  if (event.method === 'turn/started') {
    if (thread.turns.some((t) => t.id === p.turn.id)) return thread;
    return { ...thread, turns: [...thread.turns, { ...p.turn, items: p.turn.items ?? [] }] };
  }
  if (!p.turnId && !p.turn?.id) return thread;
  const turnId = p.turnId ?? p.turn.id;
  const turns = thread.turns.map((turn) => {
    if (turn.id !== turnId) return turn;
    if (event.method === 'turn/completed') return { ...turn, status: p.turn.status, error: p.turn.error };
    if (p.item && ['item/started', 'item/completed'].includes(event.method)) {
      const found = turn.items.some((item) => item.id === p.item.id);
      return { ...turn, items: found ? turn.items.map((item) => item.id === p.item.id ? p.item : item) : [...turn.items, p.item] };
    }
    if (event.method === 'item/agentMessage/delta') {
      const exists = turn.items.some((item) => item.id === p.itemId);
      return { ...turn, items: exists ? turn.items.map((item) => item.id === p.itemId ? { ...item, text: (item.text ?? '') + p.delta } : item)
        : [...turn.items, { id: p.itemId, type: 'agentMessage', text: p.delta }] };
    }
    if (event.method === 'item/commandExecution/outputDelta') {
      return { ...turn, items: turn.items.map((item) => item.id === p.itemId ? { ...item, aggregatedOutput: ((item.aggregatedOutput ?? '') + p.delta).slice(-100_000) } : item) };
    }
    return turn;
  });
  return { ...thread, turns };
}
