import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import axios, { type AxiosInstance } from 'axios';
import * as logger from '../logger.js';
import {
  loadLoginData,
  saveLoginData,
  isTokenExpired,
  isRefreshTokenLikelyExpired,
  isRefreshFatalError,
  refreshToken,
} from './token.js';
import { loadProxyList, createProxyAgent, ProxyRotator } from './proxy.js';
import { resolveServerName, buildUrls, type CareLinkUrls } from './urls.js';
import type { CareLinkData, CareLinkUserInfo, CareLinkPatientLink, CareLinkCountrySettings } from '../types/carelink.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MAX_REQUESTS_PER_FETCH = 30;
const DEFAULT_MAX_RETRY_DURATION = 512;

interface CarepartnerPayloadSummary {
  markerCount: number;
  autoBasalCount: number;
  autoBasalWithNumericValue: number;
  insulinCount: number;
  mealCount: number;
  unknownCount: number;
  therapyKeys: string[];
  therapyHasNumericBasalRate: boolean;
  markerKindsTop: Array<[string, number]>;
}

function envFlag(name: string): boolean {
  return (process.env[name] || 'false').toLowerCase() === 'true';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function toRecordArray(value: unknown): Record<string, unknown>[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is Record<string, unknown> => !!asRecord(item));
  }

  const record = asRecord(value);
  if (!record) return [];

  for (const key of ['items', 'history', 'notifications', 'markers', 'data', 'value']) {
    if (Array.isArray(record[key])) {
      return (record[key] as unknown[])
        .filter((item): item is Record<string, unknown> => !!asRecord(item));
    }
  }

  return [record];
}

function extractNestedNumber(record: Record<string, unknown>, path: string): number | undefined {
  const parts = path.split('.');
  let current: unknown = record;

  for (const part of parts) {
    if (!current || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[part];
  }

  if (typeof current === 'number' && Number.isFinite(current)) return current;
  if (typeof current === 'string') {
    const parsed = Number.parseFloat(current);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function extractNumericBasalSignal(marker: Record<string, unknown>): number | undefined {
  const directKeys = ['basalRate', 'rate', 'deliveredRate', 'amount', 'value', 'bolusAmount', 'autoBasalBolus'];
  for (const key of directKeys) {
    const value = marker[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
    if (typeof value === 'string') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  const nestedPaths = [
    'data.basalRate',
    'data.rate',
    'data.amount',
    'payload.basalRate',
    'payload.rate',
    'payload.amount',
    'data.bolusAmount',
    'payload.bolusAmount',
  ];
  for (const path of nestedPaths) {
    const value = extractNestedNumber(marker, path);
    if (value !== undefined) return value;
  }

  return undefined;
}

function summarizeCarepartnerPayload(data: CareLinkData): CarepartnerPayloadSummary {
  const markers = toRecordArray(data.markers);
  const kinds = new Map<string, number>();

  let autoBasalCount = 0;
  let autoBasalWithNumericValue = 0;
  let insulinCount = 0;
  let mealCount = 0;
  let unknownCount = 0;

  for (const marker of markers) {
    const kind = String(marker['type'] || marker['kind'] || 'UNKNOWN').toUpperCase();
    kinds.set(kind, (kinds.get(kind) || 0) + 1);

    if (kind.includes('AUTO') && kind.includes('BASAL')) {
      autoBasalCount++;
      const value = extractNumericBasalSignal(marker);
      if (value != null && value > 0) autoBasalWithNumericValue++;
      continue;
    }

    if (kind === 'INSULIN' || kind.includes('BOLUS') || kind.includes('INSULIN')) {
      insulinCount++;
      continue;
    }

    if (kind === 'MEAL' || kind.includes('MEAL') || kind.includes('CARB')) {
      mealCount++;
      continue;
    }

    unknownCount++;
  }

  const therapy = asRecord(data.therapyAlgorithmState);
  const therapyKeys = therapy ? Object.keys(therapy).sort() : [];
  const therapyHasNumericBasalRate = !!therapy && [
    'autoBasalRate',
    'currentAutoBasalRate',
    'activeBasalRate',
    'safeBasalRate',
  ].some((key) => {
    const value = therapy[key];
    return (typeof value === 'number' && Number.isFinite(value))
      || (typeof value === 'string' && Number.isFinite(Number.parseFloat(value)));
  });

  return {
    markerCount: markers.length,
    autoBasalCount,
    autoBasalWithNumericValue,
    insulinCount,
    mealCount,
    unknownCount,
    therapyKeys,
    therapyHasNumericBasalRate,
    markerKindsTop: [...kinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12),
  };
}

export interface CareLinkClientOptions {
  username: string;
  password: string;
  server?: string;
  serverName?: string;
  countryCode?: string;
  lang?: string;
  patientId?: string;
  maxRetryDuration?: number;
}

export class CareLinkClient {
  private axiosInstance: AxiosInstance;
  private proxyRotator: ProxyRotator;
  private urls: CareLinkUrls;
  private loginDataPath: string;
  private serverName: string;
  private options: CareLinkClientOptions;
  private requestCount = 0;

  constructor(options: CareLinkClientOptions) {
    this.options = options;

    const countryCode = options.countryCode || process.env['MMCONNECT_COUNTRYCODE'] || 'gb';
    const lang = options.lang || process.env['MMCONNECT_LANGCODE'] || 'en';

    this.serverName = resolveServerName(
      options.server || process.env['MMCONNECT_SERVER'],
      options.serverName || process.env['MMCONNECT_SERVERNAME'],
    );
    this.urls = buildUrls(this.serverName, countryCode, lang);
    this.loginDataPath = path.join(__dirname, '..', '..', 'logindata.json');

    // Load proxy list
    const useProxy = (process.env['USE_PROXY'] || 'true').toLowerCase() !== 'false';
    const proxyFile = path.join(__dirname, '..', '..', 'https.txt');
    const proxies = useProxy ? loadProxyList(proxyFile) : [];
    this.proxyRotator = new ProxyRotator(proxies);

    // Set up axios
    this.axiosInstance = axios.create({
      maxRedirects: 0,
      timeout: 15_000,
    });

    // Response interceptor: treat 2xx/3xx as success
    this.axiosInstance.interceptors.response.use(
      response => response,
      error => {
        if (error.response?.status >= 200 && error.response?.status < 400) {
          return error.response;
        }
        return Promise.reject(error);
      },
    );

    // Request interceptor: count requests and set headers
    this.axiosInstance.interceptors.request.use(config => {
      this.requestCount++;
      if (this.requestCount > MAX_REQUESTS_PER_FETCH) {
        throw new Error('Request count exceeds the maximum in one fetch!');
      }

      config.headers['User-Agent'] = USER_AGENT;
      config.headers['Accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8';
      config.headers['Accept-Language'] = 'en-US,en;q=0.9';
      config.headers['Accept-Encoding'] = 'gzip, deflate';
      config.headers['Connection'] = 'keep-alive';
      return config;
    });

    // Apply first proxy
    if (this.proxyRotator.hasProxies) {
      this.applyProxy(this.proxyRotator.getNext());
    }
  }

  private applyProxy(proxy: { ip: string; port: string; username?: string; password?: string; protocols: string[] } | null): void {
    if (proxy) {
      const agent = createProxyAgent(proxy);
      if (agent) {
        this.axiosInstance.defaults.httpsAgent = agent;
        this.axiosInstance.defaults.httpAgent = agent;
        console.log(`[Proxy] Using proxy: ${proxy.ip}:${proxy.port}${proxy.username ? ' (authenticated)' : ''}`);
      }
    } else {
      this.axiosInstance.defaults.httpsAgent = undefined;
      this.axiosInstance.defaults.httpAgent = undefined;
    }
  }

  private async authenticate(): Promise<void> {
    let loginData = loadLoginData(this.loginDataPath);
    if (!loginData) {
      throw new Error(
        'No logindata.json found. Run "npm run login" first to authenticate with CareLink.',
      );
    }

    if (isTokenExpired(loginData.access_token)) {
      const previousRefreshToken = loginData.refresh_token;
      try {
        loginData = await refreshToken(loginData);
        try {
          saveLoginData(this.loginDataPath, loginData);
        } catch (saveError) {
          const rotated = loginData.refresh_token !== previousRefreshToken;
          console.error(
            '[Token] Failed to persist refreshed tokens to logindata.json:',
            (saveError as Error).message,
          );
          if (rotated) {
            console.error('[Token] Refresh token rotated but was not persisted; a restart may require re-login.');
          }
        }
      } catch (e) {
        const fatal = isRefreshFatalError(e) || isRefreshTokenLikelyExpired(loginData);

        if (!fatal) {
          console.error('[Token] Temporary refresh error. Keeping logindata.json and retrying later.');
          throw new Error('Temporary refresh failure. Will retry automatically.');
        }

        let deleted = false;
        try {
          fs.unlinkSync(this.loginDataPath);
          deleted = true;
        } catch (unlinkError) {
          console.error(
            '[Token] Could not delete stale logindata.json:',
            (unlinkError as Error).message,
          );
        }

        if (deleted) {
          console.error('[Token] Deleted stale logindata.json — run "npm run login" to re-authenticate.');
        } else {
          console.error('[Token] Stale logindata.json kept on disk — run "npm run login" to re-authenticate.');
        }

        throw new Error('Refresh token no longer valid. Run "npm run login" to log in again.');
      }
    }

    this.axiosInstance.defaults.headers.common['Authorization'] = 'Bearer ' + loginData.access_token;
    console.log('[Token] Using token-based auth from logindata.json');
  }

  private async getCurrentRole(): Promise<string> {
    const resp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
    return resp.data?.role?.toUpperCase() ?? '';
  }

  private async getConnectData(): Promise<CareLinkData> {
    const role = await this.getCurrentRole();
    logger.log('getConnectData - currentRole:', role);

    if (role === 'CARE_PARTNER_OUS' || role === 'CARE_PARTNER') {
      return this.fetchAsCarepartner(role);
    }
    return this.fetchAsPatient();
  }

  private async fetchAsCarepartner(_role: string): Promise<CareLinkData> {
    let patientId = this.options.patientId;

    if (!patientId) {
      const patientsResp = await this.axiosInstance.get<CareLinkPatientLink[]>(this.urls.linkedPatients);
      if (patientsResp.data?.length > 0) {
        patientId = patientsResp.data[0].username;
        logger.log('Using linked patient:', patientId);
      } else {
        throw new Error('No linked patients found for care partner account');
      }
    }

    // Check if patient has a BLE device by fetching monitor data first
    try {
      const monitorResp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);
      if (monitorResp.data && this.isBleDevice(monitorResp.data.medicalDeviceFamily)) {
        logger.log('BLE device detected for carepartner, using BLE endpoint');
        return this.fetchBleDeviceData(patientId, 'carepartner');
      }
    } catch {
      // Fall through to standard carepartner flow
    }

    // Standard carepartner flow: BLE endpoint with multi-version fallback
    logger.log('Fetching country settings from:', this.urls.countrySettings);
    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const dataRetrievalUrl = settingsResp.data?.blePereodicDataEndpoint;

    if (!dataRetrievalUrl) {
      throw new Error('Unable to retrieve data retrieval URL for care partner account');
    }

    logger.log('Data retrieval URL:', dataRetrievalUrl);

    const debugCompareEndpoints = envFlag('CARELINK_DEBUG_COMPARE_ENDPOINTS');

    // Try multiple API versions
    const endpoints = Array.from(new Set([
      dataRetrievalUrl,
      dataRetrievalUrl.replace('/v6/', '/v5/'),
      dataRetrievalUrl.replace('/v6/', '/v11/'),
      dataRetrievalUrl.replace('/v5/', '/v6/'),
      dataRetrievalUrl.replace('/v5/', '/v11/'),
    ]));

    const body: Record<string, string> = {
      username: this.options.username,
      role: 'carepartner',
      patientId,
    };

    const successfulResponses: Array<{
      endpoint: string;
      data: CareLinkData;
      summary: CarepartnerPayloadSummary;
    }> = [];

    for (const endpoint of endpoints) {
      try {
        logger.log('Trying carepartner endpoint:', endpoint);
        const resp = await this.axiosInstance.post<CareLinkData>(endpoint, body, {
          headers: { 'Content-Type': 'application/json' },
        });
        if (resp.status === 200) {
          const summary = summarizeCarepartnerPayload(resp.data);
          logger.log(
            'GET data (as carepartner)',
            endpoint,
            JSON.stringify({
              markerCount: summary.markerCount,
              autoBasalCount: summary.autoBasalCount,
              autoBasalWithNumericValue: summary.autoBasalWithNumericValue,
              therapyHasNumericBasalRate: summary.therapyHasNumericBasalRate,
            }),
          );

          successfulResponses.push({ endpoint, data: resp.data, summary });
          if (!debugCompareEndpoints) {
            return resp.data;
          }
        }
      } catch {
        logger.log('Endpoint failed:', endpoint);
      }
    }

    if (successfulResponses.length > 0) {
      if (!debugCompareEndpoints) {
        return successfulResponses[0].data;
      }

      const scored = successfulResponses.map((entry) => {
        const score =
          entry.summary.autoBasalWithNumericValue * 10_000 +
          entry.summary.autoBasalCount * 100 +
          (entry.summary.therapyHasNumericBasalRate ? 5_000 : 0) +
          entry.summary.markerCount;
        return { ...entry, score };
      });

      scored.sort((a, b) => b.score - a.score);

      logger.log(
        '[CarePartner compare] endpoint summaries=',
        JSON.stringify(
          scored.map((entry) => ({
            endpoint: entry.endpoint,
            score: entry.score,
            markerCount: entry.summary.markerCount,
            autoBasalCount: entry.summary.autoBasalCount,
            autoBasalWithNumericValue: entry.summary.autoBasalWithNumericValue,
            therapyHasNumericBasalRate: entry.summary.therapyHasNumericBasalRate,
            therapyKeys: entry.summary.therapyKeys,
            markerKindsTop: entry.summary.markerKindsTop,
          })),
        ),
      );

      logger.log('[CarePartner compare] selected endpoint:', scored[0].endpoint);
      return scored[0].data;
    }

    throw new Error('All carepartner data endpoints failed');
  }

  private isBleDevice(deviceFamily: string | undefined): boolean {
    if (!deviceFamily) return false;
    return deviceFamily.includes('BLE') || deviceFamily.includes('SIMPLERA');
  }

  private async fetchBleDeviceData(patientId?: string, role: string = 'patient'): Promise<CareLinkData> {
    logger.log('Fetching BLE device data');

    const settingsResp = await this.axiosInstance.get<CareLinkCountrySettings>(this.urls.countrySettings);
    const bleEndpoint = settingsResp.data?.blePereodicDataEndpoint;

    if (!bleEndpoint) {
      throw new Error('No BLE endpoint found in country settings');
    }

    if (!patientId) {
      const userResp = await this.axiosInstance.get<CareLinkUserInfo>(this.urls.me);
      patientId = userResp.data?.id;
    }

    const body: Record<string, string> = {
      username: this.options.username,
      role,
    };

    if (patientId) {
      body.patientId = patientId;
    }

    const resp = await this.axiosInstance.post<CareLinkData>(bleEndpoint, body, {
      headers: {
        'Content-Type': 'application/json',
        'Accept': 'application/json, text/plain, */*',
      },
    });

    if (resp.data && resp.status === 200) {
      logger.log('GET data (BLE)', bleEndpoint);
      return resp.data;
    }

    throw new Error('BLE endpoint returned empty data');
  }

  private async fetchAsPatient(): Promise<CareLinkData> {
    // Try the monitor endpoint first (works for 7xxG pumps)
    try {
      const resp = await this.axiosInstance.get<CareLinkData>(this.urls.monitorData);

      if (resp.data && this.isBleDevice(resp.data.medicalDeviceFamily)) {
        logger.log('BLE device detected, using BLE endpoint');
        return this.fetchBleDeviceData();
      }

      if (resp.status === 200 && resp.data && Object.keys(resp.data).length > 1) {
        logger.log('GET data', this.urls.monitorData);
        return resp.data;
      }
    } catch {
      // Fall through to legacy endpoint
    }

    // Fall back to legacy connect endpoint
    const url = this.urls.connectData(Date.now());
    const resp = await this.axiosInstance.get<CareLinkData>(url);
    logger.log('GET data', url);
    return resp.data;
  }

  async fetch(): Promise<CareLinkData> {
    this.requestCount = 0;
    this.proxyRotator.resetRetries();

    const maxRetry = this.proxyRotator.hasProxies ? 10 : 1;
    console.log('[Fetch] Starting fetch, max retries:', maxRetry);

    for (let i = 1; i <= maxRetry; i++) {
      try {
        this.requestCount = 0;
        await this.authenticate();
        const data = await this.getConnectData();
        console.log('[Fetch] Success!');
        return data;
      } catch (e: unknown) {
        const err = e as { response?: { status: number }; code?: string; cause?: { code?: string }; message?: string };
        const httpStatus = err.response?.status;
        const errorCode = err.code || err.cause?.code || '';
        const isProxyError = [400, 403, 407, 502, 503].includes(httpStatus ?? 0);
        const isNetworkError = ['ECONNREFUSED', 'ETIMEDOUT', 'ECONNRESET', 'ENOTFOUND', 'EPROTO', 'ERR_SOCKET_BAD_PORT'].includes(errorCode);

        console.log(`[Fetch] Attempt ${i} failed: ${httpStatus ? 'HTTP ' + httpStatus : errorCode || (err as Error).message}`);

        if ((isProxyError || isNetworkError) && this.proxyRotator.hasProxies) {
          console.log('[Fetch] Trying next proxy...');
          const nextProxy = this.proxyRotator.tryNext();
          if (!nextProxy) throw e;
          this.applyProxy(nextProxy);
          await sleep(1000);
          continue;
        }

        if (i === maxRetry) throw e;

        const timeout = Math.pow(2, i);
        await sleep(1000 * timeout);
      }
    }

    throw new Error('Fetch failed after all retries');
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
