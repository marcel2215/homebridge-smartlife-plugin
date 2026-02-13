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

export class SmartLifePlatformAccessory {
  private service: Service;

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
      this.service.updateCharacteristic(this.platform.Characteristic.Active,
        current ? this.platform.Characteristic.Active.ACTIVE : this.platform.Characteristic.Active.INACTIVE);
      this.service.updateCharacteristic(this.platform.Characteristic.InUse, current ? 1 : 0);
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

    switch (byKind) {
    case 'switch':
      return this.accessory.addService(this.platform.Service.Switch, serviceName);
    case 'outlet':
      return this.accessory.addService(this.platform.Service.Outlet, serviceName);
    case 'valve':
      return this.accessory.addService(this.platform.Service.Valve, serviceName);
    case 'contact':
      return this.accessory.addService(this.platform.Service.ContactSensor, serviceName);
    case 'leak':
      return this.accessory.addService(this.platform.Service.LeakSensor, serviceName);
    case 'smoke':
      return this.accessory.addService(this.platform.Service.SmokeSensor, serviceName);
    case 'motion':
      return this.accessory.addService(this.platform.Service.MotionSensor, serviceName);
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
      this.service.setCharacteristic(this.platform.Characteristic.ValveType, this.platform.Characteristic.ValveType.IRRIGATION);

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
    }
  }

  private async setSwitch(value: CharacteristicValue | boolean): Promise<void> {
    const dpId = this.mapping.switchDpId;
    if (!dpId) {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    const target = typeof value === 'boolean' ? value : Boolean(value);

    try {
      await this.platform.sendDpCommand(this.device.devId, dpId, target);
    } catch {
      throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }

    this.device.dpsResolved[dpId] = target;
    this.refresh();
  }

  private dpValue(dpId: string | undefined): unknown {
    if (!dpId) {
      return undefined;
    }

    return this.device.dpsResolved[dpId];
  }
}
