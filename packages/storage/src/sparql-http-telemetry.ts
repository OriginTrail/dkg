import { createHash } from 'node:crypto';

// Label and identity helpers for the SPARQL HTTP adapter's slow-query telemetry.

/** A query's source label, safe to log: bounded and restricted to `[\w:./-]`. */
export function normalizeQuerySource(source: string | undefined): string {
  const trimmed = source?.trim();
  if (!trimmed) return 'unknown';
  return trimmed.replace(/[^\w:./-]/g, '_').slice(0, 120) || 'unknown';
}

/** A short stable identity for a query, without its text. */
export function hashQuery(sparql: string): string {
  return createHash('sha256').update(sparql).digest('hex').slice(0, 16);
}

/** An endpoint URL without credentials, query string or fragment. */
export function sanitizeEndpointForTelemetry(endpoint: string): string {
  try {
    const url = new URL(endpoint);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.toString();
  } catch {
    return endpoint.split(/[?#]/, 1)[0];
  }
}
