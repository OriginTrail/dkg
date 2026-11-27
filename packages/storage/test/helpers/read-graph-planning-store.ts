import { OxigraphStore } from '../../src/adapters/oxigraph.js';
import { sparqlStatements } from '../../src/adapters/sparql-statements.js';
import {
  spliceReadGraphPlan,
  type ReadGraphAdapterCapabilities,
  type ReadGraphWriteOptions,
} from '../../src/read-graph/adapter-contract.js';
import type { Quad, QueryOptions, UpdateOptions } from '../../src/triple-store.js';

/**
 * Embedded Oxigraph that sends each write it declares as one SPARQL update,
 * with the read-graph plan around it, as an adapter with read-graph support
 * does. It stands in for that adapter in tests of the layer's plans; each
 * adapter's own one-request forms are tested with the adapter. `requests`
 * records every update text it sends.
 */
export class PlanningOxigraphStore extends OxigraphStore {
  readonly readGraphCapabilities: ReadGraphAdapterCapabilities = Object.freeze({
    methods: Object.freeze([
      'delete', 'deleteByPattern', 'deleteByPatternWithoutCount', 'deleteBySubjectPrefix', 'dropGraph', 'replaceGraph',
      'replaceSubject', 'replaceSubjectAndInsert', 'update',
    ] as const),
    serialUpdates: true,
  });

  readonly requests: string[] = [];
  private readonly statements = sparqlStatements('oxigraph');

  override async delete(quads: Quad[], options?: QueryOptions): Promise<void> {
    const plan = this.statements.deleteData(quads);
    if (plan) await this.send(plan.update, options);
  }

  override async deleteByPattern(pattern: Partial<Quad>, options?: QueryOptions): Promise<number> {
    const before = await this.countQuads(pattern.graph);
    await this.send(this.statements.deleteByPattern(pattern).update, options);
    return before - await this.countQuads(pattern.graph);
  }

  override async deleteByPatternWithoutCount(pattern: Partial<Quad>, options?: QueryOptions): Promise<void> {
    await this.send(this.statements.deleteByPattern(pattern).update, options);
  }

  override async deleteBySubjectPrefix(graph: string, prefix: string, options?: QueryOptions): Promise<number> {
    const before = await this.countQuads(graph);
    await this.send(this.statements.deleteBySubjectPrefix(graph, prefix).update, options);
    return before - await this.countQuads(graph);
  }

  override async dropGraph(graph: string, options?: QueryOptions): Promise<void> {
    await this.send(this.statements.dropGraph(graph).update, options);
  }

  override async replaceGraph(graph: string, quads: Quad[], options?: QueryOptions): Promise<void> {
    await this.send(this.joined([this.statements.dropGraph(graph).update, ...this.inserted(quads)]), options);
  }

  override async replaceSubject(graph: string, subject: string, quads: Quad[], options?: QueryOptions): Promise<void> {
    await this.send(this.joined([this.subjectDeletion(graph, subject), ...this.inserted(quads)]), options);
  }

  override async replaceSubjectAndInsert(graph: string, subject: string, replacement: Quad[], inserts: Quad[], options?: QueryOptions): Promise<void> {
    await this.send(this.joined([this.subjectDeletion(graph, subject), ...this.inserted([...replacement, ...inserts])]), options);
  }

  override async update(sparql: string, options?: UpdateOptions): Promise<void> {
    await this.send(sparql, options);
  }

  override async insert(quads: Quad[], options?: QueryOptions): Promise<void> {
    if ((options as ReadGraphWriteOptions | undefined)?.readGraphPlan) throw new Error('An insert carries no read-graph plan');
    return super.insert(quads);
  }

  private async send(update: string, options: QueryOptions | undefined): Promise<void> {
    const text = spliceReadGraphPlan((options as ReadGraphWriteOptions | undefined)?.readGraphPlan, [update]);
    this.requests.push(text);
    await super.update(text);
  }

  private inserted(quads: readonly Quad[]): string[] {
    return quads.length === 0 ? [] : [this.statements.insertData(quads).update];
  }

  private subjectDeletion(graph: string, subject: string): string {
    return this.statements.deleteByPattern({ graph, subject }).update;
  }

  private joined(operations: readonly string[]): string {
    return operations.join(' ;\n');
  }
}
