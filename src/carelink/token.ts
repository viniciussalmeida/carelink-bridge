import fs from 'node:fs';
import axios from 'axios';
import qs from 'qs';
import type { LoginData } from '../types/carelink.js';

interface RefreshTokenOptions {
  maxAttempts?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt: number): number {
  return Math.min(8000, 1000 * Math.pow(2, attempt - 1));
}

function extractErrorText(data: unknown): string {
  if (!data || typeof data !== 'object') return '';
  const obj = data as Record<string, unknown>;
  const error = typeof obj['error'] === 'string' ? obj['error'] : '';
  const description = typeof obj['error_description'] === 'string' ? obj['error_description'] : '';
  return (error + ' ' + description).toLowerCase().trim();
}

export function isRefreshFatalError(error: unknown): boolean {
  if (!axios.isAxiosError(error)) return false;

  const status = error.response?.status;
  const text = extractErrorText(error.response?.data);

  // Auth0-style terminal refresh failures.
  if (text.includes('invalid_grant') || text.includes('invalid_token')) return true;
  if (text.includes('expired') || text.includes('revoked')) return true;

  // Explicit auth failures should force re-login.
  if (status === 401 || status === 403) return true;
  if (status === 400 && (text.includes('invalid') || text.includes('unauthorized'))) return true;

  return false;
}

export function loadLoginData(filePath: string): LoginData | null {
  try {
    if (!fs.existsSync(filePath)) return null;

    const data: LoginData = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const required: (keyof LoginData)[] = ['access_token', 'refresh_token', 'client_id', 'token_url'];

    for (const field of required) {
      if (!data[field]) {
        console.log('[Token] logindata.json missing field: ' + field);
        return null;
      }
    }
    return data;
  } catch (e) {
    console.log('[Token] Failed to read logindata.json:', (e as Error).message);
    return null;
  }
}

export function saveLoginData(filePath: string, data: LoginData): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 4));
}

export function isTokenExpired(accessToken: string): boolean {
  try {
    const parts = accessToken.split('.');
    if (parts.length !== 3) return true;

    const payload = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
    if (!payload.exp) return true;

    // Expired if less than 1 minute remaining
    return payload.exp * 1000 < Date.now() + 60 * 1000;
  } catch (e) {
    console.log('[Token] Failed to decode JWT:', (e as Error).message);
    return true;
  }
}

export function isRefreshTokenLikelyExpired(loginData: LoginData): boolean {
  if (!loginData.refresh_expires_at) return false;
  return loginData.refresh_expires_at < Date.now() + 60 * 1000;
}

export async function refreshToken(loginData: LoginData, options: RefreshTokenOptions = {}): Promise<LoginData> {
  const maxAttempts = options.maxAttempts ?? 3;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (attempt === 1) {
        console.log('[Token] Refreshing access token...');
      } else {
        console.log(`[Token] Retrying token refresh (attempt ${attempt}/${maxAttempts})...`);
      }

      const resp = await axios.post(
        loginData.token_url,
        qs.stringify({
          grant_type: 'refresh_token',
          client_id: loginData.client_id,
          refresh_token: loginData.refresh_token,
        }),
        { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
      );

      loginData.access_token = resp.data.access_token;
      if (resp.data.refresh_token) {
        loginData.refresh_token = resp.data.refresh_token;
      }

      // Some providers include refresh token lifetime metadata.
      const refreshExpiresIn = Number(resp.data.refresh_expires_in ?? resp.data.refresh_token_expires_in);
      if (!Number.isNaN(refreshExpiresIn) && refreshExpiresIn > 0) {
        loginData.refresh_expires_at = Date.now() + refreshExpiresIn * 1000;
      }

      console.log('[Token] Token refreshed successfully');
      return loginData;
    } catch (error) {
      lastError = error;
      if (isRefreshFatalError(error) || attempt === maxAttempts) {
        throw error;
      }

      const delayMs = getRetryDelayMs(attempt);
      console.error(`[Token] Transient refresh error, retrying in ${Math.round(delayMs / 1000)}s...`);
      await sleep(delayMs);
    }
  }

  throw lastError instanceof Error ? lastError : new Error('Token refresh failed');
}
