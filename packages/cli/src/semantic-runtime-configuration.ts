import { canonicalizeJson, type CanonicalJsonValue } from '@origintrail-official/dkg-core';
import type { ProgramConfigurationRecord, SemanticProgramBinding, SemanticRuntimeConfig, SemanticRuntimeStore } from '@origintrail-official/dkg-semantic-runtime';

import { programBindingDigest, validateProgramBindings, validateProgramRoutes } from './semantic-runtime-program-bindings.js';

type Route = NonNullable<SemanticRuntimeConfig['programRoutes']>[number];
type Kind = ProgramConfigurationRecord['kind'];
const key = (graph: string, operation: string) => JSON.stringify([graph, operation]);

/** File entries are defaults. Durable API entries (including revocations) win. */
export class SemanticProgramConfiguration {
  private readonly fileBindings: SemanticProgramBinding[];
  private readonly fileRoutes: Route[];
  private records: ProgramConfigurationRecord[];

  constructor(private readonly store: SemanticRuntimeStore, private readonly config: SemanticRuntimeConfig) {
    this.fileBindings = config.programBindings ?? [];
    this.fileRoutes = config.programRoutes ?? [];
    validateProgramBindings(this.fileBindings);
    validateProgramRoutes(this.fileRoutes);
    this.records = store.programConfigurationRecords();
    this.publish(this.merge(this.records));
  }

  inspect(kind: Kind, graph: string, operation: string) {
    const record = this.records.find((item) => item.kind === kind && item.contextGraphId === graph && item.operationIri === operation);
    const value = kind === 'binding'
      ? this.config.programBindings?.find((item) => item.contextGraphId === graph && item.operationIri === operation)
      : this.config.programRoutes?.find((item) => item.contextGraphId === graph && item.operationIri === operation);
    if (!record && !value) return undefined;
    return {
      contextGraphId: graph, operationIri: operation, origin: record ? 'api' : 'configuration-file',
      revision: record?.revision ?? 0,
      ...(record ? { updatedBy: record.updatedBy, updatedAt: record.updatedAt } : {}),
      ...(kind === 'binding' ? {
        binding: structuredClone(value as SemanticProgramBinding),
        bindingDigest: programBindingDigest(value as SemanticProgramBinding),
      } : { route: value ? structuredClone(value) as Route : null }),
    };
  }

  list(kind: Kind, graph: string) {
    const values = kind === 'binding' ? this.config.programBindings : this.config.programRoutes;
    const operations = new Set([
      ...(values ?? []).filter((entry) => entry.contextGraphId === graph).map((entry) => entry.operationIri),
      ...this.records.filter((entry) => entry.kind === kind && entry.contextGraphId === graph).map((entry) => entry.operationIri),
    ]);
    return [...operations].sort().map((operation) => this.inspect(kind, graph, operation)!);
  }

  write(kind: Kind, graph: string, operation: string, value: SemanticProgramBinding | Route | null, expectedRevision: number, updatedBy: string) {
    const current = this.inspect(kind, graph, operation);
    if ((current?.revision ?? 0) !== expectedRevision) throw new Error('PROGRAM_CONFIGURATION_CONFLICT');
    const effective = kind === 'binding' && value ? { ...value, authorizationRevision: expectedRevision + 1 } : value;
    const record: ProgramConfigurationRecord = {
      kind, contextGraphId: graph, operationIri: operation, revision: expectedRevision + 1,
      payload: effective === null ? null : canonicalizeJson(effective as unknown as CanonicalJsonValue, { maxBytes: 262_144 }),
      updatedBy, updatedAt: Date.now(),
    };
    const next = this.records.filter((item) => !(item.kind === kind && item.contextGraphId === graph && item.operationIri === operation));
    next.push(record);
    const merged = this.merge(next); // Validate the complete effective authority before the commit.
    this.store.writeProgramConfiguration(record, expectedRevision);
    this.records = next;
    this.publish(merged); // No await between durable commit and the runtime's authority change.
    return this.inspect(kind, graph, operation)!;
  }

  private merge(records: ProgramConfigurationRecord[]) {
    const bindings = new Map(this.fileBindings.map((entry) => [key(entry.contextGraphId, entry.operationIri), entry]));
    const routes = new Map(this.fileRoutes.map((entry) => [key(entry.contextGraphId, entry.operationIri), entry]));
    for (const record of records) {
      const id = key(record.contextGraphId, record.operationIri);
      const value = record.payload === null ? null : JSON.parse(record.payload);
      if (value && (value.contextGraphId !== record.contextGraphId || value.operationIri !== record.operationIri)) throw new Error('PROGRAM_CONFIGURATION_ID_MISMATCH');
      if (record.kind === 'binding') {
        if (!value || value.authorizationRevision !== record.revision) throw new Error('PROGRAM_CONFIGURATION_REVISION_MISMATCH');
        validateProgramBindings([value]); bindings.set(id, value);
      } else if (value) { validateProgramRoutes([value]); routes.set(id, value); }
      else routes.delete(id);
    }
    const result = { bindings: [...bindings.values()], routes: [...routes.values()] };
    validateProgramBindings(result.bindings); validateProgramRoutes(result.routes);
    return result;
  }

  private publish(value: { bindings: SemanticProgramBinding[]; routes: Route[] }) {
    this.config.programBindings = value.bindings;
    this.config.programRoutes = value.routes;
  }
}
