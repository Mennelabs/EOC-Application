# Layer 7 report: AI assistance, the command window, facilities and recommendations

Date: 2026-10-15/16. Branch `claude/determined-gates-zd5i8m`. Layer 7 reached `main` in nine pull requests, each squash-merged with CI green:

| PR  | Merge commit                  | What it carried                                                                                     |
| --- | ----------------------------- | --------------------------------------------------------------------------------------------------- |
| #19 | `f809d68`                     | The AI foundation, together with the partner roll-up                                                |
| #20 | `17445a5`                     | The command window and the facility registry                                                        |
| #21 | `830ed2b`                     | Facility self-registration, the yearly re-check and the console screens                             |
| #22 | `eaf383a`                     | Recommendations                                                                                     |
| #23 | `8300162`                     | Resource discovery                                                                                  |
| #25 | `e5d79dd`                     | AI drafting                                                                                         |
| #26 | `6dd209a`                     | Scribe, hand-over, translation, the severity suggestion, and the tenant-scoped settings fix         |
| #27 | `eb6fe2f`                     | Queue order, near-identical photos, agreement and fairness alerts                                   |
| #28 | (open at the time of writing) | Tasks J and K, three privacy fixes, the `photo.quality` retirement and the photo evaluation harness |

Everything in the stack is synthetic or the WESTWIND exercise (SCL-12).

**The rule under every feature:** AI suggests, drafts and interprets; a named person decides; every essential task works with AI switched off.

**The provider:** OpenAI for every AI function (decided 2026-10-15, ADR-0043). It runs only where the secret `OPENAI_API_KEY` is set and an administrator has switched the feature on. **The key is not set in the cloud environment yet**, so every AI feature is off there today, and the manual paths are what runs.

## What was built

| Area                                                                                                                                                                                                                                                                                                                                                                                                                                      | Where                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **AI foundation:** the OpenAI provider for language, speech-to-text, speech, translation, image analysis and the damage classifier. Each call is recorded with provider, model, prompt version, outcome and latency, never the content. Also: health alerts (corrections, failures, fairness), name redaction, the live evaluation suite, and the AI use register with evaluation and switches                                            | `packages/ai`, `routes/ai-register.ts`, worker `ai-health.ts`, `ai-evaluate.ts`, migrations 0054–0055, 0073–0074                                            |
| **Command window:** a catalog of 12 commands over the console's own operations. Plain words are read into shorthand by the model; shorthand works without it. Every plan is confirmed, with undo inside its window. Also: personal and organization aliases, personal history for 30 days (never on a shared device), the field app's "Ask or command", and Find help's "Ask a question" (no model)                                       | `services/api/src/commands`, `routes/commands.ts`, `ui/command-window.tsx`, `apps/field/app/command.tsx`, ADR-0044                                          |
| **Facility registry:** county EM enters and approves; partners propose; the public offers a place; a yearly re-check                                                                                                                                                                                                                                                                                                                      | `routes/facilities.ts`, `screens/facilities.tsx`, `apps/web-help/src/offer.ts`, migrations 0060–0061                                                        |
| **Recommendations:** shelter, feeding stops, a POD with walk-up points, and a MARC. Each comes with its reasons, unknowns, the places set aside, the age of its inputs and an equity check. A named person accepts, edits or rejects it with a reason                                                                                                                                                                                     | `packages/reporting/src/recommend*.ts`, `routes/recommendations.ts`, `docs/recommendations.md`                                                              |
| **Resource discovery:** partner posts, county feeds and OpenAI web search. Each candidate carries its sources, and a person decides                                                                                                                                                                                                                                                                                                       | worker `discovery.ts`, `routes/discovery.ts`, `docs/discovery.md`                                                                                           |
| **AI drafting:** situation report summaries, Form 010-0-13 Boxes 8–9, the PIO's social post, radio loop, amateur-radio read-out and WEA text, a computer-generated radio voice and social cards. Every figure is checked against the facts it cites                                                                                                                                                                                       | `routes/drafting.ts`, `sites.ts`, `official-reports.ts`, `declaration.ts`                                                                                   |
| **Field:** the conversation note-taker (consent in the survivor's language; only the confirmed note is kept, audio deleted), the shift hand-over, and live translation with an interpreter one tap away                                                                                                                                                                                                                                   | `routes/scribe.ts`, `handover.ts`, `translation.ts`, `apps/field/app/{scribe,handover,translate}.tsx`, migrations 0068–0070                                 |
| **Photo pre-sort:** the sensitive-region blur fails closed. The severity suggestion is labelled "AI suggestion — not verified" and is only for reviewers who set the degree; it sees only photos the detector cleared. Need signals come first in the queue. Near-identical photos are flagged. Agreement is reported by hazard, home type and income band, with fairness alerts. The classifier's evaluation harness has fairness slices | worker `photos.ts`, `severity.ts`, `routes/reports.ts`, `packages/reporting/src/agreement.ts`, `packages/ai/src/evaluation/photos.ts`, migrations 0071–0073 |
| **Resident dictation:** through the county's provider, never the browser's speech recognition                                                                                                                                                                                                                                                                                                                                             | `services/api/src/public/dictation.ts`, `apps/web-resident/src/intake/speech.ts`                                                                            |
| **Governance records:** the NIST AI RMF mapping, launch-gate evidence, traceability and accessibility records                                                                                                                                                                                                                                                                                                                             | `docs/ai-rmf.md`, `docs/plans/layer-7-gates.md`, `layer-7-gate-08.md`, `tools/reqindex/trace-layer7.json`, `docs/a11y/screens/*`                            |

## What passed

- **Traceability:** of the 105 requirement IDs assigned to layer 7, 92 pass and 13 are partial as of 2026-10-16, after the follow-up work (76, 23 and 6 deferred when the report was first written; `docs/traceability.md`, evidence in `trace-layer7.json`). Across every layer so far, 482 of 663 IDs pass, 145 are partial, 33 deferred, 2 designed and 1 not started. Earlier IDs this layer extends are updated in place: INT-12, PHO-03, PHO-07, AIG-05, the GATE rows and others.
- **Launch gates:** GATE-02, GATE-04 and GATE-05 pass for layer 7. GATE-03 and GATE-08 are partial; see `layer-7-gates.md`.
- **Permission sweep:** every staff route (364) refuses a caller with no token and an account with no role, and none fails with a server error (`authz-sweep.db.test.ts`, in CI).
- **CI:** each merged PR was green end to end (lint, typecheck, unit tests, scans, Semgrep, the Android build, and the compose stack with integration, database and browser suites). Locally the full database list, the console, resident, field and help journeys, and the a11y spec pass.

## What did not pass, or is not yet proven

- **Live AI.** `OPENAI_API_KEY` is not set anywhere this build ran, so the live evaluation suite (`evaluate:live`) and real calls have not run. The automated suites use a test double and recorded OpenAI replies. Before a county relies on any feature:
  1. set the key;
  2. run the evaluation from the AI use register;
  3. switch features on one by one.
- **Photo fairness before launch (PHO-13, AIG-08).** The harness exists (`pnpm --filter @cg/ai evaluate:photos <manifest.csv>`), but no labelled photo set ships. Until one is run, the severity suggestion should stay off.
- **GATE-08 gaps** (`layer-7-gates.md`):
  - These are code only: the provider-failure path of `field.voice_draft`, the scribe note model's failure, and the per-suggestion confirm controls.
  - Injection cases in the evaluation suite cover extraction and the command window only.
  - No test hides instructions in an image.
  - Listening to AI radio audio before it airs is a procedure, not a gate.
- **Screen-reader passes** of every new screen need a person with NVDA and VoiceOver, and the field app needs a device pass, including a real recorded conversation with the AI on.
- **Command window (Must, BRD section 10):**
  - Not yet in the catalog:
    - personnel, damage-assessment and resource/contact/badge commands (CMD-14, CMD-15, CMD-17);
    - administration commands (CMD-18);
    - mission drafts, priority, assignment and closure (CMD-13, AC-C01);
    - exports (CMD-16);
    - a message-sending command (AC-C08).
  - Not built:
    - the window does not use the selected record as context (CMD-06);
    - there is no open-draft registry, so unsaved forms are only protected by version checks (CMD-29, AC-C09);
    - there are no bulk commands (CMD-30) and no multi-step workflows (AC-C07);
    - latency targets are not enforced or measured (CMD-38).
- **Field and recommendations (Must):**
  - voice commands for logging meals or referring to case management (FL-07);
  - facility owners updating their own entry (REC-01);
  - canteen staff counts used as a limit (REC-06);
  - an interpreter joining a conversation remotely (FL:FR-24).
- **Earlier layers, still not started (Must):**
  - finding a survivor's record by phone and a one-time code, or by address and name (FL-02);
  - document photos into a survivor's record with consent (FL-09);
  - an off-duty release policy for open assignments (AC-05C).
- **Retention (SEC-13):** no sweep yet deletes the field-records, badges, safety, comms or child-records categories, and `cg.change_feed` is never pruned.
- **Found and fixed during this layer**, each with a test that failed before the fix:
  - several tenant settings, and the AI provider and switches, were read without the tenant filter by the worker's system role (`6dd209a`);
  - resident dictation went through the browser's speech recognition, which sends audio to Google or Apple (INT-12, AIG-06);
  - the severity classifier could be sent an unblurred photo when the detector was off or failed (PHO-07, AIG-05);
  - a legal-aid referral's note reached the referring organization and the county's audit log (FL:FR-23);
  - the AI register listed `photo.quality`, which called nothing (AIG-01).

## What was deferred and why

| What                                                                             | Why                                                                                              | When                            |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------- |
| A purpose-trained, validated damage classifier (PHO-12)                          | The university partnership does not exist yet; OpenAI's vision model fills in (Adam, 2026-10-15) | When a model card passes PHO-13 |
| A cloud AI provider in a government region                                       | OpenAI until the first customer and a cloud account (Adam, 2026-10-15)                           | First customer                  |
| Reverse-image matching against stock photos (PHO-15)                             | Needs a provider that offers it                                                                  | Later                           |
| Automatic AI switch-off (AIG-09, FL-18)                                          | Adam decided on alerts only (2026-10-15)                                                         | Not planned                     |
| Case management on the shared record (FL:FR-16 contact log, FL:FR-23 case notes) | Adam: after layer 8 (2026-10-15)                                                                 | After layer 8                   |
| The command-window, field and earlier-layer Musts listed above                   | Not built in this layer                                                                          | Next, unless you reorder        |

## Readings taken in favour of privacy and safety (flagged for you)

The plan's §12 lists all 32. The newest:

- a legal aid organization's referral responses share only the status;
- resident dictation goes through the county's provider or not at all;
- the register lists only features that call a provider;
- "income band" is the county's tract poverty quintile;
- a group is behind on severity agreement when it has 20 or more decisions and is more than 10 points under the model's overall agreement.
- finding a survivor without their code shows nothing until the survivor reads back a texted code or recognises a report read back by its date (FL-02);
- a document a survivor shares is never one of the report's damage photos, never sent to an AI service, and seen only by document readers (FL-09);
- field records are counted from the day their event closes, so an open event's records never expire (SEC-13).
- a resident's complaint about computer help is one of four fixed reasons, with no words, and changes nothing in their report; more than 10% of a feature's recent outputs drawing one raises an alert (AIG-09);
- the approved time zone is the county's own: the console shows and reads times on the county's clock with the zone named, and an entry can be dated back but not ahead (BRD:FR-00.08, AC-08A);
- a worker's request for peer support is seen only by the peer-support role, holds no words, and is deleted 30 days after it closes (FL-16);
- the roster is swept the records period after a person was archived, and every record that still names them keeps them (SEC-13).
- a field report of how a site looks, or of a resource seen, is an observation for dispatch to note; it never changes the site's status, which stays with the site's lead (FLD-11).
- a resupply request started at the reorder point is a draft a person checks and sends; one shortage is asked for once (FL:FR-21, FL:FR-22).
- a lost pet is matched to an animal found or sheltered by a person, from suggestions that show the words the descriptions share (FL:FR-08).
- a canteen stop's allergen note is about the food, never who has an allergy (FL:FR-17).
- a badge photo is printed only once a second person approves it; whoever took it cannot (BRD:FR-13.01).
- a walk-up volunteer's own sign-up by QR waits at the desk under a desk code; reception sees whether a phone or email was given but never the contact, which goes straight to the roster, and the request's details are erased once decided (FL:FR-20).
- a health notice is approved by someone other than its drafter, reaches only residents in its area who agreed to be contacted (a text only with text opt-in, an email only when email is their chosen way), and its reach is shown as counts only (FL:FR-06).
- a report sent to the field stays in review until a visit verifies it; it is routed by the parcel its location names, the parcel under its point, or the county's parcel at the street line the resident typed, never an outside geocoder, and one with no parcel in a route area waits for its place to be fixed (CON-05).
- an organization reports its places one after another in one visit, each its own report with its own number; who they are and how to reach them are asked once, everything about each place every time, and no place's needs or sharing choices are copied to another (ORG-01).

## Questions for you (defaults in force)

1. **The OpenAI key.** Set `OPENAI_API_KEY` as a secret in the cloud environment (environment settings, never in chat or the repository). Then run the evaluation from the AI use register before switching features on.
2. **Zero data retention.** Please attach the Mennelabs zero-data-retention agreement to the register's provider record (AIG-06, ADR-0043). Please also confirm it covers OpenAI web search, which discovery uses. Until then, keep `discovery.web_search` off.
3. **A labelled damage-photo set** for the fairness evaluation (PHO-13): licensed or synthetic, kept outside the repository. Who supplies it? Until it is run, the severity suggestion stays off.
4. **Planning defaults** in force, all tenant settings:
   - **fairness:** 20 decisions, 10 points;
   - **photo evaluation:** 20 cases, 10 points, 2 points of regression;
   - **AI health:** 30% of the last 50.
5. **Order of the remaining Musts.** By default, next comes the command-window catalog: personnel, damage assessment, resources and contacts, mission assignment, exports, then the open-draft registry and selected-record context. After that: FL-07 voice commands, FL-02, FL-09, REC-01, REC-06, AC-05C and the SEC-13 sweeps. An interpreter joining remotely (FL:FR-24) needs a video service, which is a paid third party: yes or no?
6. **Dictation now needs the AI service.** Without it, residents type, or use their phone keyboard's own microphone. Is that acceptable?
7. **What a public-records release withholds (SEC-13).** The requirement names restricted fields. The release also withholds, by default:
   - sensitive fields, such as mission summaries, need details and message bodies;
   - security values and residents' reference codes;
   - links to people and places;
   - household needs.

   Confidential sites are left out entirely. Each withheld column is listed in REDACTIONS.csv, and a person reviews the file before release. Should sensitive fields stay withheld, or should your county's records rules decide them? Releases are open to the EM director and the PIO, and each person can release only what they may read.

8. **Batches in the command window (CMD-30).** They exist for need claims and releases only, are phase 4 (off until a county turns them on), and need the new action `command.bulk`. Are other batch commands wanted (for example closing missions)?
9. **Deleting the core records after their period (SEC-13).** Reports, needs, missions, photos and residents' words are the last SEC-13 category without a sweep. Deleting them touches about 40 linked tables, object storage and what partners hold, and cannot be undone, so `docs/plans/sec-13-core-records.md` sets out a reading and four questions before anything is built. In short:
   - Count from the event's close?
   - Keep issued official reports and declaration figures?
   - Recall shared copies from partners?
   - Keep any de-identified counts?
10. **Documents survivors share (FL-09).** Who may see them: the default is the assessment reviewer and the damage-assessment coordinator (`document.read`). Should case managers in partner organizations see them too, through the sharing grant? Withdrawing a shared document is not built yet.
