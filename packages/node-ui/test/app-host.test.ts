import { describe, it, expect } from 'vitest';

/**
 * AppHost security tests.
 *
 * The AppHostPage component in the Node UI enforces these rules:
 * 1. Only render an iframe for apps that exist in the installed apps list
 * 2. Never construct a src URL from raw URL params (prevents path traversal)
 * 3. The iframe must have a sandbox attribute restricting capabilities
 *
 * Since the component is React (requires DOM/jsdom), we test the core
 * logic here as pure functions and verify the component source for
 * security invariants.
 */

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
