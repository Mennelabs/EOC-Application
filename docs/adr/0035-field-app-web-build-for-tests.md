# ADR-0035: The field app's web build runs the same screens for browser and accessibility tests

- Status: accepted
- Date: 2026-10-13
- Requirements: FLD-01, GATE-03, ACC-07, WCAG 2.2 AA, SCL-11, ADR-0014, ADR-0018, ADR-0019

## Decision

The field app is React Native on Expo (ADR-0014). Its screens also build for the web with react-native-web (`expo export --platform web`), and the `web` container serves that build at `/field/`. The browser suite runs it on a phone viewport against the real stack (`tests/e2e/field.spec.ts`) with axe on each screen, and the developer smokes run it against stubs. The release is the native app; the web build is a test and demonstration target, with the web storage and sign-in adapters (ADR-0032). An Android debug build (`expo prebuild` and Gradle on the runner's JDK and SDK) runs in CI on every push to prove the native project compiles; iOS needs a macOS runner (plan §14, flagged for Adam). TalkBack and VoiceOver passes, gloves and sunlight are checked by a person on a device (`docs/a11y`).

Two build details are recorded here. MapLibre 6 needs its worker bundled: the console and the public help site pass Vite's `?worker&url` to `setWorkerUrl`, and the help site's first-load budget leaves the lazily loaded worker out. The supply-chain guardrails (ADR-0019) stay on for the field app's dependencies, with one reviewed exact-version exclusion from the trust policy (`semver@6.3.1`, required by Babel; an older maintenance line published after the newer line gained provenance) and two exact overrides in `package.json` (`rolldown`, `ua-parser-js`).

## Alternatives considered

| Option                               | Why not                                                                                |
| ------------------------------------ | -------------------------------------------------------------------------------------- |
| Detox or Appium on an emulator in CI | Slow and flaky on hosted runners; axe does not run there. Kept for a later device lab. |
| A separate web field app             | Two apps to keep in step; the tests would not test what responders use.                |
| EAS cloud builds                     | A paid service (ask Adam first); local `expo prebuild` builds the same project.        |

## Why it fits SCL-11 and the government-cloud move

The web build is static files in the existing `web` image; nothing new to host. The Android build needs only the hosted runner.

## Consequences

Every field screen is checked against WCAG 2.2 AA automatically on each push; native-only behaviour (background location, the camera, SQLCipher, MDM) is covered by unit tests of `packages/field-core`, the native adapters' types and the manual device checks.
