/**
 * Root Entity Resolution (spec §9.0.1).
 *
 * The publisher sends a flat set of triples. The node determines root entities:
 * each unique subject URI becomes one Knowledge Asset with that URI as dkg:rootEntity.
 */

export interface Quad {
  subject: string;
  predicate: string;
  object: string;
  graph?: string;
}

/**
 * Group triples by unique subject URI. Each key is a root entity,
 * value is the set of triples where that subject appears.
 *
 * Blank nodes (_:...) are excluded as root entities — they are
 * internal structure, not addressable KAs.
 */
export function resolveRootEntities(quads: Quad[]): Map<string, Quad[]> {
  const entities = new Map<string, Quad[]>();

  for (const q of quads) {
    if (q.subject.startsWith('_:')) continue;

    let group = entities.get(q.subject);
    if (!group) {
      group = [];
      entities.set(q.subject, group);
    }
    group.push(q);
  }

  return entities;
}
