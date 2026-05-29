// @vitest-environment happy-dom
//
// DOM/interaction + a11y glue for the notifications pane (B3). Renders the
// real components against a controllable mock feed (the pane is pure props;
// the bell's hook is mocked) using the repo's established happy-dom +
// createRoot pattern (no new deps). Pure-logic coverage lives in
// notifications-feed.test.ts; this file owns the stateful interaction
// behaviours QA flagged: two-tap Deny (+ Escape cancels the confirm),
// approve/deny row-retained-on-failure, aria-live announcements, and
// bell Escape-closes-and-restores-focus.

import React, { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createRoot, type Root } from 'react-dom/client';
import { NotificationsPane } from '../src/ui/components/Notifications/NotificationsPane.js';
import type {
  UseNotificationsFeed,
  JoinRequestItem,
  ActivityItem,
  ActionResult,
} from '../src/ui/hooks/useNotificationsFeed.js';

// Hoisted holder so the (hoisted) vi.mock factory and the tests share one
// mutable feed reference for the bell-level render.
const hoisted = vi.hoisted(() => ({ feed: null as UseNotificationsFeed | null }));

// Mock the hook + stores so NotificationsBell renders deterministically
// (the hook normally hits the daemon; the stores are zustand selectors).
vi.mock('../src/ui/hooks/useNotificationsFeed.js', async (orig) => ({
  ...(await orig<typeof import('../src/ui/hooks/useNotificationsFeed.js')>()),
  useNotificationsFeed: () => hoisted.feed,
}));
vi.mock('../src/ui/stores/projects.js', () => ({
  useProjectsStore: (sel: (s: any) => unknown) => sel({ setActiveProject: vi.fn() }),
}));
vi.mock('../src/ui/stores/tabs.js', () => ({
  useTabsStore: () => ({ openTab: vi.fn() }),
}));

// Imported AFTER the mocks are declared (hoisting keeps the mocks first).
import { NotificationsBell } from '../src/ui/components/Shell/NotificationsBell.js';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const joinItem = (over: Partial<JoinRequestItem> = {}): JoinRequestItem => ({
  id: 1,
  cgId: 'cg:a',
  contextGraphName: 'Alpha',
  agentAddress: '0xabc0000000000000000000000000000000000abc',
  agentName: 'Dana',
  ts: 1000,
  read: false,
  ...over,
});

function makeFeed(over: Partial<UseNotificationsFeed> = {}): UseNotificationsFeed {
  return {
    joinRequests: [],
    activity: [],
    unread: 0,
    hasInformationalUnread: false,
    status: 'ready',
    partialActivityError: false,
    approve: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
    deny: vi.fn(async (): Promise<ActionResult> => ({ ok: true })),
    markSeen: vi.fn(),
    markAllInformationalSeen: vi.fn(),
    retry: vi.fn(),
    ...over,
  };
}

describe('NotificationsPane — interaction + a11y (happy-dom)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  const render = (feed: UseNotificationsFeed) =>
    act(() => {
      root.render(
        React.createElement(NotificationsPane, { feed, onOpenContextGraph: vi.fn() }),
      );
    });

  const buttonByText = (re: RegExp): HTMLButtonElement | undefined =>
    [...container.querySelectorAll('button')].find((b) => re.test(b.textContent ?? '')) as
      | HTMLButtonElement
      | undefined;

  it('Deny is a two-tap inline confirm (first tap reveals Deny? Yes/Cancel, no reject yet)', async () => {
    const deny = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    render(makeFeed({ joinRequests: [joinItem()], deny }));

    // First tap: the Deny button → reveals the confirm; reject NOT called.
    const denyBtn = buttonByText(/^Deny$/)!;
    expect(denyBtn).toBeTruthy();
    act(() => denyBtn.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(deny).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Deny?');

    // Second tap: Yes → reject called once. Await so the async run() settles
    // inside act (the row sets phase synchronously, then awaits the mutation).
    const yesBtn = buttonByText(/^Yes$/)!;
    await act(async () => {
      yesBtn.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(deny).toHaveBeenCalledTimes(1);
  });

  it('Escape inside the Deny-confirm cancels the confirm (does not reject)', () => {
    const deny = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    render(makeFeed({ joinRequests: [joinItem()], deny }));
    act(() => buttonByText(/^Deny$/)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(container.textContent).toContain('Deny?');

    const confirm = container.querySelector('.v10-notif-deny-confirm')!;
    act(() =>
      confirm.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(container.textContent).not.toContain('Deny?');
    expect(deny).not.toHaveBeenCalled();
  });

  it('Approve has NO confirm — single click invokes approve immediately', async () => {
    const approve = vi.fn(async (): Promise<ActionResult> => ({ ok: true }));
    render(makeFeed({ joinRequests: [joinItem()], approve }));
    await act(async () => {
      buttonByText(/^Approve$/)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(approve).toHaveBeenCalledTimes(1);
  });

  it('on approve FAILURE the row is retained with an inline Retry (not removed)', async () => {
    const approve = vi.fn(
      async (): Promise<ActionResult> => ({ ok: false, error: 'HTTP 503', roleError: false }),
    );
    render(makeFeed({ joinRequests: [joinItem()], approve }));
    await act(async () => {
      buttonByText(/^Approve$/)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    // Row still present (join title visible) + a Retry affordance appeared.
    expect(container.textContent).toContain('Join request');
    expect(buttonByText(/Retry/)).toBeTruthy();
  });

  it('role-error failure surfaces the no-longer-curator copy', async () => {
    const approve = vi.fn(
      async (): Promise<ActionResult> => ({
        ok: false,
        error: 'Only the context graph creator can manage invitations',
        roleError: true,
      }),
    );
    render(makeFeed({ joinRequests: [joinItem()], approve }));
    await act(async () => {
      buttonByText(/^Approve$/)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(container.textContent).toContain('no longer the curator');
  });

  it('renders an aria-live region for action announcements', () => {
    render(makeFeed({ joinRequests: [joinItem()] }));
    expect(container.querySelector('[aria-live="polite"]')).toBeTruthy();
  });

  it('identity-pending shows "Verifying access…", never the all-caught-up copy', () => {
    render(makeFeed({ status: 'identity-pending' }));
    expect(container.textContent).toContain('Verifying access');
    expect(container.textContent).not.toContain('all caught up');
  });

  it('empty ready state shows the scoped all-caught-up copy', () => {
    render(makeFeed({ status: 'ready' }));
    expect(container.textContent).toContain('all caught up');
  });

  it('Mark all read calls markAllInformationalSeen (informational only)', () => {
    const markAllInformationalSeen = vi.fn();
    const digest: ActivityItem = {
      kind: 'digest', id: 'd1', cgId: 'cg:a', contextGraphName: 'Alpha',
      event: 'promoted', count: 2, ts: 1, read: false,
    };
    render(makeFeed({ hasInformationalUnread: true, activity: [digest], markAllInformationalSeen }));
    act(() => buttonByText(/Mark all read/)!.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(markAllInformationalSeen).toHaveBeenCalledTimes(1);
  });

  it('I4: Mark all read SHOWS when only rejected confirmations are unread (badge=0)', () => {
    // Rejections are excluded from badgeCount, so unread=0 here — but they are
    // informational-unread and must be clearable. The button gates on
    // hasInformationalUnread, NOT badgeCount.
    const rejected: ActivityItem = {
      kind: 'join_rejected', id: 7, cgId: 'cg:c', contextGraphName: 'Gamma', ts: 1, read: false,
    };
    render(makeFeed({ unread: 0, hasInformationalUnread: true, activity: [rejected] }));
    expect(buttonByText(/Mark all read/)).toBeTruthy();
  });

  it('I4: Mark all read HIDDEN when nothing informational is unread', () => {
    render(makeFeed({ unread: 0, hasInformationalUnread: false, joinRequests: [joinItem()] }));
    // A pending join request is actionable, not informational — no Mark-all-read.
    expect(buttonByText(/Mark all read/)).toBeUndefined();
  });

  it('M9 frontend re-surface: a digest renders unread again after a load() returns read=0 for its digestKey', () => {
    const digest = (read: boolean): ActivityItem => ({
      kind: 'digest', id: 'activity:cg:a:promoted:42', cgId: 'cg:a',
      contextGraphName: 'Alpha', event: 'promoted', count: 2, ts: 1, read,
    });
    const rowUnread = () =>
      !!container.querySelector('.v10-notif-row-activity.v10-notif-unread');

    // Unread initially.
    render(makeFeed({ unread: 1, activity: [digest(false)] }));
    expect(rowUnread()).toBe(true);

    // markSeen → the next load() returns the SAME digestKey read=1: no longer unread.
    render(makeFeed({ unread: 0, activity: [digest(true)] }));
    expect(rowUnread()).toBe(false);

    // A new same-bucket event lands → load() REPLACES data with the digest
    // re-surfaced as read=0 → it shows unread again (no stale-merge that would
    // keep it read). This is the M9 frontend half.
    render(makeFeed({ unread: 1, activity: [digest(false)] }));
    expect(rowUnread()).toBe(true);
  });
});

describe('NotificationsBell — disclosure keyboard + focus (happy-dom)', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    hoisted.feed = makeFeed({ unread: 1, joinRequests: [joinItem()] });
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    hoisted.feed = null;
    vi.restoreAllMocks();
  });

  const bellBtn = () =>
    [...container.querySelectorAll('button')].find((b) =>
      /Notifications/.test(b.getAttribute('aria-label') ?? ''),
    ) as HTMLButtonElement;

  const openPane = () => {
    act(() => root.render(React.createElement(NotificationsBell)));
    act(() => bellBtn().dispatchEvent(new MouseEvent('click', { bubbles: true })));
  };

  it('renders the unread badge and is a disclosure (aria-haspopup/expanded)', () => {
    act(() => root.render(React.createElement(NotificationsBell)));
    const btn = bellBtn();
    expect(btn.getAttribute('aria-haspopup')).toBe('dialog');
    expect(btn.getAttribute('aria-expanded')).toBe('false');
    expect(container.querySelector('.v10-header-notif-badge')?.textContent).toBe('1');
  });

  it('opens on click (pane mounts, aria-expanded → true)', () => {
    openPane();
    expect(bellBtn().getAttribute('aria-expanded')).toBe('true');
    expect(container.querySelector('.v10-notif-pane')).toBeTruthy();
  });

  it('I5: on open, focus lands on the Approve button — not the row Open-{CG} link', () => {
    openPane();
    const active = document.activeElement as HTMLElement | null;
    expect(active?.classList.contains('v10-notif-btn-approve')).toBe(true);
    // Regression guard: it must NOT be the cg-link that precedes the actions.
    expect(active?.classList.contains('v10-notif-cg-link')).toBe(false);
  });

  it('Escape closes the pane and restores focus to the bell', () => {
    openPane();
    expect(container.querySelector('.v10-notif-pane')).toBeTruthy();
    act(() =>
      container.querySelector('.v10-header-notif-wrap')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })),
    );
    expect(container.querySelector('.v10-notif-pane')).toBeNull();
    expect(bellBtn().getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(bellBtn());
  });
});
