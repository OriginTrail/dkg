import { Command } from 'commander';
import { writeFile, mkdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute } from 'node:path';
import { toErrorMessage } from '@origintrail-official/dkg-core';
import {
  loadBundleDirWithReport,
  importBundle,
  exportBundle,
  validateBundle,
  quadsToNQuads,
  conceptIdToKaName,
  DEFAULT_IRI_BASE,
  RDF_TYPE,
  SCHEMA_NS,
  SECTION_GENID_INFIX,
  type BundleImport,
  type Quad,
  type TypeRelation,
} from '@origintrail-official/dkg-okf';
import { batchEntityQuads, type PublishQuad } from '../batching.js';
import { ApiClient } from '../api-client.js';
import type { ActionOpts } from '../cli-helpers.js';

/**
 * `dkg okf` — ingest a Google Open Knowledge Format (OKF) bundle into the DKG as
 * verifiable, owned Knowledge Assets (reconstructing the cross-concept link
 * graph), and serialise a Context Graph back into a conformant OKF bundle.
 *
 * The OKF→RDF mapping is the pure, deterministic mapper in
 * `@origintrail-official/dkg-okf`; this command is the thin node-facing wrapper
 * (mirrors `dkg epcis`). Import defaults to **Working Memory** (free, private,
 * reversible) and NEVER publishes to Verifiable Memory: `--share` advances the
 * assets to Shared Working Memory (free, team-visible); on-chain VM promotion is
 * a separate, explicitly-gated capstone (`dkg knowledge publish` / the DEMO
 * runbook), not part of import.
 */
export function registerOkfCommand(program: Command): void {
  // Bulk-import chunking contract (ADR 0002): ≤5,000 quads per wm/write.
  const CHUNK = 5000;

  const OKF_EXIT_CODES = {
    SUCCESS: 0,
    UNEXPECTED: 1,
    CLIENT_ERROR: 2,
    PUBLISHER_UNAVAILABLE: 3,
    NOT_FOUND: 4,
  } as const;

  function exitCodeForOkfHttpStatus(status: number | undefined): number {
    if (status === undefined) return OKF_EXIT_CODES.UNEXPECTED;
    if (status >= 200 && status < 300) return OKF_EXIT_CODES.SUCCESS;
    if (status === 503) return OKF_EXIT_CODES.PUBLISHER_UNAVAILABLE;
    if (status === 404) return OKF_EXIT_CODES.NOT_FOUND;
    if (status >= 400 && status < 500) return OKF_EXIT_CODES.CLIENT_ERROR;
    return OKF_EXIT_CODES.UNEXPECTED;
  }

  function reportOkfError(err: unknown): never {
    const httpStatus = (err as { httpStatus?: number })?.httpStatus;
    const responseBody = (err as { responseBody?: unknown })?.responseBody;
    if (responseBody !== undefined) {
      try {
        console.log(JSON.stringify(responseBody, null, 2));
      } catch {
        // not serialisable
      }
    }
    console.error(toErrorMessage(err));
    process.exit(exitCodeForOkfHttpStatus(httpStatus));
  }

  // KA name for a concept: DKG asset names cannot contain '/', so path
  // separators in the concept ID are mapped to '__' (the RDF subject IRI keeps
  // the original '/'). See `conceptIdToKaName` in @origintrail-official/dkg-okf.
  const conceptKaName = conceptIdToKaName;

  const isPayloadTooLarge = (e: unknown) => (e as { httpStatus?: number })?.httpStatus === 413;

  async function writeOkfAssetBatch(
    client: ApiClient,
    contextGraphId: string,
    name: string,
    batch: PublishQuad[],
    subGraphName?: string,
  ): Promise<number> {
    try {
      const res = await client.knowledgeAssetWrite(contextGraphId, name, batch, { subGraphName });
      return res.written ?? batch.length;
    } catch (e) {
      if (isPayloadTooLarge(e) && batch.length > 1) {
        const mid = Math.floor(batch.length / 2);
        console.error(`  413 on ${batch.length} quads - splitting into ${mid}/${batch.length - mid}`);
        return (await writeOkfAssetBatch(client, contextGraphId, name, batch.slice(0, mid), subGraphName)) +
          (await writeOkfAssetBatch(client, contextGraphId, name, batch.slice(mid), subGraphName));
      }
      throw e;
    }
  }

  async function writeOkfAssetBatches(
    client: ApiClient,
    contextGraphId: string,
    name: string,
    quads: PublishQuad[],
    subGraphName?: string,
  ): Promise<number> {
    let count = 0;
    for (const batch of batchEntityQuads(quads, { maxBatchQuads: CHUNK, splitOversizedEntities: true })) {
      count += await writeOkfAssetBatch(client, contextGraphId, name, batch, subGraphName);
    }
    return count;
  }

  async function createAndWriteOkfAssetDraft(
    client: ApiClient,
    contextGraphId: string,
    name: string,
    quads: PublishQuad[],
    subGraphName?: string,
  ): Promise<number> {
    await client.createKnowledgeAsset(contextGraphId, name, { subGraphName });
    return writeOkfAssetBatches(client, contextGraphId, name, quads, subGraphName);
  }

  async function finalizeAndShareOkfAsset(
    client: ApiClient,
    contextGraphId: string,
    name: string,
    subGraphName?: string,
  ): Promise<void> {
    await client.knowledgeAssetFinalize(contextGraphId, name, { subGraphName });
    const shareResult = await client.knowledgeAssetShare(contextGraphId, name, {
      subGraphName,
      entities: 'all',
    });
    if (shareResult.swmShared !== true) {
      throw new Error(`Knowledge Asset "${name}" share did not report swmShared:true`);
    }
  }

  // The daemon's /api/query returns SELECT results as `{ bindings: [...] }` —
  // WITHOUT the `type: 'bindings'` discriminator the QueryResult union expects.
  // Gating on `result.type === 'bindings'` therefore silently yields no rows
  // (the bug that made `okf verify` report 0 for everything). Read `bindings`
  // structurally instead.
  function bindingsOf(result: unknown): Array<Record<string, unknown>> {
    if (result && typeof result === 'object' && Array.isArray((result as { bindings?: unknown }).bindings)) {
      return (result as { bindings: Array<Record<string, unknown>> }).bindings;
    }
    return [];
  }

  // A `/api/query` binding cell can arrive as a bare string OR a SPARQL-JSON
  // object (`{ value, type, datatype? }`); calling `.startsWith()`/`.exec()` on
  // the object form throws at runtime. Normalise every cell to its string value
  // before use (mirrors the daemon's `bindingValue`). The static `QueryResult`
  // type annotates cells as strings, but the runtime path can return objects.
  const cell = (v: unknown): string => {
    if (v === null || v === undefined) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'object' && 'value' in (v as Record<string, unknown>)) {
      const raw = (v as { value?: unknown }).value;
      return raw === null || raw === undefined ? '' : String(raw);
    }
    return String(v);
  };

  function summarize(imported: BundleImport): {
    concepts: number;
    reservedSkipped: number;
    triples: number;
    linksResolved: number;
    linksBroken: number;
    citations: number;
  } {
    let linksResolved = 0;
    let linksBroken = 0;
    let citations = 0;
    for (const c of imported.concepts) {
      linksResolved += new Set(c.resolvedLinks.map((l) => l.targetConceptId)).size;
      linksBroken += c.brokenLinks.length;
      citations += c.citations.length;
    }
    return {
      concepts: imported.concepts.length,
      reservedSkipped: imported.reservedSkipped.length,
      triples: imported.quads.length,
      linksResolved,
      linksBroken,
      citations,
    };
  }

  const okfCmd = program
    .command('okf')
    .description('Import / export Google Open Knowledge Format (OKF) bundles as Knowledge Assets');

  // Collector for repeatable options (commander passes (val, prev)).
  const collect = (val: string, prev: string[]): string[] => prev.concat([val]);

  // Parse repeatable `--relate "<FromType>><ToType>=<predicate>"` rules into
  // deterministic type-pair edge relations. The predicate is used as-is if it is
  // a full IRI, otherwise resolved against schema.org (so `hasPart` → schema:hasPart).
  function parseRelateRules(raw: string[]): TypeRelation[] {
    return raw.map((rule) => {
      const eq = rule.lastIndexOf('=');
      const gt = rule.indexOf('>');
      if (eq === -1 || gt === -1 || gt > eq) {
        throw new Error(`Invalid --relate rule "${rule}". Expected "<FromType>><ToType>=<predicate>".`);
      }
      const from = rule.slice(0, gt).trim();
      const to = rule.slice(gt + 1, eq).trim();
      const predToken = rule.slice(eq + 1).trim();
      if (!from || !to || !predToken) {
        throw new Error(`Invalid --relate rule "${rule}". Expected "<FromType>><ToType>=<predicate>".`);
      }
      const predicate = predToken.includes('://') ? predToken : SCHEMA_NS + predToken;
      return { from, to, predicate };
    });
  }

  // ─── dkg okf import <bundleDir> ─────────────────────────────────────
  okfCmd
    .command('import <bundleDir>')
    .description('Import an OKF bundle into a Context Graph (defaults to Working Memory)')
    .option('--context-graph-id <id>', 'Target Context Graph')
    .option('--sub-graph-name <name>', 'Sub-graph within the Context Graph')
    .option('--iri-base <base>', `IRI namespace for concept subjects (default ${DEFAULT_IRI_BASE})`)
    .option('--include-code-span-links', 'Treat links inside inline code spans as edges (default: off, per CommonMark)')
    .option(
      '--relate <rule>',
      'Type a cross-concept edge by endpoint types: "<FromType>><ToType>=<predicate>" ' +
        '(repeatable; predicate is a full IRI or a schema.org term, e.g. ' +
        '"BigQuery Dataset>BigQuery Table=hasPart"). Default: all edges schema:mentions.',
      collect,
      [] as string[],
    )
    .option('--replace', 'Discard any existing Working-Memory draft for each concept before writing (avoids stale triples when re-importing a changed bundle). WM-only: it does NOT clear already-shared SWM.')
    .option('--create-context-graph', 'Create the Context Graph if it does not exist')
    .option('--share', 'Finalize and advance assets to Shared Working Memory (free, team-visible)')
    .option(
      '--private',
      'Import each concept as its own named Knowledge Asset in the private Context Graph, ' +
        'then finalize and share those assets to Shared Working Memory. Content stays ' +
        'gossip-restricted to allowlisted peers. Implies a private CG on --create-context-graph.',
    )
    .option(
      '--allowed-peer <peerId>',
      'Allowlist a peer id on the private Context Graph (repeatable). On --create-context-graph the ' +
        'peers seed the allowlist; on an existing CG each is invited.',
      collect,
      [] as string[],
    )
    .option(
      '--allow-public-context-graph',
      'Override the safety check that refuses --private imports into an existing Context Graph whose accessPolicy is "public" (which would expose the private substance).',
    )
    .option('--manifest <path>', 'Resumability manifest path (default <bundleDir>/.okf-import-manifest.json)')
    .option('--dry-run', 'Run the deterministic mapping offline and print the summary; never touch the node')
    .option('--print-nquads', 'With --dry-run, also print the canonical N-Quads')
    .action(async (bundleDir: string, opts: ActionOpts) => {
      try {
        if (!existsSync(bundleDir)) {
          console.error(`Bundle directory not found: ${bundleDir}`);
          process.exit(OKF_EXIT_CODES.UNEXPECTED);
        }
        const iriBase = opts.iriBase ? String(opts.iriBase) : DEFAULT_IRI_BASE;
        const includeCodeSpanLinks = Boolean(opts.includeCodeSpanLinks);
        const typeRelations = parseRelateRules(
          Array.isArray(opts.relate) ? (opts.relate as string[]) : [],
        );

        const { files, skippedSymlinks } = loadBundleDirWithReport(bundleDir);
        for (const s of skippedSymlinks) {
          console.error(`Warning: skipped symlinked bundle entry (not followed): ${s}`);
        }
        const conformance = validateBundle(files);
        const imported = importBundle(files, { iriBase, includeCodeSpanLinks, typeRelations });
        const summary = summarize(imported);

        // The deterministic, offline portion — no node required.
        if (opts.dryRun) {
          console.log(
            JSON.stringify(
              {
                mode: 'dry-run',
                memoryLayer: opts.private || opts.share ? 'SWM' : 'WM',
                importMode: 'per-concept',
                conformant: conformance.conformant,
                okfVersion: imported.okfVersion,
                ...summary,
                iris: imported.iriByConceptId,
                warnings: imported.warnings,
                conformanceErrors: conformance.errors,
              },
              null,
              2,
            ),
          );
          if (opts.printNquads) {
            process.stdout.write('\n' + quadsToNQuads(imported.quads));
          }
          return;
        }

        if (!conformance.conformant) {
          // §9: a non-conformant bundle is unusual but we only hard-stop on the
          // two rules that make triples meaningless (parse / missing type).
          console.error('Bundle is not OKF-conformant:');
          for (const e of conformance.errors) console.error(`  - ${e}`);
          process.exit(OKF_EXIT_CODES.CLIENT_ERROR);
        }

        const contextGraphId = opts.contextGraphId ? String(opts.contextGraphId) : undefined;
        if (!contextGraphId) {
          console.error('--context-graph-id is required (or use --dry-run).');
          process.exit(OKF_EXIT_CODES.UNEXPECTED);
        }
        const subGraphName = opts.subGraphName ? String(opts.subGraphName) : undefined;
        const graph = `did:dkg:context-graph:${contextGraphId}`;

        const isPrivate = Boolean(opts.private);
        const allowedPeers = Array.isArray(opts.allowedPeer)
          ? (opts.allowedPeer as string[])
          : [];

        const client = await ApiClient.connect();

        // Ensure the Context Graph exists.
        const { exists } = await client.contextGraphExists(contextGraphId);
        if (!exists) {
          if (!opts.createContextGraph) {
            console.error(
              `Context Graph "${contextGraphId}" does not exist. Re-run with --create-context-graph to create it.`,
            );
            process.exit(OKF_EXIT_CODES.NOT_FOUND);
          }
          // --private ⇒ accessPolicy 1 (invite-only, off-chain). allowedPeers seed
          // the allowlist; register:false keeps it off-chain (no spend).
          await client.createContextGraph(
            contextGraphId,
            contextGraphId,
            undefined,
            isPrivate ? { private: true, accessPolicy: 1 } : undefined,
            isPrivate && allowedPeers.length ? allowedPeers : undefined,
          );
          console.log(
            `Created ${isPrivate ? 'private (invite-only) ' : ''}Context Graph "${contextGraphId}"` +
              (isPrivate && allowedPeers.length ? ` with ${allowedPeers.length} allowlisted peer(s).` : '.'),
          );
        } else if (isPrivate) {
          // Existing CG + --private: REFUSE to import private substance into a
          // Context Graph that is publicly readable. accessPolicy comes from the
          // daemon's CG list ('public' | 'ownerOnly' | 'allowList').
          const list = await client.listContextGraphs().catch(() => null);
          const policy = list?.contextGraphs?.find((c: { id: string }) => c.id === contextGraphId)
            ?.accessPolicy;
          if (policy === 'public' && !opts.allowPublicContextGraph) {
            console.error(
              `Refusing --private import: Context Graph "${contextGraphId}" already exists with ` +
                `accessPolicy "public". Writing private substance there would expose it. Use a ` +
                `private (invite-only) Context Graph, or pass --allow-public-context-graph to override.`,
            );
            process.exit(OKF_EXIT_CODES.CLIENT_ERROR);
          }
          if (policy !== 'allowList' && policy !== 'ownerOnly') {
            console.error(
              `  warning: could not confirm Context Graph "${contextGraphId}" is invite-only ` +
                `(accessPolicy "${policy ?? 'unknown'}"); proceeding with the private write.`,
            );
          }
          // Invite each allowlisted peer (best-effort; already-member is fine).
          for (const peerId of allowedPeers) {
            try {
              await client.inviteToContextGraph(contextGraphId, peerId);
              console.log(`  invited peer ${peerId}`);
            } catch (e) {
              console.error(`  could not invite ${peerId}: ${toErrorMessage(e)}`);
            }
          }
        }

        // Resumability manifest: per-concept STAGE, not just "done". A bare
        // done-set would make the documented `import` → `import --share` flow skip
        // every concept (already "done" from the WM pass) before finalize/share
        // ran, falsely reporting SWM with nothing shared. We record the furthest
        // stage each concept reached ('wm' = created+written, 'swm' = finalized+
        // shared) so a later --share advances WM concepts instead of skipping them.
        type Stage = 'wm' | 'swm';
        const manifestPath = opts.manifest
          ? String(opts.manifest)
          : join(bundleDir, '.okf-import-manifest.json');
        const stages = new Map<string, Stage>();
        // --replace forces a fresh import: ignore prior stages so every concept is
        // re-created (with its WM draft discarded first, below) rather than skipped.
        if (!opts.replace && existsSync(manifestPath)) {
          try {
            const prev = JSON.parse(await readFile(manifestPath, 'utf-8')) as {
              contextGraphId?: string;
              subGraphName?: string;
              mode?: string;
              stages?: Record<string, Stage>;
              done?: string[]; // legacy format → treat as reached 'wm'
            };
            const sameTarget = prev.contextGraphId === contextGraphId && prev.subGraphName === subGraphName;
            if (sameTarget && prev.mode !== undefined && prev.mode !== 'per-concept') {
              console.error('  warning: ignoring incompatible OKF manifest; starting per-concept lifecycle import.');
            } else if (sameTarget) {
              if (prev.stages && typeof prev.stages === 'object') {
                for (const [id, s] of Object.entries(prev.stages)) {
                  if (s === 'wm' || s === 'swm') stages.set(id, s);
                }
              } else if (Array.isArray(prev.done)) {
                for (const id of prev.done) stages.set(id, 'wm');
              }
            }
          } catch {
            // ignore a corrupt manifest; re-import is idempotent per KA name
          }
        }

        const persistManifest = async () =>
          writeFile(
            manifestPath,
            JSON.stringify(
              {
                contextGraphId,
                ...(subGraphName ? { subGraphName } : {}),
                mode: 'per-concept',
                stages: Object.fromEntries(stages),
              },
              null,
              2,
            ),
          );

        const targetStage: Stage = isPrivate || opts.share ? 'swm' : 'wm';
        const layer = targetStage === 'swm' ? 'SWM' : 'WM';
        let written = 0;
        let created = 0;
        let shared = 0;
        for (const concept of imported.concepts) {
          const name = conceptKaName(concept.conceptId);
          const current = stages.get(concept.conceptId);
          // Already at or past the target stage for this run → nothing to do.
          if (current === 'swm' || current === targetStage) continue;

          const needCreate = current === undefined; // not yet written to WM

          if (needCreate) {
            const quads = concept.quads.map((q: Quad) => ({
              subject: q.subject,
              predicate: q.predicate,
              object: q.object,
              graph,
            }));
            if (opts.replace) {
              // Discard any existing WM draft so a changed re-import doesn't
              // accumulate stale triples on top of the old ones (best-effort:
              // there may be nothing to discard).
              await client
                .knowledgeAssetDiscard(contextGraphId, name, { subGraphName })
                .catch(() => undefined);
            }
            written += await createAndWriteOkfAssetDraft(client, contextGraphId, name, quads, subGraphName);
            created += 1;
            stages.set(concept.conceptId, 'wm');
            await persistManifest();
          }
          if (targetStage === 'swm') {
            // Advance WM → SWM (works whether the KA was just created or was
            // already in WM from a prior `import` run).
            await finalizeAndShareOkfAsset(client, contextGraphId, name, subGraphName);
            shared += 1;
            stages.set(concept.conceptId, 'swm');
            await persistManifest();
          }
          console.log(`  ${layer}  ${concept.conceptId}  →  ${concept.iri}` +
            (needCreate ? `  (${concept.quads.length} quads${targetStage === 'swm' ? ', shared' : ''})` : '  (advanced WM→SWM)'));
        }

        console.log(
          JSON.stringify(
            {
              mode: 'import',
              contextGraphId,
              memoryLayer: layer,
              importMode: 'per-concept',
              ...(isPrivate ? { accessPolicy: 'private (invite-only, off-chain)', allowlistedPeers: allowedPeers.length } : {}),
              okfVersion: imported.okfVersion,
              ...summary,
              triplesWritten: written,
              assetsCreated: created,
              assetsShared: shared,
              note:
                layer === 'WM'
                  ? 'Assets are in private Working Memory (free, reversible). No on-chain verification.'
                  : 'Assets sealed and shared to Shared Working Memory (free, team-visible). No on-chain verification — VM promotion is a separate gated step.',
            },
            null,
            2,
          ),
        );
      } catch (err) {
        reportOkfError(err);
      }
    });

  // ─── dkg okf export <contextGraphId> <outDir> ───────────────────────
  okfCmd
    .command('export <contextGraphId> <outDir>')
    .description('Serialise a Context Graph back into a conformant OKF bundle (clean inverse of import)')
    .option('--sub-graph-name <name>', 'Sub-graph within the Context Graph')
    .option('--iri-base <base>', `IRI namespace concept subjects were minted under (default ${DEFAULT_IRI_BASE})`)
    .option('--view <view>', 'working-memory | shared-working-memory | verifiable-memory', 'shared-working-memory')
    .action(async (contextGraphId: string, outDir: string, opts: ActionOpts) => {
      try {
        const iriBase = opts.iriBase ? String(opts.iriBase) : DEFAULT_IRI_BASE;
        // Back-compat: the pre-v10.0.1 token was `verified-memory`; v10.0.1
        // renamed it to `verifiable-memory`. Accept the old spelling and map it
        // to the canonical token before querying.
        const rawView = String(opts.view ?? 'shared-working-memory');
        const view = (rawView === 'verified-memory' ? 'verifiable-memory' : rawView) as
          | 'working-memory'
          | 'shared-working-memory'
          | 'verifiable-memory';

        const client = await ApiClient.connect();
        // Fetch all triples whose subject is an OKF concept IRI in this graph.
        const sparql = `SELECT ?s ?p ?o WHERE { GRAPH ?g { ?s ?p ?o } FILTER(STRSTARTS(STR(?s), "${iriBase}")) }`;
        const { result } = await client.query(sparql, contextGraphId, {
          view,
          ...(opts.subGraphName ? { subGraphName: String(opts.subGraphName) } : {}),
        });

        const bindings = bindingsOf(result);

        // Daemon bindings are already in N-term form (literals as `"…"`/`"…"^^<dt>`,
        // IRIs as raw or `<…>`). Strip IRI brackets so they match the mapper's
        // raw-IRI quad-term convention; literals/blank nodes pass through.
        const unwrapIri = (term: string): string =>
          term.startsWith('<') && term.endsWith('>') ? term.slice(1, -1) : term;

        const quadsBySubject = new Map<string, Quad[]>();
        for (const b of bindings) {
          const s = cell(b.s);
          const p = cell(b.p);
          const o = cell(b.o);
          if (!s || !p || !o) continue;
          const subject = unwrapIri(s);
          const quad: Quad = { subject, predicate: unwrapIri(p), object: o };
          if (!quadsBySubject.has(subject)) quadsBySubject.set(subject, []);
          quadsBySubject.get(subject)!.push(quad);
        }

        // Rebuild a minimal BundleImport for the exporter. Keep only real concept
        // roots: subjects under the IRI base that carry an OKF concept rdf:type.
        // This excludes the skolemized `dkg:hasSection` nodes
        // (`<conceptIri>/.well-known/genid/...`), which would otherwise be rebuilt
        // as standalone `.well-known/genid/*.md` files that were never concepts.
        const concepts = [...quadsBySubject.entries()]
          .filter(
            ([iri, quads]) =>
              iri.startsWith(iriBase) &&
              !iri.includes(SECTION_GENID_INFIX) &&
              quads.some((q) => q.predicate === RDF_TYPE),
          )
          .map(([iri, quads]) => ({
            conceptId: iri.slice(iriBase.length),
            iri,
            quads,
            resolvedLinks: [],
            brokenLinks: [],
            codeSpanLinks: [],
            citations: [],
          }));
        const imported: BundleImport = {
          okfVersion: null,
          iriByConceptId: Object.fromEntries(concepts.map((c) => [c.conceptId, c.iri])),
          concepts,
          reservedSkipped: [],
          quads: concepts.flatMap((c) => c.quads),
          warnings: [],
        };

        if (concepts.length === 0) {
          console.error(
            `No OKF concepts (subjects under "${iriBase}") found in Context Graph "${contextGraphId}" (${view}).`,
          );
          process.exit(OKF_EXIT_CODES.NOT_FOUND);
        }

        const outFiles = exportBundle(imported, { iriBase });
        // Path-traversal guard: concept IDs come from graph subjects (untrusted),
        // so a subject like `urn:okf:../../escape` would otherwise write outside
        // outDir. Refuse any file that doesn't resolve under the output directory.
        const outRoot = resolve(outDir);
        for (const f of outFiles) {
          const full = resolve(outDir, f.path);
          const rel = relative(outRoot, full);
          if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
            console.error(`Refusing to write outside the output directory: "${f.path}"`);
            process.exit(OKF_EXIT_CODES.CLIENT_ERROR);
          }
          await mkdir(dirname(full), { recursive: true });
          await writeFile(full, f.content, 'utf-8');
        }
        console.log(
          JSON.stringify(
            { mode: 'export', contextGraphId, view, outDir, concepts: concepts.length, files: outFiles.length },
            null,
            2,
          ),
        );
      } catch (err) {
        reportOkfError(err);
      }
    });

  // ─── dkg okf verify <bundleDir> ─────────────────────────────────────
  // Completeness gate for a (private) bulk-imported corpus: map the bundle
  // offline, then re-query the Context Graph and compare actual triple counts
  // per integrity predicate against what the deterministic mapping expects.
  // Turns a silent undercount into an exact, actionable report — and exits
  // non-zero on any shortfall so it can gate a pipeline. The fix for a
  // shortfall is to re-run the same `import --private` and inspect the
  // lifecycle manifest for the chunk that did not complete.
  // Predicates we treat as integrity signals (order = report order).
  const INTEGRITY_PREDICATES = [
    RDF_TYPE, // imported from @origintrail-official/dkg-okf — single source of truth

    'http://schema.org/source',
    'http://schema.org/license',
    'http://schema.org/citation',
    'http://schema.org/mentions',
  ];

  okfCmd
    .command('verify <bundleDir>')
    .description('Compare a bulk-imported Context Graph against the bundle it was built from (completeness gate)')
    .requiredOption('--context-graph-id <id>', 'Context Graph to verify')
    .option('--iri-base <base>', `IRI namespace concept subjects were minted under (default ${DEFAULT_IRI_BASE})`)
    .option('--include-code-span-links', 'Match the import: treat code-span links as edges')
    .option(
      '--relate <rule>',
      'Match the import: type cross-concept edges by endpoint types ' +
        '"<FromType>><ToType>=<predicate>" (repeatable). MUST mirror the --relate rules used at ' +
        'import time — otherwise the offline expectation uses the default schema:mentions mapping ' +
        'and reports a false shortfall against a graph that actually holds the typed predicate.',
      collect,
      [] as string[],
    )
    .option('--list-missing <n>', 'List up to N concept IRIs missing their rdf:type (best-effort)', (v: string) => parseInt(v, 10))
    .action(async (bundleDir: string, opts: ActionOpts) => {
      try {
        if (!existsSync(bundleDir)) {
          console.error(`Bundle directory not found: ${bundleDir}`);
          process.exit(OKF_EXIT_CODES.UNEXPECTED);
        }
        const iriBase = opts.iriBase ? String(opts.iriBase) : DEFAULT_IRI_BASE;
        const contextGraphId = String(opts.contextGraphId);
        // The offline expectation MUST be built with the same edge typing the import used,
        // or a --relate'd predicate (e.g. schema:hasPart) is reconstructed as schema:mentions
        // and verify reports a false shortfall. Mirror the import's --relate exactly.
        const typeRelations = parseRelateRules(
          Array.isArray(opts.relate) ? (opts.relate as string[]) : [],
        );

        // Offline: what the deterministic mapping SHOULD have produced.
        const { files } = loadBundleDirWithReport(bundleDir);
        const imported = importBundle(files, {
          iriBase,
          includeCodeSpanLinks: Boolean(opts.includeCodeSpanLinks),
          typeRelations,
        });
        const expectedByPred = new Map<string, number>();
        for (const q of imported.quads) {
          expectedByPred.set(q.predicate, (expectedByPred.get(q.predicate) ?? 0) + 1);
        }
        const expectedConcepts = imported.concepts.length;

        const client = await ApiClient.connect();
        const countFor = async (predicate: string): Promise<number> => {
          // Scope the count to subjects under this bundle's IRI base. A graph-wide
          // count would let unrelated pre-existing triples mask a real shortfall
          // (or inflate it) and report "complete" when concepts are actually missing.
          const sparql =
            `SELECT (COUNT(*) AS ?c) WHERE { GRAPH ?g { ?s <${predicate}> ?o ` +
            `FILTER(STRSTARTS(STR(?s), "${iriBase}")) } }`;
          const { result } = await client.query(sparql, contextGraphId, {
            includeSharedMemory: true,
          });
          const bindings = bindingsOf(result);
          const raw = cell(bindings[0]?.c) || '0';
          const m = /^"?(\d+)"?/.exec(raw);
          return m ? parseInt(m[1], 10) : 0;
        };

        // Verify EVERY predicate the bundle actually produced, not a fixed
        // allowlist — otherwise a shortfall in e.g. schema:hasPart (--relate),
        // schema:dateModified or producer-extra keys would be invisible. The
        // INTEGRITY_PREDICATES list only fixes the leading report order.
        const orderedPreds = [
          ...INTEGRITY_PREDICATES.filter((p) => expectedByPred.has(p)),
          ...[...expectedByPred.keys()].filter((p) => !INTEGRITY_PREDICATES.includes(p)).sort(),
        ];
        const rows: Array<{ predicate: string; expected: number; actual: number; missing: number }> = [];
        for (const predicate of orderedPreds) {
          const expected = expectedByPred.get(predicate) ?? 0;
          if (expected === 0) continue; // predicate not used by this bundle
          const actual = await countFor(predicate);
          rows.push({ predicate, expected, actual, missing: Math.max(0, expected - actual) });
        }

        // Best-effort concept-level diff (subjects present with rdf:type).
        let missingConcepts: string[] | undefined;
        if (opts.listMissing) {
          const sparql = `SELECT DISTINCT ?s WHERE { GRAPH ?g { ?s <${RDF_TYPE}> ?o } }`;
          const { result } = await client.query(sparql, contextGraphId, { includeSharedMemory: true });
          const bindings = bindingsOf(result);
          const unwrap = (t: string): string => (t.startsWith('<') && t.endsWith('>') ? t.slice(1, -1) : t);
          const present = new Set(bindings.map((b) => unwrap(cell(b.s))));
          missingConcepts = imported.concepts
            .map((c) => c.iri)
            .filter((iri) => !present.has(iri))
            .slice(0, Number(opts.listMissing));
        }

        const totalMissing = rows.reduce((a, r) => a + r.missing, 0);
        const complete = totalMissing === 0;
        console.log(
          JSON.stringify(
            {
              mode: 'verify',
              contextGraphId,
              expectedConcepts,
              complete,
              predicates: rows,
              totalMissingTriples: totalMissing,
              ...(missingConcepts ? { missingConcepts } : {}),
              note: complete
                ? 'Context Graph matches the bundle on all integrity predicates.'
                : 'SHORTFALL: the node\'s SWM holds fewer triples than the bundle defines. ' +
                  'Re-run the same `dkg okf import --private` (idempotent second pass; the store ' +
                  'dedupes, so only the dropped triples are re-written), then verify again.',
            },
            null,
            2,
          ),
        );
        if (!complete) process.exit(OKF_EXIT_CODES.CLIENT_ERROR);
      } catch (err) {
        reportOkfError(err);
      }
    });
}
