import type { Digest32V1 } from '@origintrail-official/dkg-core/system-record-v1';
import type {
  CreateSystemRecordRequesterOptionsV1,
  SystemRecordExactFetchResultV1,
  SystemRecordRequesterAdmissionV1,
  SystemRecordRequesterByteAdmissionV1,
  SystemRecordRequesterExchangeV1,
  SystemRecordRequesterLimitsV1,
  SystemRecordRequesterV1,
} from '@origintrail-official/dkg-agent/dist/system-records/requester-v1.js';
import { createSystemRecordRequesterV1 } from '@origintrail-official/dkg-agent/dist/system-records/requester-v1.js';

declare const byteAdmission: SystemRecordRequesterByteAdmissionV1;
declare const streamAdmission: SystemRecordRequesterAdmissionV1;
declare const decodeAdmission: SystemRecordRequesterAdmissionV1;
declare const exchange: SystemRecordRequesterExchangeV1;
declare const digest: Digest32V1;
declare const signal: AbortSignal;
declare const networkId: CreateSystemRecordRequesterOptionsV1['networkId'];
const limits: Readonly<SystemRecordRequesterLimitsV1> = Object.freeze({
  maxTrackedDigests: 1,
});

const options: CreateSystemRecordRequesterOptionsV1 = {
  networkId,
  openExchange: async (_signal) => exchange,
  byteAdmission,
  streamAdmission,
  decodeAdmission,
  limits,
};
const requester: SystemRecordRequesterV1 = createSystemRecordRequesterV1(options);
const trackedDigests: number = requester.stats().trackedDigests;
const result: Promise<SystemRecordExactFetchResultV1> = requester.fetch({
  type: 'object',
  objectKind: 'profile-bundle',
  objectDigest: digest,
}, signal);

void result;
void trackedDigests;
