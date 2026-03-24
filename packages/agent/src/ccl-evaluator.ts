import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

export type CclFactTuple = [string, ...unknown[]];

export interface CclCanonicalPolicy {
  policy?: string;
  version?: string;
  rules?: Array<{
    name: string;
    params?: string[];
    all?: CclCondition[];
  }>;
  decisions?: Array<{
    name: string;
    params?: string[];
    all?: CclCondition[];
  }>;
}

export type CclCondition =
  | { atom: { pred: string; args?: unknown[] } }
  | { exists: { where?: CclCondition[] } }
  | { not_exists: { where?: CclCondition[] } }
  | { count_distinct: { vars?: string[]; where?: CclCondition[]; op: string; value: number } };

export interface CclEvaluationResult {
  derived: Record<string, unknown[][]>;
  decisions: Record<string, unknown[][]>;
}

export interface ValidateCclPolicyOptions {
  expectedName?: string;
  expectedVersion?: string;
}

type Binding = Record<string, unknown>;

function isVar(value: unknown): value is string {
  return typeof value === 'string' && value.startsWith('$');
}

function normalizeVarName(value: string): string {
  return value.startsWith('$') ? value : `$${value}`;
}

function tupleKey(tuple: unknown[]): string {
  return JSON.stringify(tuple);
}

function compareTuples(left: unknown[], right: unknown[]): number {
  return tupleKey(left).localeCompare(tupleKey(right));
}

export function parseCclPolicy(content: string): CclCanonicalPolicy {
  const parsed = yaml.load(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('CCL policy must be a YAML object');
  }
  return parsed as CclCanonicalPolicy;
}

export function validateCclPolicy(content: string, opts: ValidateCclPolicyOptions = {}): CclCanonicalPolicy {
  const policy = parseCclPolicy(content);
  if (!policy.policy || typeof policy.policy !== 'string') {
    throw new Error('CCL policy must define a string "policy" name');
  }
  if (!policy.version || typeof policy.version !== 'string') {
    throw new Error('CCL policy must define a string "version"');
  }
  if (opts.expectedName && policy.policy !== opts.expectedName) {
    throw new Error(`CCL policy name mismatch: expected ${opts.expectedName}, got ${policy.policy}`);
  }
  if (opts.expectedVersion && policy.version !== opts.expectedVersion) {
    throw new Error(`CCL policy version mismatch: expected ${opts.expectedVersion}, got ${policy.version}`);
  }
  if (policy.rules != null && !Array.isArray(policy.rules)) {
    throw new Error('CCL policy "rules" must be an array when provided');
  }
  if (policy.decisions != null && !Array.isArray(policy.decisions)) {
    throw new Error('CCL policy "decisions" must be an array when provided');
  }
  for (const rule of policy.rules ?? []) validateEntry(rule, 'rule');
  for (const decision of policy.decisions ?? []) validateEntry(decision, 'decision');
  return policy;
}

export function hashCclFacts(facts: CclFactTuple[]): string {
  const normalized = facts.map(tuple => [...tuple]).sort(compareTuples);
  return `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
}

export class CclEvaluator {
  private readonly policy: CclCanonicalPolicy;
  private readonly relations = new Map<string, Map<string, unknown[]>>();

  constructor(policy: CclCanonicalPolicy, facts: CclFactTuple[]) {
    this.policy = policy;
    for (const row of facts) {
      const [pred, ...args] = row;
      this.getRelation(pred).set(tupleKey(args), args);
    }
  }

  run(): CclEvaluationResult {
    this.deriveFixpoint();
    const decisions = this.evaluateDecisions();
    const derived: Record<string, unknown[][]> = {};
    for (const rule of this.policy.rules ?? []) {
      derived[rule.name] = this.sortedTuples(this.getRelation(rule.name));
    }
    return { derived, decisions };
  }

  private deriveFixpoint(): void {
    const rules = this.policy.rules ?? [];
    for (let round = 0; round < 64; round += 1) {
      let changed = false;
      for (const rule of rules) {
        const relation = this.getRelation(rule.name);
        const before = relation.size;
        for (const tuple of this.evaluateRule(rule)) {
          relation.set(tupleKey(tuple), tuple);
        }
        if (relation.size !== before) changed = true;
      }
      if (!changed) return;
    }
    throw new Error('CCL fixpoint did not converge');
  }

  private evaluateRule(rule: NonNullable<CclCanonicalPolicy['rules']>[number]): unknown[][] {
    const params = (rule.params ?? []).map(normalizeVarName);
    const tuples = new Map<string, unknown[]>();
    for (const binding of this.evaluateConditions(rule.all ?? [], [{}])) {
      const head = params.map(param => binding[param]);
      tuples.set(tupleKey(head), head);
    }
    return [...tuples.values()].sort(compareTuples);
  }

  private evaluateDecisions(): Record<string, unknown[][]> {
    const decisions: Record<string, unknown[][]> = {};
    for (const decision of this.policy.decisions ?? []) {
      const params = (decision.params ?? []).map(normalizeVarName);
      const tuples = new Map<string, unknown[]>();
      for (const binding of this.evaluateConditions(decision.all ?? [], [{}])) {
        const head = params.map(param => binding[param]);
        tuples.set(tupleKey(head), head);
      }
      decisions[decision.name] = [...tuples.values()].sort(compareTuples);
    }
    return decisions;
  }

  private evaluateConditions(conditions: CclCondition[], bindings: Binding[]): Binding[] {
    let current = bindings;
    for (const condition of conditions) {
      const next: Binding[] = [];
      for (const binding of current) {
        next.push(...this.evaluateCondition(condition, binding));
      }
      current = next;
      if (current.length === 0) break;
    }
    return current;
  }

  private evaluateCondition(condition: CclCondition, binding: Binding): Binding[] {
    if ('atom' in condition) {
      return this.matchAtom(condition.atom.pred, condition.atom.args ?? [], binding);
    }
    if ('exists' in condition) {
      const matches = this.evaluateConditions(condition.exists.where ?? [], [{ ...binding }]);
      return matches.length > 0 ? [binding] : [];
    }
    if ('not_exists' in condition) {
      const matches = this.evaluateConditions(condition.not_exists.where ?? [], [{ ...binding }]);
      return matches.length === 0 ? [binding] : [];
    }
    if ('count_distinct' in condition) {
      const vars = (condition.count_distinct.vars ?? []).map(normalizeVarName);
      const matches = this.evaluateConditions(condition.count_distinct.where ?? [], [{ ...binding }]);
      const projection = new Set(matches.map(match => tupleKey(vars.map(variable => match[variable]))));
      return compareInts(projection.size, condition.count_distinct.op, Number(condition.count_distinct.value)) ? [binding] : [];
    }
    throw new Error(`Unsupported CCL condition: ${JSON.stringify(condition)}`);
  }

  private matchAtom(pred: string, args: unknown[], binding: Binding): Binding[] {
    const out: Binding[] = [];
    for (const tuple of this.sortedTuples(this.getRelation(pred))) {
      if (tuple.length !== args.length) continue;
      const candidate: Binding = { ...binding };
      let ok = true;
      for (let i = 0; i < args.length; i += 1) {
        const term = args[i];
        const value = tuple[i];
        if (isVar(term)) {
          if (Object.hasOwn(candidate, term)) {
            if (candidate[term] !== value) {
              ok = false;
              break;
            }
          } else {
            candidate[term] = value;
          }
        } else if (term !== value) {
          ok = false;
          break;
        }
      }
      if (ok) out.push(candidate);
    }
    return out;
  }

  private getRelation(pred: string): Map<string, unknown[]> {
    let relation = this.relations.get(pred);
    if (!relation) {
      relation = new Map<string, unknown[]>();
      this.relations.set(pred, relation);
    }
    return relation;
  }

  private sortedTuples(relation: Map<string, unknown[]>): unknown[][] {
    return [...relation.values()].map(tuple => [...tuple]).sort(compareTuples);
  }
}

function compareInts(left: number, op: string, right: number): boolean {
  switch (op) {
    case '>=': return left >= right;
    case '>': return left > right;
    case '==': return left === right;
    case '<=': return left <= right;
    case '<': return left < right;
    default: throw new Error(`Unsupported CCL comparison operator: ${op}`);
  }
}

function validateEntry(entry: { name: string; params?: string[]; all?: CclCondition[] }, kind: 'rule' | 'decision'): void {
  if (!entry || typeof entry !== 'object') {
    throw new Error(`CCL ${kind} entry must be an object`);
  }
  if (!entry.name || typeof entry.name !== 'string') {
    throw new Error(`CCL ${kind} entry must define a string name`);
  }
  if (entry.params != null && !Array.isArray(entry.params)) {
    throw new Error(`CCL ${kind} ${entry.name} params must be an array when provided`);
  }
  if (entry.all != null && !Array.isArray(entry.all)) {
    throw new Error(`CCL ${kind} ${entry.name} all-clause must be an array when provided`);
  }
  for (const condition of entry.all ?? []) validateCondition(condition);
}

function validateCondition(condition: CclCondition): void {
  if ('atom' in condition) {
    if (!condition.atom?.pred || typeof condition.atom.pred !== 'string') {
      throw new Error('CCL atom condition must define a string pred');
    }
    if (condition.atom.args != null && !Array.isArray(condition.atom.args)) {
      throw new Error(`CCL atom ${condition.atom.pred} args must be an array when provided`);
    }
    return;
  }
  if ('exists' in condition || 'not_exists' in condition) {
    const where = 'exists' in condition ? condition.exists.where : condition.not_exists.where;
    if (where != null && !Array.isArray(where)) {
      throw new Error(`CCL ${'exists' in condition ? 'exists' : 'not_exists'} where-clause must be an array when provided`);
    }
    for (const nested of where ?? []) validateCondition(nested);
    return;
  }
  if ('count_distinct' in condition) {
    const spec = condition.count_distinct;
    if (spec.vars != null && !Array.isArray(spec.vars)) {
      throw new Error('CCL count_distinct vars must be an array when provided');
    }
    if (!['>=', '>', '==', '<=', '<'].includes(spec.op)) {
      throw new Error(`Unsupported CCL comparison operator: ${spec.op}`);
    }
    if (typeof spec.value !== 'number' || !Number.isFinite(spec.value)) {
      throw new Error('CCL count_distinct value must be a finite number');
    }
    if (spec.where != null && !Array.isArray(spec.where)) {
      throw new Error('CCL count_distinct where-clause must be an array when provided');
    }
    for (const nested of spec.where ?? []) validateCondition(nested);
    return;
  }
  throw new Error(`Unsupported CCL condition: ${JSON.stringify(condition)}`);
}
