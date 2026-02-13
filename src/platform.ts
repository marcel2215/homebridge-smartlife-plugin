import type {
  API,
  Characteristic,
  DynamicPlatformPlugin,
  Logging,
  PlatformAccessory,
  Service,
} from 'homebridge';

import {
  MAX_DISCOVERY_INTERVAL_SECONDS,
  MAX_POLL_INTERVAL_SECONDS,
  MIN_DISCOVERY_INTERVAL_SECONDS,
  MIN_POLL_INTERVAL_SECONDS,
  DEFAULT_COUNTRY_CODE,
  DEFAULT_DISCOVERY_INTERVAL_SECONDS,
  DEFAULT_LOG_LEVEL,
  DEFAULT_MAX_RETRIES,
  DEFAULT_POLL_INTERVAL_SECONDS,
  DEFAULT_REGION,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type LogLevel,
  type SmartLifePlatformConfig,
} from './config.js';
import { PLATFORM_NAME, PLUGIN_NAME } from './settings.js';
import {
  classifyAndMapDevice,
  type DeviceControlMapping,
  resolveDevice,
} from './deviceMapping.js';
import { SmartLifeCloudClient } from './smartlife/client.js';
import type { SmartLifeResolvedDevice } from './smartlife/types.js';
import {
  SmartLifePlatformAccessory,
  type SmartLifeAccessoryContext,
} from './platformAccessory.js';

function parseHomeId(home: { gid?: number; id?: number }): number | undefined {
  if (typeof home.gid === 'number' && Number.isFinite(home.gid) && home.gid > 0) {
    return home.gid;
  }

  if (typeof home.id === 'number' && Number.isFinite(home.id) && home.id > 0) {
    return home.id;
  }

  return undefined;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeCountryCode(value: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : DEFAULT_COUNTRY_CODE;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

export class SmartLifePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory<SmartLifeAccessoryContext>> = new Map();

  private readonly accessoryHandlers = new Map<string, SmartLifePlatformAccessory>();
  private readonly deviceById = new Map<string, SmartLifeResolvedDevice>();
  private readonly unsupportedCategories = new Set<string>();
  private readonly commandQueue = new Map<string, Promise<void>>();

  private readonly logLevel: LogLevel;
  private readonly pollIntervalSeconds: number;
  private readonly discoveryIntervalSeconds: number;

  private readonly client?: SmartLifeCloudClient;

  private syncChain: Promise<void> = Promise.resolve();
  private pollTimer?: NodeJS.Timeout;
  private discoveryTimer?: NodeJS.Timeout;

  constructor(
    public readonly log: Logging,
    public readonly config: SmartLifePlatformConfig,
    public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.logLevel = config.logLevel ?? DEFAULT_LOG_LEVEL;
    this.pollIntervalSeconds = clamp(
      config.pollIntervalSeconds ?? DEFAULT_POLL_INTERVAL_SECONDS,
      MIN_POLL_INTERVAL_SECONDS,
      MAX_POLL_INTERVAL_SECONDS,
    );
    this.discoveryIntervalSeconds = clamp(
      config.discoveryIntervalSeconds ?? DEFAULT_DISCOVERY_INTERVAL_SECONDS,
      MIN_DISCOVERY_INTERVAL_SECONDS,
      MAX_DISCOVERY_INTERVAL_SECONDS,
    );

    const email = typeof config.email === 'string' ? config.email.trim() : '';
    const password = typeof config.password === 'string' ? config.password : '';

    if (!email || !password) {
      this.log.error('SmartLife email and password are required. Platform disabled.');
      return;
    }

    const countryCode = normalizeCountryCode(config.countryCode ?? DEFAULT_COUNTRY_CODE);

    this.client = new SmartLifeCloudClient({
      username: email,
      password,
      countryCode,
      region: config.region ?? DEFAULT_REGION,
      requestTimeoutMs: config.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      maxRetries: clamp(config.maxRetries ?? DEFAULT_MAX_RETRIES, 1, 10),
      logLevel: this.logLevel,
      logger: {
        info: this.log.info.bind(this.log),
        warn: this.log.warn.bind(this.log),
        error: this.log.error.bind(this.log),
        debug: this.log.debug.bind(this.log),
      },
    });

    this.debug('SmartLife platform initialized with poll=%ss discovery=%ss', this.pollIntervalSeconds, this.discoveryIntervalSeconds);

    this.api.on('didFinishLaunching', () => {
      void this.onDidFinishLaunching();
    });

    this.api.on('shutdown', () => {
      this.stopTimers();
    });
  }

  public configureAccessory(accessory: PlatformAccessory) {
    const typedAccessory = accessory as PlatformAccessory<SmartLifeAccessoryContext>;
    this.debug('Loading accessory from cache: %s', typedAccessory.displayName);
    this.accessories.set(typedAccessory.UUID, typedAccessory);
  }

  public async sendDpCommand(deviceId: string, dpId: string, value: boolean): Promise<void> {
    if (!this.client) {
      throw new Error('SmartLife client is not initialized');
    }

    const previous = this.commandQueue.get(deviceId) ?? Promise.resolve();

    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          await this.client!.publishDp(deviceId, { [dpId]: value });
          this.trace('DP publish success devId=%s dp=%s value=%s', deviceId, dpId, value);
        } catch (error) {
          this.warn('DP publish failed devId=%s dp=%s: %s', deviceId, dpId, toErrorMessage(error));
          await this.refreshDeviceDp(deviceId);
          throw error;
        }
      })
      .finally(() => {
        if (this.commandQueue.get(deviceId) === next) {
          this.commandQueue.delete(deviceId);
        }
      });

    this.commandQueue.set(deviceId, next);
    return next;
  }

  private async onDidFinishLaunching(): Promise<void> {
    if (!this.client) {
      return;
    }

    await this.enqueueSync(true, 'startup');

    this.pollTimer = setInterval(() => {
      void this.enqueueSync(false, 'poll');
    }, this.pollIntervalSeconds * 1000);

    this.discoveryTimer = setInterval(() => {
      void this.enqueueSync(true, 'discovery');
    }, this.discoveryIntervalSeconds * 1000);

    this.info('SmartLife polling enabled (%ss) with discovery refresh (%ss)', this.pollIntervalSeconds, this.discoveryIntervalSeconds);
  }

  private stopTimers() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.discoveryTimer) {
      clearInterval(this.discoveryTimer);
      this.discoveryTimer = undefined;
    }
  }

  private async enqueueSync(includeProductRefs: boolean, reason: string): Promise<void> {
    this.syncChain = this.syncChain
      .then(async () => this.syncOnce(includeProductRefs, reason))
      .catch((error) => {
        const details = error instanceof Error && error.stack ? error.stack : toErrorMessage(error);
        this.error('SmartLife sync chain error: %s', details);
      });

    return this.syncChain;
  }

  private async syncOnce(includeProductRefs: boolean, reason: string): Promise<void> {
    if (!this.client) {
      return;
    }

    this.debug('Starting SmartLife sync (%s, includeProductRefs=%s)', reason, includeProductRefs);

    const homes = await this.client.listHomes();
    const homeIds = homes
      .map((home) => parseHomeId(home))
      .filter((homeId): homeId is number => homeId !== undefined);

    if (homeIds.length === 0) {
      this.warn('No SmartLife homes found.');
      this.reconcileAccessories([]);
      return;
    }

    const devices: SmartLifeResolvedDevice[] = [];

    for (const homeId of homeIds) {
      try {
        const homeDevices = await this.client.listHomeDevices(homeId, includeProductRefs);
        for (const rawDevice of homeDevices) {
          const resolved = resolveDevice(rawDevice, homeId);
          if (resolved) {
            devices.push(resolved);
          }
        }
      } catch (error) {
        this.warn('Home %s sync failed: %s', homeId, toErrorMessage(error));
      }
    }

    this.reconcileAccessories(devices);
    this.trace('SmartLife sync complete: homes=%s devices=%s', homeIds.length, devices.length);
  }

  private reconcileAccessories(devices: SmartLifeResolvedDevice[]) {
    const seen = new Set<string>();

    for (const device of devices) {
      const mapping = classifyAndMapDevice(device);
      if (!mapping) {
        this.markUnsupportedCategory(device.categoryResolved);
        continue;
      }

      const uuid = this.api.hap.uuid.generate(device.devId);
      seen.add(uuid);
      this.deviceById.set(device.devId, device);

      const existing = this.accessories.get(uuid);
      if (existing) {
        this.upsertExistingAccessory(existing, device, mapping);
      } else {
        this.addNewAccessory(uuid, device, mapping);
      }
    }

    for (const [uuid, accessory] of this.accessories) {
      if (!seen.has(uuid)) {
        this.removeAccessory(accessory);
      }
    }
  }

  private upsertExistingAccessory(
    accessory: PlatformAccessory<SmartLifeAccessoryContext>,
    device: SmartLifeResolvedDevice,
    mapping: DeviceControlMapping,
  ) {
    const previousKind = accessory.context.kind;
    accessory.displayName = device.name;

    const contextChanged =
      accessory.context.deviceId !== device.devId
      || accessory.context.homeId !== device.homeId
      || accessory.context.kind !== mapping.kind
      || accessory.context.category !== device.categoryResolved
      || JSON.stringify(accessory.context.mapping) !== JSON.stringify(mapping);

    if (contextChanged) {
      accessory.context.deviceId = device.devId;
      accessory.context.homeId = device.homeId;
      accessory.context.kind = mapping.kind;
      accessory.context.category = device.categoryResolved;
      accessory.context.mapping = mapping;
      this.api.updatePlatformAccessories([accessory]);
    }

    const existingHandler = this.accessoryHandlers.get(accessory.UUID);
    if (!existingHandler || previousKind !== mapping.kind) {
      this.accessoryHandlers.set(
        accessory.UUID,
        new SmartLifePlatformAccessory(this, accessory, device, mapping),
      );
      return;
    }

    existingHandler.update(device, mapping);
  }

  private addNewAccessory(uuid: string, device: SmartLifeResolvedDevice, mapping: DeviceControlMapping) {
    const accessory = new this.api.platformAccessory<SmartLifeAccessoryContext>(device.name, uuid);
    accessory.context.deviceId = device.devId;
    accessory.context.homeId = device.homeId;
    accessory.context.kind = mapping.kind;
    accessory.context.category = device.categoryResolved;
    accessory.context.mapping = mapping;

    this.accessories.set(uuid, accessory);
    this.accessoryHandlers.set(uuid, new SmartLifePlatformAccessory(this, accessory, device, mapping));

    const hapAccessory = (accessory as unknown as {
      _associatedHAPAccessory?: { bridge?: unknown };
    })._associatedHAPAccessory;
    this.debug('Registering accessory candidate: %s (%s) bridgePresent=%s', device.name, device.devId, Boolean(hapAccessory?.bridge));

    if (!hapAccessory?.bridge) {
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    } else {
      this.debug('Accessory already bridged before registration, skipping duplicate register: %s (%s)', device.name, device.devId);
    }

    this.info('Added accessory: %s (%s)', device.name, device.devId);
  }

  private removeAccessory(accessory: PlatformAccessory<SmartLifeAccessoryContext>) {
    this.info('Removing accessory: %s', accessory.displayName);
    this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
    this.accessories.delete(accessory.UUID);
    this.accessoryHandlers.delete(accessory.UUID);

    const deviceId = accessory.context.deviceId;
    if (deviceId) {
      this.deviceById.delete(deviceId);
    }
  }

  private async refreshDeviceDp(deviceId: string): Promise<void> {
    if (!this.client) {
      return;
    }

    try {
      const latest = await this.client.getDeviceDp(deviceId);
      const current = this.deviceById.get(deviceId);
      if (!current) {
        return;
      }

      current.dpsResolved = latest;
      const uuid = this.api.hap.uuid.generate(deviceId);
      this.accessoryHandlers.get(uuid)?.refresh();
    } catch (error) {
      this.debug('Device DP refresh failed devId=%s: %s', deviceId, toErrorMessage(error));
    }
  }

  private markUnsupportedCategory(category: string) {
    if (this.unsupportedCategories.has(category)) {
      return;
    }

    this.unsupportedCategories.add(category);
    this.warn('Skipping unsupported SmartLife category for HomeKit exposure: %s', category);
  }

  private info(message: string, ...parameters: unknown[]) {
    this.log.info(message, ...parameters);
  }

  private warn(message: string, ...parameters: unknown[]) {
    this.log.warn(message, ...parameters);
  }

  private error(message: string, ...parameters: unknown[]) {
    this.log.error(message, ...parameters);
  }

  private debug(message: string, ...parameters: unknown[]) {
    if (this.logLevel === 'debug' || this.logLevel === 'trace') {
      this.log.debug(message, ...parameters);
    }
  }

  private trace(message: string, ...parameters: unknown[]) {
    if (this.logLevel === 'trace') {
      this.log.debug(message, ...parameters);
    }
  }
}
