/** Accept the bare and serialized literal forms returned by supported stores.
 * Domain validation belongs to the caller; this does not unescape RDF terms. */
export function stripSparqlLiteralValue(value: string | undefined): string {
  return (value ?? '').replace(/^"/, '').replace(/"(?:\^\^<[^>]+>|@[a-zA-Z-]+)?$/, '');
}
