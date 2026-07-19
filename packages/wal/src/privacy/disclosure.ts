import type { PrivateDisclosureRequest } from '../authority/types.js';
import type {
  PrivateDisclosureResult,
  PrivatePayloadAuthorityGate,
} from './types.js';

const DENIED = Object.freeze({ status: 'denied' as const });

/**
 * Authorization-before-lookup wrapper. Callers receive one denial shape and
 * the private loader is never invoked until the exact current DKG view allows
 * disclosure.
 */
export class WalPrivatePayloadDisclosureGate {
  constructor(private readonly authority: PrivatePayloadAuthorityGate) {}

  async disclose<Value>(
    request: PrivateDisclosureRequest,
    load: () => Value | Promise<Value>,
    evaluatedAtMs?: number,
  ): Promise<PrivateDisclosureResult<Value>> {
    try {
      if (!await this.authority.authorizePrivateDisclosure(request, evaluatedAtMs)) return DENIED;
      return { status: 'allowed', value: await load() };
    } catch {
      return DENIED;
    }
  }
}
