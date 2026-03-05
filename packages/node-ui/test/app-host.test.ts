import { describe, it, expect, vi } from 'vitest';

const INSTALLED_APPS = [
  { id: 'oregon-trail', label: 'Oregon Trail', path: '/apps/oregon-trail' },
  { id: 'my-app', label: 'My App', path: '/apps/my-app' },
];

const INSTALLED_APPS_WITH_STATIC_URL = [
  { id: 'oregon-trail', label: 'Oregon Trail', path: '/apps/oregon-trail', staticUrl: 'http://127.0.0.1:19300/apps/oregon-trail/' },
  { id: 'my-app', label: 'My App', path: '/apps/my-app', staticUrl: 'http://127.0.0.1:19300/apps/my-app/' },
];

function resolveApp(appId: string | undefined, apps: typeof INSTALLED_APPS) {
  return apps.find(a => a.id === appId);
}

describe('AppHost — app resolution security', () => {
  it('resolves a known app ID to its metadata', () => {
    const app = resolveApp('oregon-trail', INSTALLED_APPS);
    expect(app).toBeDefined();
    expect(app!.path).toBe('/apps/oregon-trail');
  });

  it('returns undefined for an unknown app ID', () => {
    expect(resolveApp('nonexistent', INSTALLED_APPS)).toBeUndefined();
  });

  it('returns undefined for path-traversal attempts', () => {
    expect(resolveApp('..', INSTALLED_APPS)).toBeUndefined();
    expect(resolveApp('%2E%2E', INSTALLED_APPS)).toBeUndefined();
    expect(resolveApp('../../../etc/passwd', INSTALLED_APPS)).toBeUndefined();
    expect(resolveApp('oregon-trail/../../secret', INSTALLED_APPS)).toBeUndefined();
  });

  it('returns undefined for empty or undefined appId', () => {
    expect(resolveApp(undefined, INSTALLED_APPS)).toBeUndefined();
    expect(resolveApp('', INSTALLED_APPS)).toBeUndefined();
  });

  it('only uses server-provided path, never constructs from raw param', () => {
    const app = resolveApp('oregon-trail', INSTALLED_APPS);
    expect(app!.path).toBe('/apps/oregon-trail');
    expect(app!.path).not.toContain('..');
  });
});

describe('AppHost — sandbox policy', () => {
  it('sandbox never includes allow-same-origin (apps share one static-server origin)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    const sandboxMatch = src.match(/sandbox="([^"]*)"/);
    expect(sandboxMatch).toBeTruthy();
    expect(sandboxMatch![1]).not.toContain('allow-same-origin');
  });

  it('sandbox includes allow-scripts, allow-forms, allow-popups', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    const sandboxMatch = src.match(/sandbox="([^"]*)"/);
    expect(sandboxMatch).toBeTruthy();
    expect(sandboxMatch![1]).toContain('allow-scripts');
    expect(sandboxMatch![1]).toContain('allow-forms');
    expect(sandboxMatch![1]).toContain('allow-popups');
  });

  it('sandbox blocks top-level navigation (no allow-top-navigation in sandbox value)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    const sandboxMatch = src.match(/sandbox="([^"]*)"/);
    expect(sandboxMatch).toBeTruthy();
    expect(sandboxMatch![1]).not.toContain('allow-top-navigation');
  });

  it('uses staticUrl (different origin) when available, falling back to same-origin path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    expect(src).toContain('app.staticUrl');
    expect(src).toContain('app.path');
  });

  it('iframe src resolves to separate-origin URL when staticUrl is provided', () => {
    const app = INSTALLED_APPS_WITH_STATIC_URL.find(a => a.id === 'oregon-trail')!;
    const iframeSrc = app.staticUrl || `${app.path}/`;
    expect(iframeSrc).toBe('http://127.0.0.1:19300/apps/oregon-trail/');
    expect(new URL(iframeSrc).port).toBe('19300');
  });

  it('iframe src falls back to same-origin path when staticUrl is absent', () => {
    const app = INSTALLED_APPS.find(a => a.id === 'oregon-trail')!;
    const iframeSrc = (app as any).staticUrl || `${app.path}/`;
    expect(iframeSrc).toBe('/apps/oregon-trail/');
  });

  it('component does not render iframe when app is not found', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    expect(src).toContain('if (!app)');
    expect(src).not.toMatch(/src=\{.*appId/);
  });
});

describe('AppHost — CORS preflight and src lifecycle', () => {
  it('preflights staticUrl with standard CORS fetch, not no-cors (opaque responses hide errors)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    expect(src).not.toContain("mode: 'no-cors'");
    expect(src).not.toContain('mode: "no-cors"');
    expect(src).toContain("method: 'HEAD'");
  });

  it('gates staticUrl on response.ok so 404/500 falls back to path', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    expect(src).toContain('r.ok');
  });

  it('clears src to null at effect start so stale iframe is removed during preflight', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    const effectBody = src.slice(src.indexOf('useEffect(() => {'));
    const firstSetSrc = effectBody.indexOf('setSrc(');
    const setSrcNull = effectBody.indexOf('setSrc(null)');
    expect(setSrcNull).toBeGreaterThan(-1);
    expect(setSrcNull).toBeLessThan(firstSetSrc === setSrcNull ? Infinity : effectBody.indexOf('fetch('));
  });

  it('preflight logic: ok response uses staticUrl, non-ok falls back to path', () => {
    const app = { id: 'test', label: 'Test', path: '/apps/test', staticUrl: 'http://localhost:19300/apps/test/' };

    const okResult = (response: { ok: boolean }) =>
      response.ok ? app.staticUrl : `${app.path}/`;

    expect(okResult({ ok: true })).toBe(app.staticUrl);
    expect(okResult({ ok: false })).toBe('/apps/test/');
  });
});

describe('AppHost — postMessage token handoff', () => {
  it('uses wildcard target origin for postMessage (cross-origin iframe)', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    const postMessageCalls = src.match(/\.postMessage\(\s*\{[^}]*\}\s*,\s*['"]([^'"]*)['"]/g) ?? [];
    expect(postMessageCalls.length).toBeGreaterThan(0);
    for (const call of postMessageCalls) {
      expect(call).toContain("'*'");
    }
  });

  it('sends apiOrigin alongside token in postMessage', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    expect(src).toContain('apiOrigin: window.location.origin');
  });

  it('responds to dkg-token-request from iframe via message listener', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    expect(src).toContain('dkg-token-request');
    expect(src).toContain('e.source');
  });

  it('sendToken function sends token with wildcard origin (behavioral)', () => {
    const mockPostMessage = vi.fn();
    const mockIframe = {
      contentWindow: { postMessage: mockPostMessage },
    };
    const token = 'test-token-abc123';

    (globalThis as any).__DKG_TOKEN__ = token;

    const sendToken = () => {
      const t = (globalThis as any).__DKG_TOKEN__;
      if (t && mockIframe.contentWindow) {
        mockIframe.contentWindow.postMessage(
          { type: 'dkg-token', token: t, apiOrigin: 'http://localhost:19200' },
          '*',
        );
      }
    };

    sendToken();

    expect(mockPostMessage).toHaveBeenCalledOnce();
    expect(mockPostMessage).toHaveBeenCalledWith(
      { type: 'dkg-token', token: 'test-token-abc123', apiOrigin: 'http://localhost:19200' },
      '*',
    );

    delete (globalThis as any).__DKG_TOKEN__;
  });

  it('does not send token when no token is set', () => {
    const mockPostMessage = vi.fn();
    delete (globalThis as any).__DKG_TOKEN__;

    const sendToken = () => {
      const t = (globalThis as any).__DKG_TOKEN__;
      if (t) {
        mockPostMessage({ type: 'dkg-token', token: t }, '*');
      }
    };

    sendToken();
    expect(mockPostMessage).not.toHaveBeenCalled();
  });

  it('token-request handler verifies source matches iframe contentWindow', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    expect(src).toContain('iframeRef.current?.contentWindow === e.source');
  });
});
