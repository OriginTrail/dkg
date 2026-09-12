// SPDX-License-Identifier: Apache-2.0
// @ts-check

import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';

/** @typedef {import('./domain-contract.js').RemoteCanaryCertificateV1} RemoteCanaryCertificateV1 */

export const ARTIFACT_SCHEMA = 'dkg-rfc64-remote-canary-certificate-v1';

/** Closed machine-readable failure vocabulary for certificate v1. */
export const REMOTE_CANARY_ERROR_CODES_V1 = /** @type {const} */ ([
  'artifact-input-path-alias',
  'auth-secret-file-must-be-absolute',
  'auth-secret-malformed',
  'auth-secret-read-failed',
  'authorization-404-control-node',
  'authorization-404-control-without-404',
  'authorization-404-requires-code-and-control',
  'authorization-body-circular',
  'authorization-body-key-too-long',
  'authorization-body-not-json',
  'authorization-code-not-rfc64-specific',
  'authorization-denial-code-mismatch',
  'authorization-denial-status-mismatch',
  'authorization-gap-reason',
  'authorization-not-found-control-failed',
  'authorization-not-found-control-missing',
  'authorization-node-reference',
  'authorization-path',
  'authorization-post-must-be-read-only-query',
  'authorization-response-malformed',
  'catalog-swm-query-failed',
  'catalog-swm-query-must-be-ask',
  'catalog-swm-query-must-be-read-only',
  'catalog-swm-query-must-depend-on-data',
  'catalog-swm-query-uses-canary-vocabulary',
  'chain-rpc-not-configured',
  'command-empty',
  'command-output-too-large',
  'command-start-failed',
  'command-timeout',
  'config-artifact-path-alias',
  'config-shape',
  'context-graph-node-reference',
  'context-graph-node-role',
  'duplicate-context-graph',
  'duplicate-node-id',
  'duplicate-node-identity',
  'exactly-one-receiver-required',
  'fetch-unavailable',
  'inline-command-secret-rejected',
  'lifecycle-receiver-mismatch',
  'node-base-url',
  'node-base-url-credentials-or-query',
  'node-base-url-path',
  'node-base-url-requires-https',
  'node-build-mismatch',
  'node-chain-id-invalid',
  'node-http-status-failed',
  'node-identity-changed',
  'node-network-changed',
  'node-network-mismatch',
  'node-network-missing',
  'node-redirect-rejected',
  'node-request-failed',
  'node-response-too-large',
  'node-json-malformed',
  'node-status-missing',
  'offline-catchup-timeout',
  'preflight-status-malformed',
  'private-gate-evidence-authorization-checks',
  'private-gate-evidence-invalid',
  'private-gate-evidence-not-bound-to-run',
  'private-gate-evidence-path-must-be-absolute',
  'private-gate-evidence-read-failed',
  'private-gate-evidence-source-mismatch',
  'private-gate-evidence-stale',
  'private-gate-evidence-too-large',
  'private-gate-evidence-unused',
  'receiver-became-reachable-during-offline-window',
  'receiver-did-not-recover',
  'receiver-did-not-stop',
  'receiver-node-required',
  'receiver-start-command-failed',
  'receiver-stop-command-failed',
  'revoked-authentication-credentials-required',
  'rfc64-catalog-disabled',
  'rfc64-catalog-service-not-started',
  'rfc64-kill-switch-active',
  'rfc64-legacy-sync-allowed',
  'rfc64-mode-mismatch',
  'rfc64-operational-evidence-drift',
  'rfc64-operational-incomplete',
  'rfc64-operational-mode-missing',
  'rfc64-operational-parity-changed',
  'rpc-evidence-cohort-mismatch',
  'rpc-evidence-command-failed',
  'rpc-evidence-commit-mismatch',
  'rpc-evidence-count-out-of-range',
  'rpc-evidence-count-overflow',
  'rpc-evidence-future',
  'rpc-evidence-malformed',
  'rpc-evidence-path-must-be-absolute',
  'rpc-evidence-read-failed',
  'rpc-evidence-sample-count',
  'rpc-evidence-stale',
  'rpc-evidence-time-invalid',
  'rpc-evidence-too-large',
  'rpc-evidence-total-mismatch',
  'rpc-evidence-window-not-bound-to-run',
  'rpc-evidence-window-not-minutely',
  'source-node-required',
  'source-receiver-must-differ',
  'swm-propagation-timeout',
  'swm-share-not-confirmed',
  'sync-reconciler-disabled',
  'unexpected-execution-failure',
  'unauthorized-authentication-mode',
  'unsafe-node-path',
  'vm-parity-timeout',
  'vm-query-must-be-ask',
  'vm-query-must-be-read-only',
  'vm-query-must-depend-on-data',
  'vm-query-parity-failed',
  'revoked-authentication-mode',
]);

export const REMOTE_CANARY_ERROR_CATEGORIES_V1 = /** @type {const} */ ([
  'authentication',
  'command',
  'configuration',
  'evidence',
  'http',
  'invariant',
  'lifecycle',
  'policy',
  'programming',
  'swm',
  'vm',
]);

export const REMOTE_CANARY_PHASES_V1 = /** @type {const} */ ([
  'authorization',
  'catalog-swm-evidence',
  'config',
  'failed',
  'final-preflight',
  'live-swm-propagation',
  'offline-catchup',
  'preflight',
  'rpc-usage',
  'vm-parity',
]);

export const REMOTE_CANARY_EVIDENCE_GAPS_V1 = /** @type {const} */ ([
  'offline-catchup',
  'vm-parity',
  'catalog-swm',
  'authorization-unauthorized',
  'authorization-revoked',
  'rpc-usage',
]);

/** Executable proof that an INCOMPLETE certificate contains a real evidence gap. */
export const REMOTE_CANARY_INCOMPLETE_CHECKS_SCHEMA_V1 = /** @type {const} */ ({
  type: 'object',
  anyOf: [
    {
      required: ['offlineCatchup'],
      properties: {
        offlineCatchup: {
          type: 'object',
          required: ['status'],
          properties: { status: { const: 'EVIDENCE_REQUIRED' } },
        },
      },
    },
    {
      required: ['vmParity'],
      properties: {
        vmParity: {
          type: 'array',
          contains: {
            type: 'object',
            required: ['status'],
            properties: { status: { const: 'EVIDENCE_REQUIRED' } },
          },
        },
      },
    },
    {
      required: ['catalogSwm'],
      properties: {
        catalogSwm: {
          type: 'array',
          contains: {
            type: 'object',
            required: ['status'],
            properties: { status: { const: 'EVIDENCE_REQUIRED' } },
          },
        },
      },
    },
    {
      required: ['authorization'],
      properties: {
        authorization: {
          type: 'object',
          required: ['unauthorized'],
          properties: {
            unauthorized: {
              type: 'object',
              required: ['status'],
              properties: { status: { const: 'EVIDENCE_REQUIRED' } },
            },
          },
        },
      },
    },
    {
      required: ['authorization'],
      properties: {
        authorization: {
          type: 'object',
          required: ['revoked'],
          properties: {
            revoked: {
              type: 'object',
              required: ['status'],
              properties: { status: { const: 'EVIDENCE_REQUIRED' } },
            },
          },
        },
      },
    },
    {
      required: ['rpcUsage'],
      properties: {
        rpcUsage: {
          type: 'object',
          required: ['status'],
          properties: { status: { const: 'EVIDENCE_REQUIRED' } },
        },
      },
    },
  ],
});

/** Executable, type-level canonical contract for every certificate-v1 variant. */
export const REMOTE_CANARY_CERTIFICATE_SCHEMA_V1 = /** @type {const} */ ({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://dkg.origintrail.io/schemas/rfc64-remote-canary-certificate-v1.json',
  title: 'RFC-64 remote canary certificate',
  oneOf: [
    { $ref: '#/$defs/starting' },
    { $ref: '#/$defs/dryRun' },
    { $ref: '#/$defs/pass' },
    { $ref: '#/$defs/incomplete' },
    { $ref: '#/$defs/fail' },
  ],
  $defs: {
    instant: { type: 'string', format: 'date-time' },
    shaCommit: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    opaqueRef: { type: 'string', pattern: '^[a-z]+:[0-9a-f]{20}$' },
    starting: {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'status', 'phase', 'startedAt'],
      properties: {
        schema: { const: ARTIFACT_SCHEMA },
        status: { const: 'INCOMPLETE' },
        phase: { const: 'starting' },
        startedAt: { $ref: '#/$defs/instant' },
      },
    },
    topology: {
      type: 'object',
      additionalProperties: false,
      required: ['nodeCount', 'nodes', 'contextGraphs'],
      properties: {
        nodeCount: { type: 'integer', minimum: 2 },
        nodes: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['nodeRef', 'role', 'authentication'],
            properties: {
              nodeRef: { $ref: '#/$defs/opaqueRef' },
              role: { enum: ['source', 'receiver', 'observer'] },
              authentication: { enum: ['none', 'bearer-file'] },
            },
          },
        },
        contextGraphs: {
          type: 'array',
          minItems: 1,
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['contextGraphRef', 'sourceNodeRef', 'receiverNodeRef', 'expectedMode'],
            properties: {
              contextGraphRef: { $ref: '#/$defs/opaqueRef' },
              sourceNodeRef: { $ref: '#/$defs/opaqueRef' },
              receiverNodeRef: { $ref: '#/$defs/opaqueRef' },
              expectedMode: { const: 'catalog' },
            },
          },
        },
      },
    },
    dryRun: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schema', 'status', 'phase', 'startedAt', 'finishedAt',
        'expectedCommit', 'cohortRef', 'topology', 'plan',
      ],
      properties: {
        schema: { const: ARTIFACT_SCHEMA },
        status: { const: 'DRY_RUN' },
        phase: { const: 'planned' },
        startedAt: { $ref: '#/$defs/instant' },
        finishedAt: { $ref: '#/$defs/instant' },
        expectedCommit: { $ref: '#/$defs/shaCommit' },
        cohortRef: { $ref: '#/$defs/opaqueRef' },
        topology: { $ref: '#/$defs/topology' },
        plan: {
          type: 'object',
          additionalProperties: false,
          required: [
            'preflight', 'liveSwmPropagationChecks', 'offlineCatchup',
            'vmParityChecks', 'vmParityEvidence', 'catalogSwmEvidence',
            'authorization', 'rpcUsage',
          ],
          properties: {
            preflight: { const: 'exact-build-network-sync-and-catalog-mode' },
            liveSwmPropagationChecks: { type: 'integer', minimum: 1 },
            offlineCatchup: { enum: ['PLANNED', 'EVIDENCE_REQUIRED'] },
            vmParityChecks: { type: 'integer', minimum: 1 },
            vmParityEvidence: { enum: ['PLANNED', 'EVIDENCE_REQUIRED'] },
            catalogSwmEvidence: { enum: ['PLANNED', 'EVIDENCE_REQUIRED'] },
            authorization: {
              type: 'object',
              additionalProperties: false,
              required: ['unauthorized', 'revoked', 'companionEvidence'],
              properties: {
                unauthorized: { enum: ['PLANNED', 'EVIDENCE_REQUIRED'] },
                revoked: { enum: ['PLANNED', 'EVIDENCE_REQUIRED'] },
                companionEvidence: { enum: ['PLANNED', 'NOT_CONFIGURED'] },
              },
            },
            rpcUsage: { enum: ['PLANNED', 'EVIDENCE_REQUIRED'] },
          },
        },
      },
    },
    markerPass: {
      type: 'object',
      additionalProperties: false,
      required: ['contextGraphRef', 'markerRef', 'status'],
      properties: {
        contextGraphRef: { $ref: '#/$defs/opaqueRef' },
        markerRef: { $ref: '#/$defs/opaqueRef' },
        status: { const: 'PASS' },
      },
    },
    offlineCatchup: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'requirement'],
          properties: {
            status: { const: 'EVIDENCE_REQUIRED' },
            requirement: { const: 'single-receiver-stop-start' },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'receiverCount', 'contextGraphs'],
          properties: {
            status: { const: 'PASS' },
            receiverCount: { const: 1 },
            contextGraphs: {
              type: 'array',
              minItems: 1,
              items: { $ref: '#/$defs/markerPass' },
            },
          },
        },
      ],
    },
    vmParity: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'contextGraphRef', 'status', 'statusParity', 'cursorPresent',
            'digestParity', 'rowCountParity', 'vmQueryChecked',
          ],
          properties: {
            contextGraphRef: { $ref: '#/$defs/opaqueRef' },
            status: { const: 'PASS' },
            statusParity: { const: 'PASS' },
            cursorPresent: { const: true },
            digestParity: { const: true },
            rowCountParity: { const: true },
            vmQueryChecked: { const: true },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'contextGraphRef', 'status', 'statusParity', 'cursorPresent',
            'digestParity', 'rowCountParity', 'vmQueryChecked', 'requirement',
          ],
          properties: {
            contextGraphRef: { $ref: '#/$defs/opaqueRef' },
            status: { const: 'EVIDENCE_REQUIRED' },
            statusParity: { const: 'PASS' },
            cursorPresent: { const: true },
            digestParity: { const: true },
            rowCountParity: { const: true },
            vmQueryChecked: { const: false },
            requirement: { const: 'vm-ask-query' },
          },
        },
      ],
    },
    catalogSwm: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'contextGraphRef', 'status', 'queryChecked',
            'sourceQueryPassed', 'receiverQueryPassed',
          ],
          properties: {
            contextGraphRef: { $ref: '#/$defs/opaqueRef' },
            status: { const: 'PASS' },
            queryChecked: { const: true },
            sourceQueryPassed: { const: true },
            receiverQueryPassed: { const: true },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['contextGraphRef', 'status', 'requirement', 'queryChecked'],
          properties: {
            contextGraphRef: { $ref: '#/$defs/opaqueRef' },
            status: { const: 'EVIDENCE_REQUIRED' },
            requirement: { const: 'known-catalog-swm-ask-query' },
            queryChecked: { const: false },
          },
        },
      ],
    },
    authorizationCheck: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'denialObserved'],
          properties: {
            status: { const: 'PASS' },
            denialObserved: { const: true },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'reasonCode'],
          properties: {
            status: { const: 'EVIDENCE_REQUIRED' },
            reasonCode: {
              enum: ['catalog-protocol-api-not-exposed', 'revocation-api-not-exposed'],
            },
          },
        },
      ],
    },
    privateGateEvidence: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schema', 'artifactRef', 'sourceRevision', 'runtimeManifestDigest',
        'runtimeProvenanceRef', 'startedAt', 'finishedAt',
      ],
      properties: {
        schema: { const: 'dkg-rfc64-private-release-gate-v1' },
        artifactRef: { $ref: '#/$defs/opaqueRef' },
        sourceRevision: { $ref: '#/$defs/shaCommit' },
        runtimeManifestDigest: { type: 'string', pattern: '^0x[0-9a-f]{64}$' },
        runtimeProvenanceRef: { $ref: '#/$defs/opaqueRef' },
        startedAt: { $ref: '#/$defs/instant' },
        finishedAt: { $ref: '#/$defs/instant' },
      },
    },
    rpcUsage: {
      oneOf: [
        {
          type: 'object',
          additionalProperties: false,
          required: ['status', 'requirement', 'acceptedSources'],
          properties: {
            status: { const: 'EVIDENCE_REQUIRED' },
            requirement: { const: 'dkg-rpc-usage-minutes-v1' },
            acceptedSources: {
              type: 'array',
              prefixItems: [{ const: 'evidence-file' }, { const: 'command' }],
              minItems: 2,
              maxItems: 2,
            },
          },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'status', 'source', 'cohortRef', 'windowStartedAt', 'windowEndedAt',
            'sampleCount', 'measuredSeconds', 'total', 'requestsPerMinute', 'byMethod',
          ],
          properties: {
            status: { const: 'PASS' },
            source: { enum: ['evidence-file', 'command'] },
            cohortRef: { $ref: '#/$defs/opaqueRef' },
            windowStartedAt: { $ref: '#/$defs/instant' },
            windowEndedAt: { $ref: '#/$defs/instant' },
            sampleCount: { type: 'integer', minimum: 1 },
            measuredSeconds: { type: 'number', minimum: 0 },
            total: { type: 'integer', minimum: 0, maximum: 9007199254740991 },
            requestsPerMinute: { type: 'number', minimum: 0 },
            byMethod: {
              type: 'object',
              additionalProperties: {
                type: 'integer', minimum: 0, maximum: 9007199254740991,
              },
            },
          },
        },
      ],
    },
    preflight: {
      type: 'object',
      additionalProperties: false,
      required: ['status', 'nodes'],
      properties: {
        status: { const: 'PASS' },
        nodes: {
          type: 'array',
          minItems: 2,
          items: {
            type: 'object',
            additionalProperties: false,
            required: [
              'nodeRef', 'role', 'commit', 'chainId', 'syncReconcilerEnabled',
              'catalogServiceEnabled', 'contextGraphs',
            ],
            properties: {
              nodeRef: { $ref: '#/$defs/opaqueRef' },
              role: { enum: ['source', 'receiver', 'observer'] },
              commit: { $ref: '#/$defs/shaCommit' },
              chainId: { type: 'string', pattern: '^(0|[1-9][0-9]*)$' },
              syncReconcilerEnabled: { const: true },
              catalogServiceEnabled: { const: true },
              contextGraphs: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  required: ['contextGraphRef', 'mode', 'legacySyncAllowed'],
                  properties: {
                    contextGraphRef: { $ref: '#/$defs/opaqueRef' },
                    mode: { const: 'catalog' },
                    legacySyncAllowed: { const: false },
                  },
                },
              },
            },
          },
        },
      },
    },
    checks: {
      type: 'object',
      additionalProperties: false,
      required: [
        'liveSwmPropagation', 'offlineCatchup', 'vmParity',
        'catalogSwm', 'authorization', 'rpcUsage',
      ],
      properties: {
        liveSwmPropagation: {
          type: 'array', minItems: 1, items: { $ref: '#/$defs/markerPass' },
        },
        offlineCatchup: { $ref: '#/$defs/offlineCatchup' },
        vmParity: { type: 'array', minItems: 1, items: { $ref: '#/$defs/vmParity' } },
        catalogSwm: {
          type: 'array', minItems: 1, items: { $ref: '#/$defs/catalogSwm' },
        },
        authorization: {
          type: 'object',
          additionalProperties: false,
          required: ['unauthorized', 'revoked', 'companionEvidence'],
          properties: {
            unauthorized: { $ref: '#/$defs/authorizationCheck' },
            revoked: { $ref: '#/$defs/authorizationCheck' },
            companionEvidence: {
              oneOf: [
                { type: 'null' },
                { $ref: '#/$defs/privateGateEvidence' },
              ],
            },
          },
        },
        rpcUsage: { $ref: '#/$defs/rpcUsage' },
      },
    },
    passChecks: {
      allOf: [
        { $ref: '#/$defs/checks' },
        {
          type: 'object',
          required: [
            'offlineCatchup', 'vmParity', 'catalogSwm', 'authorization', 'rpcUsage',
          ],
          properties: {
            offlineCatchup: {
              type: 'object',
              required: ['status'],
              properties: { status: { const: 'PASS' } },
            },
            vmParity: {
              type: 'array',
              items: {
                type: 'object',
                required: ['status'],
                properties: { status: { const: 'PASS' } },
              },
            },
            catalogSwm: {
              type: 'array',
              items: {
                type: 'object',
                required: ['status'],
                properties: { status: { const: 'PASS' } },
              },
            },
            authorization: {
              type: 'object',
              required: ['unauthorized', 'revoked'],
              properties: {
                unauthorized: {
                  type: 'object',
                  required: ['status'],
                  properties: { status: { const: 'PASS' } },
                },
                revoked: {
                  type: 'object',
                  required: ['status'],
                  properties: { status: { const: 'PASS' } },
                },
              },
            },
            rpcUsage: {
              type: 'object',
              required: ['status'],
              properties: { status: { const: 'PASS' } },
            },
          },
        },
      ],
    },
    completedBase: {
      type: 'object',
      additionalProperties: false,
      required: [
        'schema', 'status', 'phase', 'startedAt', 'finishedAt',
        'expectedCommit', 'cohortRef', 'topology', 'preflight', 'checks',
        'evidenceRequired',
      ],
      properties: {
        schema: { const: ARTIFACT_SCHEMA },
        status: { enum: ['PASS', 'INCOMPLETE'] },
        phase: { enum: ['complete', 'evidence-required'] },
        startedAt: { $ref: '#/$defs/instant' },
        finishedAt: { $ref: '#/$defs/instant' },
        expectedCommit: { $ref: '#/$defs/shaCommit' },
        cohortRef: { $ref: '#/$defs/opaqueRef' },
        topology: { $ref: '#/$defs/topology' },
        preflight: { $ref: '#/$defs/preflight' },
        checks: { $ref: '#/$defs/checks' },
        evidenceRequired: {
          type: 'array',
          uniqueItems: true,
          items: {
            enum: REMOTE_CANARY_EVIDENCE_GAPS_V1,
          },
        },
      },
    },
    pass: {
      allOf: [
        { $ref: '#/$defs/completedBase' },
        {
          type: 'object',
          required: ['status', 'phase', 'checks', 'evidenceRequired'],
          properties: {
            status: { const: 'PASS' },
            phase: { const: 'complete' },
            checks: { $ref: '#/$defs/passChecks' },
            evidenceRequired: { type: 'array', maxItems: 0 },
          },
        },
      ],
    },
    incomplete: {
      allOf: [
        { $ref: '#/$defs/completedBase' },
        {
          type: 'object',
          required: ['status', 'phase', 'checks', 'evidenceRequired'],
          properties: {
            status: { const: 'INCOMPLETE' },
            phase: { const: 'evidence-required' },
            checks: REMOTE_CANARY_INCOMPLETE_CHECKS_SCHEMA_V1,
            evidenceRequired: { type: 'array', minItems: 1 },
          },
        },
      ],
    },
    fail: {
      type: 'object',
      additionalProperties: false,
      required: ['schema', 'status', 'phase', 'startedAt', 'finishedAt', 'failure'],
      properties: {
        schema: { const: ARTIFACT_SCHEMA },
        status: { const: 'FAIL' },
        phase: { enum: REMOTE_CANARY_PHASES_V1 },
        startedAt: { $ref: '#/$defs/instant' },
        finishedAt: { $ref: '#/$defs/instant' },
        failure: {
          type: 'object',
          additionalProperties: false,
          required: ['code'],
          properties: { code: { enum: REMOTE_CANARY_ERROR_CODES_V1 } },
        },
      },
    },
  },
});

// Export each executable variant as an independent schema so TypeScript can
// derive the persisted union without recursively expanding all five branches
// and every shared definition in one instantiation.
export const REMOTE_CANARY_STARTING_CERTIFICATE_SCHEMA_V1 = /** @type {const} */ ({
  ...REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs.starting,
  $defs: REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs,
});
export const REMOTE_CANARY_DRY_RUN_CERTIFICATE_SCHEMA_V1 = /** @type {const} */ ({
  ...REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs.dryRun,
  $defs: REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs,
});
export const REMOTE_CANARY_PASS_CERTIFICATE_SCHEMA_V1 = /** @type {const} */ ({
  ...REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs.pass,
  $defs: REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs,
});
export const REMOTE_CANARY_INCOMPLETE_CERTIFICATE_SCHEMA_V1 = /** @type {const} */ ({
  ...REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs.incomplete,
  $defs: REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs,
});
export const REMOTE_CANARY_FAILED_CERTIFICATE_SCHEMA_V1 = /** @type {const} */ ({
  ...REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs.fail,
  $defs: REMOTE_CANARY_CERTIFICATE_SCHEMA_V1.$defs,
});

// NodeNext sees these CommonJS-compatible packages as namespaces even though
// their runtime default exports are constructable/callable.
// @ts-expect-error Runtime interop is covered by artifact contract tests.
const artifactValidator = new Ajv2020({ allErrors: false, strict: true });
// @ts-expect-error Runtime interop is covered by artifact contract tests.
addFormats(artifactValidator);
/** @type {import('ajv').ValidateFunction<RemoteCanaryCertificateV1>} */
const matchesRemoteCanaryCertificateV1 = artifactValidator.compile(
  REMOTE_CANARY_CERTIFICATE_SCHEMA_V1,
);

/**
 * Central checked constructor/encoder boundary for every certificate variant.
 * @template {RemoteCanaryCertificateV1} Certificate
 * @param {Certificate} artifact
 * @returns {Readonly<Certificate>}
 */
export function createRemoteCanaryCertificateV1(artifact) {
  if (!matchesRemoteCanaryCertificateV1(artifact)) {
    throw new TypeError('remote-canary-certificate-contract');
  }
  return /** @type {Readonly<Certificate>} */ (/** @type {unknown} */ (Object.freeze(artifact)));
}

/** @param {unknown} artifact @returns {RemoteCanaryCertificateV1} */
export function validateRemoteCanaryCertificateV1(artifact) {
  if (!matchesRemoteCanaryCertificateV1(artifact)) {
    throw new TypeError('remote-canary-certificate-contract');
  }
  return artifact;
}
