/**
 * Publisher-internal helper for reading SPARQL *binding* values.
 *
 * This is deliberately NOT a general RDF literal parser and is deliberately
 * NOT part of any package's public API: `@origintrail-official/dkg-rdf-utils`
 * owns that job (`parseRdfLiteralTerm` / `decodeRdfLiteralBody`), and it is
 * the implementation to reach for when parsing user-facing or on-the-wire RDF.
 *
 * What this handles instead is the narrow shape the publisher's own lifecycle
 * bookkeeping reads back out of the store: a binding that is either a bare IRI
 * or a literal the publisher itself wrote (`"created"`, `"WM"`,
 * `"2"^^<xsd:integer>`). It stays here, unexported from the package barrel, so
 * the codebase does not grow a second literal decoder presented as shared API.
 */

/**
 * Strip the quoting from an optional SPARQL binding value.
 *
 * Bare values (IRIs) pass through unchanged. Quoted values are JSON-decoded;
 * when a datatype/language suffix makes that invalid JSON, the raw body
 * between the outer quotes is returned. Lenient by design — a lifecycle read
 * must not throw on an unexpected binding shape.
 */
export function stripOptionalLiteral(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith('"')) {
    try {
      return JSON.parse(value);
    } catch {
      const lastQuote = value.lastIndexOf('"');
      return value.slice(1, lastQuote > 0 ? lastQuote : undefined);
    }
  }
  return value;
}
