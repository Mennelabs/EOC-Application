# ADR-0014: Field app on React Native with Expo (local builds), MapLibre RN, SQLCipher

- Status: proposed (built in layer 4)
- Date: 2026-10-12
- Requirements: FLD-01..17, DSP-05/07/08, CHN-07, CON-17, NFR-08, FL-08

## Decision

- **Framework:** React Native through Expo SDK with a custom dev client and _local_ builds (`expo prebuild` + Xcode/Gradle). EAS cloud builds are a paid service and are not used unless Adam approves.
- **Maps:** `@maplibre/maplibre-react-native` reading offline PMTiles packages cut from our self-hosted tiles (ADR-0015).
- **Storage:** `op-sqlite` with SQLCipher encryption; key in iOS Keychain / Android Keystore via `expo-secure-store`; app unlock with PIN or biometrics (`expo-local-authentication`).
- **Location:** `expo-location` with `expo-task-manager` background updates, only while checked in (DSP-08). Finding Q-07 covers the paid Transistor alternative.
- **Camera / QR:** `expo-camera` (photo-first capture, QR check-in).
- **Device management:** managed app configuration (`react-native-mdm`-style AppConfig keys) for tenant URL and single-app mode.
- **Screenshots:** blocked on screens with personal details (`expo-screen-capture`).

## Alternatives considered

| Option                            | Why not                                                                                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Bare React Native without Expo    | More native setup per module; Expo modules cover our needs and still allow native code.                                                 |
| Flutter                           | Fixed decision is React Native.                                                                                                         |
| WatermelonDB                      | Good sync framework, but its sync protocol would sit beside our action-catalog sync; plain SQLite plus our outbox keeps one write path. |
| Transistor background-geolocation | Best battery/accuracy, but paid licence (ask first).                                                                                    |

## Why it fits SCL-11 and the government-cloud move

The app talks only to the API through the gateway; changing environment is a managed-config value.

## Consequences

Watch Expo SDK upgrade cadence; pin versions and test offline/background behaviour on real low-end Android devices.
