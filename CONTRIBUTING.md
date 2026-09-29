# Contributing

- Issues and pull requests are welcome. Describe the device (model, Android version, ROM) for anything phone-specific, and attach the logs from **诊断 → 分享日志**.
- Before a pull request: `npm test` (both contract groups) and, for Android changes, `cd android && ./gradlew assembleDebug`.
- Keep DSH unmodified: Android adaptations go into `packages/android-compat`, the payload's host patch layer, or the DSH binding's public extension points — never into files under `@deepseek-ai/`.
- The SDK (`packages/sdk/src/api.ts`) is versioned: additions are fine, breaking changes need a new major (`ash-api/2`).
