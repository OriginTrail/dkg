import { executionTrace } from './trace.js';
import { getAddress } from 'ethers';
import { GraphComputerError } from './errors.js';
import { canonicalInputs } from './inputs.js';
import { createUuid } from './uuid.js';
import { sha256, signInvocation } from './signing.js';
import { assertPeer, integer, isRecord, Transport } from './transport.js';
import type {
  Approval, ApproveProgram, Execution, GraphComputerOptions, InvokeProgram, JsonValue, Operation,
  PreparedInvocation, ProgramRoute, RequestOptions, RevisionedOperation, Route, UploadedProgram, UploadProgram, StoredProgram,
} from './types.js';

export { GraphComputerError } from './errors.js';
export { createUuid } from './uuid.js';
export type * from './types.js';

const SR = 'https://origintrail.io/semantic-runtime/v1#';
const BINDINGS = '/api/programs/bindings';
const ROUTES = '/api/programs/routes';

/** Browser/Node.js SDK. Use an external signer or explicitly select an agent held by the authenticated node. */
export class GraphComputer {
  readonly programs: Programs;
  readonly routes: Routes;

  constructor(options: GraphComputerOptions) {
    const transport = new Transport({ ...options });
    this.programs = new Programs(transport);
    this.routes = new Routes(transport);
  }
}

class Programs {
  constructor(private readonly transport: Transport) {}

  async getSource(input: { graphId: string; programIri: string; programLayer: 'wm' | 'swm' | 'vm' }, options: RequestOptions = {}): Promise<StoredProgram> {
    const params = new URLSearchParams({ contextGraphId: graph(input.graphId), programIri: iri(input.programIri), programLayer: input.programLayer });
    const value = await this.transport.request('/api/programs/source?' + params, { ...options, retry: true });
    if (!isRecord(value) || value.contextGraphId !== graph(input.graphId) || value.programIri !== input.programIri || value.layer !== input.programLayer
      || typeof value.source !== 'string' || typeof value.authorAgentAddress !== 'string'
      || (value.label !== undefined && typeof value.label !== 'string')
      || typeof value.version !== 'string' || !['sexpr-v1', 'typescript-v1'].includes(String(value.language))
      || !Array.isArray(value.requiredTools) || !value.requiredTools.every(v => typeof v === 'string')
      || !Array.isArray(value.permittedPrograms) || !value.permittedPrograms.every(v => typeof v === 'string')) invalidResponse();
    return { ...value, sourceHash: sha256(value.source) } as unknown as StoredProgram;
  }

  /** Store and finalize source in private Working Memory. Does not approve or share it. */
  async upload(input: UploadProgram, options: RequestOptions = {}): Promise<UploadedProgram> {
    const graphId = graph(input.graphId);
    if (typeof input.source !== 'string' || !input.source.trim()) throw new TypeError('Program source is required');
    if (!Array.isArray(input.requiredTools)) throw new TypeError('requiredTools must be an array of tool IRIs');
    const language = input.language ?? 'sexpr-v1';
    if (!['sexpr-v1', 'typescript-v1'].includes(language)) throw new TypeError('Unsupported Program language');
    if (input.permittedPrograms !== undefined && !Array.isArray(input.permittedPrograms)) throw new TypeError('permittedPrograms must be an array');
    const requestedPermissions = input.requestedPermissions === undefined ? undefined : JSON.stringify({
      ...input.requestedPermissions, graphId: graph(input.requestedPermissions.graphId),
    });
    if (requestedPermissions && new TextEncoder().encode(requestedPermissions).length > 65536) throw new TypeError('Requested permissions exceed 64 KiB');
    const id = createUuid();
    const programIri = iri(input.programIri ?? `urn:dkg:program:${id}`);
    const name = input.name ?? `program-${id}`;
    const version = input.version ?? '1.0.0';
    if (!name || !version) throw new TypeError('Program name and version must be non-empty');
    const sourceHash = sha256(input.source);
    const quad = (predicate: string, object: string) => ({ subject: programIri, predicate, object });
    const payload = {
      contextGraphId: graphId, name, finalize: true, alsoShareSwm: false, alsoPublishVm: false,
      quads: [
        quad('http://www.w3.org/1999/02/22-rdf-syntax-ns#type', `${SR}Program`),
        quad('http://www.w3.org/2000/01/rdf-schema#label', JSON.stringify(input.label ?? name)),
        quad(`${SR}language`, JSON.stringify(language)),
        quad(`${SR}version`, JSON.stringify(version)),
        quad(`${SR}source`, JSON.stringify(input.source)),
        ...(requestedPermissions ? [quad(`${SR}requestedToolPermissions`, JSON.stringify(requestedPermissions))] : []),
        ...[...new Set(input.requiredTools)].map(tool => quad(`${SR}requiresTool`, iri(tool))),
        ...[...new Set(input.permittedPrograms ?? [])].map(program => quad(`${SR}permitsProgram`, iri(program))),
        ...(input.derivedFrom ? [quad('http://www.w3.org/ns/prov#wasDerivedFrom', iri(input.derivedFrom))] : []),
      ],
    };
    let authorAgentAddress = '';
    const asset = await this.transport.request('/api/knowledge-assets', {
      ...options, method: 'POST', body: address => { authorAgentAddress = address; return this.transport.options.localAgent ? { ...payload, authorAgentAddress: address } : payload; },
    });
    if (!isRecord(asset) || asset.status !== 'wm-sealed' || typeof asset.assertionUri !== 'string'
      || typeof asset.authorAddress !== 'string' || asset.authorAddress.toLowerCase() !== authorAgentAddress.toLowerCase()) {
      throw new GraphComputerError('INVALID_RESPONSE', 'Program upload did not return a sealed asset with the expected author', { details: asset });
    }
    return { graphId, programIri, programLayer: 'wm', authorAgentAddress, sourceHash, name, asset };
  }

  /** Explicit owner approval; the server validates source, tool grants, caller and executor. */
  approve(input: ApproveProgram, options: RequestOptions = {}): Promise<Approval> {
    return this.writeApproval('POST', input, undefined, options);
  }

  updateApproval(input: ApproveProgram & { expectedRevision: number }, options: RequestOptions = {}): Promise<Approval> {
    revision(input.expectedRevision);
    return this.writeApproval('PUT', input, input.expectedRevision, options);
  }

  async getApproval(input: Operation, options: RequestOptions = {}): Promise<Approval> {
    return approval(await this.transport.request(BINDINGS + query(input), { ...options, retry: true }));
  }

  async listApprovals(input: { graphId: string }, options: RequestOptions = {}): Promise<Approval[]> {
    const value = await this.transport.request(BINDINGS + query(input), { ...options, retry: true });
    if (!Array.isArray(value)) invalidResponse();
    return value.map(approval);
  }

  async revoke(input: RevisionedOperation, options: RequestOptions = {}): Promise<Approval> {
    const payload = { ...operation(input), expectedRevision: revision(input.expectedRevision) };
    return approval(await this.transport.request(BINDINGS, { ...options, method: 'DELETE', body: () => payload }));
  }

  /** Produces a serializable recovery handle without signing or sending a request. */
  prepareInvocation(input: InvokeProgram): PreparedInvocation {
    if (Object.keys(input).some(key => !['graphId', 'operationIri', 'invocationId', 'executorPeerId', 'inputs'].includes(key))) {
      throw new TypeError('Unsupported invocation field');
    }
    const value: PreparedInvocation = {
      graphId: graph(input.graphId), operationIri: iri(input.operationIri),
      invocationId: input.invocationId ?? createUuid(),
      executorPeerId: input.executorPeerId ?? this.transport.options.executorPeerId,
      ...(input.inputs !== undefined ? { inputs: JSON.parse(canonicalInputs(input.inputs)) } : {}),
    };
    if (typeof value.invocationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.invocationId)) {
      throw new TypeError('invocationId must be a UUID');
    }
    value.invocationId = value.invocationId.toLowerCase();
    if (value.executorPeerId !== undefined) {
      assertPeer(value.executorPeerId);
      if (this.transport.options.localAgent && value.executorPeerId !== this.transport.options.peerId)
        throw new TypeError('Local-agent remote execution uses the node configured route; omit executorPeerId');
    }
    return value;
  }

  async invoke(input: InvokeProgram, options: RequestOptions = {}): Promise<Execution> {
    const invocation = this.prepareInvocation(input);
    const value = await this.transport.request('/api/programs/execute', {
      ...options, method: 'POST', retry: true, invocationId: invocation.invocationId,
      body: async address => ({
        ...operation(invocation), invocationId: invocation.invocationId,
        ...(invocation.inputs !== undefined ? { inputs: invocation.inputs } : {}),
        ...(invocation.executorPeerId && invocation.executorPeerId !== this.transport.options.peerId
          ? { authorization: await signInvocation(this.transport.options.signer!, address, this.transport.options.peerId, invocation) }
          : {}),
      }),
    });
    if (!isRecord(value) || value.invocationId !== invocation.invocationId
      || value.executionIri !== `urn:sr:execution:${invocation.invocationId}` || value.persisted !== true
      || !['wm', 'swm', 'vm'].includes(String(value.executionLayer))
      || (value.outputs !== undefined && (!Array.isArray(value.outputs) || !value.outputs.every(v => typeof v === 'string')))
      || (value.executionUal !== undefined && typeof value.executionUal !== 'string')) {
      throw new GraphComputerError('INVALID_RESPONSE', 'Execution receipt does not match this invocation or is not persisted', {
        invocationId: invocation.invocationId, details: value,
      });
    }
    let trace;
    try { trace = executionTrace(value.trace, value.executionIri as string); }
    catch { throw new GraphComputerError('INVALID_RESPONSE', 'Execution trace does not match this invocation', { invocationId: invocation.invocationId }); }
    const rawOutputs = (value.outputs ?? []) as string[];
    return {
      invocationId: invocation.invocationId, executionIri: value.executionIri as string,
      executionLayer: value.executionLayer as Execution['executionLayer'], persisted: true,
      ...(value.executionUal ? { executionUal: value.executionUal as string } : {}),
      ...(trace ? { trace } : {}),
      rawOutputs,
      outputs: rawOutputs.map(output => { try { return JSON.parse(output) as JsonValue; } catch { return output; } }),
    };
  }

  private async writeApproval(method: 'POST' | 'PUT', input: ApproveProgram, expectedRevision: number | undefined, options: RequestOptions): Promise<Approval> {
    const program = input.program;
    if (!/^[0-9a-f]{64}$/.test(program.sourceHash)) throw new TypeError('Program sourceHash must be a SHA-256 hex digest');
    if (!['wm', 'swm', 'vm'].includes(program.programLayer)) throw new TypeError('Invalid Program layer');
    if (!input.query && !input.sparqlRead && !input.assetCreation && !input.typescript) throw new TypeError('Explicit Program permission is required');
    const binding = {
      ...operation(input),
      allowedCallerAgentAddresses: input.allowedCallers.map(getAddress),
      program: { contextGraphId: graph(program.graphId), programIri: iri(program.programIri),
        sourceHash: program.sourceHash, authorAgentAddress: getAddress(program.authorAgentAddress), programLayer: program.programLayer },
      executionLayer: input.executionLayer ?? 'wm',
      ...(input.query ? { query: input.query } : {}),
      ...(input.sparqlRead ? { sparqlRead: input.sparqlRead } : {}),
      ...(input.assetCreation ? { assetCreation: input.assetCreation } : {}),
      ...(input.typescript ? { typescript: { ...input.typescript, children: input.typescript.children.map(child => ({
        contextGraphId: graph(child.graphId), operationIri: iri(child.operationIri),
        ...(child.programIri ? { programIri: iri(child.programIri) } : {}),
        ...(child.bindingDigest ? { bindingDigest: child.bindingDigest } : {}),
      })) } } : {}),
    };
    // Snapshot the reviewed policy before asynchronous signing; never mutate caller input.
    const snapshot = JSON.stringify(binding);
    const executor = input.executorAgentAddress === undefined ? undefined : getAddress(input.executorAgentAddress);
    return approval(await this.transport.request(BINDINGS, {
      ...options, method, body: address => ({
        binding: { ...JSON.parse(snapshot), executorAgentAddress: executor ?? address },
        ...(expectedRevision !== undefined ? { expectedRevision } : {}),
      }),
    }));
  }
}

class Routes {
  constructor(private readonly transport: Transport) {}

  async create(input: ProgramRoute, options: RequestOptions = {}): Promise<Route> {
    return this.write('POST', input, undefined, options);
  }

  async update(input: ProgramRoute & { expectedRevision: number }, options: RequestOptions = {}): Promise<Route> {
    return this.write('PUT', input, revision(input.expectedRevision), options);
  }

  async get(input: Operation, options: RequestOptions = {}): Promise<Route> {
    return route(await this.transport.request(ROUTES + query(input), { ...options, retry: true }));
  }

  async list(input: { graphId: string }, options: RequestOptions = {}): Promise<Route[]> {
    const value = await this.transport.request(ROUTES + query(input), { ...options, retry: true });
    if (!Array.isArray(value)) invalidResponse();
    return value.map(route);
  }

  async remove(input: RevisionedOperation, options: RequestOptions = {}): Promise<Route> {
    const payload = { ...operation(input), expectedRevision: revision(input.expectedRevision) };
    return route(await this.transport.request(ROUTES, { ...options, method: 'DELETE', body: () => payload }));
  }

  private async write(method: 'POST' | 'PUT', input: ProgramRoute, expectedRevision: number | undefined, options: RequestOptions): Promise<Route> {
    assertPeer(input.targetPeerId);
    const payload = { route: { ...operation(input), targetPeerId: input.targetPeerId },
      ...(expectedRevision !== undefined ? { expectedRevision } : {}) };
    return route(await this.transport.request(ROUTES, { ...options, method, body: () => payload }));
  }
}

function graph(value: string): string {
  if (typeof value !== 'string') throw new TypeError('A canonical Context Graph ID is required');
  const id = value.trim().replace(/^did:dkg:context-graph:/, '');
  if (!/^[\w:/.@-]{1,256}$/.test(id) || id.split('/').some(part => part === '.' || part === '..')) {
    throw new TypeError('Invalid Context Graph ID');
  }
  return id;
}

function iri(value: string): string {
  if (typeof value !== 'string' || value.length > 2048 || !/^[a-z][a-z0-9+.-]*:/i.test(value)
    || /[\p{Cc}\s<>"{}|^`\\]/u.test(value)) throw new TypeError('An absolute IRI without unsafe characters is required');
  return value;
}

function operation(value: Operation) { return { contextGraphId: graph(value.graphId), operationIri: iri(value.operationIri) }; }
function revision(value: number) { return integer(value, 0, Number.MAX_SAFE_INTEGER, 'expectedRevision'); }
function query(value: { graphId: string; operationIri?: string }) {
  return '?' + new URLSearchParams({ contextGraphId: graph(value.graphId),
    ...(value.operationIri !== undefined ? { operationIri: iri(value.operationIri) } : {}) }).toString();
}
function invalidResponse(): never { throw new GraphComputerError('INVALID_RESPONSE', 'Invalid Program configuration response'); }
function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || !Number.isSafeInteger(value.revision) || (value.revision as number) < 0
    || typeof value.contextGraphId !== 'string' || typeof value.operationIri !== 'string') invalidResponse();
  return value;
}
function approval(value: unknown): Approval {
  const data = record(value);
  if (!isRecord(data.binding) || typeof data.bindingDigest !== 'string') invalidResponse();
  return data as unknown as Approval;
}
function route(value: unknown): Route {
  const data = record(value);
  if (data.route !== null && !isRecord(data.route)) invalidResponse();
  return data as unknown as Route;
}
