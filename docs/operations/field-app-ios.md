# The field app on iPhone: building it on a Mac

Decision 2026-10-15 (`docs/decisions.md`): the iOS build of the field app is made by Adam on his own Mac with Xcode; it needs an Apple Developer Program membership in Mennelabs' name. Android keeps building in CI (`.github/workflows/ci.yml`, job `android`); iOS in CI would need a paid macOS runner (layer-4 plan §14). EAS cloud builds stay off (ADR-0014, rule 10).

Everything Xcode will see is generated from `apps/field/app.json` by `expo prebuild`; `apps/field/test/ios-config.test.ts` checks that file on every push (identifier, background location, every permission text, the privacy manifest, English and Spanish, no product or county name in the build). This page is the part a person does.

## 1. What the Mac needs

| Item                             | Why                                                                                                                                                           |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| macOS with Xcode 16 or newer     | Builds, signs and runs the app; install from the App Store, then open it once and accept the licence; `xcode-select --install` for the tools.                 |
| Node (the version in `.nvmrc`)   | `nvm install` in the repository picks it; `corepack enable` gives `pnpm`.                                                                                     |
| CocoaPods                        | Native modules on iOS: `brew install cocoapods` (or `sudo gem install cocoapods`). `expo prebuild` runs `pod install` itself.                                 |
| Apple Developer Program          | Signing on a device and any distribution. Membership in Mennelabs' name; Adam is the account holder. A free Apple ID runs the app on a phone for 7 days only. |
| An iPhone with Developer Mode on | Settings → Privacy & Security → Developer Mode, after the first Xcode run asks for it.                                                                        |

## 2. Build and run on a phone

```sh
git clone <repository> && cd EOC-Application
nvm install && corepack enable
pnpm install --frozen-lockfile
cd apps/field
FIELD_API_BASE=https://respond.example-county.gov FIELD_TENANT=westwind pnpm prebuild:ios
open ios/Field.xcworkspace
```

- `FIELD_API_BASE` is the county's gateway (the same origin that serves `/config.json`); `FIELD_TENANT` its organization code. Both come from the environment through `app.config.js`, so `app.json` is never edited per county (SCL-11, ADM-03). The product and county names are read from the gateway at start; the build holds neither.
- `prebuild:ios` writes `apps/field/ios/` (git-ignored) and runs `pod install`. Re-run it after a dependency change; add `--clean` to start the folder over.
- In Xcode: select the `Field` target → **Signing & Capabilities** → **Team**: Mennelabs. Leave **Automatically manage signing** on. The capabilities are already there from `app.json`: Background Modes (Location updates), Keychain, Face ID text, camera, photo library and microphone texts, the privacy manifest.
- Choose the phone in the toolbar and press Run. The first run asks the phone to trust the developer certificate (Settings → General → VPN & Device Management).

## 3. What to check on the phone before anyone else gets a build

In this order, each against the Westwind exercise stack (`docs/02`):

1. Organization code, sign-in, PIN, then Face ID unlock; ten wrong PINs clear the store (FLD-02).
2. Check in: iOS asks for location "While Using", then on the next start "Always" with the text about being checked in. Leave the app: the blue location pill shows while checked in and stops at check-out (DSP-08, FLD-15).
3. Badge and wristband scan with the camera; a photo on a damage record; the photo leaves the phone once received (FLD-06).
4. The scribe: the microphone prompt names consent; recording stops when the screen is left (FL-04, FL-18).
5. An offline map package downloads and draws; airplane mode keeps the app working and the outbox sends on return (FLD-13, FLD-09).
6. VoiceOver on every screen of the checklist in `docs/a11y/checklist.md`; Dynamic Type at the largest accessibility size; gloves and sunlight (GATE-03).
7. Screenshots and screen recording on a screen with personal details come out black on both platforms (expo-screen-capture: FLAG_SECURE on Android, Apple's secure-field protection on iOS); take one on a record and one on the sign-in screen, which stays allowed (FLD-02).

## 4. Distribution

- **Internal testing:** Product → Archive → Distribute App → **TestFlight**. Testers install TestFlight and get the build within a day of review.
- **County devices under device management:** Apple Business Manager with the app as a **custom app** (unlisted, assigned to the county's organization) or an **unlisted App Store** link, pushed by the county's MDM. Which one is a question for Adam and the first county; both need the Program membership and App Store review.
- **App Store Connect asks two questions the code cannot answer for Adam:** export compliance (the app encrypts its store with SQLCipher and talks TLS; standard algorithms, no proprietary cryptography) and the App Privacy labels (precise location while checked in, photos, name and email of the signed-in worker, the device identifier for remote wipe; nothing is used for tracking, and the privacy manifest says so). The privacy labels should match `docs/plans/layer-4.md` §6 and the retention table in `docs/traceability.md` (SEC-13).
- The version is `expo.version` and `expo.ios.buildNumber` in `app.json`; each upload needs a higher build number.

## 5. Not built yet

- **Managed app configuration (MDM) is not read** on either platform (FLD-02 partial): the gateway and organization code come from the build's `extra`, so a county's devices get a build made for that county. Reading `com.apple.configuration.managed` (iOS) and `RestrictionsManager` (Android) would let one build serve every county from the MDM; it needs a native module and a test device, and waits on the first managed deployment.
- **Badge printing from the phone** waits on Brother's SDK (ADR-0047 §3).
- **An iOS build in CI** waits on a paid macOS runner (layer-4 plan §14).
