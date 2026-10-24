import { afterEach, describe, expect, it, vi } from 'vitest';
import { shareAssertionAtomically } from '../hooks/capture-chat.mjs';

describe('capture-chat atomic sharing', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('shares the complete per-turn assertion without a retired entities selector', async () => {
    const fetcher = vi.fn(async (_url: string, init?: RequestInit) =>
      new Response(JSON.stringify({
        swmShared: true,
        promotedCount: 7,
        sealed: true,
        publishReady: true,
        shareOperationId: 'turn-share-1',
      }), { status: 200, headers: { 'Content-Type': 'application/json' } }));
    vi.stubGlobal('fetch', fetcher);

    const result = await shareAssertionAtomically({
      api: 'http://127.0.0.1:9200',
      project: 'team-cg',
      subGraph: 'chat',
      token: 'secret',
    }, 'chat-session-turn-1');

    expect(result).toMatchObject({ swmShared: true, sealed: true, publishReady: true });
    expect(fetcher).toHaveBeenCalledTimes(1);
    const [url, init] = fetcher.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:9200/api/knowledge-assets/chat-session-turn-1/swm/share');
    expect(JSON.parse(String(init?.body))).toEqual({
      contextGraphId: 'team-cg',
      subGraphName: 'chat',
    });
  });
});
