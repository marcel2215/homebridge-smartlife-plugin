import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';

import type { AccessoryKind, DeviceControlMapping } from './deviceMapping.js';
import {
  parseContactDetected,
  parseLeakDetected,
  parseMotionDetected,
  parseSmokeDetected,
  parseSwitchState,
} from './deviceMapping.js';
import type { SmartLifeResolvedDevice } from './smartlife/types.js';
import type { SmartLifePlatform } from './platform.js';

export interface SmartLifeAccessoryContext {
  deviceId?: string;
  homeId?: number;
  category?: string;
  kind?: AccessoryKind;
  mapping?: DeviceControlMapping;
}

function sanitizeHomeKitName(name: string): string {
  const cleaned = name
    .replace(/[^A-Za-z0-9 ']/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > 0 ? cleaned : 'SmartLife Device';
}

type ReachabilityReason = ReturnType<SmartLifePlatform['getDeviceReachabilityReason']>;
const BLOCKED_OPERATION_LOG_INTERVAL_MS = 30000;

function parseDurationSeconds(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
    return Math.floor(value);
  }

  if (typeof value === 'string' && value.trim().length > 0) {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  return 0;
}

export class SmartLifePlatformAccessory {
  private service: Service;
  private lastReachabilityReason?: ReachabilityReason;
  private lastBlockedOperationLogAtMs = 0;
  private valveSetDurationSeconds = 0;

  constructor(
    private readonly platform: SmartLifePlatform,
    private readonly accessory: PlatformAccessory<SmartLifeAccessoryContext>,
    private device: SmartLifeResolvedDevice,
    private mapping: DeviceControlMapping,
  ) {
    this.service = this.initService();
    this.configureAccessoryInformation();
    this.configureHandlers();
    this.refresh();
  }

  public update(device: SmartLifeResolvedDevice, mapping: DeviceControlMapping) {
    this.device = device;
    this.mapping = mapping;
    this.accessory.context.homeId = device.homeId;
    this.accessory.context.category = device.categoryResolved;
    this.accessory.context.kind = mapping.kind;
    this.accessory.context.mapping = mapping;
    this.accessory.displayName = device.name;
    this.configureAccessoryInformation();
    this.refresh();
  }

  public refresh() {
    this.updateReachabilityCharacteristics();

    switch (this.mapping.kind) {
    case 'switch':
    case 'outlet': {
      const current = parseSwitchState(this.dpValue(this.mapping.switchDpId));
      this.service.updateCharacteristic(this.platform.Characteristic.On, current);
      if (this.mapping.kind === 'outlet') {
        this.service.updateCharacteristic(this.platform.Characteristic.OutletInUse, current);
      }
      break;
    }
    case 'valve': {
      const current = parseSwitchState(this.dpValue(this.mapping.switchDpId));
      const countdown = this.valveDurationSeconds();
      this.valveSetDurationSeconds = countdown;
      this.service.updateCharacteristic(this.platform.Characteristic.Active,
        current ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
      this.service.updateCharacteristic(this.platform.Characteristic.InUse, current ? 1 : 0);
      this.service.updateCharacteristic(this.platform.Characteristic.SetDuration, countdown);
      this.service.updateCharacteristic(this.platform.Characteristic.RemainingDuration, current ? countdown : 0);
      break;
    }
    case 'contact': {
      const isOpen = parseContactDetected(this.dpValue(this.mapping.contactDpId), this.mapping.contactDpId ?? '');
      this.service.updateCharacteristic(this.platform.Characteristic.ContactSensorState,
        isOpen
          ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
          : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED);
      break;
    }
    case 'leak': {
      const detected = parseLeakDetected(this.dpValue(this.mapping.leakDpId));
      this.service.updateCharacteristic(this.platform.Characteristic.LeakDetected,
        detected
          ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
          : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED);
      break;
    }
    case 'smoke': {
      const detected = parseSmokeDetected(this.dpValue(this.mapping.smokeDpId));
      this.service.updateCharacteristic(this.platform.Characteristic.SmokeDetected,
        detected
          ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED
          : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED);
      break;
    }
    case 'motion': {
      const detected = parseMotionDetected(this.dpValue(this.mapping.motionDpId));
      this.service.updateCharacteristic(this.platform.Characteristic.MotionDetected, detected);
      break;
    }
    }
  }

  public refreshReachability() {
    this.updateReachabilityCharacteristics();
  }

  private configureAccessoryInformation() {
    const safeName = sanitizeHomeKitName(this.device.name);
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Volcano Technology Limited')
      .setCharacteristic(this.platform.Characteristic.Model, this.device.categoryResolved)
      .setCharacteristic(this.platform.Characteristic.SerialNumber, this.device.devId)
      .setCharacteristic(this.platform.Characteristic.Name, safeName);
  }

  private initService(): Service {
    const byKind = this.mapping.kind;
    const serviceName = sanitizeHomeKitName(this.device.name);
    const existing = this.accessory.services
      .filter((service) => service.UUID !== this.platform.Service.AccessoryInformation.UUID);

    for (const service of existing) {
      this.accessory.removeService(service);
    }

    let service: Service;

    switch (byKind) {
    case 'switch':
      service = this.accessory.addService(this.platform.Service.Switch, serviceName);
      break;
    case 'outlet':
      service = this.accessory.addService(this.platform.Service.Outlet, serviceName);
      break;
    case 'valve':
      service = this.accessory.addService(this.platform.Service.Valve, serviceName);
      break;
    case 'contact':
      service = this.accessory.addService(this.platform.Service.ContactSensor, serviceName);
      break;
    case 'leak':
      service = this.accessory.addService(this.platform.Service.LeakSensor, serviceName);
      break;
    case 'smoke':
      service = this.accessory.addService(this.platform.Service.SmokeSensor, serviceName);
      break;
    case 'motion':
      service = this.accessory.addService(this.platform.Service.MotionSensor, serviceName);
      break;
    }

    this.ensureOptionalStatusCharacteristics(service);
    return service;
  }

  private ensureOptionalStatusCharacteristics(service: Service) {
    if (!service.testCharacteristic(this.platform.Characteristic.StatusFault)) {
      service.addOptionalCharacteristic(this.platform.Characteristic.StatusFault);
    }

    if (!service.testCharacteristic(this.platform.Characteristic.StatusActive)) {
      service.addOptionalCharacteristic(this.platform.Characteristic.StatusActive);
    }
  }

  private configureHandlers() {
    if (this.mapping.kind === 'switch' || this.mapping.kind === 'outlet') {
      this.service.getCharacteristic(this.platform.Characteristic.On)
        .onGet(async () => parseSwitchState(this.dpValue(this.mapping.switchDpId)))
        .onSet(async (value) => this.setSwitch(value));
    }

    if (this.mapping.kind === 'outlet') {
      this.service.getCharacteristic(this.platform.Characteristic.OutletInUse)
        .onGet(async () => parseSwitchState(this.dpValue(this.mapping.switchDpId)));
    }

    if (this.mapping.kind === 'valve') {
      this.service.setCharacteristic(this.platform.Characteristic.ValveType, this.platform.Characteristic.ValveType.GENERIC_VALVE);
      this.service.setCharacteristic(this.platform.Characteristic.SetDuration, this.valveDurationSeconds());
      this.service.setCharacteristic(this.platform.Characteristic.RemainingDuration, this.valveRemainingSeconds());

      this.service.getCharacteristic(this.platform.Characteristic.Active)
        .onGet(async () => {
          const on = parseSwitchState(this.dpValue(this.mapping.switchDpId));
          return on ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE;
        })
        .onSet(async (value) => {
          const active = (value as number) === this.platform.Characteristic.Active.ACTIVE;
          await this.setSwitch(active);
        });

      this.service.getCharacteristic(this.platform.Characteristic.InUse)
        .onGet(async () => parseSwitchState(this.dpValue(this.mapping.switchDpId)) ? 1 : 0);

      this.service.getCharacteristic(this.platform.Characteristic.SetDuration)
        .onGet(async () => this.valveDurationSeconds())
        .onSet(async (value) => {
          this.valveSetDurationSeconds = parseDurationSeconds(value);
          this.refresh();
        });

      this.service.getCharacteristic(this.platform.Characteristic.RemainingDuration)
        .onGet(async () => this.valveRemainingSeconds());
    }

    if (this.mapping.kind === 'contact') {
      this.service.getCharacteristic(this.platform.Characteristic.ContactSensorState)
        .onGet(async () => {
          const isOpen = parseContactDetected(this.dpValue(this.mapping.contactDpId), this.mapping.contactDpId ?? '');
          return isOpen
            ? this.platform.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
            : this.platform.Characteristic.ContactSensorState.CONTACT_DETECTED;
        });
    }

    if (this.mapping.kind === 'leak') {
      this.service.getCharacteristic(this.platform.Characteristic.LeakDetected)
        .onGet(async () => {
          const detected = parseLeakDetected(this.dpValue(this.mapping.leakDpId));
          return detected
            ? this.platform.Characteristic.LeakDetected.LEAK_DETECTED
            : this.platform.Characteristic.LeakDetected.LEAK_NOT_DETECTED;
        });
    }

    if (this.mapping.kind === 'smoke') {
      this.service.getCharacteristic(this.platform.Characteristic.SmokeDetected)
        .onGet(async () => {
          const detected = parseSmokeDetected(this.dpValue(this.mapping.smokeDpId));
          return detected
            ? this.platform.Characteristic.SmokeDetected.SMOKE_DETECTED
            : this.platform.Characteristic.SmokeDetected.SMOKE_NOT_DETECTED;
        });
    }

    if (this.mapping.kind === 'motion') {
      this.service.getCharacteristic(this.platform.Characteristic.MotionDetected)
        .onGet(async () => parseMotionDetected(this.dpValue(this.mapping.motionDpId)));
    }
  }

  private currentReachabilityReason(): ReachabilityReason {
    return this.platform.getDeviceReachabilityReason(this.device.devId);
  }

  private updateReachabilityCharacteristics() {
    const reason = this.currentReachabilityReason();
    this.logReachabilityTransition(reason);

    const isReachable = reason === 'ok';
    this.service.updateCharacteristic(this.platform.Characteristic.StatusFault,
      isReachable
        ? this.platform.Characteristic.StatusFault.NO_FAULT
        : this.platform.Characteristic.StatusFault.GENERAL_FAULT);

    if (this.service.testCharacteristic(this.platform.Characteristic.StatusActive)) {
      this.service.updateCharacteristic(this.platform.Characteristic.StatusActive, isReachable);
    }
  }

  private logReachabilityTransition(reason: ReachabilityReason) {
    if (this.lastReachabilityReason === reason) {
      return;
    }

    this.lastReachabilityReason = reason;

    if (reason === 'ok') {
      this.platform.log.debug('Device reachable again: %s (%s)', this.device.name, this.device.devId);
      return;
    }

    this.platform.log.warn('Device unreachable: %s (%s) reason=%s', this.device.name, this.device.devId, reason);
  }

  private assertReachableForWrite() {
    const reason = this.currentReachabilityReason();
    this.logReachabilityTransition(reason);

    if (reason === 'ok') {
      return;
    }

    const now = Date.now();
    if (now - this.lastBlockedOperationLogAtMs >= BLOCKED_OPERATION_LOG_INTERVAL_MS) {
      this.platform.log.warn('Blocking write for unreachable device: %s (%s) reason=%s', this.device.name, this.device.devId, reason);
      this.lastBlockedOperationLogAtMs = now;
    }
    throw this.communicationError();
  }

  private communicationError() {
    return new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }

  private async setSwitch(value: CharacteristicValue | boolean): Promise<void> {
    const dpId = this.mapping.switchDpId;
    if (!dpId) {
      throw this.communicationError();
    }

    this.assertReachableForWrite();

    const target = typeof value === 'boolean' ? value : Boolean(value);

    try {
      await this.platform.sendDpCommand(this.device.devId, dpId, target);
    } catch {
      throw this.communicationError();
    }

    this.device.dpsResolved[dpId] = target;
    this.refresh();
  }

  private valveDurationSeconds(): number {
    const fromDp = parseDurationSeconds(this.dpValue(this.mapping.countdownDpId));
    if (fromDp > 0) {
      return fromDp;
    }

    return this.valveSetDurationSeconds;
  }

  private valveRemainingSeconds(): number {
    const current = parseSwitchState(this.dpValue(this.mapping.switchDpId));
    if (!current) {
      return 0;
    }

    return this.valveDurationSeconds();
  }

  private dpValue(dpId: string | undefined): unknown {
    if (!dpId) {
      return undefined;
    }

    return this.device.dpsResolved[dpId];
  }
}
