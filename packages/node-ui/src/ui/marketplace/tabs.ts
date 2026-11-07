// The marketplace section's centre tabs and their deep-link paths.

export const MARKETPLACE_TABS = {
  browse: { id: 'marketplace', label: 'Marketplace', path: '/marketplace' },
  plans: { id: 'marketplace-plans', label: 'Plans', path: '/marketplace/plans' },
  access: { id: 'marketplace-access', label: 'Access', path: '/marketplace/access' },
  operate: { id: 'marketplace-operate', label: 'Operate', path: '/marketplace/operate' },
} as const;

export const MARKETPLACE_TAB_IDS: readonly string[] = Object.values(MARKETPLACE_TABS).map((t) => t.id);

/** The section stays off unless enabled: visiting any page with `?marketplace` turns it on. */
export const MARKETPLACE_FLAG_KEY = 'dkg-marketplace-enabled';

export function marketplaceEnabled(): boolean {
  try {
    if (new URLSearchParams(window.location.search).has('marketplace')) {
      localStorage.setItem(MARKETPLACE_FLAG_KEY, '1');
    }
    return localStorage.getItem(MARKETPLACE_FLAG_KEY) === '1';
  } catch {
    return false;
  }
}
