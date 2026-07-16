# Migration: remove /api/assertion → unify on /api/knowledge-assets

Base: integration/v10-devnet. Branch: feat/unify-knowledge-assets-routes. Target: rc.17.

Staged: (1) KA route completeness + parity, (2) repoint ~80 consumers, (3) unit+devnet tests, (4) delete assertion.ts.

## New KA paths (the unified contract)

| New KA route | Replaces legacy |
|---|---|
| `POST /api/knowledge-assets` | `/api/assertion/create (atomic)` |
| `POST /api/knowledge-assets/:name/wm/write` | `/api/assertion/:name/write` |
| `POST /api/knowledge-assets/:name/wm/finalize` | `/api/assertion/:name/finalize` |
| `POST /api/knowledge-assets/:name/wm/discard` | `/api/assertion/:name/discard` |
| `POST /api/knowledge-assets/:name/wm/pull-from` | `(new) seed draft` |
| `GET  /api/knowledge-assets/:name/wm/quads` | `/api/assertion/:name/query` |
| `POST /api/knowledge-assets/:name/wm/import-file` | `/api/assertion/:name/import-file` |
| `GET  /api/knowledge-assets/:name/wm/extraction-status` | `/api/assertion/:name/extraction-status` |
| `POST /api/knowledge-assets/:name/swm/share` | `/api/assertion/:name/promote` |
| `POST /api/knowledge-assets/:name/swm/share-async` | `/api/assertion/:name/promote-async` |
| `GET  /api/knowledge-assets/swm/share-jobs` | `/api/assertion/promote-async` |
| `GET  /api/knowledge-assets/swm/share-jobs/:jobId` | `/api/assertion/promote-async/:jobId` |
| `DELETE /api/knowledge-assets/swm/share-jobs/:jobId` | `/api/assertion/promote-async/:jobId` |
| `POST /api/knowledge-assets/swm/share-jobs/:jobId/recover` | `/api/assertion/promote-async/:jobId/recover` |
| `POST /api/knowledge-assets/:name/vm/publish` | `(shared-memory publish path)` |
| `GET  /api/knowledge-assets/:identifier` | `/api/assertion/:name/history (+author scope)` |
| `POST /api/knowledge-assets/import-artifact/resolve` | `/api/assertion/import-artifact/resolve` |
| `POST /api/knowledge-assets/import-artifact/read-markdown` | `/api/assertion/import-artifact/read-markdown` |
| `POST /api/knowledge-assets/semantic-enrichment/write` | `/api/assertion/semantic-enrichment/write` |

## Helper relocation → packages/cli/src/daemon/routes/shared-assertion-helpers.ts

Already shared (import as-is): safeDecodeURIComponent, validateOptionalSubGraphName, validateRequiredContextGraphId, normalizeContextGraphIdOrUri, resolveRequiredWriteContextGraphId, PromoteJobView, PromoteJobErrorView, recordAssertionActivity, validatePreSignedAuthorAttestation, extractBearerToken

Move out of assertion.ts: sortAssertionQuads, validatePromoteJobId, decodePromoteJobId, promoteJobToView, isoFromEpochMs, asyncPromoteUnavailable, normalizeSemanticQuads, rdfLiteral, escapeRdfLiteralBody, typedLiteral, buildSemanticEnrichmentProvenanceQuads, normalizeMarkdownReadLimit, normalizeGeneratedAt, normalizeGeneratedBy, comparableAgentAddress, isSameAgentAddress, assertImportedArtifactOwnerAddress, isPublicOpenContextGraph, ImportArtifactRouteError, handleImportArtifactRouteError, resolveImportedArtifactFromSharedMemory, resolveImportedArtifact, parseImportedAssertionUri, bindingCellValue, normalizeLiteralBinding, normalizeIriBinding, singletonMetadataBinding, hashFromFileUrn, validateContentHash, ImportedArtifactResolution

## Parity gaps (9 blockers + side-effects)

- **[important]** `POST /api/knowledge-assets` — Missing 'alreadyExists' flag in response when assertion already exists
  - fix: Add check after agent.assertion.create(): if error.message includes 'already exists', catch it and return 201 with { assertionUri, alreadyExists: true, status: 'draft-open' } instead of 400 error
  - ref: assertion.ts:1548-1652 — legacy create catches 'already exists' error and returns 400, but does not flag response with alreadyExists status
- **[important]** `POST /api/knowledge-assets` — Missing emitMemoryGraphChanged SSE for assertion_created operation
  - fix: After line 343, add: emitMemoryGraphChanged?.({ contextGraphId, layers: ['wm'], subGraphName, operation: 'assertion_created', source: 'api', counts: { triples: 0 } })
  - ref: assertion.ts:1554-1561 — emits assertion_created event after successful create
- **[important]** `POST /api/knowledge-assets` — Missing recordAssertionActivity for 'created' kind
  - fix: After emitMemoryGraphChanged for create, add try/catch block: recordAssertionActivity(dashDb, { contextGraphId, kind: 'created', actorAgentAddress: resolvedAuthorAgentAddress ?? requestAgentAddress, subGraphName }); emitNotification?.({ contextGraphId, type: 'assertion_activity' })
  - ref: assertion.ts:1568-1576 — records activity with kind='created' and actorAgentAddress for attribution
- **[important]** `POST /api/knowledge-assets` — Missing emitMemoryGraphChanged SSE for assertion_written operation during autoFinalize
  - fix: After line 350 (await agent.assertion.write), add: emitMemoryGraphChanged?.({ contextGraphId, layers: ['wm'], subGraphName, operation: 'assertion_written', source: 'api', counts: { triples: quads.length } })
  - ref: assertion.ts:1585-1592 — emits assertion_written after write in the atomic create path
- **[important]** `POST /api/knowledge-assets` — Missing emitMemoryGraphChanged SSE for assertion_finalized operation during autoFinalize
  - fix: After line 351 (await agent.assertion.finalize), before building seal response, add: emitMemoryGraphChanged?.({ contextGraphId, layers: ['wm'], subGraphName, operation: 'assertion_finalized', source: 'api' })
  - ref: assertion.ts:1606-1612 — emits assertion_finalized after finalize in atomic path
- **[important]** `POST /api/knowledge-assets` — Missing emitMemoryGraphChanged SSE for assertion_promoted operation when alsoShareSwm succeeds
  - fix: After line 361 (await agent.assertion.promote for swm), add: if (share.promotedCount !== 0) { emitMemoryGraphChanged?.({ contextGraphId, layers: ['wm', 'swm'], subGraphName, operation: 'assertion_promoted', source: 'api', counts: { triples: share.promotedCount } }); try { recordAssertionActivity(...) } catch {} }
  - ref: assertion.ts:1629-1636 — emits assertion_promoted when promote count > 0
- **[important]** `POST /api/knowledge-assets` — Missing alsoShareSwm/alsoPublishVm boolean validation — currently accepts any truthy value
  - fix: Change lines 357, 367: if (alsoShareSwm === true) and if (alsoPublishVm === true) instead of if (alsoShareSwm)/if (alsoPublishVm). Also validate on finalize options.
  - ref: assertion.ts:1459-1460 — uses strict boolean === true checks, not truthiness
- **[blocker]** `POST /api/knowledge-assets` — Missing context graph resolution/validation — no call to resolveRequiredWriteContextGraphId for contextGraphId param
  - fix: Add after line 329: const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(agent, contextGraphId, res, { callerAgentAddress: undefined, allowLocalExactFallback: true }); if (!resolvedContextGraphId) return; Then use resolvedContextGraphId in all subsequent calls.
  - ref: assertion.ts:1466-1472 — validates and resolves contextGraphId via resolveRequiredWriteContextGraphId
- **[important]** `POST /api/knowledge-assets/:name/wm/write` — Missing emitMemoryGraphChanged SSE for assertion_written operation
  - fix: After line 462 (await agent.assertion.write), add: emitMemoryGraphChanged?.({ contextGraphId, layers: ['wm'], subGraphName, operation: 'assertion_written', source: 'api', counts: { triples: parsed.quads.length } })
  - ref: assertion.ts:1712-1719 — emits assertion_written after successful write
- **[blocker]** `POST /api/knowledge-assets/:name/wm/finalize` — Response missing full seal fields: assertionUri, authorAddress, schemeVersion, chainId, kav10Address — only returns merkleRoot and eip712Digest
  - fix: Replace line 469 response with: return jsonResponse(res, 200, { assertionUri: seal.assertionUri, merkleRoot: hex(seal.merkleRoot), authorAddress: seal.authorAddress, schemeVersion: seal.schemeVersion, chainId: seal.chainId.toString(), kav10Address: seal.kav10Address, eip712Digest: seal.eip712Digest })
  - ref: assertion.ts:2166-2174 — returns { assertionUri, merkleRoot, authorAddress, schemeVersion, chainId, kav10Address, eip712Digest }
- **[important]** `POST /api/knowledge-assets/:name/wm/finalize` — Missing emitMemoryGraphChanged SSE for assertion_finalized operation
  - fix: Before line 469 return, add: emitMemoryGraphChanged?.({ contextGraphId, layers: ['wm'], subGraphName, operation: 'assertion_finalized', source: 'api' })
  - ref: assertion.ts:2159-2165 — emits assertion_finalized after successful finalize
- **[important]** `POST /api/knowledge-assets/:name/wm/discard` — Missing emitMemoryGraphChanged SSE for assertion_discarded operation
  - fix: Before line 473 return, add: emitMemoryGraphChanged?.({ contextGraphId, layers: ['wm'], subGraphName, operation: 'assertion_discarded', source: 'api' })
  - ref: assertion.ts:2236-2242 — emits assertion_discarded after successful discard
- **[important]** `POST /api/knowledge-assets/:name/swm/share` — Missing emitMemoryGraphChanged SSE for assertion_promoted operation when promotedCount > 0
  - fix: After line 497, add: if (share.promotedCount !== 0) { emitMemoryGraphChanged?.({ contextGraphId, layers: ['wm', 'swm'], subGraphName, operation: 'assertion_promoted', source: 'api', counts: { triples: share.promotedCount } }) }
  - ref: assertion.ts:1816-1823 — emits assertion_promoted only when promotedCount !== 0
- **[important]** `POST /api/knowledge-assets/:name/swm/share` — Missing recordAssertionActivity for 'promoted' kind when promotedCount > 0
  - fix: After emitMemoryGraphChanged, add: try { recordAssertionActivity(dashDb, { contextGraphId, kind: 'promoted', actorAgentAddress: requestAgentAddress, subGraphName, tripleCount: share.promotedCount }); emitNotification?.({ contextGraphId, type: 'assertion_activity' }); } catch {}
  - ref: assertion.ts:1826-1834 — records promoted activity and emits notification when promotedCount !== 0
- **[blocker]** `POST /api/knowledge-assets/:name/vm/publish` — Response missing full publish metadata: assertionUri, authorAddress, merkleRoot, kas array — only returns kaId, status, ual, txHash
  - fix: Replace lines 518-525 response with full memory.ts publish response shape including assertionUri, authorAddress (from pub.seal.authorAddress), merkleRoot, and kas array
  - ref: memory.ts:1747-1765 — returns { kaId, status, assertionUri, authorAddress, merkleRoot, kas: [{tokenId, rootEntity}], txHash, blockNumber, contextGraphError }
- **[important]** `GET /api/knowledge-assets/:identifier` — Missing agentAddress scoping/filtering support — legacy accepts optional agentAddress query param to scope results to specific agent
  - fix: Add: const agentAddress = url.searchParams.get('agentAddress') ?? undefined; if (agentAddress && !/^[\w:.\-]+$/.test(agentAddress)) return jsonResponse(res, 400, { error: 'Invalid agentAddress format' }); Pass { subGraphName, ...(agentAddress ? { agentAddress } : {}) } to resolveDescriptor()
  - ref: assertion.ts:2276-2285 — accepts optional agentAddress query param and passes to agent.assertion.history()
- **[important]** `GET /api/knowledge-assets/:identifier` — Missing DID normalization and safeDecodeURIComponent for :identifier param — legacy safely decodes URL-encoded names
  - fix: Add param validation: const decodedName = safeDecodeURIComponent(name, res); if (decodedName === null) return; const nameVal = validateAssertionName(decodedName); if (!nameVal.valid) return jsonResponse(res, 400, { error: 'Invalid assertion name: ' + nameVal.reason }); Use decodedName for classifyKaIdentifier
  - ref: assertion.ts:2262-2265 — uses safeDecodeURIComponent for path segment extraction
- **[important]** `GET /api/knowledge-assets/:identifier` — Missing contextGraphId normalization via normalizeContextGraphIdOrUri
  - fix: Add: const normalizedCg = normalizeContextGraphIdOrUri(cg); Pass normalizedCg to resolveDescriptor instead of raw cg
  - ref: assertion.ts:2275 — normalizes context graph id/uri via normalizeContextGraphIdOrUri before passing to agent
- **[important]** `GET /api/knowledge-assets/:identifier/{wm,swm,vm}` — Missing agentAddress scoping support on per-layer GET
  - fix: Add agentAddress extraction and validation same as main GET, pass to resolveDescriptor
  - ref: assertion.ts:2276-2285 — legacy history GET accepts agentAddress param
- **[important]** `GET /api/knowledge-assets/:identifier/{wm,swm,vm}` — Missing :identifier param validation and decoding on per-layer GET
  - fix: Add same validation/decoding as main GET route
  - ref: assertion.ts:2262-2265 — validates and decodes assertion name
- **[blocker]** `POST /api/knowledge-assets/:name/wm/write` — Missing context graph resolution/validation — no call to resolveRequiredWriteContextGraphId
  - fix: After extracting contextGraphId from parsed, add: const resolvedContextGraphId = await resolveRequiredWriteContextGraphId(agent, contextGraphId, res, { ... }); if (!resolvedContextGraphId) return; Use resolvedContextGraphId in subsequent calls
  - ref: assertion.ts:1697-1703 — validates and resolves contextGraphId before write
- **[blocker]** `POST /api/knowledge-assets/:name/wm/finalize` — Missing context graph resolution/validation — no call to resolveRequiredWriteContextGraphId
  - fix: After extracting contextGraphId, add context graph resolution via resolveRequiredWriteContextGraphId. Use resolved value in all subsequent calls.
  - ref: assertion.ts:2081-2087 — validates and resolves contextGraphId before finalize
- **[blocker]** `POST /api/knowledge-assets/:name/wm/discard` — Missing context graph resolution/validation — no call to resolveRequiredWriteContextGraphId
  - fix: Add context graph resolution via resolveRequiredWriteContextGraphId after parsing body
  - ref: assertion.ts:2215-2221 — validates and resolves contextGraphId before discard
- **[important]** `POST /api/knowledge-assets/:name/wm/write` — Missing :name param validation and decoding
  - fix: Add: const decodedName = safeDecodeURIComponent(name, res); if (decodedName === null) return; const nameVal = validateAssertionName(decodedName); if (!nameVal.valid) return jsonResponse(res, 400, ...); Use decodedName in all calls
  - ref: assertion.ts:1681-1690 — validates assertion name extracted from URL
- **[important]** `POST /api/knowledge-assets/:name/wm/finalize` — Missing :name param validation and decoding
  - fix: Add name validation/decoding at start of finalize handler
  - ref: assertion.ts:2061-2070 — validates assertion name from URL path
- **[important]** `POST /api/knowledge-assets/:name/wm/discard` — Missing :name param validation and decoding
  - fix: Add name validation/decoding at start of discard handler
  - ref: assertion.ts:2201-2210 — validates assertion name from URL path
- **[important]** `POST /api/knowledge-assets/:name/swm/share` — Missing :name param validation and decoding
  - fix: Add name validation/decoding at start of share handler
  - ref: assertion.ts:1785-1794 — validates assertion name
- **[blocker]** `POST /api/knowledge-assets/:name/swm/share` — Missing context graph resolution/validation
  - fix: Add context graph resolution via resolveRequiredWriteContextGraphId
  - ref: assertion.ts:1799-1805 — resolves context graph before promote
- **[important]** `POST /api/knowledge-assets/:name/vm/publish` — Missing :name param validation and decoding
  - fix: Add name validation/decoding at start of vm/publish handler
  - ref: assertion.ts — legacy publish uses decoded name from URL
- **[blocker]** `POST /api/knowledge-assets/:name/vm/publish` — Missing context graph resolution/validation
  - fix: Add context graph resolution via resolveRequiredWriteContextGraphId
  - ref: memory.ts:1566-1572 — resolves context graph before publish
- **[important]** `POST /api/knowledge-assets/:name/wm/pull-from` — Missing :name param validation and decoding
  - fix: Add name validation/decoding at start of pull-from handler
  - ref: assertion.ts — legacy routes validate assertion names from URL
- **[blocker]** `POST /api/knowledge-assets/:name/wm/pull-from` — Missing context graph resolution/validation
  - fix: Add context graph resolution via resolveRequiredWriteContextGraphId
  - ref: assertion.ts — legacy routes resolve context graphs before mutations
- **[nice]** `POST /api/knowledge-assets` — Atomic create with alsoShareSwm/alsoPublishVm failure leaves durable draft on partial failure — if share/publish fails after finalize, the sealed assertion remains
  - fix: This is actually correct per RFC-43 §10.5.5 (atomic/all-or-nothing is at create+finalize step; opt-in layers are async-safe to fail). The current 207 response handling (lines 391-392) is correct. No fix needed.
  - ref: assertion.ts:1595-1651 — legacy create also has this: once sealed, it's committed regardless of promote/publish tail outcome; 207 response indicates partial success
- **[important]** `POST /api/knowledge-assets` — Activity for promoted in alsoShareSwm path attributes to wrong agent — should use resolvedAuthorAgentAddress but KA lacks author context
  - fix: KA create needs to track resolvedAuthorAgentAddress from finalize options and pass to promote-activity recording. Store it in result scope or compute from finalizeOptions
  - ref: assertion.ts:1643 — records activity with actorAgentAddress: resolvedAuthorAgentAddress ?? requestAgentAddress
- **[important]** `POST /api/knowledge-assets/:name/vm/publish` — Missing activity recording for published event
  - fix: Add recordAssertionActivity call after successful publish (when httpStatus === 200): recordAssertionActivity(dashDb, { contextGraphId, kind: 'published', actorAgentAddress: requestAgentAddress, subGraphName }); emitNotification?.(...).
  - ref: memory.ts:1709+ — records operation tracking/completion via tracker object, which feeds activity system
