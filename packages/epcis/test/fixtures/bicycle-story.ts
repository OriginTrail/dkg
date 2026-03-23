import type { EPCISDocument } from '../../src/types.js';

/** Valid ObjectEvent: receiving a bicycle frame */
export const VALID_OBJECT_EVENT_DOC: EPCISDocument = {
  '@context': {
    '@vocab': 'https://gs1.github.io/EPCIS/',
    'epcis': 'https://gs1.github.io/EPCIS/',
    'cbv': 'https://ref.gs1.org/cbv/',
    'type': '@type',
    'id': '@id',
    'eventID': '@id',
  },
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: '2024-03-01T08:00:00Z',
  epcisBody: {
    eventList: [
      {
        eventID: 'urn:uuid:fixture-obj-1',
        type: 'ObjectEvent',
        eventTime: '2024-03-01T08:00:00.000Z',
        eventTimeZoneOffset: '+00:00',
        epcList: ['urn:epc:id:sgtin:4012345.011111.1001'],
        action: 'ADD',
        bizStep: 'https://ref.gs1.org/cbv/BizStep-receiving',
        disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
        readPoint: { id: 'urn:epc:id:sgln:4012345.00001.0' },
        bizLocation: { id: 'urn:epc:id:sgln:4012345.00001.0' },
      },
    ],
  },
};

/** Valid TransformationEvent: components assembled into bicycle */
export const VALID_TRANSFORMATION_EVENT_DOC: EPCISDocument = {
  '@context': {
    '@vocab': 'https://gs1.github.io/EPCIS/',
    'epcis': 'https://gs1.github.io/EPCIS/',
    'cbv': 'https://ref.gs1.org/cbv/',
    'type': '@type',
    'id': '@id',
    'eventID': '@id',
  },
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: '2024-03-01T12:00:00Z',
  epcisBody: {
    eventList: [
      {
        eventID: 'urn:uuid:fixture-transform-1',
        type: 'TransformationEvent',
        eventTime: '2024-03-01T12:00:00.000Z',
        eventTimeZoneOffset: '+00:00',
        inputEPCList: [
          'urn:epc:id:sgtin:4012345.011111.1001',
          'urn:epc:id:sgtin:4012345.022222.2001',
          'urn:epc:id:sgtin:4012345.022222.2002',
          'urn:epc:id:sgtin:4012345.033333.3001',
        ],
        outputEPCList: ['urn:epc:id:sgtin:4012345.099999.9001'],
        bizStep: 'https://ref.gs1.org/cbv/BizStep-commissioning',
        disposition: 'https://ref.gs1.org/cbv/Disp-active',
        readPoint: { id: 'urn:epc:id:sgln:4012345.00003.0' },
        bizLocation: { id: 'urn:epc:id:sgln:4012345.00003.0' },
      },
    ],
  },
};

/** Valid AggregationEvent: bicycle packed onto pallet */
export const VALID_AGGREGATION_EVENT_DOC: EPCISDocument = {
  '@context': {
    '@vocab': 'https://gs1.github.io/EPCIS/',
    'epcis': 'https://gs1.github.io/EPCIS/',
    'cbv': 'https://ref.gs1.org/cbv/',
    'type': '@type',
    'id': '@id',
    'eventID': '@id',
  },
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: '2024-03-01T14:00:00Z',
  epcisBody: {
    eventList: [
      {
        eventID: 'urn:uuid:fixture-aggregation-1',
        type: 'AggregationEvent',
        eventTime: '2024-03-01T14:00:00.000Z',
        eventTimeZoneOffset: '+00:00',
        parentID: 'urn:epc:id:sscc:4012345.0000000001',
        childEPCs: ['urn:epc:id:sgtin:4012345.099999.9001'],
        action: 'ADD',
        bizStep: 'https://ref.gs1.org/cbv/BizStep-packing',
        disposition: 'https://ref.gs1.org/cbv/Disp-in_progress',
        readPoint: { id: 'urn:epc:id:sgln:4012345.00004.0' },
        bizLocation: { id: 'urn:epc:id:sgln:4012345.00004.0' },
      },
    ],
  },
};

/** Invalid: missing required fields */
export const INVALID_DOC = {
  type: 'EPCISDocument',
  // missing @context, schemaVersion, creationDate, epcisBody
};

/** Valid structure but empty eventList */
export const EMPTY_EVENT_LIST_DOC: EPCISDocument = {
  '@context': {
    '@vocab': 'https://gs1.github.io/EPCIS/',
    'type': '@type',
    'id': '@id',
    'eventID': '@id',
  },
  type: 'EPCISDocument',
  schemaVersion: '2.0',
  creationDate: '2024-03-01T08:00:00Z',
  epcisBody: {
    eventList: [],
  },
};
