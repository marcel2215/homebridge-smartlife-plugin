import { createHash, createHmac, createPublicKey, publicEncrypt, randomUUID, constants as cryptoConstants } from 'node:crypto';

import type { LogLevel, SmartLifeRegion } from '../config.js';
import type {
  ApiRequestOptions,
  ProductRef,
  ProductStandardConfig,
  SmartLifeApiResponse,
  SmartLifeDevice,
  SmartLifeHome,
  SmartLifeLoginResponse,
  SmartLifeTokenResponse,
} from './types.js';

const APP_KEY = 'ekmnwp9f5pnh3trdtpgy';
const APP_SECRET = 'r3me7ghmxjevrvnpemwmhw3fxtacphyg';
const APP_SECRET_2 = 'jfg5rs5kkmrj5mxahugvucrsvw43t48x';
const APP_CERT_SHA256 = '0F:C3:61:99:9C:C0:C3:5B:A8:AC:A5:7D:AA:55:93:A2:0C:F5:57:27:70:2E:A8:5A:D7:B3:22:89:49:F8:88:FE';
const APP_TTID = 'smartlife';
const ET_VERSION = '0.0.1';

const LOGIN_NON_RETRYABLE_CODES = new Set([
  'USER_PASSWD_WRONG',
  'USER_LOGIN_INVALID',
  'USER_NOT_EXISTS',
  'USER_NOT_REGISTER',
]);

const SESSION_ERROR_CODES = new Set([
  'USER_SESSION_INVALID',
  'TOKEN_INVALID',
  'TOKEN_EXPIRED',
]);

const RETRYABLE_CODES = new Set([
  'FrequentlyInvoke',
  'FREQUENTLY_INVOKE',
  'SYSTEM_ERROR',
  'REQUEST_ERROR',
]);

const ENDPOINTS: Record<'us' | 'eu' | 'in', string> = {
  us: 'https://a1-us.lifeaiot.com/api.json',
  eu: 'https://a1-eu.lifeaiot.com/api.json',
  in: 'https://a1-in.lifeaiot.com/api.json',
};

const SIGNED_KEYS = new Set([
  'a',
  'v',
  'lat',
  'lon',
  'lang',
  'deviceId',
  'imei',
  'imsi',
  'appVersion',
  'ttid',
  'isH5',
  'h5Token',
  'os',
  'clientId',
  'postData',
  'time',
  'requestId',
  'n4h5',
  'sid',
  'sp',
  'et',
]);

function backoffDelay(attempt: number): number {
  const base = 500;
  const max = 8000;
  return Math.min(max, base * Math.pow(2, attempt - 1));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mobileHash(value: string): string {
  const md5 = createHash('md5').update(value).digest('hex');
  return md5.slice(8, 16) + md5.slice(0, 8) + md5.slice(24, 32) + md5.slice(16, 24);
}

function bigIntDecimalToBuffer(decimal: string): Buffer {
  const sanitized = decimal.trim();
  if (!/^[0-9]+$/.test(sanitized)) {
    throw new Error('Invalid decimal integer');
  }

  let hex = BigInt(sanitized).toString(16);
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  const bytes = Buffer.from(hex, 'hex');
  if (bytes.length === 0) {
    return Buffer.from([0]);
  }

  return bytes;
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function encryptPasswordWithPublicKeyExponent(passwordMd5Hex: string, modulusDecimal: string, exponentDecimal: string): string {
  const key = createPublicKey({
    key: {
      kty: 'RSA',
      n: toBase64Url(bigIntDecimalToBuffer(modulusDecimal)),
      e: toBase64Url(bigIntDecimalToBuffer(exponentDecimal)),
    },
    format: 'jwk',
  });

  return publicEncrypt(
    {
      key,
      padding: cryptoConstants.RSA_PKCS1_PADDING,
    },
    Buffer.from(passwordMd5Hex, 'utf8'),
  ).toString('hex');
}

function randomDeviceId(length: number): string {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';

  for (let i = 0; i < length; i += 1) {
    const index = Math.floor(Math.random() * alphabet.length);
    result += alphabet[index];
  }

  return result;
}

function normalizeApiUrl(url: string): string {
  if (url.endsWith('/api.json')) {
    return url;
  }

  return `${url.replace(/\/$/, '')}/api.json`;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function redactRequestParamsForLog(params: Record<string, string>): Record<string, string> {
  const redacted = { ...params };

  if (redacted.sid) {
    redacted.sid = '<redacted>';
  }
  if (redacted.sign) {
    redacted.sign = '<redacted>';
  }

  if (typeof redacted.postData === 'string' && redacted.postData.length > 0) {
    try {
      const parsed = JSON.parse(redacted.postData) as Record<string, unknown>;
      for (const key of ['passwd', 'token', 'code', 'email', 'mobile']) {
        if (parsed[key] !== undefined) {
          parsed[key] = '<redacted>';
        }
      }
      redacted.postData = JSON.stringify(parsed);
    } catch {
      redacted.postData = '<redacted>';
    }
  }

  return redacted;
}

function redactResponseForLog<T>(payload: SmartLifeApiResponse<T>): SmartLifeApiResponse<T> {
  const result = payload.result;
  if (!result || typeof result !== 'object') {
    return payload;
  }

  const copy = { ...(result as Record<string, unknown>) };
  for (const key of ['sid', 'token', 'ecode', 'uid']) {
    if (copy[key] !== undefined) {
      copy[key] = '<redacted>';
    }
  }

  if (typeof copy.email === 'string') {
    copy.email = '<redacted>';
  }
  if (typeof copy.mobile === 'string') {
    copy.mobile = '<redacted>';
  }

  return {
    ...payload,
    result: copy as T,
  };
}

function normalizeProductRef(raw: ProductRef): ProductRef | undefined {
  const productId = typeof raw.id === 'string' && raw.id.length > 0
    ? raw.id
    : (typeof raw.productId === 'string' && raw.productId.length > 0 ? raw.productId : undefined);

  if (!productId) {
    return undefined;
  }

  const schemaText = raw.schemaInfo?.schema;
  let parsedSchema: Array<{ code?: string; id?: number | string; mode?: string }> = [];
  if (typeof schemaText === 'string' && schemaText.length > 0) {
    try {
      const value = JSON.parse(schemaText);
      if (Array.isArray(value)) {
        parsedSchema = value
          .filter((item): item is { code?: string; id?: number | string; mode?: string } => typeof item === 'object' && item !== null);
      }
    } catch {
      parsedSchema = [];
    }
  }

  const functionSchemaList: NonNullable<ProductStandardConfig['functionSchemaList']> = [];
  const statusSchemaList: NonNullable<ProductStandardConfig['statusSchemaList']> = [];

  for (const schema of parsedSchema) {
    const code = typeof schema.code === 'string' && schema.code.length > 0 ? schema.code : undefined;
    const idValue = schema.id === undefined || schema.id === null ? undefined : String(schema.id);
    if (!code || !idValue) {
      continue;
    }

    const relationDpIdMaps = { dpId: idValue };
    statusSchemaList.push({ dpCode: code, relationDpIdMaps });

    const mode = typeof schema.mode === 'string' ? schema.mode : '';
    if (mode.includes('w')) {
      functionSchemaList.push({ standardCode: code, relationDpIdMaps });
    }
  }

  const standardConfig: ProductStandardConfig = {
    productId,
    category: raw.category,
    functionSchemaList,
    statusSchemaList,
  };

  return {
    ...raw,
    productId,
    standardConfig,
  };
}

interface SmartLifeLogger {
  info: (message: string, ...parameters: unknown[]) => void;
  warn: (message: string, ...parameters: unknown[]) => void;
  error: (message: string, ...parameters: unknown[]) => void;
  debug: (message: string, ...parameters: unknown[]) => void;
}

interface SmartLifeCloudClientOptions {
  username: string;
  password: string;
  countryCode: string;
  region: SmartLifeRegion;
  requestTimeoutMs: number;
  maxRetries: number;
  logLevel: LogLevel;
  logger: SmartLifeLogger;
}

export class SmartLifeApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly payload?: unknown,
  ) {
    super(message);
    this.name = 'SmartLifeApiError';
  }
}

export class SmartLifeCloudClient {
  private readonly username: string;
  private readonly password: string;
  private readonly countryCode: string;
  private readonly region: SmartLifeRegion;
  private readonly requestTimeoutMs: number;
  private readonly maxRetries: number;
  private readonly logLevel: LogLevel;
  private readonly logger: SmartLifeLogger;

  private readonly hmacSecret = `${APP_CERT_SHA256}_${APP_SECRET_2}_${APP_SECRET}`;
  private readonly deviceId = randomDeviceId(44);

  private sid?: string;
  private endpoint = ENDPOINTS.us;
  private loginPromise?: Promise<void>;
  private readonly productRefsByHome = new Map<number, Map<string, ProductRef>>();

  constructor(options: SmartLifeCloudClientOptions) {
    this.username = options.username;
    this.password = options.password;
    this.countryCode = options.countryCode;
    this.region = options.region;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.maxRetries = options.maxRetries;
    this.logLevel = options.logLevel;
    this.logger = options.logger;
  }

  public async listHomes(): Promise<SmartLifeHome[]> {
    const response = await this.requestWithRetry<unknown[]>({
      action: 'm.life.home.space.list',
      version: '1.0',
      requiresSid: true,
    });

    if (!Array.isArray(response)) {
      this.debug('Unexpected homes payload: %j', response);
      return [];
    }

    return response
      .filter((item) => typeof item === 'object' && item !== null)
      .map((item) => item as SmartLifeHome);
  }

  public async listHomeDevices(homeId: number, includeProductRefs = false): Promise<SmartLifeDevice[]> {
    const devicesResponse = await this.requestWithRetry<unknown[]>({
      action: 'm.life.my.group.device.list',
      version: '2.2',
      requiresSid: true,
      data: {
        gid: homeId,
      },
    });

    if (!Array.isArray(devicesResponse)) {
      this.debug('Unexpected devices payload for home %s: %j', homeId, devicesResponse);
      return [];
    }

    let productRefMap = this.productRefsByHome.get(homeId) ?? new Map<string, ProductRef>();
    if (includeProductRefs || productRefMap.size === 0) {
      try {
        productRefMap = await this.getProductRefMap(homeId);
        this.productRefsByHome.set(homeId, productRefMap);
      } catch (error) {
        this.debug('Product references fetch failed for home %s: %s', homeId, toErrorMessage(error));
      }
    }

    return devicesResponse
      .filter((item): item is SmartLifeDevice => typeof item === 'object' && item !== null)
      .map((item) => {
        const device = item as SmartLifeDevice;
        const productId = typeof device.productId === 'string' ? device.productId : undefined;
        const ref = productId ? productRefMap.get(productId) : undefined;
        const refConfig = ref?.standardConfig;
        return {
          ...device,
          homeId,
          category: device.category ?? ref?.category,
          categoryCode: device.categoryCode ?? ref?.categoryCode,
          productStandardConfig: device.productStandardConfig ?? refConfig,
        };
      });
  }

  public async publishDp(devId: string, dps: Record<string, unknown>): Promise<void> {
    await this.requestWithRetry<boolean>({
      action: 'thing.m.device.dp.publish',
      version: '1.0',
      requiresSid: true,
      data: {
        devId,
        dps: JSON.stringify(dps),
      },
    });
  }

  public async getDeviceDp(devId: string): Promise<Record<string, unknown>> {
    const response = await this.requestWithRetry<Record<string, unknown>>({
      action: 'thing.m.device.dp.get',
      version: '1.0',
      requiresSid: true,
      data: {
        devId,
      },
    });

    return typeof response === 'object' && response !== null ? response : {};
  }

  private async getProductRefMap(homeId: number): Promise<Map<string, ProductRef>> {
    const response = await this.requestWithRetry<unknown[]>({
      action: 'm.life.device.ref.info.my.list',
      version: '7.2',
      requiresSid: true,
      data: {
        gid: homeId,
        zigbeeGroup: true,
      },
    });

    const result = new Map<string, ProductRef>();
    if (!Array.isArray(response)) {
      return result;
    }

    for (const item of response) {
      if (typeof item !== 'object' || item === null) {
        continue;
      }

      const ref = normalizeProductRef(item as ProductRef);
      if (ref?.productId) {
        result.set(ref.productId, ref);
      }
    }

    return result;
  }

  private async requestWithRetry<T>(request: ApiRequestOptions): Promise<T> {
    const requiresSid = request.requiresSid !== false;
    let attempts = 0;
    let lastError: unknown;

    while (attempts < this.maxRetries) {
      attempts += 1;
      try {
        if (requiresSid) {
          await this.ensureSession();
        }
        return await this.requestRaw<T>(request);
      } catch (error) {
        lastError = error;

        if (requiresSid && this.isSessionError(error)) {
          this.debug('Session expired, re-authenticating before retry.');
          this.sid = undefined;
          await this.ensureSession(true);
          continue;
        }

        if (!this.shouldRetry(error) || attempts >= this.maxRetries) {
          throw error;
        }

        const delayMs = backoffDelay(attempts);
        this.debug('Retrying %s after %sms due to: %s', request.action, delayMs, toErrorMessage(error));
        await sleep(delayMs);
      }
    }

    throw lastError instanceof Error ? lastError : new Error('Unknown SmartLife request error');
  }

  private async ensureSession(forceLogin = false): Promise<void> {
    if (!forceLogin && this.sid) {
      return;
    }

    if (!forceLogin && this.loginPromise) {
      await this.loginPromise;
      return;
    }

    this.loginPromise = this.login().finally(() => {
      this.loginPromise = undefined;
    });

    await this.loginPromise;
  }

  private async login(): Promise<void> {
    const endpoints = this.endpointOrder();
    let lastError: unknown;

    for (const endpoint of endpoints) {
      try {
        this.endpoint = endpoint;
        this.debug('Attempting SmartLife login via %s', endpoint);

        const token = await this.requestRaw<SmartLifeTokenResponse>({
          action: 'thing.m.user.username.token.get',
          version: '2.0',
          requiresSid: false,
          data: {
            countryCode: this.countryCode,
            username: this.username,
            isUid: false,
          },
        });

        const login = await this.requestRaw<SmartLifeLoginResponse>({
          action: this.username.includes('@') ? 'thing.m.user.email.password.login' : 'thing.m.user.mobile.passwd.login',
          version: this.username.includes('@') ? '3.0' : '4.0',
          requiresSid: false,
          data: this.loginPayload(token),
        });

        if (!login || typeof login.sid !== 'string' || login.sid.length === 0) {
          throw new SmartLifeApiError('NO_SESSION', 'Missing sid in login response', login);
        }

        this.sid = login.sid;

        if (typeof login.domain?.mobileApiUrl === 'string' && login.domain.mobileApiUrl.length > 0) {
          this.endpoint = normalizeApiUrl(login.domain.mobileApiUrl);
        }

        this.info('Authenticated with SmartLife cloud endpoint: %s', this.endpoint);
        return;
      } catch (error) {
        lastError = error;

        if (error instanceof SmartLifeApiError && LOGIN_NON_RETRYABLE_CODES.has(error.code)) {
          throw error;
        }

        this.warn('SmartLife login failed on %s: %s', endpoint, toErrorMessage(error));
      }
    }

    throw lastError instanceof Error ? lastError : new Error('SmartLife authentication failed');
  }

  private loginPayload(token: SmartLifeTokenResponse): Record<string, unknown> {
    const passwordMd5Hex = createHash('md5').update(this.password).digest('hex');
    let encryptedPassword = passwordMd5Hex;
    let ifencrypt = 0;

    if (typeof token.publicKey === 'string' && token.publicKey.length > 0 && typeof token.exponent === 'string' && token.exponent.length > 0) {
      try {
        encryptedPassword = encryptPasswordWithPublicKeyExponent(passwordMd5Hex, token.publicKey, token.exponent);
        ifencrypt = 1;
      } catch (error) {
        this.warn('RSA password encryption (publicKey/exponent) failed, fallback to next method: %s', toErrorMessage(error));
      }
    }

    if (ifencrypt === 0 && typeof token.pbKey === 'string' && token.pbKey.length > 0) {
      try {
        const key = createPublicKey({
          key: Buffer.from(token.pbKey, 'base64'),
          format: 'der',
          type: 'spki',
        });

        encryptedPassword = publicEncrypt(
          {
            key,
            padding: cryptoConstants.RSA_PKCS1_PADDING,
          },
          Buffer.from(passwordMd5Hex, 'utf8'),
        ).toString('hex');

        ifencrypt = 1;
      } catch (error) {
        this.warn('RSA password encryption (pbKey) failed, fallback to md5-hex password: %s', toErrorMessage(error));
      }
    }

    const payload: Record<string, unknown> = {
      countryCode: this.countryCode,
      [this.username.includes('@') ? 'email' : 'mobile']: this.username,
      passwd: encryptedPassword,
      options: '{"group": 1,"mfaCode": ""}',
      token: token.token,
      ifencrypt,
    };

    return payload;
  }

  private async requestRaw<T>(request: ApiRequestOptions): Promise<T> {
    const requiresSid = request.requiresSid !== false;
    if (requiresSid && !this.sid) {
      throw new SmartLifeApiError('USER_SESSION_INVALID', 'Session is not available');
    }

    const params = this.signedQueryParams(request, requiresSid);
    const url = this.endpoint;
    const formBody = new URLSearchParams(params).toString();
    const redactedBody = new URLSearchParams(redactRequestParamsForLog(params)).toString();

    this.trace('HTTP POST %s body=%s', url, redactedBody);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formBody,
        signal: controller.signal,
      });

      if (!response.ok) {
        throw new SmartLifeApiError('HTTP_ERROR', `HTTP ${response.status} ${response.statusText}`);
      }

      const payload = await response.json() as SmartLifeApiResponse<T>;
      this.trace('HTTP response for %s: %j', request.action, redactResponseForLog(payload));

      if (!payload.success) {
        throw new SmartLifeApiError(payload.errorCode ?? 'UNKNOWN_API_ERROR', payload.errorMsg ?? 'Unknown API error', payload);
      }

      return payload.result as T;
    } catch (error) {
      if (error instanceof SmartLifeApiError) {
        throw error;
      }

      if (error instanceof Error && error.name === 'AbortError') {
        throw new SmartLifeApiError('REQUEST_TIMEOUT', `SmartLife request timed out: ${request.action}`);
      }

      throw new SmartLifeApiError('NETWORK_ERROR', toErrorMessage(error));
    } finally {
      clearTimeout(timer);
    }
  }

  private signedQueryParams(request: ApiRequestOptions, requiresSid: boolean): Record<string, string> {
    const now = Math.floor(Date.now() / 1000).toString();

    const params: Record<string, string> = {
      a: request.action,
      deviceId: this.deviceId,
      os: 'Android',
      lang: 'en',
      v: request.version ?? '1.0',
      clientId: APP_KEY,
      time: now,
      et: ET_VERSION,
      ttid: APP_TTID,
      appVersion: '6.6.0',
      appRnVersion: '5.11',
      platform: 'Android',
      requestId: randomUUID(),
    };

    if (request.data) {
      params.postData = JSON.stringify(request.data);
    }

    if (requiresSid && this.sid) {
      params.sid = this.sid;
    }

    params.sign = createHmac('sha256', this.hmacSecret)
      .update(this.stringToSign(params))
      .digest('hex');

    return params;
  }

  private stringToSign(params: Record<string, string>): string {
    const sortedKeys = Object.keys(params).sort((a, b) => a.localeCompare(b));
    const parts: string[] = [];

    for (const key of sortedKeys) {
      const value = params[key];
      if (!SIGNED_KEYS.has(key) || value.length === 0) {
        continue;
      }

      if (key === 'postData') {
        parts.push(`${key}=${mobileHash(value)}`);
      } else {
        parts.push(`${key}=${value}`);
      }
    }

    return parts.join('||');
  }

  private endpointOrder(): string[] {
    const all = [ENDPOINTS.us, ENDPOINTS.eu, ENDPOINTS.in];

    if (this.region === 'auto') {
      return all;
    }

    const preferred = ENDPOINTS[this.region];
    return [preferred, ...all.filter((endpoint) => endpoint !== preferred)];
  }

  private isSessionError(error: unknown): boolean {
    if (!(error instanceof SmartLifeApiError)) {
      return false;
    }

    if (SESSION_ERROR_CODES.has(error.code)) {
      return true;
    }

    const normalizedCode = error.code.toLowerCase();
    return normalizedCode.includes('session') || normalizedCode.includes('token');
  }

  private shouldRetry(error: unknown): boolean {
    if (!(error instanceof SmartLifeApiError)) {
      return true;
    }

    if (this.isSessionError(error)) {
      return true;
    }

    if (RETRYABLE_CODES.has(error.code)) {
      return true;
    }

    const normalized = error.code.toLowerCase();
    return normalized.includes('timeout') || normalized.includes('network');
  }

  private info(message: string, ...parameters: unknown[]) {
    this.logger.info(message, ...parameters);
  }

  private warn(message: string, ...parameters: unknown[]) {
    this.logger.warn(message, ...parameters);
  }

  private debug(message: string, ...parameters: unknown[]) {
    if (this.logLevel === 'debug' || this.logLevel === 'trace') {
      this.logger.debug(message, ...parameters);
    }
  }

  private trace(message: string, ...parameters: unknown[]) {
    if (this.logLevel === 'trace') {
      this.logger.debug(message, ...parameters);
    }
  }
}
