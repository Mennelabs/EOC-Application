# ADR-0002: TypeScript on Node.js 22 LTS for every service and app

- Status: proposed
- Date: 2026-10-12
- Requirements: SCL-11, SCL-15, NFR-11

## Decision

TypeScript (strict mode) for the API, workers, both web apps, the React Native field app and shared packages. Server runtime: Node.js 22 LTS on `node:22-alpine` images.

## Alternatives considered

| Option                              | Why not                                                                                                                                                                                                 |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Go for services, TypeScript for UIs | Fast and small images, but two languages means validation schemas and the action catalog (NFR-11: "consistent shared definitions… for manual, shorthand and natural-language paths") get written twice. |
| Java/Kotlin (Spring)                | Mature in government, but heavier containers and no code sharing with React Native.                                                                                                                     |
| Python (FastAPI)                    | Good for AI work, but no sharing with the field app; weaker typing across the boundary.                                                                                                                 |
| C#/.NET                             | Strong in government; same sharing problem as Java.                                                                                                                                                     |

## Why it fits SCL-11 and the government-cloud move

Node images are small, start in under a second, and run anywhere OCI images run. The LTS line has security support through April 2027, with a planned move to Node 24 LTS.

## Consequences

- One set of zod schemas (`packages/contracts`) validates the same payload in the browser, the field app, the API and the worker.
- CPU-heavy work (image processing, tile cutting) runs in workers or dedicated containers, not in the API event loop.
