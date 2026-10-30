import { describe, expect, it, vi } from 'vitest';
import { DkgLocalLlmRuntime } from '../src/runtime.js';
import { makeMcp, answerResponse } from './helpers/runtime-fixtures.js';

describe('runtime session boundaries', () => {
  it('bounds retained turns, copies returned history, and resets the session counter on clear', async () => {
    const trace = { write: vi.fn() };
    const fetcher = vi.fn<typeof fetch>(async () => answerResponse('reply'));
    const runtime = await DkgLocalLlmRuntime.create({ mcp: makeMcp(), fetch: fetcher, profile: 'chat', maxSessionTurns: 2, maxSessionChars: 1_000, trace });
    expect(runtime.getSessionInfo()).toEqual({ turns: 0, maxTurns: 2, maxChars: 1_000 });
    await runtime.run('first');
    await runtime.run('second');
    await runtime.run('third');
    expect(runtime.getSessionHistory().map(turn => [turn.turn, turn.user])).toEqual([[2, 'second'], [3, 'third']]);
    const history = runtime.getSessionHistory();
    history[0].user = 'external mutation';
    history.pop();
    expect(runtime.getSessionHistory().map(turn => turn.user)).toEqual(['second', 'third']);
    await runtime.clearSession();
    expect(runtime.getSessionInfo()).toEqual({ turns: 0, maxTurns: 2, maxChars: 1_000 });
    expect(trace.write).toHaveBeenCalledWith('SESSION CLEARED', { removedTurns: 2 });
    await runtime.run('fresh');
    expect(runtime.getSessionHistory()).toEqual([{ turn: 1, user: 'fresh', assistant: 'reply', evidence: [] }]);
    const request = JSON.parse(String(fetcher.mock.calls[3][1]?.body));
    expect(request.messages[0].content).not.toContain('BOUNDED CHAT SESSION');
  });

  it.each([1, 2, 3, 20, 26, 27, 28, 40, 300])('compacts prior conversation to a %i character context budget', async maxSessionChars => {
    const fetcher = vi.fn<typeof fetch>(async () => answerResponse(`ANSWER_START ${'x'.repeat(600)} ANSWER_END`));
    const runtime = await DkgLocalLlmRuntime.create({ mcp: makeMcp(), fetch: fetcher, profile: 'chat', maxSessionChars });
    await runtime.run('FIRST_MARKER');
    await runtime.run('SECOND_MARKER');
    await runtime.run('THIRD_MARKER');
    const request = JSON.parse(String(fetcher.mock.calls[2][1]?.body));
    const initial = JSON.parse(String(fetcher.mock.calls[0][1]?.body));
    const historyPrefix = `${initial.messages[0].content}\n\nBOUNDED CHAT SESSION\n`
      + 'Prior turns below only resolve conversational references. They are not current DKG evidence.\n'
      + 'For a DKG follow-up, call an available read tool and ground the new answer in its result.\n\n';
    expect(request.messages[0].content.startsWith(historyPrefix)).toBe(true);
    const renderedHistory = request.messages[0].content.slice(historyPrefix.length);
    expect(renderedHistory.length).toBeLessThanOrEqual(maxSessionChars);
    // For this fixture the detailed marker is 27 characters. Smaller budgets
    // must still fit a marker; they cannot accommodate the verbose one.
    if (maxSessionChars >= 27) expect(renderedHistory).toContain('chars omitted');
    else expect(renderedHistory).toContain('…');
    expect(renderedHistory).not.toContain('FIRST_MARKER');
    expect(renderedHistory).not.toContain('x'.repeat(600));
    if (maxSessionChars === 300) {
      expect(renderedHistory).toContain('SECOND_MARKER');
      expect(renderedHistory).toContain('ANSWER_END');
    }
  });
});

