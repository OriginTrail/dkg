/** Fields actually reconstructed from query bindings, shared with the response type. */
export const EPCIS_QUERY_STRING_FIELDS = [
  'eventTime', 'eventTimeZoneOffset', 'action', 'bizStep', 'disposition',
  'parentID', 'configurationId', 'shipmentId',
] as const;

export const EPCIS_QUERY_LOCATION_FIELDS = ['readPoint', 'bizLocation'] as const;

export const EPCIS_QUERY_ARRAY_BINDINGS = [
  ['epcList', 'epcList'],
  ['childEPCList', 'childEPCs'],
  ['inputEPCs', 'inputEPCList'],
  ['outputEPCs', 'outputEPCList'],
] as const;

export type EpcisReconstructedField = 'type'
  | typeof EPCIS_QUERY_STRING_FIELDS[number]
  | typeof EPCIS_QUERY_LOCATION_FIELDS[number]
  | typeof EPCIS_QUERY_ARRAY_BINDINGS[number][1];
