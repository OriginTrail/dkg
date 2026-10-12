// SPDX-License-Identifier: Apache-2.0
/**
 * RFC-64 control objects signed by an author key that an external signer
 * holds.
 *
 * An author signs a control object (an SWM author inventory head, an author
 * catalog head, its catalog issuer delegation, the policy seed of its
 * wallet-namespaced graph, ...) with EIP-191 over the object's 32-byte digest,
 * `sha256("dkg-control-object-v1\n" ‖ canonical JSON of the unsigned object)`,
 * and receivers recover the issuer from that digest. An external signer is not
 * asked to sign the digest blind: the producers mark the object they sign
 * (see {@link signingRfc64ControlObjectV1}), and the signer is first offered
 * `dkg_signControlObject` with the canonical object, so it can check the
 * object and recompute the digest. A digest that is not the digest of the
 * marked object is never sent.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { ethers } from 'ethers';
import {
  CONTROL_OBJECT_DIGEST_DOMAIN,
  canonicalizeUnsignedControlEnvelopeBytes,
  computeControlObjectDigest,
  type UnsignedControlEnvelopeV1,
} from '@origintrail-official/dkg-core';
import { signMessageWithPreimage, type AuthorSigner } from '@origintrail-official/dkg-chain';

/** The optional external-signer method that signs a control object from its canonical form. */
export const RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1 = 'dkg_signControlObject';

const controlObjectBeingSigned = new AsyncLocalStorage<UnsignedControlEnvelopeV1>();

/** Run `sign` (which signs the digest of `unsigned`) with `unsigned` marked as the object being signed. */
export function signingRfc64ControlObjectV1<T>(
  unsigned: UnsignedControlEnvelopeV1,
  sign: () => Promise<T>,
): Promise<T> {
  return controlObjectBeingSigned.run(unsigned, sign);
}

/**
 * The EIP-191 signature of an author key the external signer holds over
 * `objectDigest`, which must be the digest of the control object being signed.
 */
export async function signRfc64ControlObjectExternallyV1(
  signer: Pick<AuthorSigner, 'signMessage'>,
  objectDigest: Uint8Array,
): Promise<string> {
  const unsigned = controlObjectBeingSigned.getStore();
  if (unsigned === undefined) {
    throw new Error('RFC-64: an author key held by the external signer signs only a control object it is shown');
  }
  if (ethers.hexlify(computeControlObjectDigest(unsigned)) !== ethers.hexlify(objectDigest)) {
    throw new Error('RFC-64: the digest to sign is not the digest of the control object being signed');
  }
  return signMessageWithPreimage(signer, {
    method: RFC64_CONTROL_OBJECT_SIGNING_METHOD_V1,
    preimage: {
      domain: CONTROL_OBJECT_DIGEST_DOMAIN,
      envelope: new TextDecoder().decode(canonicalizeUnsignedControlEnvelopeBytes(unsigned)),
    },
    message: objectDigest,
  });
}
