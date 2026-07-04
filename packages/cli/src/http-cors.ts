export function corsHeaders(
  origin?: string | null,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  if (!origin) return { ...extraHeaders };
  const headers: Record<string, string> = {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-DKG-CSRF',
    ...extraHeaders,
  };
  if (origin !== '*') {
    headers['Access-Control-Allow-Credentials'] = 'true';
    headers.Vary = 'Origin';
  }
  return headers;
}
