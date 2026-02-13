# homebridge-smartlife-cloud

Homebridge platform plugin for SmartLife that:

- authenticates with SmartLife account email/password
- uses SmartLife cloud APIs (no direct LAN control)
- discovers devices in all homes in the account
- exposes supported devices to Apple Home (HomeKit)
- keeps state synced with frequent cloud polling

## What this plugin supports

Supported HomeKit services:

- `Switch`
- `Outlet`
- `Valve` (irrigation style)
- `ContactSensor`
- `LeakSensor`
- `SmokeSensor`
- `MotionSensor`

Devices/categories unsupported by native clean HomeKit mapping are skipped.

## Configuration

```json
{
  "platform": "SmartLifeCloud",
  "name": "SmartLife Cloud",
  "email": "you@example.com",
  "password": "your-password",
  "countryCode": "1",
  "region": "auto",
  "pollIntervalSeconds": 5,
  "discoveryIntervalSeconds": 300,
  "requestTimeoutMs": 10000,
  "maxRetries": 3,
  "logLevel": "info"
}
```

## Logging

`logLevel` values:

- `info`: normal logs
- `debug`: includes sync and retry details
- `trace`: includes request/response trace logs

## Reliability behavior

- automatic session/token re-login on session errors
- cooldown for repeated non-retryable auth failures (prevents login hammering)
- retry with exponential backoff on transient cloud failures
- jittered retry with HTTP 429/5xx retry handling
- command queue per device with duplicate/no-op coalescing to prevent rapid state race conditions
- periodic discovery refresh and frequent status polling
- accessory pruning protection during partial sync failures
- per-device reachability tracking with HomeKit `StatusFault` and communication-failure behavior for unreachable devices

## Notes

This plugin uses SmartLife cloud request signing and login flow compatible with current SmartLife Android app backend endpoints. It avoids local Tuya protocol by design.
