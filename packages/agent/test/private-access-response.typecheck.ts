import type { PrivateAccessResponse } from '../src/private-access-request.js';

declare const response: PrivateAccessResponse;
if (response.granted) {
  const root: string = response.privateMerkleRoot;
  const matches: true = response.verification.matches;
  const kind: 'peer-root-self-check' = response.verification.kind;
  void [root, matches, kind];
} else {
  const matches: false = response.verification.matches;
  const kind: 'not-checked' = response.verification.kind;
  void [matches, kind];
  // @ts-expect-error Denied responses carry no Merkle root.
  void response.privateMerkleRoot;
}
// @ts-expect-error A granted response must include its peer-supplied root.
const missingRoot: PrivateAccessResponse = { granted: true, quads: [], storedInGraph: false,
  verification: { kind: 'peer-root-self-check', matches: true, chainAnchored: false } };
void missingRoot;
