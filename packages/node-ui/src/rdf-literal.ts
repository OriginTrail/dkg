/**
 * Decode an RDF string literal whose body was written with JSON-style
 * escaping, optionally followed by an RDF datatype or language suffix.
 */
export function decodeRdfStringLiteral(value: string): string {
  if (!value) return '';
  // BCP-47 language tags allow ASCII letters, digits, and hyphens (with
  // a leading letter); private-use subtags like `x-private1` are valid.
  // The old `@[a-z-]+` rejected `@en-US`, `@zh-Hans-CN`, `@x-private1`,
  // causing non-English / regional labels to render as raw quoted text
  // in the singleton-shelf and any other consumer.
  const typed = value.match(/^"([\s\S]*)"(?:\^\^<[^>]+>)?(?:@[A-Za-z0-9-]+)?$/);
  if (!typed) return value;
  try {
    return JSON.parse(`"${typed[1]}"`) as string;
  } catch {
    return typed[1];
  }
}
