/** Formatting the conversation model needs: timestamps and attachment text. */

export function formatLocalTimestamp(value?: string | Date): string {
  if (value === undefined || value === null || value === '') return '';
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) return typeof value === 'string' ? value : '';
  // Include the date so a chat that spans more than one day stays
  // legible — `HH:MM AM/PM` alone was ambiguous as soon as a session
  // crossed midnight. `medium` date + `short` time renders e.g.
  // "May 14, 2026, 10:05 PM" in en-US.
  return parsed.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Companion to `formatLocalTimestamp` that returns an ISO 8601 string
 * for the same moment. Used to populate `<time dateTime={tsRaw}>` so
 * screen readers and machine parsers can read the timestamp in a
 * locale-independent format alongside the human-readable display
 * (UX-lead P1-A minimum). Returns `undefined` for absent / unparseable
 * input so the caller can drop the prop instead of emitting an empty
 * `dateTime` attribute.
 */

export function toIsoTimestamp(value?: string | Date): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.valueOf())) return undefined;
  return parsed.toISOString();
}

export function formatAttachmentImportContextValue(value: string | number | null | undefined): string {
  return String(value ?? '')
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
