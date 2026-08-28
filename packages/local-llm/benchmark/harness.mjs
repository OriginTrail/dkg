const MUTATION_ALLOWLIST = new Set([
  'dkg_context_graph_create',
  'dkg_sub_graph_create',
  'dkg_knowledge_asset_create',
  'dkg_knowledge_asset_write',
  'dkg_knowledge_asset_finalize',
  'dkg_query_catalog_save',
]);

const PROJECT_TOOLS = new Set([
  'dkg_sub_graph_list',
  'dkg_knowledge_asset_create',
  'dkg_knowledge_asset_write',
  'dkg_knowledge_asset_finalize',
  'dkg_knowledge_asset_query',
  'dkg_knowledge_asset_history',
  'dkg_query',
  'dkg_get_entity',
  'dkg_query_catalog_list',
  'dkg_query_catalog_run',
  'dkg_query_catalog_save',
]);

export function contentText(result) {
  return (result?.content ?? [])
    .map((item) => item?.type === 'text' ? item.text : JSON.stringify(item))
    .filter(Boolean)
    .join('\n');
}

export function resultFailed(result) {
  return Boolean(result?.isError);
}

export function validateBenchmarkCall(name, args, target, source = 'model') {
  const errors = [];
  if (name === 'dkg_context_graph_create' && args.id !== target.graphId) {
    errors.push(`id must equal ${target.graphId}`);
  }
  if (name === 'dkg_sub_graph_create' && args.contextGraphId !== target.graphId) {
    errors.push(`contextGraphId must equal ${target.graphId}`);
  }
  if (PROJECT_TOOLS.has(name) && args.projectId !== target.graphId) {
    errors.push(`projectId must equal ${target.graphId}`);
  }
  const assetMutation = ['dkg_knowledge_asset_create', 'dkg_knowledge_asset_write', 'dkg_knowledge_asset_finalize']
    .includes(name);
  const allowedAssetNames = source === 'model' && assetMutation
    ? [target.assetName]
    : [target.assetName, target.fixtureAssetName];
  if (name.startsWith('dkg_knowledge_asset_') && !allowedAssetNames.includes(args.name)) {
    errors.push(`name must equal ${allowedAssetNames.join(' or ')}`);
  }
  if (['dkg_knowledge_asset_create', 'dkg_knowledge_asset_write', 'dkg_knowledge_asset_finalize']
    .includes(name) && args.subGraphName !== 'model-families') {
    errors.push('subGraphName must equal model-families');
  }
  if (name === 'dkg_sub_graph_create'
    && !['model-families', 'model-capabilities'].includes(args.subGraphName)) {
    errors.push('subGraphName must be model-families or model-capabilities');
  }
  if (name === 'dkg_query_catalog_save' && args.subGraph !== 'model-families') {
    errors.push('subGraph must equal model-families');
  }
  return errors;
}

export function isAllowedBenchmarkMutation(name) {
  return MUTATION_ALLOWLIST.has(name);
}

export class GuardedBenchmarkMcp {
  constructor(delegate, target) {
    this.delegate = delegate;
    this.target = target;
    this.records = [];
  }

  async listTools() {
    return this.delegate.listTools();
  }

  async callTool(input) {
    return this.#call(input, 'model');
  }

  async callFixture(name, args) {
    const result = await this.#call({ name, arguments: args }, 'fixture');
    if (resultFailed(result)) {
      throw new Error(`Fixture ${name} failed: ${contentText(result)}`);
    }
    return result;
  }

  async #call(input, source) {
    const args = input.arguments ?? {};
    const started = performance.now();
    let result;
    const errors = validateBenchmarkCall(input.name, args, this.target, source);
    const mutating = /_(?:create|discard|finalize|import|publish|register|save|send|share|subscribe|write)(?:_|$)/
      .test(input.name);
    if (mutating && !isAllowedBenchmarkMutation(input.name)) {
      errors.push(`${input.name} is outside the benchmark mutation allowlist`);
    }
    if (errors.length) {
      result = {
        isError: true,
        content: [{ type: 'text', text: `Invalid benchmark arguments: ${errors.join('; ')}` }],
      };
    } else {
      try {
        result = await this.delegate.callTool(input);
      } catch (error) {
        result = {
          isError: true,
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        };
      }
    }
    this.records.push({
      sequence: this.records.length + 1,
      timestamp: new Date().toISOString(),
      source,
      name: input.name,
      args,
      isError: Boolean(result.isError),
      text: contentText(result),
      structuredContent: result.structuredContent,
      durationMs: performance.now() - started,
    });
    return result;
  }
}

export function modelCallsSince(mcp, offset) {
  return mcp.records.slice(offset).filter((record) => record.source === 'model');
}

export function successfulCalls(calls, name) {
  return calls.filter((call) => call.name === name && !call.isError);
}

export function modelAssetLifecyclePass(calls, target, minimumQuads = 10) {
  const creates = successfulCalls(calls, 'dkg_knowledge_asset_create')
    .filter((call) => call.args.name === target.assetName);
  const oneShot = creates.some((call) => Array.isArray(call.args.quads)
    && call.args.quads.length >= minimumQuads);
  if (oneShot) return true;
  const writes = successfulCalls(calls, 'dkg_knowledge_asset_write')
    .filter((call) => call.args.name === target.assetName
      && Array.isArray(call.args.quads)
      && call.args.quads.length >= minimumQuads);
  const finalized = successfulCalls(calls, 'dkg_knowledge_asset_finalize')
    .some((call) => call.args.name === target.assetName);
  return creates.length > 0 && writes.length > 0 && finalized;
}

export function phaseReport(phase, result, calls, error) {
  const passed = !error && phase.evaluate({ result, calls });
  return {
    id: phase.id,
    group: phase.group,
    prompt: phase.prompt,
    pass: passed,
    error: error ? (error instanceof Error ? error.message : String(error)) : null,
    answer: result?.answer ?? '',
    profile: result?.profile ?? null,
    toolCalls: calls,
  };
}

export function markdownReport(metadata, phases, verifications) {
  const passed = phases.filter((phase) => phase.pass).length;
  const verificationPassed = verifications.filter((item) => item.pass).length;
  const lines = [
    `# Real DKG local-LLM benchmark — ${metadata.label}`,
    '',
    `- Model: ${metadata.model}`,
    `- Context Graph: ${metadata.graphId}`,
    `- Endpoint: ${metadata.llamaUrl}`,
    `- System context: v${metadata.systemContextVersion}`,
    `- Scenarios: ${passed}/${phases.length} passed`,
    `- Independent DKG verification: ${verificationPassed}/${verifications.length} passed`,
    `- Interaction trace: ${metadata.traceFile}`,
    '',
    '| Scenario | Group | Pass | Tools |',
    '|---|---|---:|---|',
  ];
  for (const phase of phases) {
    lines.push(`| ${phase.id} | ${phase.group} | ${phase.pass ? 'yes' : 'no'} | ${phase.toolCalls.map((call) => call.name).join(', ') || 'none'} |`);
  }
  lines.push('', '## Independent verification', '');
  for (const item of verifications) lines.push(`- ${item.pass ? '[x]' : '[ ]'} ${item.name}${item.error ? ` — ${item.error}` : ''}`);
  const failures = phases.filter((phase) => !phase.pass);
  lines.push('', `## Scenario failures (${failures.length})`, '');
  if (!failures.length) lines.push('None.');
  for (const failure of failures) lines.push(`- **${failure.id}** — ${failure.error || 'expected tool/evidence condition was not met'}`);
  return `${lines.join('\n')}\n`;
}
