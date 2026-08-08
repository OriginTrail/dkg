const api = await import('@origintrail-official/dkg-core/system-record-v1');

const representativeExports = [
  'SYSTEM_RECORD_KIND_V1',
  'AGENT_PROFILE_SCHEMA_V1',
  'computeAgentProfileHeadObjectDigestV1',
  'parseCanonicalSystemRecordAppliedStateV1',
  'computeSystemRecordRootDescriptorDigestV1',
  'verifySystemRecordResponsePayloadV1',
];

for (const name of representativeExports) {
  if (!(name in api)) {
    throw new Error(`system-record-v1 package export is missing ${name}`);
  }
}

console.log(`system-record-v1 package export ok (${representativeExports.length} representative symbols)`);
