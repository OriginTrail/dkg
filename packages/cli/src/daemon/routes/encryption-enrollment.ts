import { isExplicitNodeOperator, authenticatedAgentAddress } from '../../auth.js';
import { readBody, jsonResponse, SMALL_BODY_BYTES } from '../http-utils.js';
import type { RequestContext } from './context.js';

/** Key custody is node-admin prepared and agent approved; neither action grants graph membership. */
export async function handleEncryptionEnrollment(ctx: RequestContext): Promise<boolean> {
  const { req, res, path, authentication, agent } = ctx;
  if (req.method !== 'POST' || !['/api/agent/encryption-enrollments', '/api/agent/encryption-enrollments/activate'].includes(path)) return false;
  const activation = path.endsWith('/activate');
  if (!activation && !isExplicitNodeOperator(authentication)) {
    jsonResponse(res, 403, { error: 'Preparing encryption custody requires an explicitly authenticated node operator' });
    return true;
  }
  const caller = authenticatedAgentAddress(authentication);
  if (activation && (!caller || !('credential' in authentication) || authentication.credential !== 'agent-key')) {
    jsonResponse(res, 403, { error: 'Activation requires the recipient agent’s signed HTTP request' });
    return true;
  }
  try {
    const body = JSON.parse(await readBody(req, SMALL_BODY_BYTES));
    const allowed = activation ? ['agentAddress', 'enrollmentId', 'encryptionKeyProof', 'custodyProof'] : ['agentAddress'];
    if (!body || Array.isArray(body) || Object.keys(body).some((key) => !allowed.includes(key))
      || allowed.some((key) => typeof body[key] !== 'string' || !body[key])) {
      throw new Error(`Expected exactly: ${allowed.join(', ')}`);
    }
    if (activation && body.agentAddress.toLowerCase() !== caller!.toLowerCase()) {
      jsonResponse(res, 403, { error: 'An agent may activate only its own encryption custody' });
      return true;
    }
    const result = activation
      ? await agent.activateEncryptionKeyEnrollment(body)
      : await agent.prepareEncryptionKeyEnrollment(body.agentAddress);
    jsonResponse(res, activation ? 200 : 201, result);
  } catch (error) {
    jsonResponse(res, 400, { error: error instanceof Error ? error.message : 'Encryption enrollment failed' });
  }
  return true;
}
