import type {
  ProductStandardConfig,
  SmartLifeResolvedDevice,
  SmartLifeDevice,
} from './smartlife/types.js';

export type AccessoryKind = 'switch' | 'outlet' | 'valve' | 'contact' | 'leak' | 'smoke' | 'motion';

export interface DeviceControlMapping {
  kind: AccessoryKind;
  switchDpId?: string;
  countdownDpId?: string;
  contactDpId?: string;
  leakDpId?: string;
  smokeDpId?: string;
  motionDpId?: string;
}

const SWITCH_CATEGORIES = new Set(['dlq', 'kg', 'tdq', 'qjdcz', 'szjqr']);
const OUTLET_CATEGORIES = new Set(['cz', 'pc', 'wkcz']);
const VALVE_CATEGORIES = new Set(['ggq', 'sfkzq']);
const CONTACT_CATEGORIES = new Set(['mcs']);
const LEAK_CATEGORIES = new Set(['rqbj', 'jwbj', 'sj']);
const SMOKE_CATEGORIES = new Set(['ywbj']);
const MOTION_CATEGORIES = new Set(['pir', 'hps']);

const SWITCH_CODES = ['switch', 'switch_1', 'switch_led', 'start', 'status'];
const COUNTDOWN_CODES = ['countdown', 'countdown_1'];
const CONTACT_CODES = ['doorcontact_state', 'door_open_state', 'contact_state'];
const LEAK_CODES = ['watersensor_state', 'gas_sensor_state', 'ch4_sensor_state', 'water_state', 'leak_state'];
const SMOKE_CODES = ['smoke_sensor_state', 'smoke_state', 'smoke'];
const MOTION_CODES = ['pir', 'pir_state', 'motion_state', 'presence_state'];
const VALVE_NAME_HINTS = ['valve', 'zawor', 'zawór'];

function buildSchemaIndex(config?: ProductStandardConfig): Map<string, string[]> {
  const index = new Map<string, string[]>();

  const push = (code: string | undefined, relationMap?: Record<string, unknown>) => {
    if (!code) {
      return;
    }

    const ids = relationMap ? Object.values(relationMap)
      .map((value) => String(value))
      .filter((value) => value.length > 0) : [];

    if (ids.length === 0) {
      return;
    }

    index.set(code.toLowerCase(), ids);
  };

  for (const item of config?.functionSchemaList ?? []) {
    push(item.standardCode, item.relationDpIdMaps);
  }

  for (const item of config?.statusSchemaList ?? []) {
    push(item.dpCode, item.relationDpIdMaps);
  }

  return index;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value !== 0;
  }

  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized.length === 0) {
      return undefined;
    }

    if (['true', 'on', 'open', 'opened', 'yes', 'alarm', 'detected', '1'].includes(normalized)) {
      return true;
    }

    if (['false', 'off', 'close', 'closed', 'no', 'normal', 'clear', '0'].includes(normalized)) {
      return false;
    }

    const asNumber = Number(normalized);
    if (!Number.isNaN(asNumber)) {
      return asNumber !== 0;
    }
  }

  return undefined;
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : undefined;
}

function findDpId(device: SmartLifeResolvedDevice, codes: string[], allowBooleanFallback: boolean): string | undefined {
  const dps = device.dpsResolved;
  const schemaIndex = buildSchemaIndex(device.productStandardConfig);

  for (const code of codes) {
    const key = code.toLowerCase();
    const fromSchema = schemaIndex.get(key);

    if (fromSchema && fromSchema.length > 0) {
      for (const dpId of fromSchema) {
        if (dps[dpId] !== undefined) {
          return dpId;
        }
      }
      return fromSchema[0];
    }

    if (dps[code] !== undefined) {
      return code;
    }

    const matchedKey = Object.keys(dps).find((dpKey) => {
      const lower = dpKey.toLowerCase();
      return lower === key || lower.startsWith(`${key}_`);
    });

    if (matchedKey) {
      return matchedKey;
    }
  }

  if (allowBooleanFallback) {
    return Object.keys(dps).find((dpKey) => toBoolean(dps[dpKey]) !== undefined);
  }

  return undefined;
}

export function classifyAndMapDevice(device: SmartLifeResolvedDevice): DeviceControlMapping | undefined {
  const switchDpId = findDpId(device, SWITCH_CODES, true);
  const countdownDpId = findDpId(device, COUNTDOWN_CODES, false);
  const contactDpId = findDpId(device, CONTACT_CODES, false);
  const leakDpId = findDpId(device, LEAK_CODES, false);
  const smokeDpId = findDpId(device, SMOKE_CODES, false);
  const motionDpId = findDpId(device, MOTION_CODES, false);

  const category = device.categoryResolved;

  if (SWITCH_CATEGORIES.has(category)) {
    return switchDpId ? { kind: 'switch', switchDpId } : undefined;
  }

  if (OUTLET_CATEGORIES.has(category)) {
    const normalizedName = device.name.toLowerCase();
    if (VALVE_NAME_HINTS.some((hint) => normalizedName.includes(hint))) {
      return switchDpId ? { kind: 'valve', switchDpId, countdownDpId } : undefined;
    }
    return switchDpId ? { kind: 'outlet', switchDpId } : undefined;
  }

  if (VALVE_CATEGORIES.has(category)) {
    return switchDpId ? { kind: 'valve', switchDpId, countdownDpId } : undefined;
  }

  if (CONTACT_CATEGORIES.has(category)) {
    return contactDpId ? { kind: 'contact', contactDpId } : undefined;
  }

  if (LEAK_CATEGORIES.has(category)) {
    return leakDpId ? { kind: 'leak', leakDpId } : undefined;
  }

  if (SMOKE_CATEGORIES.has(category)) {
    return smokeDpId ? { kind: 'smoke', smokeDpId } : undefined;
  }

  if (MOTION_CATEGORIES.has(category)) {
    return motionDpId ? { kind: 'motion', motionDpId } : undefined;
  }

  if (contactDpId) {
    return { kind: 'contact', contactDpId };
  }

  if (leakDpId) {
    return { kind: 'leak', leakDpId };
  }

  if (smokeDpId) {
    return { kind: 'smoke', smokeDpId };
  }

  if (motionDpId) {
    return { kind: 'motion', motionDpId };
  }

  if (switchDpId) {
    return { kind: 'switch', switchDpId };
  }

  return undefined;
}

export function getCategory(device: SmartLifeDevice): string {
  if (typeof device.category === 'string' && device.category.length > 0) {
    return device.category;
  }

  const normalizedCategoryCode = (value: string): string => {
    const [base] = value.split('_');
    return base.length > 0 ? base : value;
  };

  if (typeof device.categoryCode === 'string' && device.categoryCode.length > 0) {
    return normalizedCategoryCode(device.categoryCode);
  }

  const productInfoCategory = device.productInfo?.category;
  if (typeof productInfoCategory === 'string' && productInfoCategory.length > 0) {
    return productInfoCategory;
  }

  const productInfoCategoryCode = device.productInfo?.categoryCode;
  if (typeof productInfoCategoryCode === 'string' && productInfoCategoryCode.length > 0) {
    return normalizedCategoryCode(productInfoCategoryCode);
  }

  return 'unknown';
}

export function getDeviceDps(device: SmartLifeDevice): Record<string, unknown> {
  const dpsFromDataPoint = device.dataPointInfo?.dps;
  if (dpsFromDataPoint && typeof dpsFromDataPoint === 'object') {
    return dpsFromDataPoint;
  }

  if (device.dps && typeof device.dps === 'object') {
    return device.dps;
  }

  return {};
}

export function resolveDevice(rawDevice: SmartLifeDevice, homeId: number): SmartLifeResolvedDevice | undefined {
  const devId = typeof rawDevice.devId === 'string' ? rawDevice.devId : undefined;
  if (!devId) {
    return undefined;
  }

  const name = typeof rawDevice.name === 'string' && rawDevice.name.trim().length > 0
    ? rawDevice.name
    : devId;

  const dpsResolved = getDeviceDps(rawDevice);
  const categoryResolved = getCategory(rawDevice);

  return {
    ...rawDevice,
    devId,
    name,
    homeId,
    categoryResolved,
    dpsResolved,
  };
}

export function isCloudOnline(device: SmartLifeResolvedDevice): boolean {
  return device.cloudOnline !== false;
}

export function parseSwitchState(value: unknown): boolean {
  return toBoolean(value) ?? false;
}

export function parseContactDetected(value: unknown, dpKey: string): boolean {
  const normalized = normalizeString(value);
  const key = dpKey.toLowerCase();

  if (normalized !== undefined) {
    if (normalized === 'open' || normalized === 'opened' || normalized === 'alarm') {
      return true;
    }
    if (normalized === 'closed' || normalized === 'close' || normalized === 'normal') {
      return false;
    }
  }

  const boolValue = toBoolean(value);
  if (boolValue === undefined) {
    return false;
  }

  if (key.includes('doorcontact')) {
    return !boolValue;
  }

  return boolValue;
}

export function parseLeakDetected(value: unknown): boolean {
  const normalized = normalizeString(value);
  if (normalized !== undefined) {
    if (['alarm', 'warn', 'leak', 'detected', 'open', 'opened'].includes(normalized)) {
      return true;
    }
    if (['normal', 'none', 'clear', 'closed', 'close'].includes(normalized)) {
      return false;
    }
  }

  return toBoolean(value) ?? false;
}

export function parseSmokeDetected(value: unknown): boolean {
  return parseLeakDetected(value);
}

export function parseMotionDetected(value: unknown): boolean {
  const normalized = normalizeString(value);
  if (normalized !== undefined) {
    if (['pir', 'motion', 'move', 'detected', 'presence', 'on'].includes(normalized)) {
      return true;
    }
    if (['none', 'clear', 'normal', 'off'].includes(normalized)) {
      return false;
    }
  }

  return toBoolean(value) ?? false;
}
