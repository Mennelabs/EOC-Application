# ADR-0047: Badges print through the operating system's Brother driver, sized to the label; the field app's Brother SDK waits on the binary and its licence

- Status: accepted as the default in force (decision 2026-10-15, `docs/decisions.md`; the field-app SDK step waits on Adam)
- Date: 2026-10-18
- Requirements: BRD:FR-13.04, BRD:FR-13.05, BRD:FR-13.06, BDG-02, SCL-11, SCL-15

## Decision

1. **The console prints through the driver, not a vendor API.** The badge print view offers the two label printers the county chose, the Brother QL-820NWB (62 mm × 100 mm die-cut label) and the QL-1110NWB (4 in × 6 in), and a letter page for any printer. The choice sets the print dialog's page size and the badge card's dimensions (`@page` and label-sized styles); the browser hands the page to the operating system's Brother driver, which the county installs once on each check-in desk. No printer is reached from the server, no SDK runs in the browser, and the stack has no new container or dependency (SCL-11).
2. **The label is a fact on the badge.** Each print outcome (requested, confirmed, failed) records the layout it was printed on (`cg.badge.print_layout`, and the badge event's detail), so a reprint on the other printer is history, not a guess (BRD:FR-13.02, 13.06). A physical print is still confirmed by a person, never by a timestamp.
3. **The field app's Brother mobile SDK is the next step, on Adam's word.** Brother's Mobile SDK is a binary (Android AAR, iOS framework) under Brother's licence, not an npm package; the community wrappers that bundle it are immature (`react-native-brother-printers` 0.0.4, `@w3lcome/react-native-brother-printers` 0.1.7) and would add a native module the Android CI build has to compile. Adding it means accepting the licence and pinning a binary in the repository or a private registry (SEC-09 supply-chain scanning); that is Adam's call (rule 10). Until then a field desk prints from the console on a laptop beside it, or shares the badge from the console's print view to the printer's own app.

## Alternatives considered

| Option                                                           | Why not                                                                                                                                                                                     |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A print service container speaking the printers' raster protocol | A device on the desk's network reached from a container: a second network path to secure and keep in the government cloud, for two printer models; the driver already exists on every desk. |
| Brother's b-PAC SDK in the browser                               | Windows-only ActiveX; not an option for a web console on every desk.                                                                                                                        |
| Generating a PDF per label on the server                         | Possible with `@cg/pdf`, but the browser print dialog with `@page` gives the same label-sized output without a new endpoint; a PDF can follow if a county needs batch printing.             |
| The community React Native wrappers now                          | They bundle Brother's binary under its licence and are at version 0.x; the cost lands on CI and the supply chain before the first field print.                                              |

## Consequences

- A check-in desk installs the Brother driver and picks the printer in the print dialog; the console says which label it is sized for.
- The badge list shows the last label a badge was printed on; a reprint on the other printer is a new print outcome.
- The field app's badge printing stays a known limitation until Adam approves the SDK (`docs/operations/known-limitations.md`).
