// DMaaST-specific payload and provenance policy. Not part of the generic component runtime.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { jpbReadSpec } from './jpb-read-policy.mjs';
export const JPB_SOURCE = jpbReadSpec.contextGraphId;
export const JPB_TARGET = '0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-plca-study';
export const JPB_WORKBOOK = '2f0585064042668c4a854290a2e0ef365a24e57d58345881108067d397470fbf';
const fail = message => Object.assign(new Error(message), { status: 409, code: 'DKG_COMPONENT_UNCONFIRMED' });
export function verifyJpbEvidence(payload) {
  const stored = payload.quads.filter(q => q.predicate === 'urn:nos:workflow:payload');
  if (stored.length !== 1 || createHash('sha256').update(JSON.parse(stored[0].object)).digest('hex') !== payload.digest)
    throw fail('JPB evidence digest differs.');
}
export function componentEvidence(rows, context, read, workbook, programContext) {
  let assessment;
  if (programContext) {
    const raw = programContext.rawOutputs;
    if (!Array.isArray(raw) || raw.length !== 1 || !raw[0]?.assessment
      || createHash('sha256').update(JSON.stringify(raw)).digest('hex') !== programContext.receipt?.outputSha256
      || !isDeepStrictEqual(rows, raw[0].records))
      throw fail('Calculated evidence must preserve the verified Program output assessment and records.');
    assessment = raw[0].assessment;
  }
  if (
    !Array.isArray(rows) ||
    !rows.length ||
    rows.length > 20 ||
    JSON.stringify(rows).length > 8192
  )
    throw fail("Use one bounded JPB evidence batch.");
  for (const r of rows) {
    if (!r || (!r.erp && !r.workbook))
      throw fail("Write mapped ERP/workbook evidence records.");
    if (r.erp && !read.records.some((v) => isDeepStrictEqual(v, r.erp)))
      throw fail("ERP provenance differs from this execution DKG Read.");
    if (
      r.workbook &&
      (!workbook.some((v) => isDeepStrictEqual(v, r.workbook)) ||
        r.workbook.evidence?.contentDigest !== JPB_WORKBOOK ||
        r.workbook.allocationStatus !== "unconfirmed")
    )
      throw fail("Workbook provenance differs from this execution input.");
  }
  const payload = JSON.stringify({
    kind: programContext ? 'PLCADemoResult' : "PLCAInputEvidence",
    interpretation: "planned-routing-reference-only",
    allocationStatus: "unconfirmed",
    plcaCalculated: assessment?.calculated === true,
    ...(programContext ? { assessment, programExecution: programContext.receipt } : {}),
    execution: { ...context, status: "running-at-write" },
    source: read.source,
    records: rows,
  });
  const digest = createHash("sha256").update(payload).digest("hex"),
    subject = "urn:nos:jpb:input-evidence:" + digest;
  const q = (predicate, object) => ({ subject, predicate, object, graph: "" });
  const quads = [
    q(
      "http://www.w3.org/1999/02/22-rdf-syntax-ns#type",
      programContext ? 'urn:nos:workflow:PLCADemoResult' : "urn:nos:workflow:PLCAInputEvidence",
    ),
    q("urn:nos:workflow:payload", JSON.stringify(payload)),
    q("urn:nos:workflow:sha256", JSON.stringify(digest)),
    q("urn:nos:workflow:allocationStatus", JSON.stringify("unconfirmed")),
    q("http://www.w3.org/ns/prov#wasGeneratedBy", context.executionIri),
    q("urn:nos:workflow:workflow", context.kaRef),
  ];
  if (programContext) quads.push(q('http://www.w3.org/ns/prov#wasGeneratedBy', programContext.receipt.executionIri));
  for (const r of rows)
    for (const ref of [
      r.erp?.recordId,
      r.erp?.evidence?.sourceEvidence,
      r.workbook && "urn:sha256:" + r.workbook.evidence.contentDigest,
    ].filter(Boolean))
      quads.push(q("http://www.w3.org/ns/prov#wasDerivedFrom", ref));
  return {
    name: "nos-input-" + digest,
    digest,
    quads: [...new Map(quads.map((q) => [JSON.stringify(q), q])).values()],
  };
}
