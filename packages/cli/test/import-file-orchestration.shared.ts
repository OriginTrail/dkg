import { contextGraphAssertionUri, contextGraphMetaUri, assertionLifecycleUri, parseMultipart, findReservedSubjectPrefix, isSkolemizedUri, FileStore, ExtractionPipelineRegistry, extractFromMarkdown, randomUUID, buildImportFileResponse, normalizeDetectedContentType, ImportFileRouteError, type CapturedQuad, type MockAgent, type ImportFileResult, type ExtractionStatusRecord } from './import-file-test-helpers';
import { normalizeLargeRdfLiteralsForBlazegraph } from '@origintrail-official/dkg-core';
import { inferContentTypeFromFilename } from '../src/daemon/manifest.js';



export async function runImportFileOrchestration(params: {
  agent: MockAgent;
  fileStore: FileStore;
  extractionRegistry: ExtractionPipelineRegistry;
  extractionStatus: Map<string, ExtractionStatusRecord>;
  multipartBody: Buffer;
  boundary: string;
  assertionName: string;
  onInProgress?: (assertionUri: string, record: ExtractionStatusRecord) => void | Promise<void>;
  // Bug 19: per-assertion mutex map. If omitted, a fresh map is used
  // (safe for sequential tests). Concurrent-import tests that need to
  // observe the lock must pass a shared map across their parallel calls.
  assertionImportLocks?: Map<string, Promise<void>>;
  requestAgentAddress?: string;
  onMemoryGraphChanged?: (event: {
    contextGraphId: string;
    layers: string[];
    subGraphName?: string;
    operation: string;
    source: string;
    counts: { triples: number };
  }) => void | Promise<void>;
}): Promise<ImportFileResult> {
  const { agent, fileStore, extractionRegistry, extractionStatus, multipartBody, boundary, assertionName, onInProgress, onMemoryGraphChanged } = params;
  const assertionImportLocks = params.assertionImportLocks ?? new Map<string, Promise<void>>();
  const requestAgentAddress = params.requestAgentAddress ?? agent.peerId;

  const fields = parseMultipart(multipartBody, boundary);
  const filePart = fields.find(f => f.name === 'file' && f.filename !== undefined)!;
  const textField = (name: string): string | undefined => {
    const f = fields.find(x => x.name === name && x.filename === undefined);
    return f ? f.content.toString('utf-8') : undefined;
  };
  const contextGraphId = textField('contextGraphId')!;
  const contentTypeOverrideRaw = textField('contentType');
  // Mirror the daemon: blank `contentType=` is treated as absent.
  const contentTypeOverride =
    contentTypeOverrideRaw && contentTypeOverrideRaw.trim().length > 0
      ? contentTypeOverrideRaw
      : undefined;
  const ontologyRef = textField('ontologyRef');
  const subGraphName = textField('subGraphName');
  // Mirror the daemon's detection (#1101 + Codex PR #1107): filename-extension
  // inference rescues the IMPLICIT octet-stream default, but an EXPLICIT
  // `contentType=application/octet-stream` override is the opaque-blob escape
  // hatch and suppresses inference.
  let detectedContentType = normalizeDetectedContentType(contentTypeOverride ?? filePart.contentType);
  const explicitOctetStream =
    contentTypeOverride !== undefined &&
    normalizeDetectedContentType(contentTypeOverride) === 'application/octet-stream';
  if (detectedContentType === 'application/octet-stream' && !explicitOctetStream) {
    const inferred = inferContentTypeFromFilename(filePart.filename);
    if (inferred) detectedContentType = inferred;
  }
  if (subGraphName) {
    const registeredSubGraphs = await agent.listSubGraphs(contextGraphId);
    if (!registeredSubGraphs.some(subGraph => subGraph.name === subGraphName)) {
      throw new Error(`Sub-graph "${subGraphName}" has not been registered in context graph "${contextGraphId}". Call createSubGraph() first.`);
    }
  }

  const fileStoreEntry = await fileStore.put(filePart.content, detectedContentType);
  const assertionUri = contextGraphAssertionUri(contextGraphId, requestAgentAddress, assertionName, subGraphName);
  const uploadedFilename = filePart.filename?.trim() ?? '';
  const startedAt = new Date().toISOString();

  // Round 14 Bug 42: per-assertion mutex BEFORE extraction — mirrors
  // the daemon's restructure. Concurrent imports of the same assertion
  // name used to race during Phase 1/2 extraction and commit in
  // extraction-finish order rather than request-arrival order.
  // Moving the lock here serializes the entire handler per URI so
  // commits land in the order their callers arrived. Released in the
  // outer `finally` at the bottom of this function.
  const previousLock = assertionImportLocks.get(assertionUri) ?? Promise.resolve();
  let releaseLock: () => void = () => {};
  const currentLock = new Promise<void>(resolve => { releaseLock = resolve; });
  const chainedLock = previousLock.then(() => currentLock);
  assertionImportLocks.set(assertionUri, chainedLock);
  await previousLock;

  try {
  let mdIntermediate: string | null = null;
  let pipelineUsed: string | null = null;
  let mdIntermediateHash: string | undefined;
  let importRootEntity: string | undefined;
  const recordInProgress = async (): Promise<void> => {
    const record: ExtractionStatusRecord = {
      status: 'in_progress',
      fileHash: fileStoreEntry.keccak256,
      detectedContentType,
      pipelineUsed,
      tripleCount: 0,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
      startedAt,
    };
    extractionStatus.set(assertionUri, record);
    if (onInProgress) {
      await onInProgress(assertionUri, record);
    }
  };
  const recordFailed = (error: string, tripleCount: number, failedPipelineUsed: string | null = pipelineUsed): void => {
    extractionStatus.set(assertionUri, {
      status: 'failed',
      fileHash: fileStoreEntry.keccak256,
      ...(importRootEntity ? { rootEntity: importRootEntity } : {}),
      detectedContentType,
      pipelineUsed: failedPipelineUsed,
      tripleCount,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
      error,
      startedAt,
      completedAt: new Date().toISOString(),
    });
  };
  const fail = (statusCode: number, error: string, tripleCount: number, failedPipelineUsed: string | null = pipelineUsed): never => {
    recordFailed(error, tripleCount, failedPipelineUsed);
    throw new ImportFileRouteError(statusCode, buildImportFileResponse({
      assertionUri,
      fileHash: fileStoreEntry.keccak256,
      rootEntity: importRootEntity,
      detectedContentType,
      extraction: {
        status: 'failed',
        tripleCount,
        pipelineUsed: failedPipelineUsed,
        ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
        error,
      },
    }));
  };
  const previousExtractionStatusRecord = extractionStatus.get(assertionUri);
  const importMetaValue = (
    snapshot: CapturedQuad[],
    predicate: string,
  ): string | undefined => snapshot.find(q =>
    q.subject === assertionUri &&
    q.predicate === `http://dkg.io/ontology/${predicate}`
  )?.object;
  const parseImportMetaLiteral = (value: string | undefined): string | undefined => {
    const trimmed = value?.trim();
    if (!trimmed) return undefined;
    const literalMatch = /^"((?:[^"\\]|\\.)*)"/.exec(trimmed);
    if (literalMatch) {
      try {
        return JSON.parse(literalMatch[0]);
      } catch {
        return literalMatch[1];
      }
    }
    return trimmed.replace(/^<|>$/g, '');
  };
  const parseImportMetaInteger = (value: string | undefined): number | undefined => {
    const integerMatch = /^"(-?\d+)"/.exec(value?.trim() ?? '');
    if (!integerMatch) return undefined;
    const parsed = Number.parseInt(integerMatch[1], 10);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const buildPreviousExtractionStatusRecordFromMeta = (
    snapshot: CapturedQuad[],
  ): ExtractionStatusRecord | undefined => {
    const fileHash = parseImportMetaLiteral(importMetaValue(snapshot, 'sourceFileHash'));
    const detectedContentType = parseImportMetaLiteral(importMetaValue(snapshot, 'sourceContentType'));
    const tripleCount = parseImportMetaInteger(importMetaValue(snapshot, 'structuralTripleCount'));
    if (!fileHash || !detectedContentType || tripleCount == null) {
      return undefined;
    }
    const extractionStatus = parseImportMetaLiteral(importMetaValue(snapshot, 'extractionStatus'));
    const statusValue = extractionStatus === 'skipped' ? 'skipped' : 'completed';
    const restoredAt = new Date().toISOString();
    const fileName = parseImportMetaLiteral(importMetaValue(snapshot, 'sourceFileName'));
    const rootEntity = parseImportMetaLiteral(importMetaValue(snapshot, 'rootEntity'));
    const mdIntermediateHashFromMeta = parseImportMetaLiteral(importMetaValue(snapshot, 'mdIntermediateHash'));
    return {
      status: statusValue,
      fileHash,
      ...(fileName ? { fileName } : {}),
      ...(rootEntity ? { rootEntity } : {}),
      detectedContentType,
      pipelineUsed: statusValue === 'skipped' ? null : detectedContentType,
      tripleCount,
      ...(mdIntermediateHashFromMeta ? { mdIntermediateHash: mdIntermediateHashFromMeta } : {}),
      startedAt: restoredAt,
      completedAt: restoredAt,
    };
  };
  const getRestorablePreviousExtractionStatusRecord = (
    metaSnapshot: CapturedQuad[],
  ): ExtractionStatusRecord | undefined =>
    previousExtractionStatusRecord
      ? { ...previousExtractionStatusRecord }
      : buildPreviousExtractionStatusRecordFromMeta(metaSnapshot);
  const restoreExtractionStatusRecord = (record: ExtractionStatusRecord): void => {
    extractionStatus.set(assertionUri, record);
  };
  const failWithRestoredPreviousStatus = (
    statusCode: number,
    error: string,
    tripleCount: number,
    previousStatusRecord: ExtractionStatusRecord,
    failedPipelineUsed: string | null = pipelineUsed,
  ): never => {
    try {
      fail(statusCode, error, tripleCount, failedPipelineUsed);
    } catch (routeError) {
      restoreExtractionStatusRecord(previousStatusRecord);
      throw routeError;
    }
    throw new Error('unreachable');
  };

  await recordInProgress();

  if (detectedContentType === 'text/markdown') {
    mdIntermediate = filePart.content.toString('utf-8');
    pipelineUsed = 'text/markdown';
    await recordInProgress();
  } else {
    const converter = extractionRegistry.get(detectedContentType);
    if (converter) {
      const { mdIntermediate: md } = await converter.extract({
        filePath: fileStoreEntry.path,
        contentType: detectedContentType,
        ontologyRef,
        agentDid: `did:dkg:agent:${requestAgentAddress}`,
      });
      mdIntermediate = md;
      pipelineUsed = detectedContentType;
      const mdEntry = await fileStore.put(Buffer.from(md, 'utf-8'), 'text/markdown');
      mdIntermediateHash = mdEntry.keccak256;
      await recordInProgress();
    }
  }

  // Graceful degrade
  if (mdIntermediate === null) {
    const metaGraph = contextGraphMetaUri(contextGraphId);
    const lifecycleSubject = assertionLifecycleUri(contextGraphId, requestAgentAddress, assertionName, subGraphName);
    const listCreateMetaSubjects = async (): Promise<string[]> => {
      const lifecycleSubjectLiteral = JSON.stringify(lifecycleSubject);
      const lifecyclePrefixLiteral = JSON.stringify(`${lifecycleSubject}/`);
      const assertionUriLiteral = JSON.stringify(assertionUri);
      const result = await agent.store.query(
        `SELECT DISTINCT ?s WHERE { GRAPH <${metaGraph}> { ?s ?p ?o . FILTER(STR(?s) = ${lifecycleSubjectLiteral} || STRSTARTS(STR(?s), ${lifecyclePrefixLiteral}) || STR(?s) = ${assertionUriLiteral}) } }`,
      );
      if (result.type !== 'bindings') return [];
      return result.bindings
        .map(row => row['s'])
        .filter((subject): subject is string => typeof subject === 'string' && subject.length > 0);
    };
    const snapshotCreateMeta = async (): Promise<CapturedQuad[]> => {
      const subjects = new Set([
        assertionUri,
        lifecycleSubject,
        ...(await listCreateMetaSubjects()),
      ]);
      const snapshot: CapturedQuad[] = [];
      for (const subject of subjects) {
        const result = await agent.store.query(
          `CONSTRUCT { <${subject}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${subject}> ?p ?o } }`,
        );
        if (result.type === 'quads') {
          snapshot.push(...result.quads.map(q => ({ ...q, graph: metaGraph })));
        }
      }
      return snapshot;
    };
    const restoreCreateMetaSnapshot = async (snapshot: CapturedQuad[]): Promise<void> => {
      const subjects = new Set([
        assertionUri,
        lifecycleSubject,
        ...snapshot.map(q => q.subject),
        ...(await listCreateMetaSubjects()),
      ]);
      for (const subject of subjects) {
        await agent.store.deleteByPattern({ subject, graph: metaGraph });
      }
      if (snapshot.length > 0) {
        await agent.store.insert(snapshot);
      }
    };
    const snapshotCreateDataGraph = async (): Promise<CapturedQuad[]> => {
      const result = await agent.store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionUri}> { ?s ?p ?o } }`,
      );
      if (result.type !== 'quads') return [];
      return result.quads.map(q => ({ ...q, graph: assertionUri }));
    };
    const restoreCreateSnapshot = async (
      metaSnapshot: CapturedQuad[],
      dataSnapshot: CapturedQuad[],
      hadDataGraphBeforeCreate: boolean,
    ): Promise<void> => {
      const restoreErrors: string[] = [];
      try {
        if (dataSnapshot.length > 0) {
          await agent.store.dropGraph(assertionUri);
          await agent.store.insert(dataSnapshot);
        } else if (hadDataGraphBeforeCreate) {
          await agent.store.dropGraph(assertionUri);
          await agent.store.createGraph(assertionUri);
        } else if (!hadDataGraphBeforeCreate) {
          await agent.store.dropGraph(assertionUri);
        }
      } catch (err: any) {
        restoreErrors.push(`data graph rollback failed: ${err?.message ?? err}`);
      }
      try {
        await restoreCreateMetaSnapshot(metaSnapshot);
      } catch (err: any) {
        restoreErrors.push(`metadata rollback failed: ${err?.message ?? err}`);
      }
      if (restoreErrors.length > 0) {
        throw new Error(restoreErrors.join('; '));
      }
    };

    let preCreateDataGraphExisted = false;
    let preCreateDataSnapshot: CapturedQuad[];
    let preCreateMetaSnapshot: CapturedQuad[];
    try {
      preCreateDataGraphExisted = await agent.store.hasGraph(assertionUri);
      preCreateDataSnapshot = await snapshotCreateDataGraph();
      preCreateMetaSnapshot = await snapshotCreateMeta();
    } catch (err: any) {
      fail(500, `Failed to snapshot assertion create state for skipped extraction rollback: ${err?.message ?? String(err)}`, 0, null);
    }

    try {
      await agent.publisher.assertionCreate(contextGraphId, assertionName, requestAgentAddress, subGraphName);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (!(message.includes('already exists') || message.includes('duplicate') || message.includes('conflict'))) {
        const rollbackErrors: string[] = [];
        try {
          await restoreCreateSnapshot(preCreateMetaSnapshot, preCreateDataSnapshot, preCreateDataGraphExisted);
        } catch (rollbackErr: any) {
          rollbackErrors.push(`create rollback failed: ${rollbackErr?.message ?? rollbackErr}`);
        }
        const rollbackSuffix = rollbackErrors.length > 0
          ? `; rollback failures: ${rollbackErrors.join('; ')}`
          : '';
        if (message.includes('has not been registered') || message.includes('Invalid') || message.includes('Unsafe')) {
          const previousStatusRecord = rollbackErrors.length === 0
            ? getRestorablePreviousExtractionStatusRecord(preCreateMetaSnapshot)
            : undefined;
          if (previousStatusRecord) {
            failWithRestoredPreviousStatus(400, `${message}${rollbackSuffix}`, 0, previousStatusRecord);
          }
          fail(400, `${message}${rollbackSuffix}`, 0);
        }
        const previousStatusRecord = rollbackErrors.length === 0
          ? getRestorablePreviousExtractionStatusRecord(preCreateMetaSnapshot)
          : undefined;
        if (previousStatusRecord) {
          failWithRestoredPreviousStatus(500, `${message}${rollbackSuffix}`, 0, previousStatusRecord);
        }
        fail(500, `${message}${rollbackSuffix}`, 0);
      }
    }

    const skippedMetaQuads: CapturedQuad[] = [
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceContentType', object: JSON.stringify(detectedContentType), graph: metaGraph },
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceFileHash', object: JSON.stringify(fileStoreEntry.keccak256), graph: metaGraph },
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/extractionStatus', object: JSON.stringify('skipped'), graph: metaGraph },
      { subject: assertionUri, predicate: 'http://dkg.io/ontology/structuralTripleCount', object: '"0"^^<http://www.w3.org/2001/XMLSchema#integer>', graph: metaGraph },
    ];
    if (uploadedFilename.length > 0) {
      skippedMetaQuads.push({
        subject: assertionUri,
        predicate: 'http://dkg.io/ontology/sourceFileName',
        object: JSON.stringify(uploadedFilename),
        graph: metaGraph,
      });
    }

    let skippedMetaCleanupSucceeded = false;
    let skippedDataDropSucceeded = false;
    try {
      await agent.store.deleteByPattern({ subject: assertionUri, graph: metaGraph });
      skippedMetaCleanupSucceeded = true;
      await agent.store.dropGraph(assertionUri);
      skippedDataDropSucceeded = true;
      await agent.store.insert(skippedMetaQuads);
    } catch (err: any) {
      const rollbackErrors: string[] = [];
      if (skippedMetaCleanupSucceeded) {
        try {
          await agent.store.deleteByPattern({ subject: assertionUri, graph: metaGraph });
        } catch (partialMetaCleanupErr: any) {
          rollbackErrors.push(`partial _meta cleanup failed: ${partialMetaCleanupErr?.message ?? partialMetaCleanupErr}`);
        }
      }
      try {
        await restoreCreateSnapshot(preCreateMetaSnapshot, preCreateDataSnapshot, preCreateDataGraphExisted);
      } catch (createRollbackErr: any) {
        rollbackErrors.push(`create rollback failed: ${createRollbackErr?.message ?? createRollbackErr}`);
      }
      const rollbackSuffix = rollbackErrors.length > 0
        ? `; rollback failures: ${rollbackErrors.join('; ')}`
        : '';
      const previousStatusRecord = rollbackErrors.length === 0
        ? getRestorablePreviousExtractionStatusRecord(preCreateMetaSnapshot)
        : undefined;
      if (previousStatusRecord) {
        restoreExtractionStatusRecord(previousStatusRecord);
      } else {
        recordFailed(`Failed to persist skipped extraction metadata: ${err?.message ?? String(err)}${rollbackSuffix}`, 0);
      }
      throw err;
    }

    const skippedRecord: ExtractionStatusRecord = {
      status: 'skipped',
      fileHash: fileStoreEntry.keccak256,
      detectedContentType,
      pipelineUsed: null,
      tripleCount: 0,
      startedAt,
      completedAt: new Date().toISOString(),
    };
    extractionStatus.set(assertionUri, skippedRecord);
    if (onMemoryGraphChanged) {
      await onMemoryGraphChanged({
        contextGraphId,
        layers: ['wm'],
        subGraphName,
        operation: 'assertion_imported',
        source: 'api',
        counts: { triples: 0 },
      });
    }
    return buildImportFileResponse({
      assertionUri,
      fileHash: fileStoreEntry.keccak256,
      detectedContentType,
      extraction: { status: 'skipped', tripleCount: 0, pipelineUsed: null },
    });
  }

  // Phase 2 — file descriptor block (rows 4-13) lives on URI subjects
  // (Round 4 Option B after the blank-node approach was reverted). The
  // URNs `urn:dkg:file:keccak256:<hex>` and `urn:dkg:extraction:<uuid>`
  // are filtered out of `assertionPromote`'s partition by a subject-
  // prefix filter in the real publisher, so cross-assertion contention
  // on the file URN is impossible on promote.
  const fileUri = `urn:dkg:file:${fileStoreEntry.keccak256}`;
  const provUri = `urn:dkg:extraction:${randomUUID()}`;
  const agentDid = `did:dkg:agent:${requestAgentAddress}`;
  let triples: ReturnType<typeof extractFromMarkdown>['triples'];
  let sourceFileLinkage: ReturnType<typeof extractFromMarkdown>['sourceFileLinkage'];
  let documentSubjectIri: string;
  let resolvedRootEntity: string;
  try {
    let result = extractFromMarkdown({
      markdown: mdIntermediate,
      agentDid,
      ontologyRef,
      documentIri: assertionUri,
      sourceFileIri: fileUri,
    });
    // Mirror daemon issue #122 interim behavior: the import-file path
    // still pins the document subject to the assertion URI. A divergent
    // frontmatter `rootEntity` is rejected explicitly until distinct
    // document-vs-root identity is plumbed through the promote path.
    if (result.resolvedRootEntity !== assertionUri) {
      importRootEntity = result.resolvedRootEntity;
      const reservedPrefix = findReservedSubjectPrefix(result.resolvedRootEntity);
      if (reservedPrefix) {
        fail(
          400,
          `Frontmatter 'rootEntity' resolves to the reserved namespace '${reservedPrefix}*', which is protocol-reserved for daemon-generated import bookkeeping subjects.`,
          0,
        );
      }
      if (isSkolemizedUri(result.resolvedRootEntity)) {
        fail(
          400,
          `Frontmatter 'rootEntity' resolves to the skolemized URI '${result.resolvedRootEntity}', but import-file rootEntity must identify a root subject rather than a skolemized child (/.well-known/genid/...).`,
          0,
        );
      }
      fail(
        400,
        `Frontmatter 'rootEntity' override is not yet supported on the import-file path when it diverges from the imported document subject. Remove the 'rootEntity' key from frontmatter or make it match the document subject; tracking issue #122.`,
        0,
      );
    }
    triples = result.triples;
    // Round 13 Bug 39: rename mirror — see daemon for rationale.
    sourceFileLinkage = result.sourceFileLinkage;
    documentSubjectIri = result.subjectIri;
    resolvedRootEntity = result.resolvedRootEntity;
    importRootEntity = resolvedRootEntity;
  } catch (err: any) {
    if (err instanceof ImportFileRouteError) {
      throw err;
    }
    const message = err?.message ?? String(err);
    // Bug 13 + Round 7 Bug 20: invalid frontmatter IRIs AND invalid
    // programmatic `rootEntityIri` / `sourceFileIri` inputs both
    // throw from the extractor. Surface as a 400 rather than a 500.
    if (
      message.includes('Invalid frontmatter')
      || message.includes("Invalid 'rootEntityIri'")
      || message.includes("Invalid 'sourceFileIri'")
    ) {
      fail(400, message, 0);
    }
    fail(500, `Phase 2 extraction failed: ${message}`, 0);
  }

  // Build the full quad set across both graphs (assertion data graph +
  // CG root `_meta`) and commit them in a single atomic `store.insert`
  // call. See the daemon comment for the full rationale — short version:
  // every storage adapter's `insert` is a single N-Quads load / INSERT
  // DATA operation, so all-or-nothing applies across graphs.
  const assertionGraph = contextGraphAssertionUri(contextGraphId, agent.peerId, assertionName, subGraphName);
  const metaGraph = contextGraphMetaUri(contextGraphId);
  const startedAtLiteral = `"${startedAt}"^^<http://www.w3.org/2001/XMLSchema#dateTime>`;
  const markdownFormUri = mdIntermediateHash
    ? `urn:dkg:file:${mdIntermediateHash}`
    : fileUri;

  // Data-graph quads: content + extractor linkage + daemon-owned rows
  // 2, markdownForm, 4, 5, 8, 9-13. Round 9 Bug 27 removed rows 6 (`dkg:fileName`)
  // and 7 (`dkg:contentType`) from the file descriptor block — those
  // per-upload facts now live on the assertion UAL in `_meta`, not on
  // the content-addressed `<fileUri>` subject. See daemon equivalent.
  const dataGraphQuads: CapturedQuad[] = [
    ...triples.map(t => ({ ...t, graph: assertionGraph })),
    ...sourceFileLinkage.map(t => ({ ...t, graph: assertionGraph })),
    // Row 2 — daemon-owned. Always the ORIGINAL upload content type, so
    // for PDF this is "application/pdf", not the markdown intermediate.
    // Its subject matches rows 1 and 3 on the resolved document entity.
    { subject: documentSubjectIri, predicate: 'http://dkg.io/ontology/sourceContentType', object: JSON.stringify(detectedContentType), graph: assertionGraph },
    // Graph-level link to the markdown bytes structural extraction ran against.
    { subject: documentSubjectIri, predicate: 'http://dkg.io/ontology/markdownForm', object: markdownFormUri, graph: assertionGraph },
    // Rows 4, 5, 8 file descriptor — intrinsic-to-content properties only
    { subject: fileUri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/File', graph: assertionGraph },
    { subject: fileUri, predicate: 'http://dkg.io/ontology/contentHash', object: JSON.stringify(fileStoreEntry.keccak256), graph: assertionGraph },
    { subject: fileUri, predicate: 'http://dkg.io/ontology/size', object: `"${fileStoreEntry.size}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: assertionGraph },
    // Rows 9-13 extraction provenance — URI subject (filtered out of promote)
    { subject: provUri, predicate: 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type', object: 'http://dkg.io/ontology/ExtractionProvenance', graph: assertionGraph },
    // Provenance still points at the ORIGINAL upload file URN; the new
    // entity-level `dkg:markdownForm` link exposes the Phase 2 markdown input.
    { subject: provUri, predicate: 'http://dkg.io/ontology/extractedFrom', object: fileUri, graph: assertionGraph },
    { subject: provUri, predicate: 'http://dkg.io/ontology/extractedBy', object: agentDid, graph: assertionGraph },
    { subject: provUri, predicate: 'http://dkg.io/ontology/extractedAt', object: startedAtLiteral, graph: assertionGraph },
    { subject: provUri, predicate: 'http://dkg.io/ontology/extractionMethod', object: JSON.stringify('structural'), graph: assertionGraph },
  ];

  // `_meta` quads (rows 14-20 + Round 9 Bug 27 `dkg:sourceFileName`) —
  // CG root `_meta` graph, never sub-graph.
  const metaQuads: CapturedQuad[] = [
    // Row 14 — uses the extractor's resolved root entity so row 3 and row 14 agree.
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/rootEntity', object: resolvedRootEntity, graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceContentType', object: JSON.stringify(detectedContentType), graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/sourceFileHash', object: JSON.stringify(fileStoreEntry.keccak256), graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/extractionMethod', object: JSON.stringify('structural'), graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/extractionStatus', object: JSON.stringify('completed'), graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/structuralTripleCount', object: `"${triples.length}"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
    { subject: assertionUri, predicate: 'http://dkg.io/ontology/semanticTripleCount', object: `"0"^^<http://www.w3.org/2001/XMLSchema#integer>`, graph: metaGraph },
  ];
  if (mdIntermediateHash) {
    metaQuads.push({
      subject: assertionUri,
      predicate: 'http://dkg.io/ontology/mdIntermediateHash',
      object: JSON.stringify(mdIntermediateHash),
      graph: metaGraph,
    });
  }
  // Round 9 Bug 27: `dkg:sourceFileName` on the assertion UAL —
  // per-upload metadata parallel to existing `dkg:sourceContentType`
  // (row 15). Skipped when no filename was provided.
  if (uploadedFilename.length > 0) {
    metaQuads.push({
      subject: assertionUri,
      predicate: 'http://dkg.io/ontology/sourceFileName',
      object: JSON.stringify(uploadedFilename),
      graph: metaGraph,
    });
  }

  // Round 14 Bug 42: lock acquisition moved to the top of the
  // function, before any Phase 1/2 extraction. This inner `try`
  // now wraps only the assertion.create + snapshot + cleanup +
  // insert + rollback sequence. See the daemon equivalent and the
  // lock-acquisition site above for full rationale.
  try {
    try {
      await agent.publisher.assertionCreate(contextGraphId, assertionName, requestAgentAddress, subGraphName);
    } catch (err: any) {
      const message = err?.message ?? String(err);
      if (!(message.includes('already exists') || message.includes('duplicate') || message.includes('conflict'))) {
        if (message.includes('has not been registered') || message.includes('Invalid') || message.includes('Unsafe')) {
          fail(400, message, triples.length);
        }
        fail(500, message, triples.length);
      }
    }

    // Snapshot BOTH graphs for Bugs 11 + 15 rollback. The data-graph
    // snapshot captures every quad in the assertion graph; the `_meta`
    // snapshot is scoped to `<assertionUri> ?p ?o` within the CG root
    // `_meta` graph — we only rollback rows keyed by THIS assertion.
    let dataSnapshot: CapturedQuad[] = [];
    let metaSnapshot: CapturedQuad[] = [];
    try {
      const dataResult = await agent.store.query(
        `CONSTRUCT { ?s ?p ?o } WHERE { GRAPH <${assertionGraph}> { ?s ?p ?o } }`,
      );
      if (dataResult.type === 'quads') {
        dataSnapshot = dataResult.quads.map(q => ({ ...q, graph: assertionGraph }));
      }
    } catch (err: any) {
      // Round 13 Bug 38: mark the error so the outer catch preserves
      // the stage-specific failure message instead of overwriting it
      // with the raw store error. Mirrors the daemon equivalent.
      recordFailed(`Failed to snapshot assertion data graph for rollback: ${err?.message ?? String(err)}`, 0);
      (err as any).__failureAlreadyRecorded = true;
      throw err;
    }
    try {
      const metaResult = await agent.store.query(
        `CONSTRUCT { <${assertionUri}> ?p ?o } WHERE { GRAPH <${metaGraph}> { <${assertionUri}> ?p ?o } }`,
      );
      if (metaResult.type === 'quads') {
        metaSnapshot = metaResult.quads.map(q => ({ ...q, graph: metaGraph }));
      }
    } catch (err: any) {
      // Round 13 Bug 38: same stage-context preservation as the
      // dataSnapshot branch above.
      recordFailed(`Failed to snapshot _meta for rollback: ${err?.message ?? String(err)}`, 0);
      (err as any).__failureAlreadyRecorded = true;
      throw err;
    }

    // Round 7 Bug 22: unified write-stage rollback. Track which
    // cleanup steps succeeded so the catch block can restore the
    // exact snapshots corresponding to state we actually corrupted:
    //
    //  - deleteByPattern fails → no rollback (state unchanged)
    //  - deleteByPattern succeeds, dropGraph fails → restore meta
    //  - dropGraph succeeds, insert fails → restore both
    //  - insert succeeds → no rollback
    let metaCleanupSucceeded = false;
    let dataDropSucceeded = false;
    try {
      await agent.store.deleteByPattern({ subject: assertionUri, graph: metaGraph });
      metaCleanupSucceeded = true;
      await agent.store.dropGraph(assertionGraph);
      dataDropSucceeded = true;
      const normalizedImportQuads = normalizeLargeRdfLiteralsForBlazegraph([...dataGraphQuads, ...metaQuads], {
        label: 'import-file.quads',
      }).quads.map((q) => {
        if (q.graph === undefined) {
          throw new Error('import-file.quads normalization produced a quad without graph');
        }
        return {
          subject: q.subject,
          predicate: q.predicate,
          object: q.object,
          graph: q.graph,
        };
      });
      await agent.store.insert(normalizedImportQuads);
    } catch (writeErr: any) {
      const rollbackErrors: string[] = [];
      if (dataDropSucceeded && dataSnapshot.length > 0) {
        try {
          await agent.store.insert(dataSnapshot);
        } catch (dataRollbackErr: any) {
          rollbackErrors.push(`data rollback failed: ${dataRollbackErr?.message ?? dataRollbackErr}`);
        }
      }
      if (metaCleanupSucceeded && metaSnapshot.length > 0) {
        try {
          await agent.store.insert(metaSnapshot);
        } catch (metaRollbackErr: any) {
          rollbackErrors.push(`_meta rollback failed: ${metaRollbackErr?.message ?? metaRollbackErr}`);
        }
      }
      if (rollbackErrors.length > 0) {
        recordFailed(
          `write stage failed AND rollback failures: ${writeErr?.message ?? writeErr}; ${rollbackErrors.join('; ')}`,
          triples.length,
        );
        (writeErr as any).__failureAlreadyRecorded = true;
      } else {
        const previousStatusRecord =
          getRestorablePreviousExtractionStatusRecord(metaSnapshot);
        if (previousStatusRecord) {
          (writeErr as any).__previousExtractionStatusRecord =
            previousStatusRecord;
        }
      }
      throw writeErr;
    }
  } catch (err: any) {
    // An ImportFileRouteError means a nested `fail()` call already
    // recorded a precise failure state. Don't re-record.
    if (err instanceof ImportFileRouteError) {
      throw err;
    }
    // Bug 15: compound rollback failure already wrote a rich error
    // record — don't overwrite it with the bare insert error.
    if (err?.__failureAlreadyRecorded) {
      throw err;
    }
    // Round 10 Bug 29: the `Invalid`/`Unsafe`/`has not been registered`
    // substring branch was removed from this outer catch. The inner
    // `assertion.create` catch (line 592 in this harness) is the only
    // step in this block where a user-input validation error
    // legitimately originates — and it already short-circuits with
    // fail(400, …) and returns. Post-`assertion.create` steps
    // (snapshot, cleanup, insert, rollback) operate on daemon-
    // constructed quads; `Invalid`/`Unsafe` in those messages
    // signals an internal storage error and must surface as 500.
    //
    // Unexpected insert failure: because the insert is atomic, nothing
    // landed, but we still record the failure so /extraction-status
    // doesn't stay stuck at in_progress.
    recordFailed(err?.message ?? String(err), triples.length);
    const previousStatusRecord = err?.__previousExtractionStatusRecord as
      | ExtractionStatusRecord
      | undefined;
    if (previousStatusRecord) {
      restoreExtractionStatusRecord(previousStatusRecord);
    }
    throw err;
  }

  const completedRecord: ExtractionStatusRecord = {
    status: 'completed',
    fileHash: fileStoreEntry.keccak256,
    ...(importRootEntity ? { rootEntity: importRootEntity } : {}),
    detectedContentType,
    pipelineUsed,
    tripleCount: triples.length,
    mdIntermediateHash,
    startedAt,
    completedAt: new Date().toISOString(),
  };
  extractionStatus.set(assertionUri, completedRecord);

  return buildImportFileResponse({
    assertionUri,
    fileHash: fileStoreEntry.keccak256,
    rootEntity: importRootEntity,
    detectedContentType,
    extraction: {
      status: 'completed',
      tripleCount: triples.length,
      pipelineUsed,
      ...(mdIntermediateHash ? { mdIntermediateHash } : {}),
    },
  });
  } finally {
    // Round 14 Bug 42 outer finally: release the per-assertion lock
    // so the next waiter can start. Runs regardless of early returns
    // (graceful-degrade skipped path), failed-extraction throws, the
    // inner write-stage rethrow, or normal completion. Mirrors the
    // daemon's outer finally at the equivalent handler-end location.
    releaseLock();
    if (assertionImportLocks.get(assertionUri) === chainedLock) {
      assertionImportLocks.delete(assertionUri);
    }
  }
}
