/**
 * Select an attributable subject for a session/turn coordinate. Scoped subjects
 * take precedence over legacy subjects explicitly; subject spelling/order is
 * never the deciding factor. A subject linked to another session has no
 * attributable state or completion and is excluded from both sessions.
 * Terms are internally constructed SPARQL terms, never raw caller strings.
 */
export function chatTurnSubjectPattern(session: string, turn: string, turnId: string): string {
  const type = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
  const partOf = 'http://schema.org/isPartOf';
  const ontology = 'http://dkg.io/ontology/';
  return `
    ${turn} <${type}> <${ontology}ChatTurn> .
    ${turn} <${partOf}> ${session} .
    ${turn} <${ontology}turnId> ${turnId} .
    FILTER NOT EXISTS {
      ${turn} <${partOf}> ?otherTurnSession .
      FILTER(?otherTurnSession != ${session})
    }
    FILTER NOT EXISTS {
      ?preferredTurn <${type}> <${ontology}ChatTurn> .
      ?preferredTurn <${partOf}> ${session} .
      ?preferredTurn <${ontology}turnId> ${turnId} .
      FILTER(STRSTARTS(STR(?preferredTurn), "urn:dkg:chat:session-turn:"))
      FILTER(!STRSTARTS(STR(${turn}), "urn:dkg:chat:session-turn:"))
      FILTER NOT EXISTS {
        ?preferredTurn <${partOf}> ?otherPreferredSession .
        FILTER(?otherPreferredSession != ${session})
      }
    }
  `;
}
