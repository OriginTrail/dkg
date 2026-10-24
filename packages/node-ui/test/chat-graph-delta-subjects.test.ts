import { describe, expect, it } from 'vitest';
import { GRAPH_DELTA_MAX_SUBJECTS, selectGraphDeltaSubjects } from '../src/chat-graph-delta-subjects.js';

const CHAT = 'urn:dkg:chat:';
const DKG = 'http://dkg.io/ontology/';
const ANCHORS = {
  sessionUri: `${CHAT}session:s-graph`,
  turnUri: `${CHAT}session-turn:t2`,
  userMsgUri: `${CHAT}msg:user-2`,
  assistantMsgUri: `${CHAT}msg:assistant-2`,
};
const transition = (name: string) => `${CHAT}turn-transition:${name}`;

interface Answers {
  transitions?: string[];
  tools?: string[];
  mentions?: string[];
  memories?: string[];
}

/** A store that answers each relation query by what it names, and records them. */
function relationStore(answers: Answers) {
  const queries: string[] = [];
  const rows = (subjects: string[] = []) => ({ bindings: subjects.map((s) => ({ s })) });
  const query = async (sparql: string) => {
    queries.push(sparql);
    if (sparql.includes(`<${DKG}updatesTurn>`)) return rows(answers.transitions);
    if (sparql.includes(`<${DKG}usedTool>`)) return rows(answers.tools);
    if (sparql.includes(`<${DKG}contains>`)) return rows(answers.memories);
    if (sparql.includes(`<${DKG}mentionedIn>`)) return rows(answers.mentions);
    throw new Error(`unexpected query: ${sparql}`);
  };
  return { query, queries };
}

describe('selectGraphDeltaSubjects', () => {
  it('lists the session, the turn and its two messages first, then transitions, tools, mentions and memories, each subject once', async () => {
    const { query } = relationStore({
      transitions: [transition('failed'), transition('stored')],
      tools: [`${CHAT}tool:t1`, `${CHAT}tool:t2`],
      mentions: ['urn:dkg:entity:asset', 'urn:dkg:entity:asset', `${CHAT}tool:t1`],
      memories: ['urn:dkg:memory:m1'],
    });

    expect(await selectGraphDeltaSubjects(query, ANCHORS)).toEqual([
      ANCHORS.sessionUri, ANCHORS.turnUri, ANCHORS.userMsgUri, ANCHORS.assistantMsgUri,
      transition('failed'), transition('stored'),
      `${CHAT}tool:t1`, `${CHAT}tool:t2`, 'urn:dkg:entity:asset', 'urn:dkg:memory:m1',
    ]);
  });

  it('reads each relation with its own bounded query, none of them a UNION', async () => {
    const { query, queries } = relationStore({});

    await selectGraphDeltaSubjects(query, ANCHORS);

    // A read of the working-memory view can span more than one graph, and the
    // query engine refuses a UNION combined with DISTINCT or LIMIT across graphs.
    expect(queries).toHaveLength(4);
    for (const sparql of queries) {
      expect(sparql).not.toMatch(/\bUNION\b/i);
      expect(sparql).toMatch(/^SELECT DISTINCT \?s WHERE \{[\s\S]*\} LIMIT 5000$/);
    }
    const [transitions] = queries.filter((q) => q.includes(`<${DKG}updatesTurn>`));
    expect(transitions).toContain(`?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <${DKG}ChatTurnPersistenceTransition>`);
    // A transition is what points at the turn the delta was anchored on, not what carries its turn id.
    expect(transitions).toContain(`?s <${DKG}updatesTurn> <${ANCHORS.turnUri}>`);
    expect(queries.filter((q) => q.includes(`<${DKG}usedTool>`))).toHaveLength(1);
    expect(queries.find((q) => q.includes(`<${DKG}usedTool>`))).toContain(`<${ANCHORS.assistantMsgUri}> <${DKG}usedTool> ?s`);
    // The mentions query names `mentionedIn` and not the memory that contains the mentioned entity.
    expect(queries.filter((q) => q.includes(`<${DKG}mentionedIn>`) && !q.includes(`<${DKG}contains>`))).toHaveLength(1);
    // Mentions and memories hang off the turn's two messages, and the memory is this session's.
    const memories = queries.find((q) => q.includes(`<${DKG}contains>`))!;
    expect(memories).toContain(`VALUES ?msg { <${ANCHORS.userMsgUri}> <${ANCHORS.assistantMsgUri}> }`);
    expect(memories).toContain(`<${DKG}extractedFrom> <${ANCHORS.sessionUri}>`);
  });

  it('skips a subject that is not a safe IRI, whichever relation named it, and keeps the others', async () => {
    const { query } = relationStore({
      transitions: ['not an iri<', transition('ok')],
      tools: ['urn:dkg:tool:bad"quote'],
      mentions: [''],
      memories: ['<urn:dkg:memory:ok>'],
    });

    expect(await selectGraphDeltaSubjects(query, ANCHORS)).toEqual([
      ANCHORS.sessionUri, ANCHORS.turnUri, ANCHORS.userMsgUri, ANCHORS.assistantMsgUri, transition('ok'), 'urn:dkg:memory:ok',
    ]);
  });

  it('caps the subjects at 5000 in all, the turn\'s own and its transitions first', async () => {
    const many = (prefix: string) => Array.from({ length: GRAPH_DELTA_MAX_SUBJECTS }, (_, i) => `urn:dkg:${prefix}:${i}`);
    const { query } = relationStore({
      transitions: [transition('aaa'), transition('bbb')],
      tools: many('tool'),
      mentions: many('entity'),
      memories: many('memory'),
    });

    const subjects = await selectGraphDeltaSubjects(query, ANCHORS);

    expect(GRAPH_DELTA_MAX_SUBJECTS).toBe(5000);
    expect(subjects).toHaveLength(5000);
    expect(subjects.slice(0, 6)).toEqual([
      ANCHORS.sessionUri, ANCHORS.turnUri, ANCHORS.userMsgUri, ANCHORS.assistantMsgUri, transition('aaa'), transition('bbb'),
    ]);
    expect(new Set(subjects).size).toBe(5000);
  });

  it('fails when a relation cannot be read, rather than return a delta that silently leaves the transitions out', async () => {
    const { query } = relationStore({ transitions: [transition('aaa')] });
    const failing = async (sparql: string) => {
      if (sparql.includes(`<${DKG}updatesTurn>`)) throw new Error('store unavailable');
      return query(sparql);
    };

    await expect(selectGraphDeltaSubjects(failing, ANCHORS)).rejects.toThrow('store unavailable');
  });
});
