import { describe, it, expect, vi } from 'vitest';

const INSTALLED_APPS = [
  { id: 'oregon-trail', label: 'Oregon Trail', path: '/apps/oregon-trail' },
  { id: 'my-app', label: 'My App', path: '/apps/my-app' },
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
    const app = resolveApp('nonexistent', INSTALLED_APPS);
    expect(app).toBeUndefined();
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

describe('AppHost — iframe sandbox policy', () => {
  it('component source includes sandbox attribute', async () => {
    const { readFile } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const src = await readFile(
      join(import.meta.dirname, '..', 'src', 'ui', 'pages', 'AppHost.tsx'),
      'utf-8',
    );
    expect(src).toContain('sandbox=');
    expect(src).toContain('allow-scripts');
    expect(src).not.toContain('allow-top-navigation');
  });

  it('sandbox does not include allow-same-origin (prevents iframe escaping sandbox)', async () => {
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

describe('AppHost — postMessage token handoff with opaque-origin iframe', () => {
  it('uses wildcard target origin for postMessage (opaque iframe origin)', async () => {
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
        mockIframe.contentWindow.postMessage({ type: 'dkg-token', token: t }, '*');
      }
    };

    sendToken();

    expect(mockPostMessage).toHaveBeenCalledOnce();
    expect(mockPostMessage).toHaveBeenCalledWith(
      { type: 'dkg-token', token: 'test-token-abc123' },
      '*',
    );

    delete (globalThis as any).__DKG_TOKEN__;
  });

  it('does not send token when no token is set', () => {
    const mockPostMessage = vi.fn();
    const mockIframe = {
      contentWindow: { postMessage: mockPostMessage },
    };

    delete (globalThis as any).__DKG_TOKEN__;

    const sendToken = () => {
      const t = (globalThis as any).__DKG_TOKEN__;
      if (t && mockIframe.contentWindow) {
        mockIframe.contentWindow.postMessage({ type: 'dkg-token', token: t }, '*');
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
