import { describe, it, expect, vi } from 'vitest';
import { resolveExplicitUpdateTarget } from '../src/commands/maintenance.js';

// Guards the `dkg update <target>` stable-only gate: an explicit prerelease /
// dist-tag-pointing-at-a-prerelease must not bypass allowPrerelease:false, and a
// transient dist-tag resolution error must fail CLOSED (PR #1295 follow-up).
describe('resolveExplicitUpdateTarget', () => {
  const log = () => {};
  const resolverReturning = (ret: { version: string | null; error?: boolean }) =>
    vi.fn(async () => ret);

  it('allowPrerelease=true short-circuits — any target allowed, no registry hit', async () => {
    const resolve = resolverReturning({ version: null });
    expect(
      await resolveExplicitUpdateTarget('10.1.0-rc.1', true, { resolveLatestNpmVersion: resolve, log }),
    ).toEqual({ ok: true });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('stable explicit version on a stable-only node → allowed', async () => {
    const resolve = resolverReturning({ version: null });
    expect(
      await resolveExplicitUpdateTarget('10.1.0', false, { resolveLatestNpmVersion: resolve, log }),
    ).toEqual({ ok: true });
  });

  it('prerelease explicit version on a stable-only node → refused', async () => {
    const resolve = resolverReturning({ version: null });
    const r = await resolveExplicitUpdateTarget('10.1.0-rc.1', false, { resolveLatestNpmVersion: resolve, log });
    expect(r.ok).toBe(false);
  });

  it('dist-tag resolving to a STABLE version → allowed (resolved with allowPrerelease=true)', async () => {
    const resolve = resolverReturning({ version: '10.0.0' });
    const r = await resolveExplicitUpdateTarget('latest', false, { resolveLatestNpmVersion: resolve, log });
    expect(r).toEqual({ ok: true });
    expect(resolve).toHaveBeenCalledWith(log, true, 'latest');
  });

  it('dist-tag resolving to a PRERELEASE → refused', async () => {
    const resolve = resolverReturning({ version: '10.1.0-rc.1' });
    const r = await resolveExplicitUpdateTarget('latest', false, { resolveLatestNpmVersion: resolve, log });
    expect(r.ok).toBe(false);
  });

  it('dist-tag resolution ERROR → refused (fail CLOSED, like the no-arg path)', async () => {
    const resolve = resolverReturning({ version: null, error: true });
    const r = await resolveExplicitUpdateTarget('latest', false, { resolveLatestNpmVersion: resolve, log });
    expect(r.ok).toBe(false);
  });

  it('unknown dist-tag (no version, no error) → allowed to fall through (npm install fails naturally)', async () => {
    const resolve = resolverReturning({ version: null });
    const r = await resolveExplicitUpdateTarget('nonexistent-tag', false, { resolveLatestNpmVersion: resolve, log });
    expect(r).toEqual({ ok: true });
  });
});
