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

const EMPTY_HOMES_PRUNE_THRESHOLD = 3;
const COMMAND_STATE_GRACE_MS = 8000;

function parsePositiveInteger(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.floor(parsed);
    }
  }

  return undefined;
}

function parseHomeId(home: { gid?: number | string; id?: number | string }): number | undefined {
  return parsePositiveInteger(home.gid) ?? parsePositiveInteger(home.id);
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function normalizeCountryCode(value: string): string {
  const digits = value.replace(/[^0-9]/g, '');
  return digits.length > 0 ? digits : DEFAULT_COUNTRY_CODE;
}

function parseOptionalBoolean(value: unknown): boolean | undefined {
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

    if (['true', 'on', 'open', 'opened', 'yes', '1', 'active'].includes(normalized)) {
      return true;
    }

    if (['false', 'off', 'close', 'closed', 'no', '0', 'inactive'].includes(normalized)) {
      return false;
    }
  }

  return undefined;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

function toErrorDetails(error: unknown): string {
  if (error instanceof Error) {
    return error.stack ?? error.message;
  }

  return String(error);
}

interface ReconcileOptions {
  allowPrune: boolean;
  preserveHomeIds: Set<number>;
}

interface PendingDpWrite {
  value: boolean;
  expiresAtMs: number;
}

function isValidDpKey(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function isValidAccessoryMapping(value: unknown): value is DeviceControlMapping {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const mapping = value as DeviceControlMapping;
  const validKinds: DeviceControlMapping['kind'][] = ['switch', 'outlet', 'valve', 'contact', 'leak', 'smoke', 'motion'];
  if (!validKinds.includes(mapping.kind)) {
    return false;
  }

  if ((mapping.kind === 'switch' || mapping.kind === 'outlet' || mapping.kind === 'valve') && !isValidDpKey(mapping.switchDpId)) {
    return false;
  }
  if (mapping.kind === 'contact' && !isValidDpKey(mapping.contactDpId)) {
    return false;
  }
  if (mapping.kind === 'leak' && !isValidDpKey(mapping.leakDpId)) {
    return false;
  }
  if (mapping.kind === 'smoke' && !isValidDpKey(mapping.smokeDpId)) {
    return false;
  }
  if (mapping.kind === 'motion' && !isValidDpKey(mapping.motionDpId)) {
    return false;
  }

  return true;
}

export class SmartLifePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory<SmartLifeAccessoryContext>> = new Map();

  private readonly accessoryHandlers = new Map<string, SmartLifePlatformAccessory>();
  private readonly deviceById = new Map<string, SmartLifeResolvedDevice>();
  private readonly unsupportedCategories = new Set<string>();
  private readonly commandQueue = new Map<string, Promise<void>>();
  private readonly queuedCommandTargetByDevice = new Map<string, boolean>();
  private readonly deviceLastSeenAtMs = new Map<string, number>();
  private readonly pendingDpWrites = new Map<string, Map<string, PendingDpWrite>>();

  private readonly logLevel: LogLevel;
  private readonly pollIntervalSeconds: number;
  private readonly discoveryIntervalSeconds: number;
  private readonly stateStaleAfterMs: number;

  private readonly client?: SmartLifeCloudClient;

  private syncRunning = false;
  private pendingSyncIncludeProductRefs = false;
  private readonly pendingSyncReasons = new Set<string>();

  private pollTimer?: NodeJS.Timeout;
  private discoveryTimer?: NodeJS.Timeout;
  private emptyHomesSyncCount = 0;
  private shuttingDown = false;

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

    this.stateStaleAfterMs = Math.max(30000, this.pollIntervalSeconds * 1000 * 4);

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

    this.debug(
      'SmartLife platform initialized with poll=%ss discovery=%ss staleAfterMs=%s',
      this.pollIntervalSeconds,
      this.discoveryIntervalSeconds,
      this.stateStaleAfterMs,
    );

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
    this.restoreCachedAccessoryHandler(typedAccessory);
  }

  public isDeviceReachable(deviceId: string): boolean {
    return this.getDeviceReachabilityReason(deviceId) === 'ok';
  }

  public getDeviceReachabilityReason(deviceId: string): 'ok' | 'unknown-device' | 'cloud-offline' | 'state-stale' {
    const device = this.deviceById.get(deviceId);
    if (!device) {
      return 'unknown-device';
    }

    const cloudOnline = parseOptionalBoolean(device.cloudOnline);
    if (cloudOnline === false) {
      return 'cloud-offline';
    }

    const lastSeenAt = this.deviceLastSeenAtMs.get(deviceId);
    if (!lastSeenAt || Date.now() - lastSeenAt > this.stateStaleAfterMs) {
      return 'state-stale';
    }

    return 'ok';
  }

  public async sendDpCommand(deviceId: string, dpId: string, value: boolean): Promise<void> {
    if (!this.client) {
      throw new Error('SmartLife client is not initialized');
    }

    const current = this.deviceById.get(deviceId);
    const currentValue = current ? parseOptionalBoolean(current.dpsResolved[dpId]) : undefined;
    const existingQueue = this.commandQueue.get(deviceId);

    if (!existingQueue && currentValue !== undefined && currentValue === value) {
      this.trace('Skipping no-op command devId=%s dp=%s value=%s', deviceId, dpId, value);
      return;
    }

    if (existingQueue && this.queuedCommandTargetByDevice.get(deviceId) === value) {
      this.trace('Coalescing duplicate command devId=%s dp=%s value=%s', deviceId, dpId, value);
      return existingQueue;
    }

    this.queuedCommandTargetByDevice.set(deviceId, value);

    const previous = existingQueue ?? Promise.resolve();

    const next = previous
      .catch(() => undefined)
      .then(async () => {
        const latestDesired = this.queuedCommandTargetByDevice.get(deviceId);
        if (latestDesired !== undefined && latestDesired !== value) {
          this.trace('Dropping stale command devId=%s dp=%s value=%s latest=%s', deviceId, dpId, value, latestDesired);
          return;
        }

        try {
          await this.client!.publishDp(deviceId, { [dpId]: value });
          this.setPendingDpWrite(deviceId, dpId, value);

          const device = this.deviceById.get(deviceId);
          if (device) {
            device.dpsResolved[dpId] = value;
            this.markDeviceSeen(deviceId);
            const uuid = this.api.hap.uuid.generate(deviceId);
            this.accessoryHandlers.get(uuid)?.refresh();
          }

          void this.refreshDeviceDp(deviceId);
          this.trace('DP publish success devId=%s dp=%s value=%s', deviceId, dpId, value);
        } catch (error) {
          this.warn('DP publish failed devId=%s dp=%s value=%s error=%s', deviceId, dpId, value, toErrorDetails(error));
          await this.refreshDeviceDp(deviceId);
          throw error;
        }
      })
      .finally(() => {
        if (this.commandQueue.get(deviceId) === next) {
          this.commandQueue.delete(deviceId);
          this.queuedCommandTargetByDevice.delete(deviceId);
        }
      });

    this.commandQueue.set(deviceId, next);
    return next;
  }

  private markDeviceSeen(deviceId: string) {
    this.deviceLastSeenAtMs.set(deviceId, Date.now());
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
    this.shuttingDown = true;

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
    if (!this.client || this.shuttingDown) {
      return;
    }

    if (this.syncRunning) {
      this.pendingSyncIncludeProductRefs = this.pendingSyncIncludeProductRefs || includeProductRefs;
      this.pendingSyncReasons.add(reason);
      this.trace('Coalescing sync request reason=%s includeProductRefs=%s', reason, includeProductRefs);
      return;
    }

    this.syncRunning = true;

    let nextIncludeProductRefs = includeProductRefs;
    let nextReason = reason;

    try {
      while (!this.shuttingDown) {
        try {
          await this.syncOnce(nextIncludeProductRefs, nextReason);
        } catch (error) {
          this.error('SmartLife sync failed (%s): %s', nextReason, toErrorDetails(error));
        } finally {
          this.refreshAllAccessoryReachability();
        }

        if (!this.pendingSyncIncludeProductRefs && this.pendingSyncReasons.size === 0) {
          break;
        }

        nextIncludeProductRefs = this.pendingSyncIncludeProductRefs;
        nextReason = this.pendingSyncReasons.size > 0
          ? `coalesced:${Array.from(this.pendingSyncReasons).join('+')}`
          : 'coalesced';

        this.pendingSyncIncludeProductRefs = false;
        this.pendingSyncReasons.clear();
      }
    } finally {
      this.syncRunning = false;
    }
  }

  private async syncOnce(includeProductRefs: boolean, reason: string): Promise<void> {
    if (!this.client) {
      return;
    }

    this.debug('Starting SmartLife sync (%s, includeProductRefs=%s)', reason, includeProductRefs);

    const homes = await this.client.listHomes();
    const homeIds = Array.from(new Set(
      homes
        .map((home) => parseHomeId(home))
        .filter((homeId): homeId is number => homeId !== undefined),
    ));

    if (homeIds.length === 0) {
      this.emptyHomesSyncCount += 1;
      this.warn('No SmartLife homes found (attempt=%s).', this.emptyHomesSyncCount);

      if (includeProductRefs && this.emptyHomesSyncCount >= EMPTY_HOMES_PRUNE_THRESHOLD) {
        this.warn('Pruning cached accessories after %s consecutive empty home syncs.', this.emptyHomesSyncCount);
        this.reconcileAccessories([], {
          allowPrune: true,
          preserveHomeIds: new Set<number>(),
        });
      }

      return;
    }

    this.emptyHomesSyncCount = 0;
    this.client.pruneProductRefs(homeIds);

    const devices: SmartLifeResolvedDevice[] = [];
    const failedHomeIds = new Set<number>();

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
        failedHomeIds.add(homeId);
        this.warn('Home sync failed homeId=%s reason=%s', homeId, toErrorDetails(error));
      }
    }

    this.reconcileAccessories(devices, {
      allowPrune: includeProductRefs,
      preserveHomeIds: failedHomeIds,
    });

    this.trace('SmartLife sync complete reason=%s homes=%s devices=%s failedHomes=%s', reason, homeIds.length, devices.length, failedHomeIds.size);
  }

  private reconcileAccessories(devices: SmartLifeResolvedDevice[], options: ReconcileOptions) {
    const seen = new Set<string>();

    for (const device of devices) {
      const uuid = this.api.hap.uuid.generate(device.devId);
      const existing = this.accessories.get(uuid);

      let mapping = classifyAndMapDevice(device);
      if (!mapping && existing && isValidAccessoryMapping(existing.context.mapping)) {
        mapping = existing.context.mapping;
        this.debug('Using cached mapping for device with incomplete cloud payload: %s (%s)', device.name, device.devId);
      }

      if (!mapping) {
        this.markUnsupportedCategory(device.categoryResolved);
        continue;
      }

      seen.add(uuid);
      this.applyPendingDpWriteOverrides(device);
      this.deviceById.set(device.devId, device);
      this.markDeviceSeen(device.devId);

      if (existing) {
        this.upsertExistingAccessory(existing, device, mapping);
      } else {
        this.addNewAccessory(uuid, device, mapping);
      }
    }

    if (!options.allowPrune) {
      return;
    }

    for (const [uuid, accessory] of this.accessories) {
      if (seen.has(uuid)) {
        continue;
      }

      const homeId = accessory.context.homeId;
      if (typeof homeId === 'number' && options.preserveHomeIds.has(homeId)) {
        this.debug('Preserving accessory during partial sync failure: %s (homeId=%s)', accessory.displayName, homeId);
        continue;
      }

      this.removeAccessory(accessory);
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
      this.deviceLastSeenAtMs.delete(deviceId);
      this.commandQueue.delete(deviceId);
      this.queuedCommandTargetByDevice.delete(deviceId);
      this.pendingDpWrites.delete(deviceId);
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
      this.applyPendingDpWriteOverrides(current);
      this.markDeviceSeen(deviceId);
      const uuid = this.api.hap.uuid.generate(deviceId);
      this.accessoryHandlers.get(uuid)?.refresh();
    } catch (error) {
      this.debug('Device DP refresh failed devId=%s: %s', deviceId, toErrorMessage(error));
    }
  }

  private setPendingDpWrite(deviceId: string, dpId: string, value: boolean) {
    const byDp = this.pendingDpWrites.get(deviceId) ?? new Map<string, PendingDpWrite>();
    byDp.set(dpId, {
      value,
      expiresAtMs: Date.now() + COMMAND_STATE_GRACE_MS,
    });
    this.pendingDpWrites.set(deviceId, byDp);
  }

  private applyPendingDpWriteOverrides(device: SmartLifeResolvedDevice) {
    const byDp = this.pendingDpWrites.get(device.devId);
    if (!byDp || byDp.size === 0) {
      return;
    }

    const now = Date.now();
    let suppressed = 0;

    for (const [dpId, pending] of byDp) {
      const currentValue = parseOptionalBoolean(device.dpsResolved[dpId]);

      if (currentValue === pending.value) {
        byDp.delete(dpId);
        continue;
      }

      if (now > pending.expiresAtMs) {
        byDp.delete(dpId);
        continue;
      }

      device.dpsResolved[dpId] = pending.value;
      suppressed += 1;
    }

    if (byDp.size === 0) {
      this.pendingDpWrites.delete(device.devId);
    }

    if (suppressed > 0) {
      this.trace('Suppressed stale DP rollback devId=%s count=%s', device.devId, suppressed);
    }
  }

  private markUnsupportedCategory(category: string) {
    if (this.unsupportedCategories.has(category)) {
      return;
    }

    this.unsupportedCategories.add(category);
    this.warn('Skipping unsupported SmartLife category for HomeKit exposure: %s', category);
  }

  private restoreCachedAccessoryHandler(accessory: PlatformAccessory<SmartLifeAccessoryContext>) {
    const context = accessory.context;
    if (!context || !context.deviceId || !isValidAccessoryMapping(context.mapping)) {
      this.debug('Skipping cached handler restore for %s due to incomplete context.', accessory.displayName);
      return;
    }

    if (this.accessoryHandlers.has(accessory.UUID)) {
      return;
    }

    const homeId = parsePositiveInteger(context.homeId) ?? 0;
    const category = typeof context.category === 'string' && context.category.length > 0 ? context.category : 'unknown';

    const placeholderDevice: SmartLifeResolvedDevice = {
      devId: context.deviceId,
      name: accessory.displayName || context.deviceId,
      homeId,
      categoryResolved: category,
      dpsResolved: {},
      category,
    };

    this.deviceById.set(context.deviceId, placeholderDevice);
    this.accessoryHandlers.set(
      accessory.UUID,
      new SmartLifePlatformAccessory(this, accessory, placeholderDevice, context.mapping),
    );
    this.debug('Restored cached accessory handler: %s (%s)', accessory.displayName, context.deviceId);
  }

  private refreshAllAccessoryReachability() {
    for (const handler of this.accessoryHandlers.values()) {
      handler.refreshReachability();
    }
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
