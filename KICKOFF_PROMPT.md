You are building **Common Ground**, a disaster community-response platform for Mennelabs. Counties, cities, NGOs and states will use it to take damage and needs reports from residents, coordinate response and field work, share help with the public, and produce the federal data needed for a FEMA disaster declaration. The full product is release 1.

Start by reading `CLAUDE.md`. It holds the fixed decisions and the rules for the whole build. Then read every file in `docs/` in full, starting with `docs/00-original-BRD-FRD.txt`, which is the foundation. Then look at the mockups in `mockups/`. Don't skim. Every requirement ID is a testable commitment, and Section 29 of `docs/01-requirements-main.md` resolves conflicts between the documents.

What matters most, in priority order:

1. **Residents first.** One plain-language question at a time, by web, text, phone or assisted kiosk, in English and Spanish, accessible to WCAG 2.2 AA. A submission must never fail.
2. **People decide; AI assists.** AI drafts, sorts and suggests, and a human confirms anything consequential. AI providers are pluggable. Use a fake provider in development.
3. **Security and privacy.** Default deny, a full audit trail, configurable permissions with guardrails no county can remove, a separate CJIS enclave, and synthetic data only.
4. **Built for surge and for the move to a government cloud.** Everything runs in Docker Compose on Docker Desktop today. Every cloud service sits behind an adapter so the same containers can later run in a FedRAMP/GovRAMP environment.
5. **Frontline workers stay with survivors.** Documentation happens as a side effect of the work: scribe, quick capture, offline field app. It should not be a second job.

**Your first deliverables, before any feature code.** Stop and show me these for review:

1. `docs/requirements-index.md`: every requirement ID across all documents in one table (ID, source file, Must/Should/May, build layer 1–8, one-line summary). Flag any duplicates, contradictions or gaps you find, and say how you propose to resolve each one under Section 29.
2. `docs/architecture.md`: services and containers, including the separate CJIS container set; the data model (tenancy hierarchy, events, reports, needs, missions, people, audit); adapters (storage, keys, queue, AI, SMS/voice, maps); how permissions and guardrails are enforced; offline sync for the field app; and the path from Docker Desktop to the government cloud.
3. `docs/adr/`: one decision record for each technology choice (language, frameworks, database access, queue, auth, React Native libraries, map tile and geocoding servers, test tools), with the alternatives and the reason for each choice.
4. A monorepo scaffold where `docker compose up` brings up every service with health checks, a seed generator for a fictional county, CI covering lint, tests, accessibility, dependency and container scanning, and a README.
5. `docs/plans/layer-1.md`: the plan for layer 1 (foundations) under SCL-14.

After I approve that, build in the SCL-14 order, one layer at a time:

1. Foundations
2. Resident intake
3. Needs and public help
4. Missions, dispatch and field app
5. CJIS enclave
6. FEMA package and reports
7. AI features
8. ICS and EOC

For each layer, write the plan, build it, test it, then update `docs/traceability.md` and report back:

- what passed
- what failed
- what you deferred and why
- any decision you need from me

Don't start the next layer until the current one passes its acceptance cases and the applicable launch gates.

Ask me before you:

- break a Must requirement
- change a fixed decision in `CLAUDE.md`
- add a paid service
- build anything still open in Section 21
