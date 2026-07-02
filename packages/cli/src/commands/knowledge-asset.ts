import { Command } from 'commander';
import { toErrorMessage } from '@origintrail-official/dkg-core';
import {
  ApiClient,
  type KnowledgeAssetCreateOptions,
  type KnowledgeAssetCreateResponse,
  type KnowledgeAssetFinalizedPublishOptions,
  type KnowledgeAssetPublishResponse,
  type KnowledgeAssetShareJobState,
  type KnowledgeAssetShareResponse,
  type KnowledgeAssetWritableQuad,
  type PreSignedAuthorAttestationPayload,
} from '../api-client.js';
import {
  formatQuadObject,
  loadQuadsFromInput,
  loadStructuredFile,
  type ActionOpts,
} from '../cli-helpers.js';
import { parseNonNegativeBigIntOption } from '../publisher-runner.js';

const SHARE_JOB_STATES: readonly KnowledgeAssetShareJobState[] = [
  'queued',
  'running',
  'failed_retrying',
  'succeeded',
  'failed',
];

function requiredContextGraphId(opts: ActionOpts): string {
  const contextGraphId = opts.contextGraphId ?? opts.contextGraph;
  if (!contextGraphId) throw new Error('Missing required option: -c, --context-graph-id <id>');
  return String(contextGraphId);
}

function subGraphName(opts: ActionOpts): string | undefined {
  const value = opts.subGraphName ?? opts.subGraph;
  return value === undefined ? undefined : String(value);
}

function inputFilePath(opts: ActionOpts): string | undefined {
  const value = opts.inputFile ?? opts.file;
  return value === undefined ? undefined : String(value);
}

function hasQuadInput(opts: ActionOpts): boolean {
  return Boolean(
    inputFilePath(opts) ||
      opts.triples ||
      opts.subject ||
      opts.predicate ||
      opts.object,
  );
}

async function loadWritableQuads(opts: ActionOpts): Promise<KnowledgeAssetWritableQuad[]> {
  const quads = await loadQuadsFromInput(
    {
      ...opts,
      file: inputFilePath(opts),
    },
    '',
  );
  return quads.map((quad) => ({
    subject: quad.subject,
    predicate: quad.predicate,
    object: quad.object,
    ...(quad.graph ? { graph: quad.graph } : {}),
  }));
}

function parsePreSignedAuthorAttestation(raw: unknown): PreSignedAuthorAttestationPayload | undefined {
  if (raw === undefined || raw === null || raw === '') return undefined;
  const value = String(raw);
  try {
    return JSON.parse(value) as PreSignedAuthorAttestationPayload;
  } catch {
    return loadStructuredFile(value) as PreSignedAuthorAttestationPayload;
  }
}

function parseFinalizeAuthorOptions(opts: ActionOpts): {
  authorAgentAddress?: string;
  preSignedAuthorAttestation?: PreSignedAuthorAttestationPayload;
  schemeVersion?: number;
} {
  const authorAgentAddress =
    opts.authorAgentAddress === undefined || opts.authorAgentAddress === ''
      ? undefined
      : String(opts.authorAgentAddress);
  const hasPreSignedAuthorAttestation =
    opts.preSignedAuthorAttestation !== undefined &&
    opts.preSignedAuthorAttestation !== null &&
    opts.preSignedAuthorAttestation !== '';
  if (authorAgentAddress && hasPreSignedAuthorAttestation) {
    throw new Error('--author-agent-address and --pre-signed-author-attestation are mutually exclusive');
  }
  const schemeVersion = parseOptionalPositiveInteger(opts.schemeVersion, '--scheme-version');
  const preSignedAuthorAttestation = parsePreSignedAuthorAttestation(opts.preSignedAuthorAttestation);
  return {
    ...(authorAgentAddress ? { authorAgentAddress } : {}),
    ...(preSignedAuthorAttestation ? { preSignedAuthorAttestation } : {}),
    ...(schemeVersion !== undefined ? { schemeVersion } : {}),
  };
}

function parseOptionalPositiveInteger(raw: unknown, flag: string): number | undefined {
  if (raw === undefined) return undefined;
  const value = String(raw).trim();
  if (!/^[1-9]\d*$/.test(value)) throw new Error(`${flag} must be a positive integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`${flag} must be a positive integer`);
  return parsed;
}

function parseOptionalBigInt(raw: unknown, flag: string): bigint | undefined {
  if (raw === undefined) return undefined;
  return parseNonNegativeBigIntOption(String(raw), flag);
}

function parsePublishOptions(opts: ActionOpts): KnowledgeAssetFinalizedPublishOptions {
  const publishEpochs = parseOptionalPositiveInteger(opts.publishEpochs, '--publish-epochs');
  const publisherNodeIdentityIdOverride = parseOptionalBigInt(
    opts.publisherNodeIdentityId,
    '--publisher-node-identity-id',
  );
  return {
    ...(publishEpochs !== undefined ? { publishEpochs } : {}),
    ...(publisherNodeIdentityIdOverride !== undefined ? { publisherNodeIdentityIdOverride } : {}),
  };
}

function parseShareEntities(opts: ActionOpts): string[] | undefined {
  if (!opts.entity || opts.entity.length === 0) return undefined;
  return opts.entity.map(String);
}

function parseShareJobStates(raw: unknown): KnowledgeAssetShareJobState[] | undefined {
  if (raw === undefined) return undefined;
  const states = String(raw)
    .split(',')
    .map((state) => state.trim())
    .filter(Boolean);
  const invalid = states.filter((state) => !SHARE_JOB_STATES.includes(state as KnowledgeAssetShareJobState));
  if (invalid.length > 0) {
    throw new Error(`Invalid share job state: ${invalid.join(', ')}. Allowed: ${SHARE_JOB_STATES.join(', ')}`);
  }
  return states as KnowledgeAssetShareJobState[];
}

function printJsonOrObject(result: unknown, opts: ActionOpts): void {
  if (opts.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }
  console.log(JSON.stringify(result, null, 2));
}

function addContextGraphOption(command: Command): Command {
  return command
    .option('-c, --context-graph-id <id>', 'Target context graph')
    .option('--context-graph <id>', 'Deprecated alias for --context-graph-id');
}

function addSubGraphOption(command: Command): Command {
  return command
    .option('--sub-graph-name <name>', 'Target registered sub-graph inside the context graph')
    .option('--sub-graph <name>', 'Deprecated alias for --sub-graph-name');
}

function addQuadInputOptions(command: Command): Command {
  return command
    .option('-f, --input-file <path>', 'Path to RDF input file for local payload quads')
    .option('--file <path>', 'Deprecated alias for --input-file')
    .option('--format <format>', 'Input RDF format override for --input-file')
    .option('--triples <json>', 'JSON array of {subject,predicate,object,graph?} quads')
    .option('--subject <iri>', 'Single-quad subject IRI')
    .option('--predicate <iri>', 'Single-quad predicate IRI')
    .option('--object <term>', 'Single-quad object literal or IRI');
}

function addFinalizeAuthorOptions(command: Command): Command {
  return command
    .option('--author-agent-address <address>', 'Author agent EVM address for the seal')
    .option('--pre-signed-author-attestation <json-or-path>', 'Pre-signed AuthorAttestation JSON or file')
    .option('--scheme-version <n>', 'Author attestation scheme version');
}

function addPublishOptions(command: Command): Command {
  return command
    .option('--publish-epochs <count>', 'On-chain publish lifetime in epochs')
    .option('--publisher-node-identity-id <id>', 'Publisher node identity id override');
}

function publishNextCommand(name: string, contextGraphId: string, opts: ActionOpts): string {
  return `dkg ka publish-async ${name} --context-graph-id ${contextGraphId}${subGraphName(opts) ? ` --sub-graph-name ${subGraphName(opts)}` : ''}`;
}

function assertSharePromotedContent(result: KnowledgeAssetShareResponse, name: string, contextGraphId: string): void {
  assertNoLifecycleErrors(result, `Knowledge asset share completed partially for "${name}" in ${contextGraphId}`);
  if (result.swmShared !== true) {
    throw new Error(`Knowledge asset share for "${name}" in ${contextGraphId} did not report swmShared:true; VM publish is not ready`);
  }
}

function assertOneShotShareComplete(result: KnowledgeAssetCreateResponse, name: string, contextGraphId: string): void {
  const prefix = `Knowledge asset create/share completed partially for "${name}" in ${contextGraphId}`;
  assertNoLifecycleErrors(result, prefix);
  if (result.swmShared !== true) {
    throw new Error(`${prefix}: missing swmShared:true. Retry with dkg ka share after inspecting the draft`);
  }
  if (result.publishReady === false) {
    throw new Error(`${prefix}: publishReady=false. Finalize or re-share before VM publish`);
  }
}

function assertPublishComplete(result: KnowledgeAssetPublishResponse, name: string, contextGraphId: string): void {
  assertNoLifecycleErrors(result, `Knowledge asset VM publish completed partially for "${name}" in ${contextGraphId}`);
  if (result.error) {
    throw new Error(`Knowledge asset VM publish completed partially for "${name}" in ${contextGraphId}: ${result.error}`);
  }
  if (result.contextGraphError !== undefined) {
    const contextError = formatLifecycleDetail(result.contextGraphError);
    const locator = result.ual ? ` UAL: ${result.ual}.` : '';
    throw new Error(
      `Knowledge asset VM publish completed partially for "${name}" in ${contextGraphId}: on-chain publish succeeded, ` +
        `but context graph binding failed: ${contextError}.${locator}`,
    );
  }
}

function assertNoLifecycleErrors(result: { errors?: unknown }, prefix: string): void {
  const errors = Array.isArray(result.errors) ? result.errors : [];
  if (errors.length > 0) {
    throw new Error(`${prefix}: ${errors.map(formatLifecycleDetail).join('; ')}`);
  }
}

function formatLifecycleDetail(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const parts = [
      typeof record.phase === 'string' ? `phase=${record.phase}` : undefined,
      typeof record.code === 'string' ? `code=${record.code}` : undefined,
      typeof record.message === 'string' ? record.message : undefined,
      typeof record.error === 'string' ? record.error : undefined,
    ].filter(Boolean);
    if (parts.length > 0) return parts.join(' ');
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

async function runAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (err) {
    console.error(toErrorMessage(err));
    process.exit(1);
  }
}

export function registerKnowledgeAssetCommand(program: Command): void {
  const kaCmd = program
    .command('knowledge-asset')
    .alias('ka')
    .description('Knowledge Asset lifecycle commands');

  addFinalizeAuthorOptions(addSubGraphOption(addQuadInputOptions(addContextGraphOption(
    kaCmd
      .command('create <name>')
      .description('Create a Knowledge Asset WM draft, optionally write/finalize/share in one call')
      .option('--no-finalize', 'Leave the WM draft editable when writing payload quads')
      .option('--share', 'After writing and finalizing payload quads, share the KA from WM to SWM')
      .option('--await-curator-ack', 'Require curator acknowledgement when --share is used'),
  ))))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const contextGraphId = requiredContextGraphId(opts);
      const quads = hasQuadInput(opts) ? await loadWritableQuads(opts) : undefined;
      if (opts.share === true && (!quads || quads.length === 0 || opts.finalize === false)) {
        throw new Error('--share requires non-empty payload quads and finalize enabled');
      }
      const authorOptions = parseFinalizeAuthorOptions(opts);
      const client = await ApiClient.connect();
      const createOptions: KnowledgeAssetCreateOptions = {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
        ...(quads ? { quads } : {}),
        ...(opts.finalize === false ? { finalize: false } : {}),
        ...authorOptions,
        ...(opts.share === true ? { alsoShareSwm: true } : {}),
        ...(opts.awaitCuratorAck === true ? { awaitCuratorAck: true } : {}),
      };
      const result = await client.createKnowledgeAsset(contextGraphId, name, createOptions);
      if (opts.share === true) assertOneShotShareComplete(result, name, contextGraphId);
      console.log('Knowledge asset create complete:');
      console.log(`  Name:           ${name}`);
      console.log(`  Context graph:  ${contextGraphId}`);
      if (quads) console.log(`  Written:        ${quads.length}`);
      if (result.status) console.log(`  Status:         ${result.status}`);
      if (result.assertionUri) console.log(`  Assertion URI:  ${result.assertionUri}`);
      if (result.merkleRoot) console.log(`  Merkle root:    ${result.merkleRoot}`);
      if (result.shareOperationId) console.log(`  Share op:       ${result.shareOperationId}`);
      if (opts.share === true && result.promotedCount === 0) {
        console.log('  Note:           No new triples promoted; the KA may already be shared.');
      }
    }));

  addSubGraphOption(addQuadInputOptions(addContextGraphOption(
    kaCmd
      .command('write <name>')
      .description('Write RDF payload quads into a Knowledge Asset WM draft'),
  )))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const contextGraphId = requiredContextGraphId(opts);
      const quads = await loadWritableQuads(opts);
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetWrite(contextGraphId, name, quads, {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
      });
      console.log('Knowledge asset write complete:');
      console.log(`  Name:           ${name}`);
      console.log(`  Context graph:  ${contextGraphId}`);
      console.log(`  Written:        ${result.written ?? quads.length}`);
    }));

  addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('import-file <name>')
      .description('Import a local document into a Knowledge Asset WM draft via extraction')
      .option('-f, --input-file <path>', 'Path to the source document')
      .option('--file <path>', 'Deprecated alias for --input-file')
      .option('--content-type <type>', 'Override detected upload content type')
      .option('--ontology-ref <uri>', 'Context graph _ontology URI for guided extraction'),
  ))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const contextGraphId = requiredContextGraphId(opts);
      const filePath = inputFilePath(opts);
      if (!filePath) throw new Error('Missing required option: --input-file <path>');
      const client = await ApiClient.connect();
      const result = await client.importAssertionFile(name, {
        filePath,
        contextGraphId,
        contentType: opts.contentType,
        ontologyRef: opts.ontologyRef,
        subGraphName: subGraphName(opts),
      });
      console.log('Knowledge asset import complete:');
      console.log(`  Name:                  ${name}`);
      console.log(`  Assertion URI:         ${result.assertionUri}`);
      console.log(`  File hash:             ${result.fileHash}`);
      if (result.detectedContentType) console.log(`  Detected content type: ${result.detectedContentType}`);
      if (result.extraction?.status) console.log(`  Extraction status:     ${result.extraction.status}`);
      if (typeof result.extraction?.tripleCount === 'number') console.log(`  Triples:               ${result.extraction.tripleCount}`);
    }));

  addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('extraction-status <name>')
      .description('Show latest extraction status for an imported Knowledge Asset document'),
  ))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const client = await ApiClient.connect();
      const result = await client.assertionExtractionStatus(name, requiredContextGraphId(opts), subGraphName(opts));
      console.log(`Extraction status for "${name}":`);
      if (result.assertionUri) console.log(`  Assertion URI:  ${result.assertionUri}`);
      if (result.fileHash) console.log(`  File hash:      ${result.fileHash}`);
      console.log(`  Status:         ${result.status ?? 'unknown'}`);
      if (result.pipelineUsed) console.log(`  Pipeline:       ${result.pipelineUsed}`);
      if (typeof result.tripleCount === 'number') console.log(`  Triples:        ${result.tripleCount}`);
      if (result.mdIntermediateHash) console.log(`  Markdown hash:  ${result.mdIntermediateHash}`);
      if (result.error) console.log(`  Error:          ${result.error}`);
    }));

  addFinalizeAuthorOptions(addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('finalize <name>')
      .description('Finalize/seal a Knowledge Asset from WM, or from SWM with --layer swm')
      .option('--layer <layer>', 'Layer to finalize: wm or swm (default: wm)'),
  )))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const layer = opts.layer === undefined ? undefined : String(opts.layer);
      if (layer !== undefined && layer !== 'wm' && layer !== 'swm') {
        throw new Error('--layer must be wm or swm');
      }
      const authorOptions = parseFinalizeAuthorOptions(opts);
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetFinalize(requiredContextGraphId(opts), name, {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
        ...(layer ? { layer } : {}),
        ...authorOptions,
      });
      console.log('Knowledge asset finalized:');
      console.log(`  Name:         ${name}`);
      console.log(`  Merkle root:  ${result.merkleRoot}`);
      console.log(`  Digest:       ${result.eip712Digest}`);
    }));

  addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('share <name>')
      .description('Share a finalized Knowledge Asset from WM to SWM')
      .option('--entity <uri...>', 'Share only specific root entities (defaults to all)')
      .option('--await-curator-ack', 'Require curator acknowledgement')
      .option('--skip-seal', 'Share without sealing; not publishable until finalized/sealed later'),
  ))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const contextGraphId = requiredContextGraphId(opts);
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetShare(contextGraphId, name, {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
        ...(parseShareEntities(opts) ? { entities: parseShareEntities(opts) } : {}),
        ...(opts.awaitCuratorAck === true ? { awaitCuratorAck: true } : {}),
        ...(opts.skipSeal === true ? { skipSeal: true } : {}),
      });
      assertSharePromotedContent(result, name, contextGraphId);
      console.log('Knowledge asset shared to SWM:');
      console.log(`  Name:           ${name}`);
      console.log(`  Context graph:  ${contextGraphId}`);
      console.log(`  Triples:        ${result.promotedCount}`);
      if (result.promotedCount === 0) console.log('  Note:           No new triples promoted; the KA may already be shared.');
      if (result.sealed !== undefined) console.log(`  Sealed:         ${result.sealed}`);
      if (result.publishReady !== undefined) console.log(`  Publish ready:  ${result.publishReady}`);
      if (result.shareOperationId) console.log(`  Share op:       ${result.shareOperationId}`);
      if (result.publishReady === true) console.log(`  Next:           ${publishNextCommand(name, contextGraphId, opts)}`);
    }));

  addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('share-async <name>')
      .description('Enqueue an async WM-to-SWM share job for a Knowledge Asset')
      .option('--entity <uri...>', 'Share only specific root entities (defaults to all)'),
  ))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetShareAsync(requiredContextGraphId(opts), name, {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
        ...(parseShareEntities(opts) ? { entities: parseShareEntities(opts) } : {}),
      });
      console.log('Knowledge asset share job accepted:');
      console.log(`  Job ID:  ${result.jobId}`);
      console.log(`  State:   ${result.state}`);
    }));

  addContextGraphOption(
    kaCmd
      .command('share-jobs')
      .description('List async SWM share jobs')
      .option('--state <state>', `Comma-separated state filter (${SHARE_JOB_STATES.join('|')})`)
      .option('--limit <n>', 'Maximum jobs to return (1-1000)')
      .option('--json', 'Print JSON'),
  )
    .action(async (opts: ActionOpts) => runAction(async () => {
      const limit = parseOptionalPositiveInteger(opts.limit, '--limit');
      const states = parseShareJobStates(opts.state);
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetShareJobs({
        ...(opts.contextGraphId || opts.contextGraph ? { contextGraphId: requiredContextGraphId(opts) } : {}),
        ...(states ? { state: states } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.jobs.length === 0) {
        console.log('No Knowledge Asset share jobs found.');
        return;
      }
      for (const job of result.jobs) {
        console.log(`${job.jobId}\t${job.state}\t${job.contextGraphId}\t${job.assertionName}`);
      }
    }));

  kaCmd
    .command('share-job <job-id>')
    .description('Show async SWM share job details')
    .option('--json', 'Print JSON')
    .action(async (jobId: string, opts: ActionOpts) => runAction(async () => {
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetShareJob(jobId);
      printJsonOrObject(result, opts);
    }));

  kaCmd
    .command('cancel-share-job <job-id>')
    .description('Cancel a queued or retrying async SWM share job')
    .action(async (jobId: string) => runAction(async () => {
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetCancelShareJob(jobId);
      console.log(`Cancelled share job ${result.jobId}; state=${result.state}`);
    }));

  kaCmd
    .command('recover-share-job <job-id>')
    .description('Recover a failed async SWM share job')
    .action(async (jobId: string) => runAction(async () => {
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetRecoverShareJob(jobId);
      console.log(`Recovered share job ${result.jobId}; state=${result.state}`);
    }));

  addPublishOptions(addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('publish <name>')
      .description('Publish an already finalized and fully shared Knowledge Asset from SWM to VM')
      .option('--json', 'Print JSON'),
  )))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const contextGraphId = requiredContextGraphId(opts);
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetPublish(contextGraphId, name, {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
        ...parsePublishOptions(opts),
      });
      assertPublishComplete(result, name, contextGraphId);
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log('Knowledge asset VM publish complete:');
      console.log(`  Name:    ${name}`);
      if (result.kaId) console.log(`  KA ID:   ${result.kaId}`);
      if (result.ual) console.log(`  UAL:     ${result.ual}`);
      if (result.txHash) console.log(`  Tx hash: ${result.txHash}`);
      if (result.status) console.log(`  Status:  ${result.status}`);
    }));

  addPublishOptions(addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('publish-async <name>')
      .description('Enqueue VM publish for an already finalized and fully shared Knowledge Asset')
      .option('--json', 'Print JSON'),
  )))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const contextGraphId = requiredContextGraphId(opts);
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetPublishAsync(contextGraphId, name, {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
        ...parsePublishOptions(opts),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log('Knowledge asset publish job accepted:');
      console.log(`  Job ID:     ${result.jobId}`);
      console.log(`  Context:    ${contextGraphId}`);
      console.log(`  Name:       ${name}`);
      console.log(`  Status:     ${result.status}`);
      if (result.shareOperationId) console.log(`  Share op:   ${result.shareOperationId}`);
      if (result.intentKey) console.log(`  Intent key: ${result.intentKey}`);
    }));

  addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('pull-from <name>')
      .description('Seed a fresh WM draft from SWM or VM state')
      .requiredOption('--layer <layer>', 'Source layer: swm or vm')
      .option('--on-conflict <mode>', 'Draft conflict mode: reject or replace (default: reject)')
      .option('--json', 'Print JSON'),
  ))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const layer = String(opts.layer);
      if (layer !== 'swm' && layer !== 'vm') throw new Error('--layer must be swm or vm');
      const onConflict = opts.onConflict === undefined ? undefined : String(opts.onConflict);
      if (onConflict !== undefined && onConflict !== 'reject' && onConflict !== 'replace') {
        throw new Error('--on-conflict must be reject or replace');
      }
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetPullFrom(requiredContextGraphId(opts), name, layer, {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
        ...(onConflict ? { onConflict } : {}),
      });
      printJsonOrObject(result, opts);
    }));

  addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('discard <name>')
      .description('Discard a Knowledge Asset WM draft')
      .option('--json', 'Print JSON'),
  ))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const client = await ApiClient.connect();
      const result = await client.knowledgeAssetDiscard(requiredContextGraphId(opts), name, {
        ...(subGraphName(opts) ? { subGraphName: subGraphName(opts) } : {}),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      console.log(`Knowledge asset draft discarded: ${result.discarded ? 'yes' : 'no'}`);
    }));

  addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('query <name>')
      .description('Inspect WM quads for a Knowledge Asset')
      .option('--json', 'Print JSON instead of N-Quads-like lines'),
  ))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const client = await ApiClient.connect();
      const result = await client.queryAssertion(name, {
        contextGraphId: requiredContextGraphId(opts),
        subGraphName: subGraphName(opts),
      });
      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
        return;
      }
      if (result.count === 0) {
        console.log(`No quads found for Knowledge Asset "${name}".`);
        return;
      }
      for (const quad of result.quads) {
        console.log(`<${quad.subject}> <${quad.predicate}> ${formatQuadObject(quad.object)} <${quad.graph}> .`);
      }
      console.log(`\n${result.count} quad(s)`);
    }));

  addSubGraphOption(addContextGraphOption(
    kaCmd
      .command('history <name>')
      .alias('status')
      .description('Show Knowledge Asset lifecycle state/history descriptor')
      .option('--agent-address <address>', 'Read descriptor for a specific agent address')
      .option('--json', 'Print JSON'),
  ))
    .action(async (name: string, opts: ActionOpts) => runAction(async () => {
      const client = await ApiClient.connect();
      const result = await client.getKnowledgeAsset(
        requiredContextGraphId(opts),
        name,
        subGraphName(opts),
        opts.agentAddress ? String(opts.agentAddress) : undefined,
      );
      printJsonOrObject(result, opts);
    }));
}
