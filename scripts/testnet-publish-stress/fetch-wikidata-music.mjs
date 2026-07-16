#!/usr/bin/env node
/**
 * Fetch ~500k music-domain triples from Wikidata's public SPARQL endpoint
 * (https://query.wikidata.org/sparql) and persist them as 5000 partitions
 * of 100 triples each — one assertion per partition for the publish-stress
 * run.
 *
 * Output:  ~/.dkg-publish-stress/data/music-partitions.jsonl
 *          One JSON line per partition: {partitionKey, triples: [...nq strings]}
 *
 * The script paginates a single broad SPARQL CONSTRUCT in offset slices.
 * Each row of the SELECT is roughly 5-8 triples (entity + label + several
 * predicates), so we issue ~65 paginated queries to fill the 500k budget.
 *
 * Why CONSTRUCT instead of SELECT: CONSTRUCT yields ready-to-use N-Triples;
 * we just wrap each in a `<graph>` context to make N-Quads at publish time.
 *
 * Rate-limit-friendly: Wikidata's SPARQL service has a 60s query timeout
 * and a ~30 req/min soft cap. We honour both with 2s sleeps between pages
 * and chunky LIMITs.
 */

import { writeFile, mkdir, appendFile, stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { homedir } from 'node:os';

const OUT_PATH = `${homedir()}/.dkg-publish-stress/data/music-partitions.jsonl`;
const TARGET_PARTITIONS = parseInt(process.env.TARGET_PARTITIONS ?? '5000', 10);
const TRIPLES_PER_PARTITION = parseInt(process.env.TRIPLES_PER_PARTITION ?? '100', 10);
const TARGET_TRIPLES = TARGET_PARTITIONS * TRIPLES_PER_PARTITION;
const PAGE_LIMIT = parseInt(process.env.PAGE_LIMIT ?? '500', 10);  // # subjects per SPARQL query
const PAGE_SLEEP_MS = parseInt(process.env.PAGE_SLEEP_MS ?? '2000', 10);
const SPARQL_URL = 'https://query.wikidata.org/sparql';
const USER_AGENT = 'dkg-publish-stress/1.0 (https://github.com/OriginTrail/dkg; aleatoric@local)';

// Broad music coverage: artists (humans known for music), bands, albums,
// songs, music genres. One CONSTRUCT per class, paginated.
//
// We deliberately pick small, predictable predicate sets so each result row
// expands to a known number of triples (≈ 5-8). This makes the partition
// math tractable without per-row inspection.
const QUERY_CLASSES = [
  {
    label: 'human-musicians',
    classQid: 'Q639669',  // musician (subclass of person)
    construct: (offset, limit) => `
      PREFIX wd:  <http://www.wikidata.org/entity/>
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      PREFIX schema: <http://schema.org/>
      PREFIX skos: <http://www.w3.org/2004/02/skos/core#>
      CONSTRUCT {
        ?s rdfs:label ?label .
        ?s wdt:P31 ?type .
        ?s wdt:P106 ?occupation .
        ?s wdt:P136 ?genre .
        ?s wdt:P569 ?birthDate .
        ?s wdt:P19 ?birthPlace .
        ?s wdt:P27 ?country .
      } WHERE {
        SELECT ?s ?label ?type ?occupation ?genre ?birthDate ?birthPlace ?country WHERE {
          ?s wdt:P106 wd:${'Q639669'} ;
             rdfs:label ?label .
          FILTER (LANG(?label) = "en")
          OPTIONAL { ?s wdt:P31 ?type }
          OPTIONAL { ?s wdt:P106 ?occupation }
          OPTIONAL { ?s wdt:P136 ?genre }
          OPTIONAL { ?s wdt:P569 ?birthDate }
          OPTIONAL { ?s wdt:P19 ?birthPlace }
          OPTIONAL { ?s wdt:P27 ?country }
        } ORDER BY ?s LIMIT ${limit} OFFSET ${offset}
      }`,
  },
  {
    label: 'musical-groups',
    classQid: 'Q215380',  // musical group
    construct: (offset, limit) => `
      PREFIX wd:  <http://www.wikidata.org/entity/>
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      CONSTRUCT {
        ?s rdfs:label ?label .
        ?s wdt:P31 ?type .
        ?s wdt:P136 ?genre .
        ?s wdt:P495 ?country .
        ?s wdt:P571 ?inception .
        ?s wdt:P2031 ?activeStart .
        ?s wdt:P2032 ?activeEnd .
      } WHERE {
        SELECT ?s ?label ?type ?genre ?country ?inception ?activeStart ?activeEnd WHERE {
          ?s wdt:P31/wdt:P279* wd:Q215380 ;
             rdfs:label ?label .
          FILTER (LANG(?label) = "en")
          OPTIONAL { ?s wdt:P31 ?type }
          OPTIONAL { ?s wdt:P136 ?genre }
          OPTIONAL { ?s wdt:P495 ?country }
          OPTIONAL { ?s wdt:P571 ?inception }
          OPTIONAL { ?s wdt:P2031 ?activeStart }
          OPTIONAL { ?s wdt:P2032 ?activeEnd }
        } ORDER BY ?s LIMIT ${limit} OFFSET ${offset}
      }`,
  },
  {
    label: 'albums',
    classQid: 'Q482994',  // album
    construct: (offset, limit) => `
      PREFIX wd:  <http://www.wikidata.org/entity/>
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      CONSTRUCT {
        ?s rdfs:label ?label .
        ?s wdt:P31 ?type .
        ?s wdt:P175 ?performer .
        ?s wdt:P577 ?pubDate .
        ?s wdt:P136 ?genre .
        ?s wdt:P364 ?language .
        ?s wdt:P162 ?producer .
      } WHERE {
        SELECT ?s ?label ?type ?performer ?pubDate ?genre ?language ?producer WHERE {
          ?s wdt:P31/wdt:P279* wd:Q482994 ;
             rdfs:label ?label .
          FILTER (LANG(?label) = "en")
          OPTIONAL { ?s wdt:P31 ?type }
          OPTIONAL { ?s wdt:P175 ?performer }
          OPTIONAL { ?s wdt:P577 ?pubDate }
          OPTIONAL { ?s wdt:P136 ?genre }
          OPTIONAL { ?s wdt:P364 ?language }
          OPTIONAL { ?s wdt:P162 ?producer }
        } ORDER BY ?s LIMIT ${limit} OFFSET ${offset}
      }`,
  },
  {
    label: 'songs',
    classQid: 'Q7366',  // song
    construct: (offset, limit) => `
      PREFIX wd:  <http://www.wikidata.org/entity/>
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      CONSTRUCT {
        ?s rdfs:label ?label .
        ?s wdt:P31 ?type .
        ?s wdt:P175 ?performer .
        ?s wdt:P577 ?pubDate .
        ?s wdt:P136 ?genre .
        ?s wdt:P361 ?partOfAlbum .
      } WHERE {
        SELECT ?s ?label ?type ?performer ?pubDate ?genre ?partOfAlbum WHERE {
          ?s wdt:P31/wdt:P279* wd:Q7366 ;
             rdfs:label ?label .
          FILTER (LANG(?label) = "en")
          OPTIONAL { ?s wdt:P31 ?type }
          OPTIONAL { ?s wdt:P175 ?performer }
          OPTIONAL { ?s wdt:P577 ?pubDate }
          OPTIONAL { ?s wdt:P136 ?genre }
          OPTIONAL { ?s wdt:P361 ?partOfAlbum }
        } ORDER BY ?s LIMIT ${limit} OFFSET ${offset}
      }`,
  },
  {
    label: 'music-genres',
    classQid: 'Q188451',  // music genre
    construct: (offset, limit) => `
      PREFIX wd:  <http://www.wikidata.org/entity/>
      PREFIX wdt: <http://www.wikidata.org/prop/direct/>
      PREFIX rdfs: <http://www.w3.org/2000/01/rdf-schema#>
      CONSTRUCT {
        ?s rdfs:label ?label .
        ?s wdt:P31 ?type .
        ?s wdt:P279 ?parentGenre .
        ?s wdt:P495 ?country .
        ?s wdt:P571 ?inception .
      } WHERE {
        SELECT ?s ?label ?type ?parentGenre ?country ?inception WHERE {
          ?s wdt:P31/wdt:P279* wd:Q188451 ;
             rdfs:label ?label .
          FILTER (LANG(?label) = "en")
          OPTIONAL { ?s wdt:P31 ?type }
          OPTIONAL { ?s wdt:P279 ?parentGenre }
          OPTIONAL { ?s wdt:P495 ?country }
          OPTIONAL { ?s wdt:P571 ?inception }
        } ORDER BY ?s LIMIT ${limit} OFFSET ${offset}
      }`,
  },
];

async function fetchSparql(query) {
  const params = new URLSearchParams({ query });
  const url = `${SPARQL_URL}?${params.toString()}`;
  const res = await fetch(url, {
    headers: {
      'Accept': 'application/n-triples',
      'User-Agent': USER_AGENT,
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Wikidata SPARQL ${res.status} ${res.statusText}: ${body.slice(0, 300)}`);
  }
  const text = await res.text();
  return text;
}

// Convert N-Triples body to an array of triple strings. Each non-empty,
// non-comment line is one triple. We strip the trailing `.` so the publish
// loop can re-wrap into N-Quads with a per-partition graph IRI.
function parseNtriplesLines(body) {
  const out = [];
  for (const raw of body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    // Strip trailing dot + whitespace; keep the rest verbatim.
    const trimmed = line.replace(/\s*\.\s*$/, '');
    if (trimmed.length > 0) out.push(trimmed);
  }
  return out;
}

// Codex review on PR #722: persist per-class offsets + class cursor in a
// sidecar state file so a resumed run continues from the same SPARQL pages
// it left off on, instead of restarting from offset 0 and appending
// duplicated early data under new partition ids. The buffer of in-flight
// triples is NOT persisted (cheap to rebuild on the next fetch), but the
// fetch-cursor IS — the cost is one tiny JSON write per fetch.
const STATE_PATH = `${OUT_PATH}.state.json`;

async function loadFetchState() {
  try {
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile(STATE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed.offsets)
        && parsed.offsets.length === QUERY_CLASSES.length
        && Number.isInteger(parsed.classCursor)) {
      return { offsets: parsed.offsets.slice(), classCursor: parsed.classCursor };
    }
  } catch { /* fresh */ }
  return null;
}

async function saveFetchState(offsets, classCursor) {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(STATE_PATH, JSON.stringify({ offsets, classCursor }, null, 2));
}

async function main() {
  await mkdir(dirname(OUT_PATH), { recursive: true });

  // Resume support: if the output file already has >= N partitions, skip.
  let alreadyWritten = 0;
  try {
    const s = await stat(OUT_PATH);
    if (s.size > 0) {
      // Cheap count: each partition is one line.
      const { readFile } = await import('node:fs/promises');
      const existing = await readFile(OUT_PATH, 'utf8');
      alreadyWritten = existing.split('\n').filter((l) => l.trim().length > 0).length;
      console.error(`[resume] ${alreadyWritten} partitions already in ${OUT_PATH}`);
    }
  } catch { /* fresh */ }

  if (alreadyWritten >= TARGET_PARTITIONS) {
    console.error(`[done] target ${TARGET_PARTITIONS} reached; nothing to do.`);
    return;
  }

  // Streaming buffer: accumulate triples across classes, flush in
  // TRIPLES_PER_PARTITION chunks.
  const buffer = [];
  let partitionIdx = alreadyWritten;
  let totalTriplesSeen = alreadyWritten * TRIPLES_PER_PARTITION;
  const startedAt = Date.now();

  const flushPartition = async () => {
    while (buffer.length >= TRIPLES_PER_PARTITION && partitionIdx < TARGET_PARTITIONS) {
      const triples = buffer.splice(0, TRIPLES_PER_PARTITION);
      const partitionKey = `partition-${String(partitionIdx).padStart(6, '0')}`;
      const line = JSON.stringify({ partitionKey, triples }) + '\n';
      await appendFile(OUT_PATH, line, 'utf8');
      partitionIdx++;
      if (partitionIdx % 50 === 0) {
        const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1);
        console.error(
          `[progress] partitions=${partitionIdx}/${TARGET_PARTITIONS} ` +
          `triples=${partitionIdx * TRIPLES_PER_PARTITION} elapsed=${elapsed}s`,
        );
      }
    }
  };

  // Round-robin pages across the 5 classes until we hit the partition target.
  // Codex review on PR #722: load the persisted fetch cursor so resume
  // continues from where the prior run left off.
  const restored = await loadFetchState();
  let classCursor = restored?.classCursor ?? 0;
  const offsets = restored?.offsets ?? new Array(QUERY_CLASSES.length).fill(0);
  if (restored) {
    console.error(`[resume] fetch cursor: classCursor=${classCursor} offsets=${JSON.stringify(offsets)}`);
  }

  while (partitionIdx < TARGET_PARTITIONS) {
    const cls = QUERY_CLASSES[classCursor];
    const offset = offsets[classCursor];
    const query = cls.construct(offset, PAGE_LIMIT);
    let body;
    try {
      body = await fetchSparql(query);
    } catch (err) {
      console.error(`[error] class=${cls.label} offset=${offset}: ${err.message}`);
      // Bump offset to skip this slice and continue; don't get stuck.
      offsets[classCursor] += PAGE_LIMIT;
      classCursor = (classCursor + 1) % QUERY_CLASSES.length;
      await sleep(PAGE_SLEEP_MS * 2);
      continue;
    }
    const triples = parseNtriplesLines(body);
    if (triples.length === 0) {
      // Exhausted this class — start over from offset 0 with a different
      // class so the buffer keeps filling.
      console.error(`[wrap] class=${cls.label} returned 0 triples at offset ${offset}; resetting`);
      offsets[classCursor] = 0;
    } else {
      buffer.push(...triples);
      totalTriplesSeen += triples.length;
      offsets[classCursor] += PAGE_LIMIT;
    }
    console.error(
      `[fetch] class=${cls.label} offset=${offset} +${triples.length} triples ` +
      `(buf=${buffer.length}, total=${totalTriplesSeen})`,
    );
    await flushPartition();
    classCursor = (classCursor + 1) % QUERY_CLASSES.length;
    // Persist the fetch cursor after every page so a crash between
    // partition flushes still allows clean resume.
    await saveFetchState(offsets, classCursor);
    await sleep(PAGE_SLEEP_MS);
  }

  console.error(
    `[done] wrote ${partitionIdx} partitions × ${TRIPLES_PER_PARTITION} triples = ` +
    `${partitionIdx * TRIPLES_PER_PARTITION} triples to ${OUT_PATH}`,
  );
}

main().catch((err) => {
  console.error('[fatal]', err.stack ?? err.message ?? err);
  process.exit(1);
});
