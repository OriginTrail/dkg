// The marketplace section's centre tabs and their deep-link paths.

export const MARKETPLACE_TABS = {
  browse: { id: 'marketplace', label: 'NeuroSymbolic Marketplace', path: '/marketplace' },
  plans: { id: 'marketplace-plans', label: 'Plans', path: '/marketplace/plans' },
  access: { id: 'marketplace-access', label: 'Access', path: '/marketplace/access' },
  operate: { id: 'marketplace-operate', label: 'Operate', path: '/marketplace/operate' },
} as const;

export const MARKETPLACE_TAB_IDS: readonly string[] = Object.values(MARKETPLACE_TABS).map((t) => t.id);

/** The section stays off unless enabled: opening any page with `?marketplace` turns it on in this browser. */
export const MARKETPLACE_FLAG_KEY = 'dkg-marketplace-enabled';

/**
 * Turn the section on for good when the page was opened with `?marketplace`.
 * The app calls this once as it starts, before anything renders or routes;
 * a later page without the query keeps what an earlier one turned on.
 */
export function activateMarketplaceFromUrl(search: string = window.location.search): void {
  try {
    if (new URLSearchParams(search).has('marketplace')) localStorage.setItem(MARKETPLACE_FLAG_KEY, '1');
  } catch {
    // Storage unavailable: the section stays off.
  }
}

/** Whether the section is on in this browser: a read alone, for rendering and routing. */
export function marketplaceEnabled(): boolean {
  try {
    return localStorage.getItem(MARKETPLACE_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}
