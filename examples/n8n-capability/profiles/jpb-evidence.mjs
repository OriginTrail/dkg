// DMaaST-specific payload and provenance policy. Not part of the generic component runtime.
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
export const JPB_SOURCE = '0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-data';
export const JPB_TARGET = '0xf77258a965ba13adc77bca85da7c6a287272959a/jpb-plca-study';
export const JPB_WORKBOOK = '2f0585064042668c4a854290a2e0ef365a24e57d58345881108067d397470fbf';
const fail = message => Object.assign(new Error(message), { status: 409, code: 'DKG_COMPONENT_UNCONFIRMED' });
export function componentEvidence(rows, context, read, workbook, programOutput) {
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
    kind: programOutput ? 'PLCADemoResult' : "PLCAInputEvidence",
    interpretation: "planned-routing-reference-only",
    allocationStatus: "unconfirmed",
    plcaCalculated: programOutput?.result?.assessment?.calculated === true,
    ...(programOutput ? { assessment: programOutput.result.assessment, programExecution: programOutput.programExecution } : {}),
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
      programOutput ? 'urn:nos:workflow:PLCADemoResult' : "urn:nos:workflow:PLCAInputEvidence",
    ),
    q("urn:nos:workflow:payload", JSON.stringify(payload)),
    q("urn:nos:workflow:sha256", JSON.stringify(digest)),
    q("urn:nos:workflow:allocationStatus", JSON.stringify("unconfirmed")),
    q("http://www.w3.org/ns/prov#wasGeneratedBy", context.executionIri),
    q("urn:nos:workflow:workflow", context.kaRef),
  ];
  if (programOutput) quads.push(q('http://www.w3.org/ns/prov#wasGeneratedBy', programOutput.programExecution.executionIri));
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
