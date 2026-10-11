/**
 * GitHub OAuth device flow for the phelm CLI (T-0009).
 *
 * Protocol facts verified against the GitHub docs on 2026-10-11:
 * - Works with a GitHub App's client_id once device flow is ENABLED in the
 *   app's settings; GitHub Apps take no `scope` (permissions are set on the
 *   app; the only legal scope value, offline_access, is deliberately not
 *   requested here so the token does not expire — refresh handling is
 *   follow-up work).
 * - POST {github}/login/device/code (form body) with Accept: application/json
 *   -> device_code, user_code, verification_uri, expires_in, interval.
 * - Poll POST {github}/login/oauth/access_token with grant_type
 *   "urn:ietf:params:oauth:grant-type:device_code". Errors: authorization_pending
 *   (keep polling at `interval`), slow_down (interval += 5s), access_denied,
 *   expired_token.
 *
 * The token is the ONLY secret here; it is handed to the caller for storage
 * and never logged by this module.
 */

export const DEFAULT_GITHUB_LOGIN_URL = 'https://github.com';

export class DeviceFlowError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DeviceFlowError';
  }
}

export interface DeviceFlowDeps {
  /** Overridable transport/clock for tests. */
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

async function postForm(
  fetchFn: typeof fetch,
  url: string,
  params: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetchFn(url, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new DeviceFlowError(`device flow endpoint returned a non-JSON body (${response.status})`);
  }
  return { status: response.status, body };
}

function requireString(body: Record<string, unknown>, key: string): string {
  const value = body[key];
  if (typeof value !== 'string' || value === '') {
    throw new DeviceFlowError(`device flow response is missing '${key}'`);
  }
  return value;
}

/**
 * Run the device flow end to end. Prints the user instructions, polls until
 * the token arrives, and returns it. Throws DeviceFlowError with a
 * user-actionable message on denial, expiry or misconfiguration.
 */
export async function loginWithDeviceFlow(
  clientId: string,
  deps: DeviceFlowDeps = {},
  options: { githubLoginUrl?: string } = {},
): Promise<string> {
  const fetchFn = deps.fetch ?? fetch;
  const sleep =
    deps.sleep ??
    (async (ms: number) => {
      await new Promise((r) => setTimeout(r, ms));
    });
  const baseUrl = options.githubLoginUrl ?? DEFAULT_GITHUB_LOGIN_URL;

  if (clientId === '') {
    throw new DeviceFlowError(
      'no client id: pass --client-id, set PHELM_CLIENT_ID, or see the login guide in the README',
    );
  }

  const code = await postForm(fetchFn, `${baseUrl}/login/device/code`, { client_id: clientId });
  const deviceCode: DeviceCodeResponse = {
    device_code: requireString(code.body, 'device_code'),
    user_code: requireString(code.body, 'user_code'),
    verification_uri: requireString(code.body, 'verification_uri'),
    expires_in: typeof code.body.expires_in === 'number' ? code.body.expires_in : 900,
    interval: typeof code.body.interval === 'number' ? code.body.interval : 5,
  };

  console.log(`1. Open ${deviceCode.verification_uri} in a browser`);
  console.log(`2. Enter the code: ${deviceCode.user_code}`);
  console.log('Waiting for authorization...');

  const deadline = Date.now() + deviceCode.expires_in * 1_000;
  let interval = deviceCode.interval;

  for (;;) {
    if (Date.now() >= deadline) {
      throw new DeviceFlowError(
        'the device code expired before authorization completed; run phelm login again',
      );
    }
    await sleep(interval * 1_000);

    const poll = await postForm(fetchFn, `${baseUrl}/login/oauth/access_token`, {
      client_id: clientId,
      device_code: deviceCode.device_code,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    });
    if (typeof poll.body.access_token === 'string' && poll.body.access_token !== '') {
      return poll.body.access_token;
    }
    const error = typeof poll.body.error === 'string' ? poll.body.error : 'unknown_error';
    if (error === 'authorization_pending') {
      continue;
    }
    if (error === 'slow_down') {
      interval += 5;
      continue;
    }
    if (error === 'access_denied') {
      throw new DeviceFlowError('authorization was denied in the browser; run phelm login again');
    }
    if (error === 'expired_token') {
      throw new DeviceFlowError('the device code expired; run phelm login again');
    }
    throw new DeviceFlowError(`device flow failed: ${error}`);
  }
}
