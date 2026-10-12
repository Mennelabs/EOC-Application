# ADR-0019: GitHub Actions CI with Semgrep, Trivy, Syft SBOM and cosign signing

- Status: proposed
- Date: 2026-10-12
- Requirements: SEC-15, SCL-07, NFR-11

## Decision

GitHub Actions workflows: lint + format + typecheck; unit tests; integration tests on Compose; Playwright + axe; Semgrep (SAST); Trivy filesystem scan (dependencies, secrets, IaC) and image scan (fail on HIGH/CRITICAL with a fix available); Syft SBOM (SPDX) per image; cosign keyless signing of release images. Dependabot keeps actions, npm and Docker base images current. Third-party actions are pinned by commit SHA.

## Alternatives considered

| Option              | Why not                                                                                 |
| ------------------- | --------------------------------------------------------------------------------------- |
| CodeQL              | Free for public repos only; Semgrep OSS works for a private repo without extra licence. |
| Snyk                | Paid.                                                                                   |
| GitLab CI / Jenkins | The repository is on GitHub.                                                            |

## Why it fits SCL-11 and the government-cloud move

SBOMs and signatures are what a 3PAO asks for (SA-11, SR-3, SR-4 controls); the same signed images deploy to the government cloud.

## Consequences

DAST (OWASP ZAP baseline) is added in layer 2 when public endpoints exist.
