import { describe, it, expect } from 'vitest';
import { NS, RDF_TYPE, XSD, Class, Prop, Status, DEFAULT_CONTEXT_GRAPH } from '../src/ontology.js';

describe('ontology constants', () => {
  it('namespace is a valid URI', () => {
    expect(NS).toBe('https://ontology.dkg.io/autoresearch#');
    expect(NS).toMatch(/^https?:\/\/.+#$/);
  });

  it('all class URIs start with the namespace', () => {
    for (const uri of Object.values(Class)) {
      expect(uri).toMatch(new RegExp(`^${NS.replace('#', '\\#')}`));
    }
  });

  it('all property URIs start with the namespace', () => {
    for (const uri of Object.values(Prop)) {
      expect(uri).toMatch(new RegExp(`^${NS.replace('#', '\\#')}`));
    }
  });

  it('all status URIs start with the namespace', () => {
    for (const uri of Object.values(Status)) {
      expect(uri).toMatch(new RegExp(`^${NS.replace('#', '\\#')}`));
    }
  });

  it('defines expected classes', () => {
    expect(Class.Experiment).toBe(`${NS}Experiment`);
    expect(Class.AgentRun).toBe(`${NS}AgentRun`);
  });

  it('defines core experiment properties', () => {
    expect(Prop.valBpb).toBe(`${NS}valBpb`);
    expect(Prop.peakVramMb).toBe(`${NS}peakVramMb`);
    expect(Prop.status).toBe(`${NS}status`);
    expect(Prop.description).toBe(`${NS}description`);
    expect(Prop.commitHash).toBe(`${NS}commitHash`);
    expect(Prop.codeDiff).toBe(`${NS}codeDiff`);
    expect(Prop.platform).toBe(`${NS}platform`);
    expect(Prop.agentDid).toBe(`${NS}agentDid`);
    expect(Prop.timestamp).toBe(`${NS}timestamp`);
    expect(Prop.parentExperiment).toBe(`${NS}parentExperiment`);
  });

  it('defines training metric properties', () => {
    expect(Prop.trainingSeconds).toBe(`${NS}trainingSeconds`);
    expect(Prop.totalTokensM).toBe(`${NS}totalTokensM`);
    expect(Prop.numParamsM).toBe(`${NS}numParamsM`);
    expect(Prop.mfuPercent).toBe(`${NS}mfuPercent`);
    expect(Prop.depth).toBe(`${NS}depth`);
    expect(Prop.numSteps).toBe(`${NS}numSteps`);
  });

  it('defines AgentRun properties', () => {
    expect(Prop.startedAt).toBe(`${NS}startedAt`);
    expect(Prop.experimentCount).toBe(`${NS}experimentCount`);
    expect(Prop.bestValBpb).toBe(`${NS}bestValBpb`);
    expect(Prop.hasExperiment).toBe(`${NS}hasExperiment`);
  });

  it('defines three status values', () => {
    expect(Object.keys(Status)).toHaveLength(3);
    expect(Status.Keep).toBe(`${NS}keep`);
    expect(Status.Discard).toBe(`${NS}discard`);
    expect(Status.Crash).toBe(`${NS}crash`);
  });

  it('has a default context graph name', () => {
    expect(DEFAULT_CONTEXT_GRAPH).toBe('autoresearch');
  });

  it('property and class names are unique', () => {
    const allUris = [
      ...Object.values(Class),
      ...Object.values(Prop),
      ...Object.values(Status),
    ];
    expect(new Set(allUris).size).toBe(allUris.length);
  });

  it('uses standard RDF and XSD namespaces', () => {
    expect(RDF_TYPE).toBe('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
    expect(XSD).toBe('http://www.w3.org/2001/XMLSchema#');
  });
});
