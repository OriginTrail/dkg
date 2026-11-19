/**
 * The one wording for a context graph list that didn't load (DESIGN.md · Writing:
 * an error says what failed, with the detail when there is one). The sidebar
 * shows the short line; page banners add the detail and what is still shown.
 */
export const INVENTORY_ERROR_SHORT = 'Couldn’t load context graphs.';

const detail = (error: string | null | undefined): string => {
  const text = (error ?? '').trim().replace(/[.\s]+$/, '');
  return text ? `: ${text.charAt(0).toLowerCase()}${text.slice(1)}.` : '.';
};

export function inventoryErrorMessage({ listError, identityError, hasGraphs }: {
  listError?: string | null;
  identityError?: string | null;
  hasGraphs: boolean;
}): string {
  const parts: string[] = [];
  if (listError || !identityError) parts.push(`Couldn’t load context graphs${detail(listError)}`);
  if (identityError) parts.push(`Couldn’t load your agent identity${detail(identityError)}`);
  if (hasGraphs) parts.push('Showing the last ones loaded.');
  return parts.join(' ');
}
