import axios, { AxiosError } from 'axios';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  isRefreshFatalError,
  isRefreshTokenLikelyExpired,
  refreshToken,
} from '../src/carelink/token.js';
import type { LoginData } from '../src/types/carelink.js';

function baseLoginData(): LoginData {
  return {
    access_token: 'old-access-token',
    refresh_token: 'old-refresh-token',
    client_id: 'test-client',
    token_url: 'https://example.com/oauth/token',
    audience: 'carepartner.patient.ous',
  };
}

function axiosError(
  status?: number,
  data?: Record<string, unknown>,
  code?: string,
): AxiosError {
  return new AxiosError(
    'request failed',
    code,
    undefined,
    undefined,
    status === undefined ? undefined : {
      status,
      statusText: 'Error',
      headers: {},
      config: {} as never,
      data,
    },
  );
}

describe('token refresh hardening', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('marks invalid_grant refresh responses as fatal', () => {
    const err = axiosError(400, { error: 'invalid_grant', error_description: 'refresh token expired' });
    expect(isRefreshFatalError(err)).toBe(true);
  });

  it('marks transient server errors as non-fatal', () => {
    const err = axiosError(503, { error: 'server_error' });
    expect(isRefreshFatalError(err)).toBe(false);
  });

  it('retries transient refresh failures and succeeds', async () => {
    vi.useFakeTimers();

    const postSpy = vi.spyOn(axios, 'post');
    postSpy.mockRejectedValueOnce(axiosError(undefined, undefined, 'ETIMEDOUT'));
    postSpy.mockResolvedValueOnce({
      data: {
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        refresh_expires_in: 7200,
      },
    } as never);

    const loginData = baseLoginData();
    const resultPromise = refreshToken(loginData, { maxAttempts: 3 });

    await vi.advanceTimersByTimeAsync(1000);
    const result = await resultPromise;

    expect(postSpy).toHaveBeenCalledTimes(2);
    expect(result.access_token).toBe('new-access-token');
    expect(result.refresh_token).toBe('new-refresh-token');
    expect(result.refresh_expires_at).toBeTypeOf('number');
  });

  it('does not retry fatal refresh failures', async () => {
    const postSpy = vi.spyOn(axios, 'post');
    postSpy.mockRejectedValueOnce(
      axiosError(400, { error: 'invalid_grant', error_description: 'token is invalid' }),
    );

    await expect(refreshToken(baseLoginData(), { maxAttempts: 3 })).rejects.toBeInstanceOf(AxiosError);
    expect(postSpy).toHaveBeenCalledTimes(1);
  });

  it('reports refresh token expiry when refresh_expires_at is near', () => {
    const loginData = baseLoginData();
    loginData.refresh_expires_at = Date.now() + 30_000;

    expect(isRefreshTokenLikelyExpired(loginData)).toBe(true);
  });
});
