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
    FILTER NOT EXISTS {
      ?selectedTurn <${type}> <${ontology}ChatTurn> .
      ?selectedTurn <${partOf}> ${session} .
      ?selectedTurn <${ontology}turnId> ${turnId} .
      FILTER(STR(?selectedTurn) < STR(${turn}))
      FILTER(STRSTARTS(STR(?selectedTurn), "urn:dkg:chat:session-turn:")
        = STRSTARTS(STR(${turn}), "urn:dkg:chat:session-turn:"))
      FILTER NOT EXISTS {
        ?selectedTurn <${partOf}> ?otherSelectedSession .
        FILTER(?otherSelectedSession != ${session})
      }
    }
  `;
}

/** A deterministic, unambiguous URI for a new session/turn coordinate. */
export function scopedChatTurnUri(sessionId: string, turnId: string): string {
  return `urn:dkg:chat:session-turn:${encodeURIComponent(JSON.stringify([sessionId, turnId]))}`;
}
