# Plan: the design foundation (between layer 7 E and F)

Decided 2026-10-15 (`docs/decisions.md`): the console looked dated and showed every role all 45 workspaces, so the design foundation, the console frame and the situation home move ahead of the rest of layer 7. Evidence for every design choice: `docs/design/users-and-needs.md`. Technology choices: ADR-0045.

## Requirement IDs covered

| ID              | How                                                                                                                                                                       |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CON-01          | One console with role-based workspaces: the navigation is grouped by workspace and shows only what the person's permissions answer for; the home opens on their own work. |
| CON-11 (Should) | Briefing mode for the EOC wall display: large type, auto-refresh, no personal details.                                                                                    |
| CON-03, CON-06  | The situation home brings the map, the key counts and "what changed" onto one screen for the roles whose question that is (no new data).                                  |
| ACC-01, NFR-01  | WCAG 2.2 AA on every screen: the showcase under axe in both themes, desktop and phone; the existing journeys keep running.                                                |
| ACC-07          | Reflow at 320 px: the shell becomes a single column with a navigation drawer; wide tables scroll inside their region.                                                     |
| ACC-08          | Contrast enforced by a unit test over the tokens: 7:1 body ink, 4.5:1 other text, 3:1 lines, focus and fills, in both themes.                                             |
| ACC-09          | State never by colour alone: pills and notices carry words, a dot or an icon and a tone.                                                                                  |
| ACC-10, ACC-12  | One visible focus style everywhere; 44 px targets for staff, 48 px for residents.                                                                                         |
| ACC-16          | Reduced motion honoured; nothing moves on its own.                                                                                                                        |
| SCL-08          | The accent is a token a tenant may override; the contrast test is the gate.                                                                                               |
| SCL-11          | Fonts and components self-hosted; nothing fetched from outside.                                                                                                           |
| ADM-03          | The product name stays configuration in every header.                                                                                                                     |
| GATE-03         | Accessibility evidence: the showcase suite, the journeys, the per-screen records.                                                                                         |

## Data model

No change. No new columns, no migration.

## APIs

No new endpoints. The frame and the home read what exists: `/me` (actions, roles, tenant kind), `/events`, `/dashboard/counts`, `/recommendations`, `/facility-changes`, `/permission-changes`, `/reminders`, `/significant-events`, `/events/:id/declaration` and `/situation`. A role without an endpoint simply has no tile for it.

## Packages and screens

1. `packages/ui` (`@cg/ui`): tokens, base styles, the skin for the existing class names, the staff shell, React Aria components, icons, the theme and format helpers, the showcase.
2. The console frame: top bar (product, county, event chip, command bar, person and display menu), grouped navigation filtered by permissions with live counts, a drawer on phones, the sign-in card.
3. The home: a situation page for the roles with `dashboard.read` and an event (tiles, decisions waiting, significant events, the impact map link, what changed), a work page for everyone else (their queues, their counts), and briefing mode on `/console/briefing`.
4. The existing console screens through the shared skin (no code change), then the resident app and Find help on the tokens and the public font.

## Tests

- Unit: token contrast in both themes, theme preferences, format helpers, the navigation model (grouping, permission filter, counts).
- Showcase: Playwright with axe (WCAG 2.2 AA) in both themes on desktop and phone, reflow, open menu and dialog, briefing mode; screenshots kept.
- End-to-end: the existing journeys unchanged except the onboarding helper, which waits for the home heading by its id instead of the word "Welcome"; the planner's denied-workspace check goes to the address directly, since a workspace the person cannot use is no longer listed.
- Manual: `docs/a11y/checklist.md` on the new frame and home, both themes, recorded in `docs/a11y/screens/`.

## Deferred, and why

- The field app's restyle: React Native needs a device build to check; the token names are mirrored so it follows as its own task.
- A per-tenant accent setting in Administration: the token and the rule exist; the setting arrives with white-labelling (SCL-08) in a later layer.
- Moving every older screen's markup onto the components: the skin carries the look now; each screen moves when it is next touched, so no screen is rewritten twice.
- A screen-reader pass by a person: recorded as pending in the per-screen records, as for every earlier layer.
