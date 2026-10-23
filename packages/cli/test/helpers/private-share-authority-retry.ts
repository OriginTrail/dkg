// Only this producer diagnostic occurs before claiming a promote intent or
// writing SWM. Re-submit the same sealed named assertion; never rebuild it.
export const PRIVATE_SHARE_AUTHORITY_RETRY_ERROR =
  '[promote:encodeWorkspaceGossipPayload] A promote prerequisite is temporarily unavailable';

export async function retryPrivateShareAuthority<T extends {
  status: number;
  body: { error?: unknown };
}>(
  submit: () => Promise<T>,
  wait: (milliseconds: number) => Promise<void> =
    milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
): Promise<T> {
  const delays = [250, 500, 1_000];
  for (let attempt = 0; ; attempt += 1) {
    const result = await submit();
    if (result.status !== 500
      || result.body.error !== PRIVATE_SHARE_AUTHORITY_RETRY_ERROR
      || attempt === delays.length) return result;
    await wait(delays[attempt]!);
  }
}
