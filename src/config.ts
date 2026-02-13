import type { PlatformConfig } from 'homebridge';

export type SmartLifeRegion = 'auto' | 'us' | 'eu' | 'in';
export type LogLevel = 'info' | 'debug' | 'trace';

export interface SmartLifePlatformConfig extends PlatformConfig {
  email?: string;
  password?: string;
  countryCode?: string;
  region?: SmartLifeRegion;
  pollIntervalSeconds?: number;
  discoveryIntervalSeconds?: number;
  requestTimeoutMs?: number;
  maxRetries?: number;
  logLevel?: LogLevel;
}

export const DEFAULT_COUNTRY_CODE = '1';
export const DEFAULT_REGION: SmartLifeRegion = 'auto';
export const DEFAULT_POLL_INTERVAL_SECONDS = 5;
export const DEFAULT_DISCOVERY_INTERVAL_SECONDS = 300;
export const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
export const DEFAULT_MAX_RETRIES = 3;
export const DEFAULT_LOG_LEVEL: LogLevel = 'info';

export const MIN_POLL_INTERVAL_SECONDS = 2;
export const MAX_POLL_INTERVAL_SECONDS = 60;

export const MIN_DISCOVERY_INTERVAL_SECONDS = 30;
export const MAX_DISCOVERY_INTERVAL_SECONDS = 3600;
