# ADR-0045: One design foundation for every web app: tokens, self-hosted fonts, React Aria components

- Status: accepted (Adam, 2026-10-15)
- Date: 2026-10-15
- Requirements: CON-01, CON-11, ACC-01, ACC-07, ACC-08, ACC-09, ACC-10, ACC-12, ACC-16, NFR-01, SCL-08, SCL-11, ADM-03, GATE-03, AC-A02, AC-A03
- Evidence: `docs/design/users-and-needs.md`

## Decision

`packages/ui` (`@cg/ui`) is the one design foundation for `apps/web-console`, `apps/web-resident`, `apps/web-help` and `apps/web-cjis`; the field app mirrors its token names.

1. **Tokens as CSS custom properties** (`--cg-*`): colour (a light and a dark palette), type scale, spacing, radius, elevation, motion and target sizes. The dark palette follows the device's preference and can be fixed by the person (`data-theme`); density (`data-density`) and the wall-display briefing mode (`data-mode`, CON-11) are attributes on the document too. A unit test reads the tokens and fails when any colour pair drops below its rule: body ink 7:1, other text 4.5:1, lines, focus and fills 3:1, in both themes.
2. **Self-hosted fonts** through Fontsource (OFL): IBM Plex Sans (variable) for staff, Atkinson Hyperlegible Next (variable) for residents and the public, IBM Plex Mono for codes. Each app loads one family; no request leaves the stack for a font (SCL-11, and a resident's data plan).
3. **Components on React Aria Components** where a widget has real behaviour (menus, selects, dialogs, tabs, tooltips, switches, checkbox and radio groups) and on plain elements where the element already does the job (buttons, tables, native dialogs the console already uses). Icons come from Lucide (ISC), always beside a visible label or an accessible name.
4. **The existing class names keep working.** The console's `.panel`, `.status`, `.badge`, `.field`, `.table-wrap`, `button.primary` and the rest are skinned by the shared stylesheet, so every screen built before this foundation takes the new look without a code change, and is moved to the components as it is next touched.
5. **A showcase page** (`pnpm --filter @cg/ui showcase`) shows every token and component in both themes; a Playwright suite runs axe (WCAG 2.2 AA) on it in both themes on a desktop and a phone, checks reflow, and keeps screenshots for review. It needs no stack.
6. **The product accent is a tenant setting** (SCL-08): a county may override `--cg-accent`; text on the accent is always `--cg-accent-ink`, and the contrast test is the gate for any shipped palette.

## Alternatives considered

| Option                                   | Why not                                                                                                                                                                         |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keep one hand-written stylesheet per app | That is what made the apps look unrelated and dated; nothing shared, nothing tested.                                                                                            |
| USWDS (the US Web Design System)         | Familiar to federal buyers, but a large opinionated CSS and JS bundle, a look counties associate with federal sites, and no React Aria-grade widgets. Its conventions are kept. |
| Tailwind                                 | Utility classes in every screen; no token contract a React Native app can mirror; a build step in each app for little gain over custom properties.                              |
| shadcn/ui, Radix, MUI, Chakra            | Good libraries, but each brings its own theming layer; React Aria is the behaviour layer ADR-0013 already chose and it carries no visual opinion to fight.                      |
| Google Fonts or another CDN              | A third-party request from a survivor's phone, blocked on some networks, and not available in a government cloud without an egress rule.                                        |
| System fonts only                        | Free and fast, but the staff and public faces were chosen for legibility (distinct I/l/1, wide spacing); the variable files cost 36–48 KB once.                                 |
| Dark theme by default                    | Dark-on-light reads better for every age; dark stays a choice for night rooms and some low-vision readers (users-and-needs §1.5).                                               |

## Why it fits SCL-11 and the government-cloud move

Static CSS, fonts and JavaScript served by the same web containers; nothing fetched from outside; the same build runs on Docker Desktop and in the cloud. Preferences live on the device, not on the server.

## Consequences

- The console bundle grows by about 150 KB compressed (React Aria Components and the icons); the resident app and the public page take only the tokens, base styles and the public font (about 9 KB of CSS and 36 KB of font), inside the 300 KB first-load budget (PUB-07).
- The manual accessibility checklist (`docs/a11y/checklist.md`) applies to both themes; the per-screen records note which theme was checked.
- A new screen starts from the components; a screen touched for another reason moves its ad-hoc markup to them in the same change.
- The field app's restyle (React Native) follows separately with the same token names in `packages/ui/src/tokens.ts`, so the two stay one system.
