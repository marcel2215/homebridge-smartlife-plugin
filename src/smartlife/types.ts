export interface SmartLifeApiResponse<T> {
  success: boolean;
  result?: T;
  errorCode?: string;
  errorMsg?: string;
  t?: number;
  tid?: string;
}

export interface SmartLifeTokenResponse {
  token: string;
  exponent?: string;
  pExponent?: string;
  pbKey?: string;
  publicKey?: string;
}

export interface SmartLifeLoginDomain {
  mobileApiUrl?: string;
  regionCode?: string;
}

export interface SmartLifeLoginResponse {
  sid?: string;
  domain?: SmartLifeLoginDomain;
  uid?: string;
}

export interface SmartLifeHome {
  gid?: number;
  id?: number;
  name?: string;
  nickName?: string;
}

export interface ProductStandardConfigFunctionSchema {
  standardCode?: string;
  relationDpIdMaps?: Record<string, unknown>;
}

export interface ProductStandardConfigStatusSchema {
  dpCode?: string;
  relationDpIdMaps?: Record<string, unknown>;
}

export interface ProductStandardConfig {
  category?: string;
  functionSchemaList?: ProductStandardConfigFunctionSchema[];
  statusSchemaList?: ProductStandardConfigStatusSchema[];
  productId?: string;
}

export interface ProductRef {
  id?: string;
  category?: string;
  categoryCode?: string;
  schemaInfo?: {
    schema?: string;
    schemaExt?: string;
  };
  productId?: string;
  standardConfig?: ProductStandardConfig;
}

export interface DeviceProductInfo {
  category?: string;
  categoryCode?: string;
}

export interface DeviceDataPointInfo {
  dps?: Record<string, unknown>;
}

export interface SmartLifeDevice {
  devId?: string;
  name?: string;
  productId?: string;
  productVer?: string;
  category?: string;
  categoryCode?: string;
  cloudOnline?: boolean;
  dps?: Record<string, unknown>;
  dataPointInfo?: DeviceDataPointInfo;
  productInfo?: DeviceProductInfo;
  productStandardConfig?: ProductStandardConfig;
  homeId?: number;
}

export interface SmartLifeResolvedDevice extends SmartLifeDevice {
  devId: string;
  name: string;
  homeId: number;
  categoryResolved: string;
  dpsResolved: Record<string, unknown>;
}

export interface ApiRequestOptions {
  action: string;
  version?: string;
  data?: Record<string, unknown>;
  requiresSid?: boolean;
}
