// SPARQL 1.1 BLANK_NODE_LABEL, which N-Triples, N-Quads and Turtle share:
//   '_:' (PN_CHARS_U | [0-9]) ((PN_CHARS | '.')* PN_CHARS)?
const PN_CHARS_BASE =
  'A-Za-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D\\u037F-\\u1FFF' +
  '\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF\\uF900-\\uFDCF' +
  '\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const PN_CHARS_U = `${PN_CHARS_BASE}_`;
const PN_CHARS = `${PN_CHARS_U}\\-0-9\\u00B7\\u0300-\\u036F\\u203F-\\u2040`;
const BLANK_NODE_LABEL = new RegExp(
  `^[${PN_CHARS_U}0-9](?:[${PN_CHARS}.]*[${PN_CHARS}])?$`,
  'u',
);

/**
 * Whether `label`, a blank node's label without the `_:` prefix, is valid
 * under the BLANK_NODE_LABEL production, so `_:${label}` can be written into
 * SPARQL or N-Quads verbatim.
 */
export function isRdfBlankNodeLabel(label: string): boolean {
  return BLANK_NODE_LABEL.test(label);
}
