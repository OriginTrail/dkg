// SPDX-License-Identifier: Apache-2.0
import { isSafeIri } from '@origintrail-official/dkg-core';

/**
 * Select an attributable subject for a session/turn coordinate. Scoped subjects
 * take precedence over legacy subjects; URI order breaks ties within one class.
 * A subject linked to another session has no
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
      ?candidateTurn <${type}> <${ontology}ChatTurn> .
      ?candidateTurn <${partOf}> ${session} .
      ?candidateTurn <${ontology}turnId> ${turnId} .
      FILTER NOT EXISTS {
        ?candidateTurn <${partOf}> ?otherCandidateSession .
        FILTER(?otherCandidateSession != ${session})
      }
      FILTER(
        (STRSTARTS(STR(?candidateTurn), "urn:dkg:chat:session-turn:")
          && !STRSTARTS(STR(${turn}), "urn:dkg:chat:session-turn:"))
        || (STRSTARTS(STR(?candidateTurn), "urn:dkg:chat:session-turn:")
          = STRSTARTS(STR(${turn}), "urn:dkg:chat:session-turn:")
          && STR(?candidateTurn) < STR(${turn}))
      )
    }
  `;
}

/** A deterministic, unambiguous URI for a new session/turn coordinate. */
export function scopedChatTurnUri(sessionId: string, turnId: string): string {
  return `urn:dkg:chat:session-turn:${encodeURIComponent(JSON.stringify([sessionId, turnId]))}`;
}

export interface ExistingChatTurn {
  uri: string;
  turnId: string;
  createdAt: string | null;
}

/** Validate the identity selected by the ownership query without allocating a subject. */
export function decodeExistingChatTurn(
  selected: Record<string, string> | undefined,
  expectedTurnId: string,
  literalValue: (term: string) => string,
): ExistingChatTurn | null {
  const found = String(selected?.turn ?? '').replace(/[<>]/g, '');
  const turnId = literalValue(selected?.tid ?? '').trim();
  if (!found || !isSafeIri(found) || !turnId || turnId !== expectedTurnId) return null;
  return { uri: found, turnId, createdAt: literalValue(selected?.ts ?? '').trim() || null };
}
