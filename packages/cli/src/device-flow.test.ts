import { describe, expect, it } from 'vitest';
import { DeviceFlowError, loginWithDeviceFlow } from './device-flow.js';

/**
 * The device flow is exercised against a scripted fetch: polls return
 * authorization_pending, then slow_down (interval +5), then success. The
 * injected sleep records the throttled waits without real delays.
 */

function jsonResponse(body: Record<string, unknown>, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function formBody(request: RequestInit | undefined): URLSearchParams {
  return new URLSearchParams(String(request?.body));
}

describe('loginWithDeviceFlow', () => {
  it('runs the full flow: device code -> pending -> slow_down -> token', async () => {
    const sleeps: number[] = [];
    const calls: Array<{ url: string; body: URLSearchParams }> = [];

    const fetchFn: typeof fetch = (input, init) => {
      calls.push({ url: String(input), body: formBody(init) });
      if (calls.length === 1) {
        return Promise.resolve(
          jsonResponse({
            device_code: 'devcode123',
            user_code: 'WDJB-MJHT',
            verification_uri: 'https://github.com/login/device',
            expires_in: 900,
            interval: 5,
          }),
        );
      }
      if (calls.length === 2) {
        return Promise.resolve(jsonResponse({ error: 'authorization_pending' }));
      }
      if (calls.length === 3) {
        return Promise.resolve(jsonResponse({ error: 'slow_down', interval: 10 }));
      }
      return Promise.resolve(jsonResponse({ access_token: 'ghu_test-token' }));
    };

    const token = await loginWithDeviceFlow('cli-client-id', {
      fetch: fetchFn,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });

    expect(token).toBe('ghu_test-token');
    // First poll waits the initial interval; slow_down bumps the next wait by 5s.
    expect(sleeps).toEqual([5_000, 5_000, 10_000]);

    expect(calls[0]?.url).toBe('https://github.com/login/device/code');
    expect(calls[0]?.body.get('client_id')).toBe('cli-client-id');
    expect(calls[1]?.url).toBe('https://github.com/login/oauth/access_token');
    expect(calls[1]?.body.get('device_code')).toBe('devcode123');
    expect(calls[1]?.body.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
  });

  it('throws a user-actionable error on access_denied', async () => {
    let callCount = 0;
    const fetchFn: typeof fetch = () => {
      callCount += 1;
      return Promise.resolve(
        callCount === 1
          ? jsonResponse({
              device_code: 'd',
              user_code: 'WDJB-MJHT',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 1,
            })
          : jsonResponse({ error: 'access_denied' }),
      );
    };

    await expect(
      loginWithDeviceFlow('cli-client-id', { fetch: fetchFn, sleep: async () => {} }),
    ).rejects.toThrow(DeviceFlowError);
  });

  it('throws on expired_token and on an empty client id', async () => {
    let callCount = 0;
    const fetchFn: typeof fetch = () => {
      callCount += 1;
      return Promise.resolve(
        callCount === 1
          ? jsonResponse({
              device_code: 'd',
              user_code: 'WDJB-MJHT',
              verification_uri: 'https://github.com/login/device',
              expires_in: 900,
              interval: 1,
            })
          : jsonResponse({ error: 'expired_token' }),
      );
    };

    await expect(
      loginWithDeviceFlow('cli-client-id', { fetch: fetchFn, sleep: async () => {} }),
    ).rejects.toThrow(/expired/);

    await expect(
      loginWithDeviceFlow('', { fetch: fetchFn, sleep: async () => {} }),
    ).rejects.toThrow(/client id/);
  });
});
