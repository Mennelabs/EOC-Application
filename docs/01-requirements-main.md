# Community Damage & Needs Intake — Research-Backed Requirements

Oct 9, 2026 · @Adam Menne

## Purpose and decisions

Residents report damage and needs by answering one plain-language question at a time, by any channel, with photos coached by AI and every consequential judgment made by a human. This doc extends the original Emergency Management Application Rebuild BRD/FRD (Parts A and B plus the accessibility and command annex) with Sections 11–29, and is written to be handed to Claude Code together with it. Section 29 reconciles the two.

Decisions captured in the interview:

| Topic | Decision |
| --- | --- |
| Owner and seller | Mennelabs |
| First buyers | County/city emergency management, NGOs (Salvation Army, Red Cross), states and regional coalitions |
| Pricing | Annual subscription per jurisdiction, tiered by population served |
| Criminal-justice data | Full mission model kept; criminal-justice data lives in a separate CJIS enclave built for launch (SEC-12). Operating mode: disasters only (DEC-01) |
| Photo AI authority | Coaches photos and suggests a FEMA damage category; a human always decides |
| Photo model source | University research partnership for labeled data, training and published validation |
| Resident channels | Mobile web (no install), SMS conversation, phone/IVR or call-center assist, assisted/kiosk at shelters and PODs |
| Hosting | Develop in Docker on Docker Desktop now; move the same containers to a federally authorized (FedRAMP/GovRAMP-capable) government cloud when ready to scale (decided 2026-10-12). Language and framework: Claude Code chooses, within SCL-11, and records why. Field app: React Native. Maps: open source, MapLibre with OpenStreetMap data (SCL-13). Release 1: everything in this document (SCL-14) |
| Launch languages | English and Spanish at launch (decided 2026-10-12); more languages later, tenant-configurable |
| Free-form input | Voice or free text allowed; AI drafts answers, resident confirms each one |
| Needs in same flow | Yes — damage and needs in one intake, with separate consent for NGO sharing |

How Claude Code should use this doc:

- Treat every ID (INT-01, PHO-01…) as a testable requirement. "Must" is release-blocking; "Should" is planned; "May" is optional.
- Where a requirement here conflicts with Sections 9–10, the stricter one wins.
- Do not build anything listed in Section 21 until it is decided.

## Research basis

The strongest evidence supports one-question-at-a-time intake, coached photos reviewed by people, and designing for low literacy, smartphone-only access and many languages. Vendor claims of 40–300% completion gains for chat-style forms are marketing, not research, and should not be cited in sales material.

| Finding | Evidence strength | Design consequence |
| --- | --- | --- |
| Chatbot-style surveys produced more differentiated answers and less low-effort "satisficing" than web forms ([Kim, Lee & Gweon, CHI 2019](https://www.springerprofessional.de/doi/10.1145/3290605.3300316)) | Peer-reviewed experiment | Conversational pacing, not a free-roaming chatbot |
| In a field experiment, chatbot surveys had fewer skipped and "don't know" answers than web forms ([IZA DP 15597](https://docs.iza.org/dp15597.pdf)) | Field experiment | Ask, confirm, move on; allow "I don't know" without penalty |
| GOV.UK found simple one-question-per-page designs work better than more complicated layouts as a starting point ([GDS](https://userresearch.blog.gov.uk/2015/08/13/no-more-accordions-how-to-choose-a-form-structure/)) | Large-scale government user research | Default UI pattern for every channel |
| Oklahoma OEM residents completed a photo-and-map damage survey in under five minutes, feeding PDAs to FEMA and SBA ([Esri](https://www.esri.com/about/newsroom/arcnews/oklahoma-crowdsources-damage-assessments-to-kick-start-disaster-recovery)) | Operational precedent | Five-minute target; output must feed PDA workflows |
| FEMA can validate damage by desktop review using submitted photographs ([KYEM fact sheet](<https://kyem.ky.gov/recovery/Documents/Preliminary%20Damage%20Assessment%20(PDA)%20Guide%20Fact%20Sheet.pdf>)) | Federal guidance | Photos must be PDA-grade: whole structure, waterline, close-ups |
| FEMA uses four degrees of damage: affected, minor, major, destroyed ([PDA Pocket Guide 2025](https://www.fema.gov/sites/default/files/documents/fema_rd_pda-pocket-guide_07012025.pdf)) | Federal standard | AI suggestions map to these four, nothing else |
| A ground-photo classifier reached 93.5% validation accuracy on three classes ([Disasters journal](https://www.citedrive.com/en/discovery/deep-learningbased-classification-of-earthquake-damaged-buildings-using-terrestrial-images/)) | Research, single hazard | Purpose-trained models are promising for triage |
| GPT-4V scored near-zero R² rating damage severity from paired images ([arXiv 2401.17600](https://arxiv.org/pdf/2401.17600)) | Benchmark | Never use a general vision-LLM's severity rating as a decision |
| Roughly 54% of US adults aged 16–74 read below a 6th-grade level ([Snopes on APM/Gallup](https://www.snopes.com/news/2022/08/02/us-literacy-rate/)) | Modeled estimate | Grade 5 reading target; icons and examples on every question |
| 28% of adults in households under $30K are smartphone-dependent ([Pew 2024](https://pewresearch.org/internet/2024/01/31/americans-use-of-mobile-technology-and-home-broadband)) | National survey | Mobile-first, data-light, SMS fallback |
| 25M+ US residents are limited English proficient ([ACS via Boostlingo](https://boostlingo.com/resources/lep-state-map/)) | Census data | English and Spanish at launch, more later; free text accepted in any language |
| FEMA aid has tracked with widening wealth gaps by race and homeownership ([Pitt/Rice study](https://www.news.pitt.edu/node/35458)) | Peer-reviewed longitudinal study | Renter-first questions; equity monitoring of who reports and who gets help |

Trauma-informed practice, especially SAMHSA's safety and trust principles, frames tone and pacing ([UN Tech for Victims note](https://www.un.org/counterterrorism/sites/default/files/2026-05/TechforVictims_2026WorkingGroup-InformationNote.pdf)).

## 11. Guided conversational intake (INT)

The resident experience is a guided conversation backed by a deterministic question graph: the graph decides what is asked; AI only helps phrase, interpret and fill.

**11.1 Question engine**

- **INT-01 (Must)** Define intake as a versioned, tenant-configurable question graph (JSON schema): question, answer type, branching rules, required flag, FEMA/PDA field mapping, translations.
- **INT-02 (Must)** Present one question at a time on every channel; group only questions research shows belong together (e.g. street + city).
- **INT-03 (Must)** Branch so people see only relevant questions: renters never see owner-only questions; flood shows waterline questions; wind shows roof questions.
- **INT-04 (Must)** Median completion for a basic damage report ≤ 5 minutes on a mid-range phone over 3G; target ≤ 12 required questions on the shortest path.
- **INT-05 (Must)** Every closed question offers "I don't know" and "Skip" where the field is not legally required; neither blocks submission.
- **INT-06 (Must)** Show progress as steps remaining in words ("About 4 questions left"), not a percentage bar that jumps with branching.
- **INT-07 (Must)** Ask the safety screen first: "Is anyone in danger right now?" A yes shows local emergency instructions (ACC-48) before anything else.

**11.2 Question writing**

- **INT-08 (Must)** Write questions at or below grade 5 reading level, measured automatically in CI and reviewed by a person.
- **INT-09 (Must)** Damage-level questions use plain descriptions with illustrations, never FEMA terms: "Can you still safely live in your home?" rather than "Is the residence habitable?"
- **INT-10 (Must)** Each question shows one short example answer and why it is asked ("This helps us send the right volunteers").
- **INT-11 (Should)** Use picture-choice answers for damage type (roof, windows, water inside, tree on house, home moved off foundation).

**11.3 Free-form and voice input**

- **INT-12 (Must)** At any point a resident may type or speak freely ("A tree fell on the back bedroom and water came in"). AI extracts candidate answers for later questions.
- **INT-13 (Must)** AI-extracted answers are shown back as plain statements for one-tap confirm or edit ("You said: tree on house — is that right?"). Unconfirmed extractions are never saved as answers.
- **INT-14 (Must)** Questions already answered by a confirmed extraction are skipped; the review screen still lists them.
- **INT-15 (Must)** Store the resident's original words verbatim alongside extracted fields, in the original language.
- **INT-16 (Must)** If AI is unavailable, the same graph runs without it (ACC-37, CMD-05).

**11.4 Tone and trauma-informed behavior**

- **INT-17 (Must)** Calm, warm, non-clinical tone. No exclamation marks, emoji, gamification or celebratory animations.
- **INT-18 (Must)** Never ask why someone did not evacuate, insure, or prepare. Never imply blame.
- **INT-19 (Must)** Questions about household members, disability, medical needs or immigration-adjacent topics are optional, explain their purpose, and are asked after the damage report is safely saved.
- **INT-20 (Should)** Offer a "Pause" that saves a draft with a short resume code, respecting shared-device rules (ACC-41).

**11.5 Review and confirmation**

- **INT-21 (Must)** Before submit, show a plain-language summary grouped into "Your home," "What happened," "What you need," each editable.
- **INT-22 (Must)** Confirmation gives a short human-readable reference (e.g. 4 letters + 4 digits, no ambiguous characters), sent by SMS or email if the person chose that, and states what happens next without promising aid (ACC-30).

## 12. Photo-guided evidence and AI pre-sort (PHO)

Photos are evidence that a person reviews; AI makes the photos better and the review queue faster, but never sets a damage category on its own.

**12.1 Coached capture**

- **PHO-01 (Must)** Ask for a guided shot list based on hazard type: (1) whole home from outside, (2) worst damage close-up, (3) for flood, the highest waterline with a common object for scale, (4) optional interior. Mirrors what counties already ask residents for.
- **PHO-02 (Must)** Show an illustrated example for each requested shot, plus a safety line: "Do not go inside if it is unsafe."
- **PHO-03 (Should)** On-device checks before upload (blur, darkness, nothing building-like in frame) give one plain retake suggestion. Run in the browser where possible so it works on slow connections.
- **PHO-04 (Must)** Photos are optional for submission. A report without photos is valid and is routed for field verification.
- **PHO-05 (Must)** Accept photos from the camera or gallery, and SMS/MMS on the SMS channel; compress client-side to a tenant-set size (default ≤ 1.5 MB).

**12.2 Privacy of images**

- **PHO-06 (Must)** Read GPS and time from EXIF only to suggest location and date for the resident to confirm, then strip all EXIF from stored derivatives.
- **PHO-07 (Must)** Detect and blur faces, license plates and visible documents in any image shown outside the reviewing case worker role. Keep the original in restricted storage.
- **PHO-08 (Must)** Never publish public-submitted photos to public dashboards by default.

**12.3 AI pre-sort for reviewers**

- **PHO-09 (Must)** AI produces, per report: a suggested FEMA degree of damage (affected, minor, major, destroyed, or "cannot tell"), a confidence score, and the visible features behind it ("roof covering missing," "waterline above outlets").
- **PHO-10 (Must)** Suggestions are labeled "AI suggestion — not verified" everywhere they appear and are never shown to the resident as a finding (ACC-11).
- **PHO-11 (Must)** A credentialed reviewer sets the official degree of damage. Record suggestion, decision, reviewer and whether they agreed.
- **PHO-12 (Must)** Use a purpose-trained or fine-tuned image classifier, evaluated against FEMA matrix labels, for the suggestion. A general-purpose vision-LLM may describe features and check photo quality, but may not supply the severity rating. Source the model through a university research partnership that supplies FEMA-matrix-labeled images, independent validation and a published model card; keep the model behind a swappable inference interface.
- **PHO-13 (Must)** Before launch and per model version, publish accuracy by hazard type, home type (conventional vs manufactured) and neighborhood income band. Do not ship a model that is materially less accurate for any group.
- **PHO-14 (Should)** Sort the review queue by need signals (people unsafe, no shelter, medical needs) first and AI severity second, so AI never pushes vulnerable households down.
- **PHO-15 (Should)** Flag possible duplicates by address, near-identical images and reverse-image matches to known stock or prior-event photos, for human review only.

**12.4 PDA output**

- **PHO-16 (Must)** Export reviewed reports in a format that supports state Initial Damage Assessment and FEMA desktop PDA packages: counts by degree of damage, home type, owner/renter, insured status, representative photos, and map layer.

## 13. Multichannel reporting (CHN)

All four channels run the same question graph (INT-01) and write to the same report record, so a resident can start by text and finish with a volunteer.

| Channel | Who it serves | Key constraint |
| --- | --- | --- |
| Mobile web | Smartphone owners, including smartphone-only households | No install, works on 3G, under 300 KB first load |
| SMS conversation | Basic phones, low data, people who prefer texting | 160-character questions, numbered replies, MMS photos |
| Phone / IVR + call-center assist | People who cannot read or type easily, older adults | Agent enters answers into the same flow |
| Assisted / kiosk | Shelters, PODs, MARCs, door-to-door canvassing | Shared devices, offline capture, proxy consent |

- **CHN-01 (Must)** One report record regardless of channel; record channel of origin and every channel used.
- **CHN-02 (Must)** Mobile web is a PWA: no account or install required, installable optionally, works on the two most recent major versions of iOS Safari and Android Chrome plus 4-year-old devices.
- **CHN-03 (Must)** SMS: a keyword (e.g. DAMAGE / DANOS) starts the flow in the matching language; numbered answers; "BACK," "SKIP," "HELP," "STOP" always work; MMS photos attach to the current question.
- **CHN-04 (Must)** SMS carrier compliance: registered sender (10DLC or toll-free verified), STOP/HELP handling, no marketing content.
- **CHN-05 (Should)** IVR offers speech or keypad answers in each launch language and transfers to a live agent at any point; agents work in a staff view of the same flow.
- **CHN-06 (Must)** Assisted mode records the helper, the affected person and their consent (ACC-46); helper sees only what they entered, and the session clears on completion.
- **CHN-07 (Must)** Assisted/kiosk mode captures reports offline with encrypted local storage, shows "Not sent yet" until the server confirms, and syncs with duplicate protection (ACC-39).
- **CHN-08 (Should)** QR codes and short URLs on flyers and door hangers open the flow pre-set to the tenant, event and language.
- **CHN-09 (Should)** Residents can switch channels mid-report using their reference code (start by SMS, add photos on web).

## 14. Needs and resource connection (NED)

One intake captures both damage and needs, but sharing with each partner organization is a separate, specific, revocable consent.

- **NED-01 (Must)** After the damage report saves, ask: "Do you need help with any of these?" — shelter tonight, food or water, cleanup or tarp, medical equipment or power, transportation, pets, someone to talk to. Multi-select with icons.
- **NED-02 (Must)** Needs are a separate record linked to the damage report, so a household can ask for help without reporting damage and vice versa.
- **NED-03 (Must)** Consent screen names each receiving organization type in plain words ("Volunteer cleanup groups like Salvation Army or local churches") with yes/no per type. Default is no sharing. Damage reporting to the emergency manager is never conditional on sharing consent (ACC-45).
- **NED-04 (Must)** Partners receive only the minimum fields for their service (a cleanup crew gets address, need, contact preference — not income, medical or household details).
- **NED-05 (Must)** Residents can withdraw consent by SMS or web using their reference code; partners are notified and access is revoked within 1 hour.
- **NED-06 (Should)** Show nearby approved resources (shelters, PODs, cooling/warming centers) from tenant-published data only, with "last updated" time; never invent availability (CMD example in 10.8).
- **NED-07 (Should)** Export needs to partner case-management systems via documented API and CSV, and support multi-agency "who is handling this" claim-and-release to avoid duplicate visits.
- **NED-08 (Should)** Spiritual and emotional care is offered as an optional need, phrased without assuming any faith ("Would you like someone to talk with — a counselor or a chaplain?").
- **NED-09 (Must)** Do not ask about citizenship, immigration status, criminal history or income in the intake. If a tenant program legally requires income, it is a separate optional step with a stated reason.

## 15. Equity, inclusion and language access (EQ)

The product must reach renters, lower-income, limited-English and low-literacy households at least as well as homeowners, and must measure whether it does.

**15.1 Reaching everyone**

- **EQ-01 (Must)** Treat renters, mobile-home residents, multi-generational households and people experiencing homelessness as primary personas; every flow is tested with them before release.
- **EQ-02 (Must)** Never require proof of ownership, ID, SSN, insurance or a bank account to submit a report or a need.
- **EQ-03 (Must)** Accept any address form: apartment/unit, rural route, landmark description, "no fixed address," and Unicode names (ACC-36).
- **EQ-04 (Should)** Imagery and examples show diverse homes (apartments, manufactured homes, rural, urban) and people, reviewed by community members.
- **EQ-05 (Should)** Faith-neutral by default; tenants may add faith-based partners, always as an opt-in choice.

**15.2 Language**

- **EQ-06 (Must)** Launch with English and Spanish (decided 2026-10-12). Later languages come from tenants' Census language data, drawing on Chinese, Vietnamese, Tagalog, Arabic, Korean, Russian, Haitian Creole, French and Hindi. The product is built so adding a language needs no code change.
- **EQ-07 (Must)** All fixed strings (questions, errors, consent, confirmation) are professionally translated and community-reviewed per language before that language goes live; machine translation is not acceptable for fixed strings (ACC-35).
- **EQ-08 (Must)** Free text and voice may be in any language; store the original, show reviewers a labeled machine translation, and never decide eligibility on the translation alone.
- **EQ-09 (Must)** Right-to-left layout for Arabic and any other RTL language enabled.
- **EQ-10 (Should)** Language is detected from the device and from a first-screen picker showing each language in its own script; SMS keywords exist in each language.

**15.3 Measuring equity**

- **EQ-11 (Must)** Equity dashboard per event: report and need rates by census tract compared to tract population, renter share, income and language, to spot under-reporting areas for outreach.
- **EQ-12 (Must)** Track time-to-review and time-to-help by tract income band, renter vs owner, language and channel; alert when gaps exceed a tenant-set threshold.
- **EQ-13 (Must)** Demographic questions are optional, asked after submission, and used only in aggregate (minimum cell size 11) for equity reporting.
- **EQ-14 (Should)** Co-design and usability test with community organizations representing low-literacy, LEP, disability, older adult and renter groups each release, compensating participants.

## 16. Security and privacy architecture (SEC)

Target GovRAMP Moderate as the selling baseline for state and local buyers: it is built on NIST SP 800-53 Rev 5 and requires 319 controls ([Knox Systems](https://knoxsystems.com/resources/govramp), [Spheron](https://www.spheron.network/blog/govramp-compliant-gpu-cloud-state-government-guide-2026/)). Add SOC 2 Type II for NGO buyers and keep a CJIS-ready enclave option. GovRAMP is StateRAMP's operating name since February 2025.

**16.1 Compliance targets**

- **SEC-01 (Must)** Build to NIST SP 800-53 Rev 5 Moderate from day one: system security plan, control inheritance from the cloud provider, continuous monitoring.
- **SEC-02 (Must)** Pursue GovRAMP Ready, then Authorized, with a 3PAO; pursue SOC 2 Type II in parallel.
- **SEC-03 (Must)** Map data handling to state breach-notification laws in every tenant state, starting with Missouri.
- **SEC-04 (Should)** Support HIPAA-aligned handling (BAA-capable providers) for the medical-needs fields, even where HIPAA does not strictly apply.

**16.2 Tenancy and access**

- **SEC-05 (Must)** Multi-tenant with strict tenant isolation enforced in the database (row-level security keyed to tenant) and in object storage (per-tenant prefixes and keys); automated tests prove no cross-tenant read.
- **SEC-06 (Must)** Role- and attribute-based access: role, organization, event, geography and data category all gate access. Default deny.
- **SEC-07 (Must)** Staff sign-in via tenant SSO (SAML/OIDC) with phishing-resistant MFA (FIDO2/passkeys preferred); no shared accounts.
- **SEC-08 (Must)** Break-glass access for emergencies is time-boxed, justified, and alerts the tenant security contact.
- **SEC-09 (Must)** Residents never need an account; report lookup uses reference code plus a one-time code to the contact they gave (ACC-43).

**16.3 Data protection**

- **SEC-10 (Must)** Encrypt in transit (TLS 1.2+, HSTS) and at rest (AES-256) with per-tenant keys in a managed KMS; field-level encryption for contact details, medical needs, household composition and free-text.
- **SEC-11 (Must)** Data classification on every field (public, internal, sensitive, restricted) drives storage, export, logging and AI-context rules.
- **SEC-12 (Must)** Criminal-justice information (law-enforcement mission fields, suspect roles, weapons, arrest dispositions, bodycam references) is stored only in a separately authorized enclave, built for launch (own account/subscription, network boundary, keys and identity) meeting the current FBI CJIS Security Policy (v6.x), with its own MFA, audit and personnel screening ([CJIS v6.1 summary](https://www.bleepingcomputer.com/news/security/fbis-cjis-v61-what-security-teams-need-to-know/amp/)).
- **SEC-13 (Must)** Tenant-configurable retention per data category with automated deletion. When a tenant sets none, photos, free text and other records are kept 7 years (decided 2026-10-12). Exceptions: scribe audio is deleted once the note is confirmed (FL-04), live position trails after 30 days (DSP-08), personal command conversations after 30 days, and CJIS data follows CJIS and state records rules. Legal holds override deletion; public-records request export that redacts restricted fields.
- **SEC-14 (Must)** Data residency in US regions only; no resident data used to train any model without a tenant's written opt-in.

**16.4 Application and operations security**

- **SEC-15 (Must)** Secure SDLC: threat model per feature, SAST/DAST/dependency and container scanning in CI, signed builds, SBOM per release.
- **SEC-16 (Must)** Annual third-party penetration test plus a public vulnerability disclosure policy.
- **SEC-17 (Must)** Abuse protection without CAPTCHAs that block disabled users (ACC-44): rate limits, risk scoring, SMS verification only when risk is high.
- **SEC-18 (Must)** Immutable, tamper-evident audit log of every read of restricted data, export, permission change and AI action (CMD-37), retained per tenant policy.
- **SEC-19 (Must)** Incident response plan with tenant notification within contractually defined hours, tested twice a year.

## 17. AI governance and safety (AIG)

AI assists with phrasing, extraction, translation, photo coaching and triage; it never decides eligibility, priority, damage category or dispatch. Controls follow the [OWASP Top 10 for LLM Applications 2025](https://www.invicti.com/blog/web-security/owasp-top-10-risks-llm-security-2025), where prompt injection is the top risk and excessive agency is a named one.

- **AIG-01 (Must)** Maintain an AI use register: each AI feature, model and version, provider, data sent, decision it informs, human checkpoint, and owner.
- **AIG-02 (Must)** Resident free text, photos, and partner notes are untrusted data. They are passed to models in delimited data fields and can never change system instructions, tools or permissions (CMD-11).
- **AIG-03 (Must)** Resident-facing AI has no tools that read other records. Extraction returns only a fixed JSON schema, validated server-side before display.
- **AIG-04 (Must)** Staff-facing AI actions go through the CMD action catalog with server-side authorization; the model holds no credentials (CMD-12, CMD-21).
- **AIG-05 (Must)** Redact or tokenize names, phone numbers and exact addresses before sending text to external models where the task does not need them.
- **AIG-06 (Must)** Use AI providers under enterprise terms with zero data retention and no training on customer data, in US regions; record this per provider.
- **AIG-07 (Must)** Output filtering: block generated text that states eligibility, promises aid, gives medical or legal advice, or contains another person's data.
- **AIG-08 (Must)** Evaluation suite run on every model or prompt change: extraction accuracy on a labeled multilingual set (including low-literacy phrasing and code-switching), prompt-injection tests, and photo-model fairness slices (PHO-13). Release blocks on regression.
- **AIG-09 (Must)** Monitor in production: extraction correction rate by language, reviewer agreement rate with photo suggestions, and complaints. Auto-disable a feature per tenant when its error rate crosses a threshold, falling back to non-AI flow.
- **AIG-10 (Must)** Tell residents plainly when AI is helping ("A computer helped fill in these answers — please check them") and let them turn it off for the session.
- **AIG-11 (Should)** Align governance documentation with NIST AI RMF so government buyers can reuse it in procurement reviews.
  - **AIG-12 (Must)** AI providers are pluggable (decided 2026-10-12): one internal interface each for language models, speech-to-text, translation and image analysis, with the provider chosen per tenant in configuration. A provider can be enabled only if it meets AIG-06 (US processing, zero data retention, no training on customer data) and passes the evaluation suite (AIG-08) for that tenant's languages. Switching providers needs no code change, and every AI output records which provider and model produced it.

## 18. Scale, multi-tenancy and resilience (SCL)

Load arrives in spikes right after an event, so the platform must absorb a statewide surge while staying cheap between disasters.

- **SCL-01 (Must)** Tenant hierarchy: state → region/coalition → county/city → partner organization, with data-sharing agreements modeled explicitly between tenants (e.g. county shares de-identified counts with state, full records with its VOAD only when consented).
- **SCL-02 (Must)** Events (incidents) are first-class: each report belongs to one or more events; tenants open an event, publish its intake link/keyword, and close it.
- **SCL-03 (Must)** Handle a surge of 50,000 report submissions per hour across tenants and 10,000 concurrent SMS sessions, with intake writes queued so submission never fails under load. Load-test to 2×.
- **SCL-04 (Must)** Photo uploads go direct to object storage with resumable uploads; processing is asynchronous and never blocks submission.
- **SCL-05 (Must)** Availability: intake 99.95% monthly; staff console 99.9%. Multi-AZ by default, warm standby in a second US region with RPO ≤ 15 minutes and RTO ≤ 1 hour.
- **SCL-06 (Must)** Graceful degradation order when dependencies fail: AI features off → photo processing deferred → maps off → intake still accepts text reports.
- **SCL-07 (Must)** Infrastructure as code for every environment; per-tenant configuration (questions, languages, partners, branding, retention) without code changes.
- **SCL-08 (Should)** White-label per tenant (logo, colors, domain, sender name), meeting contrast rules (ACC-08) regardless of brand colors.
- **SCL-09 (Should)** Standards-based integrations: Esri ArcGIS feature services for PDA maps, CSV/GeoJSON export, webhooks, and a documented REST API with per-tenant keys and scopes.
  - **SCL-11 (Must)** Portable containers from day one. Every service runs in Docker, started locally with one Docker Compose command on Docker Desktop. Cloud services sit behind adapters with local stand-ins so the same images later run in a government cloud without code changes: PostgreSQL with PostGIS for data, S3-compatible storage (MinIO locally), a secrets and key service (a local vault in development, the cloud's key management service in production), and a standard message queue. Configuration comes only from environment variables and secrets, never from code.
  - **SCL-12 (Must)** Development rules until the move: only synthetic or exercise data on laptops, never real resident or criminal-justice data. The CJIS enclave is built and tested as its own separate container set, but holds real data only after it moves to an authorized government cloud and passes the state CJIS audit. Twilio and other webhooks reach a laptop only through a secured development tunnel.
    - **SCL-13 (Must)** Maps are open source: MapLibre for display on web and in the React Native field app, with OpenStreetMap data. Map tiles and address search (geocoding) are self-hosted in containers, because OpenStreetMap's free public tile servers are not for production use. Counties' parcel data is loaded per tenant. Offline map packages for the field app are cut from the self-hosted tiles. Esri ArcGIS and FEMA field tools are still supported through import and export (CON-17, SCL-09), not as the base map.
    - **SCL-14 (Must)** Release 1 includes every requirement in this document (decided 2026-10-12). Claude Code builds it in this order so each layer stands on a tested one: (1) platform foundations: tenancy, identity, permissions, audit, save and retry rules (FR-00, SEC); (2) resident intake on web, text and phone, review queue and verification; (3) needs board, partner sharing and public "Find help"; (4) missions, dispatch board and the React Native field app; (5) CJIS enclave; (6) FEMA package and official reports; (7) AI features: scribe, photo pre-sort, recommendations, resource discovery and the command window; (8) ICS forms and EOC functions. Every layer must pass its acceptance cases and the original launch gates before the next starts.
    - **SCL-15 (Must)** Claude Code records each technology choice (language, frameworks, database, queue, React Native libraries) in a short decision record in the repository: what was chosen, the alternatives, and why it fits SCL-11 and the government-cloud move.
- **SCL-10 (Must)** Licensing and metering: each contract is an annual subscription per jurisdiction, tiered by population served. Store tier, term and covered jurisdictions per tenant; a state or coalition contract can cover member jurisdictions. Never meter or cap resident reports — intake stays open during any surge regardless of plan.

## 19. Success metrics and validation plan

The product proves itself by completion, accuracy and equity, measured against a county's existing Survey123-style form in a side-by-side pilot.

| Metric | Target | Measured how |
| --- | --- | --- |
| Start-to-submit completion | ≥ 20 points above the tenant's prior form | Funnel analytics per channel |
| Median time to submit | ≤ 5 minutes | Session timing |
| "Don't know"/skip rate on required fields | Lower than prior form | Field-level analytics |
| AI extraction accepted without edit | ≥ 85% per launch language | Confirm/edit events |
| Reviewer agreement with photo suggestion | Published per hazard and income band; no group > 5 points below average | Review records |
| Report rate per 1,000 households vs damage footprint | No tract-income quintile below 70% of the highest | Equity dashboard |
| Time from report to first human review | ≤ 24 hours during declared events | Queue timestamps |
| Accessibility | Passes Section 9.12 with real assistive-technology users | Moderated testing |

Validation steps before general availability:

1. Moderated usability tests per persona (renter, older adult, LEP, low-literacy, screen-reader user, volunteer helper) on low-fidelity flows.
2. A/B test: guided conversational flow vs. one-page form, same questions, in a tabletop or real event with a pilot county.
3. Photo-model evaluation on labeled FEMA-matrix images from at least three hazard types, sliced as in PHO-13.
4. Red-team of AI features against OWASP LLM risks.
5. GovRAMP readiness assessment before the first government contract.

## 20. Declaration support (DEC)

The platform produces damage data in FEMA's federal formats so it works the same in every state, built from verified resident reports, staff logs and Census data. State-specific templates are an optional mapping layer, never the primary output. It is organized around the Individual Assistance and Public Assistance factors in [44 CFR 206.48](https://syfert.com/cfr/sections/44-206.48.html).

| 206.48 factor | Where the data comes from | Requirement |
| --- | --- | --- |
| Cause of damage | Resident intake | DEC-01 |
| Number of homes and degree of damage | Reviewer-verified reports | DEC-02, PHO-11 |
| Homeownership rate of affected homes | Resident intake | INT-03 |
| Households with adequate insurance for the peril | Resident intake | DEC-01 |
| Concentration of damage, affected jurisdictions | Report locations | DEC-05 |
| Impacted population profile (poverty, SNAP/SSI, age, disability, limited English) | Census/ACS by tract | DEC-06 |
| Infrastructure impacts over 72 hours | Staff outage log | DEC-07 |
| Casualties | Optional resident question, staff entry | DEC-01, DEC-08 |
| Disaster unemployment | Optional resident question | DEC-01 |
| Resources committed by NGOs and local government | Needs and partner tracking | DEC-09 |
| Public Assistance per-capita cost | Staff public-damage module | DEC-10 |

**20.1 Resident questions added to intake**

- **DEC-01 (Must)** Add to the question graph, each with "I don't know": home type (house, apartment or condo, mobile or manufactured home, other); primary residence (yes/no); insurance covering this damage (home or renters, flood, none, not sure); cause (wind or tornado, flood, fire, other); for flood, highest water inside the living space (none, under 18 inches, 18 inches or more, to the roofline); staying somewhere else tonight; and two optional items asked after submission: anyone hurt or missing, and anyone who lost work that regular unemployment will not cover.
- **DEC-02 (Must)** Residents never pick a FEMA degree of damage. Reviewers set it using the FEMA matrix for the home type, informed by answers, photos and the AI suggestion.

**20.2 Verification**

- **DEC-03 (Must)** Every report carries a verification status: self-reported, desktop-verified (photos sufficient), field-verified, or cannot verify. Only verified reports count toward degree-of-damage totals; self-reported counts are shown separately.
- **DEC-04 (Must)** Exclude pre-existing damage and non-primary residences from IA totals while keeping them in the record.

**20.3 Staff-side data**

- **DEC-05 (Must)** Totals by jurisdiction, tract and event, with a damage-concentration map layer.
- **DEC-06 (Must)** Automatically attach the ACS population profile for affected tracts and jurisdictions; never ask residents for this.
- **DEC-07 (Must)** Infrastructure outage log: facility or service type (hospital, water, wastewater, police, fire/EMS, school, child care, eldercare, roads, power), start and restoration time, flagging outages over 72 hours.
- **DEC-08 (Must)** Casualty counts entered only by authorized staff from official sources; resident answers are flagged as unconfirmed.
- **DEC-09 (Should)** Summarize resources committed by partners (meals, shelters, cleanup teams, donated goods) from the needs and partner records.
- **DEC-10 (Must)** Public damage module for staff: site, category of work (debris, emergency protective measures, roads and bridges, water control, buildings, utilities, parks), estimated cost and photos, rolled up against the state and county per-capita indicators the tenant enters.

**20.4 The package**

- **DEC-11 (Must)** One-click IDA package per event and jurisdiction: IA counts by degree of damage, split by owner/renter, insured/uninsured, home type and verification status; representative photos; map; outage log; population profile; partner resources; PA cost summary; and the as-of time.
- **DEC-12 (Must)** Primary output is FEMA's own PDA formats from \[fema.gov/pda\](https://www.fema.gov/sites/default/files/documents/fema\_rd\_pda-guide\_07012025.pdf): the IA Street Sheet and IA Survey (single-family and multi-family) fields, the Home Insurance Matrix categories, the PA Site Sheet and PA cost survey, and a GIS layer compatible with FEMA's field validation tools (FACT, ArcGIS Field Maps). Export to PDF, Excel/CSV and GeoJSON. Optional per-state template mappings sit on top.
- **DEC-13 (Must)** The package contains counts and representative evidence only, with no personally identifiable information, matching FEMA's PDA guidance, unless a data-sharing agreement requires more.
- **DEC-14 (Must)** Draft the data-driven parts of [FEMA Form 010-0-13](https://www.fema.gov/sites/default/files/documents/completing-fema-form_010-0-13.pdf), the governor's declaration request: Box 7 incident period and type, Box 8 damage description (≤3,000 characters), Box 9 resources committed (≤3,000 characters), Box 10 joint PDA dates and areas, Box 11 requested areas, and the data for Enclosure A (IA) and Enclosure B (PA). Drafts are labeled for state review; the platform never submits the form.
- **DEC-15 (Must)** Keep FEMA form mappings versioned and updatable without a code release, since FEMA updates PDA forms frequently. Show which FEMA form version each export used.
- **DEC-16 (Should)** Track the 30-day filing window for a major disaster request from the incident end date and show it on the event dashboard.

## 28. Public information and resource sharing (PUB)

One site record feeds every public channel, so a shelter opened, filled or closed in the console changes everywhere within minutes. This section completes what the original requirements already call for: public resources accessible without staff sign-in (9.12), accessible resource documents (ACC-49, ACC-51) and resident resource lookup (CMD-19, example 10.8).

**28.1 One source, kept honest**

- **PUB-01 (Must)** Every public channel reads from the site and resource records in the console (CON-09). A change reaches every channel within 2 minutes.
- **PUB-02 (Must)** Each public site shows: name, address and directions, type, status (open, limited, full, closed), hours, services, pets, accessibility, power for medical devices, languages spoken, nearest transit, and when it was last confirmed.
- **PUB-03 (Must)** A site not reconfirmed within a tenant-set number of hours is hidden on every channel. Site leads get a reminder before that happens.
- **PUB-04 (Must)** When a site is full or closed, every channel points to the next nearest open site of the same type.
- **PUB-05 (Must)** Confidential sites, including domestic violence shelters, are never published. Staff refer people to them privately.
- **PUB-06 (Must)** Nothing goes public without a named person's approval. Safety-critical text is human-translated or human-reviewed (ACC-35). The log records what was published, where and when.

**28.2 Channels**

- **PUB-07 (Must)** Public "Find help" page: no sign-in, under 300 KB first load, English and Spanish (more later), Section 9 accessible, list first with an optional map, searchable by address, ZIP or landmark, and printable.
- **PUB-08 (Must)** Text a keyword in any launch language (e.g. SHELTER, REFUGIO) with a ZIP code or address and get the three nearest open sites with hours, pets and accessibility.
- **PUB-09 (Must)** The phone line reads the nearest open sites in the caller's language and can transfer to a person.
- **PUB-10 (Must)** Live feed to local 211 call centers and other directories in the Open Referral (HSDS) format, plus a documented API.
- **PUB-11 (Must)** Drafts alert text sized for Wireless Emergency Alerts and the county's mass-notification system. The county sends it through its own authorized alert tool.
- **PUB-12 (Should)** Drafts social media posts and simple graphics for each site change, ready for the PIO to approve and post.
- **PUB-13 (Must)** Media sheet for TV, radio and newspapers: a page and PDF that refresh themselves, with "last updated" times.
- **PUB-14 (Should)** Audio scripts, plus optional text-to-speech audio files, in several languages: a loop for a low-power AM Travelers' Information Station, and a read-out for ARES/RACES nets serving areas without cell service.
- **PUB-15 (Must)** One-tap printable posters and flyers per language: large type, phone number, short web address and QR code. The QR code is never the only way in (ACC-50).
- **PUB-16 (Should)** Copy-and-paste widget for city, school and partner websites.
- **PUB-17 (Should)** Public open data feed (GeoJSON and HSDS) for news outlets and mapping apps, without confidential sites.
- **PUB-18 (Must)** Published resources beyond sites (hotlines, programs, deadlines such as FEMA registration) are human-reviewed, in accessible HTML, and checked for accessibility when they link outside (ACC-49, ACC-51).

## 29. Reconciliation with the original BRD/FRD

The original Emergency Management Application Rebuild BRD/FRD is the foundation, and Sections 11–28 extend it. Its system-wide rules apply to every new section: FR-00.01–10, RULE-01–18, AI-01–12, features F01–F18, NFR-01–12, INT-01–07, MIG-01–09 and launch gates GATE-01–10. Where the two disagree, the tables below say which wins; anything not listed follows the stricter rule.

**29.1 Conditional scope now approved**

The original lists these as conditional (A4). Decisions made in this document approve them.

| Original conditional item | Decision | Where |
| --- | --- | --- |
| Public status checking and corrections | Approved, with no public accounts: reference code plus a one-time code | RES-01, RES-02, SEC-09 |
| Proxy reporting and accommodation requests | Approved | CHN-06, HLP-01, ACM-01 |
| Saved public drafts and cross-device resume | Approved | INT-20, CHN-09 |
| Full offline field entry and conflict handling | Approved | FLD-13, CHN-07 |
| Continuous GPS | Approved for checked-in field workers only | DSP-08 |
| Certification management | Approved | PER-01 |
| Team, vehicle and equipment resources | Approved as typed units, never as personnel IDs (FR-06.08) | DSP-02 |
| Multi-property and organizational reporting | Approved | ORG-01 |
| Badge scan validation | Approved at check-in and checkpoints | FLD-03, FR-03 |
| Physical badge printer integration | Still open | Section 21 |
| Real SMS and email delivery, partner integrations | Approved | CHN-03, FL-11, NED-07, PUB |
| Speech dictation | Approved, always with review | INT-12, FL-04, FL-07 |
| Multi-organization tenancy | Approved | SCL-01, SEC-05 |
| Parent incident or disaster record | Approved | SCL-02 |

Still out of scope, as the original says: 911 telephony or CAD replacement, autonomous dispatch, structural-safety or assistance-eligibility decisions by the system, and unrestricted AI access.

**29.2 Conflicts and how they resolve**

| Topic | Original | Sections 11–28 | Resolution |
| --- | --- | --- | --- |
| Law-enforcement data in missions | Missions include 911 and officer-initiated sources, a law category, suspect roles, weapons, "arrest made" and bodycam references (D02, D07, F07) | No criminal-justice information at launch (SEC-12) | **Decided 2026-10-12:** keep the full mission model and build the CJIS enclave for launch (SEC-12) |
| Mission states | Open, en route, on scene, cleared, closed, plus draft and reopen (B6) | Earlier draft used "assigned" and "completed" | Original wins (MIS-02). Assignment is its own record and never changes mission state (RULE-03) |
| Damage report states | Submitted, under review, needs information, approved, rejected, duplicate, superseded (F12) | Verification levels: self-reported, desktop-verified, field-verified, cannot verify (DEC-03) | Both kept. Review state records the decision; verification level records how it was checked. Only approved, verified records count in official totals |
| Severity and structure types | No damage, affected, minor, major, destroyed; includes commercial, public and infrastructure (D05) | FEMA residential degrees | D05 is the canonical list; FEMA degrees map from it for homes; commercial and public damage feed Public Assistance and SBA data |
| Badge states | Generated, print requested, print confirmed, print failed, separate from validity (F13) | Generated, printed, handed out | Original wins; "handed out" is an optional later state (BDG-02) |
| Reminders | Full model in F09 | REM-01 | F09 governs |
| Official reports | Draft, reviewed, issued; immutable snapshots; amendments (F15) | RPT-01 | F15 governs |
| Message delivery | Queued, sent, delivered, acknowledged, failed, with provider evidence (F17) | "Read receipts" (DSP-06), resident SMS (FL-11), alerts (PUB-11) | F17 states apply to every channel. "Read" shows only when the provider proves it |
| Self-review | Assessors do not approve their own work (A7) | Review queue | Enforced: the reviewer cannot be the person who recorded the finding unless tenant policy allows it, with audit |
| Launch languages | English, Spanish, Chinese, Arabic, Hindi, French, Russian (D02 baseline) | EQ-06 list | Launch with English and Spanish (decided 2026-10-12); later languages come from both lists as tenants need them |
| Stale positions | Stale coordinates must be identified (FR-03.05) | Live dispatch map | Positions older than a tenant-set age show as stale with their age |

**29.3 Gaps the original exposed**

- **CALL-01 (Must)** Staff request intake for phone and walk-in requests (dispatcher/call-taker persona): caller, callback number, language, interpreter need, location with unknowns allowed, summary and hazards, captured in under a minute. Draft-save, intake-save and dispatch prerequisites are separate (FR-02.02). The command window can draft from a spoken summary.
- **HAZ-01 (Must)** Hazards on every mission, dispatch card and field assignment (F04): critical hazards shown apart from the narrative; reported, confirmed, corrected and cleared kept separate; sensitive details restricted. The field app warns a team about known hazards before arrival.
- **WIT-01 (Must)** Witness reporting (public role E): intake asks "Is this your home?" A "no" path records a third-party observation, asks only what was seen, never presents it as owner-confirmed, and counts it separately.
- **HLP-01 (Must)** Family and caregiver helpers in the public flow (public role D): the record keeps the helper and the person they represent separate; what the helper can see later follows DEC-10.
- **PPL-01 (Must)** One record of people involved per mission (F07, D07), with restricted fields. All D07 roles are supported; law-enforcement roles and details are stored in the CJIS enclave (SEC-12).
- **ACCT-01 (Must)** Accounts stay separate from personnel records (FR-01.05). A volunteer checked in by QR code gets a personnel record without needing a staff account.
- **A11Y-01 (Must)** Publish an accessibility statement and support contact on the public "Find help" page (ACC-03, FR-A10).
- **MIG-00 (Must)** Moving data from the current ARK apps follows MIG-01 to MIG-09, including conservative mapping of old approval flags.
- **MET-00 (Must)** The original MET-01 to MET-10 join the Section 19 metrics.

**29.4 Missions, personnel and the rest (revised)**

- **MIS-01 (Must)** A mission is any unit of field work: welfare check, verification route, cleanup work order, delivery, outreach sweep, site staffing. Missions exist only inside an activated disaster event (SCL-02), since the product is for disasters only (DEC-01). Every dispatch assignment (DSP-04) and need claim (CON-08) is a mission with an immutable ID and a unique human-readable reference that is never reused (FR-02.01, FR-02.04).
- **MIS-02 (Must)** Mission states follow the original: draft, open, en route, on scene, cleared, closed, and reopen with a reason. Allowed skips and cancellations follow approved policy (B6, DEC-06).
- **MIS-03 (Must)** Priority changes, closure and reopening need a reason and confirmation (RULE-14). Locks apply to manual and command changes equally (RULE-05).
- **MIS-04 (Must)** Assigning or releasing people updates the mission and each person's assignment in one transaction (FR-06.02).
- **PER-01 (Must)** Personnel records hold recorded skills, credentials with expiry and verification, agency, department and availability, with duty, availability and response kept separate (FR-05.03). The system never infers a qualification.
- **PER-02 (Must)** Assignment conflicts warn before saving: double-booked, off duty, over an hours limit, or missing a required credential, with authorized override and reason (FR-06.03).
- **BDG-01 (Must)** Badges with photo, name, agency, role, credentials and a scannable code for check-in (FLD-03) and checkpoints (FR-03). The code is never the only identification (AC-13C). Badges expire and can be revoked at once.
- **BDG-02 (Must)** Badge states follow F13 (generated, print requested, print confirmed, print failed), plus an optional "handed out."
- **REM-01 (Must)** Reminders follow F09. Examples here: re-confirm a site, call back a survivor, renew a shelter agreement.
- **CNT-01 (Must)** Contacts follow F17, plus 24-hour numbers, backups, and re-verification before each season.
- **RPT-01 (Must)** Situation reports, briefings and the FEMA package follow F15: draft, reviewed, issued, immutable snapshots, amendments.
- **ADM-01 (Must)** Administration follows F01 and F18: users, roles, partner organizations, data-sharing agreements, event templates, question graphs, planning factors, languages and branding, all audited.
- **ADM-02 (Must)** A partner organization can be invited, sign its data-sharing agreement, set up users and assets, and be active in under one day.
  - **ADM-03 (Must)** The product name is a single configuration value, PRODUCT\_NAME, currently "Common Ground". Every place the product names itself reads it: screens, page titles, emails, help text, exports, the public "Find help" page footer and the accessibility statement. The name is never hardcoded, and changing it needs no code release. Resident texts and calls use the county's name, not the product name (SMS and phone setup tab).
    - **ADM-04 (Must)** Permissions are fully configurable by each county (decided 2026-10-12, original DEC-05). The product ships default role templates built from the cast, field, frontline and original A7 roles; a county administrator can copy, edit, create and assign roles by action, record scope and data category. Every change is versioned and audited, and a "what can this role do" preview shows the effect before saving.
    - **ADM-05 (Must)** Guardrails no county can configure away: default deny and server-side checks (FR-00.01); public users never see private records (FR-00.02); criminal-justice data only for CJIS-qualified users (SEC-12); no one approves their own finding without a policy exception that is audited (A7); no role can edit or delete audit records (FR-08.04); granting permissions needs a second administrator (Section 30.2); restricted health, counseling and legal fields stay limited to their roles (FR-15, FR-16, FR-23).
- **RES-01 (Must)** Residents check status with their reference code plus a one-time code and can change consent at any time. A reference code alone never retrieves private data (RULE-17).
- **RES-02 (Must)** Residents can correct, add to or withdraw a report. Changes after approval go to re-review (RULE-09); the original stays in the history.
- **ACM-01 (Must)** Optional accommodation requests, never asking for a diagnosis, restricted to the access and functional needs coordinator (RULE-16, ACC-47).
- **ORG-01 (Must)** Landlords, businesses, nonprofits and faith communities can report several properties at once; each property becomes its own record (public roles B and F).

## 30. Recommendations (2026-10-12)

**30.1 Photo-model research partner**

Approach the team behind the Windstorm Structural Performance Data set (WiSPD) at Auburn University, the University of Notre Dame and the University of Florida, part of the NSF-funded StEER reconnaissance network. They hold the closest match to this product's photos: ground-level images of single-family homes after tornadoes and hurricanes, with expert damage ratings, openly published on NHERI DesignSafe ([WiSPD paper](https://ascelibrary.com/doi/10.1061/NHREFO.NHENG-1796), [StEER Hurricane Michael data](https://www.designsafe-ci.org/community/news/2021/october/learning-hurricane-michael/)).

| Candidate | What they bring | Gap for this product |
| --- | --- | --- |
| **StEER / WiSPD team (Auburn, Notre Dame, Florida) — recommended** | 4,624 single-family homes from 8 windstorms (1,608 tornado), geotagged ground photos and panoramas, component-level damage ratings; over 302,000 Hurricane Michael photos; open data | Ratings are engineering wind scales (0–4), not FEMA degrees; few no-damage, flood or manufactured-home examples |
| Purdue (Dyke and Yeum) | Automated sorting of reconnaissance photos (ARIO), trained on about 140,000 images ([DesignSafe](https://www.designsafe-ci.org/community/news/2018/july/deep-learning-rapid-analysis-visual-disaster/)) | Earthquake and concrete focus |
| Texas A&M CRASAR (Murphy) | Large drone damage benchmark ([CRASAR-U-DROIDs](https://arxiv.org/pdf/2407.17673)) | Aerial, not resident ground photos; useful later for a drone layer |

The first joint project fills the gaps: map their ratings to FEMA's four degrees and add labeled no-damage, flood and manufactured-home examples from exercises and the pilot. Fund it through a small-business research partnership grant (STTR), which pairs a small company with a research institution.

Proposed ownership terms to negotiate (have counsel review):

- Public datasets stay under their own licenses; confirm each DesignSafe license allows commercial model training.
- New labels made from public data are published openly, which builds credibility with buyers.
- Mennelabs owns the product's trained model weights, or holds an exclusive commercial license; the university keeps research and publication rights.
- Tenant photos never leave the platform for training without each tenant's written opt-in (SEC-14), are de-identified (PHO-07), and are covered by a data-use agreement.
- The university publishes an independent accuracy and fairness report for each model version (PHO-13).

**30.2 Command window (original 10.11), recommended defaults**

| Decision | Recommendation |
| --- | --- |
| Shortcut | Ctrl+K on Windows and Linux, Command+K on Mac, plus "/" when the cursor is not in a text field. Always an on-screen button. Users can remap it. Never override screen-reader keys. |
| Shorthand syntax | Slash verb, object, ID, then key:value pairs: `/mission 20261009-003 status on_scene`, `/assign 20261009-003 person:123`. Case-insensitive, tab-completion, Spanish verbs as built-in synonyms. |
| Aliases | Personal aliases allowed only for lookups and drafts. Organization aliases are created by administrators, versioned and audited, and may never hide a destructive or bulk action (CMD-04). |
| Action catalog rollout | Phase 1: search, summaries and drafts (sitrep, mission draft). Phase 2: reversible updates (notes, reminders, needs claims). Phase 3: assignments and status changes with confirmation. Phase 4: approvals, priority, closure, bulk changes, outbound messages and administration. |
| Public command coverage | Residents can ask about published resources, start or resume their own report, and check their own status after verification. Nothing else (CMD-19). |
| Confirmation policy | No confirmation for lookups and drafts. One-tap confirm for a single reversible change. A full review screen for every RULE-14 action. A second person must approve permission grants and messages to more than 500 recipients. |
| Undo | One-click undo for 15 minutes on reversible internal changes (status, assignment, notes, reminders). Everything else uses a compensating action: amend an issued report, re-review an approval, reopen a closure, send a correction for a sent message (CMD-28). |
| Batch limits | Up to 50 records per command; up to 500 with a second confirmation; above that, use a scheduled bulk job. No more than 30 consequential commands per minute per user. |
| History retention | Personal command conversations kept 30 days and clearable by the user; off on shared devices. The execution audit follows the 7-year default (SEC-13) and cannot be cleared (RULE-15). |
| Performance targets | 95% of requests: shorthand executes in under 1 second; natural-language interpretation in under 2.5 seconds; confirmed execution in under 2 seconds. A timeout after 15 seconds shows an honest pending or failed state. |

## 21. Open decisions

These need an answer before Claude Code builds the affected areas.

- [x] CJIS: design the enclave now, build later (SEC-12).
- [x] Photo model: university research partnership (PHO-12).
- [x] Pricing: annual per jurisdiction, tiered by population (SCL-10).
- [x] Owner and seller: Mennelabs.
- [ ] Photo-model partner: recommended the StEER / WiSPD team (Auburn, Notre Dame, Florida) with an STTR grant; ownership terms in Section 30.1. Next step: outreach.
- [x] Population tier breakpoints and coalition pricing: deferred (2026-10-12).
- [ ] First pilot tenant and whether a state emergency management agency will sponsor GovRAMP.
- [x] SMS and phone: Twilio, one verified toll-free number per county; answers ready in the SMS and phone setup tab.
- [ ] Which partner case-management systems to integrate first (e.g. NGO systems used by Salvation Army and Red Cross).
- [x] Launch languages: English and Spanish (EQ-06).
- [x] Product name: Common Ground, as a working name (2026-10-12). It is one configuration value, PRODUCT\_NAME (ADM-03), so it can change without code. Trademark clearance pending.
- [x] Mennelabs and ARK Incident Response: no relationship; no conflict noted (2026-10-12).
- [x] Retention default when a tenant sets none: 7 years (SEC-13).
  - [ ] Decided 2026-10-12: disasters only (DEC-01), and the full mission model with a CJIS enclave at launch (SEC-12). Danger flags stay awareness-only, and residents are told to call 911 (CON-10). Also open: physical badge printers (DEC-13). The original decision register DEC-01 to DEC-22 otherwise stays in force; many are now answered in Sections 11–29.
  - [ ] Command-window defaults (original 10.11): recommended in Section 30.2, awaiting your approval. Dictation: yes, with review.
  - [x] FEMA form mapping done (FEMA field mapping tab, DEC-17); no state mapping for the pilot.

## Sources

- [Kim, Lee & Gweon, Comparing data from chatbot and web surveys (CHI 2019)](https://www.springerprofessional.de/doi/10.1145/3290605.3300316)
- [IZA DP 15597, web surveys vs chatbots field experiment](https://docs.iza.org/dp15597.pdf)
- [GOV.UK, No more accordions: how to choose a form structure](https://userresearch.blog.gov.uk/2015/08/13/no-more-accordions-how-to-choose-a-form-structure/)
- [Esri, Oklahoma crowdsources damage assessments](https://www.esri.com/about/newsroom/arcnews/oklahoma-crowdsources-damage-assessments-to-kick-start-disaster-recovery)
- [Washoe County Davis Fire self-report survey](https://washoelife.washoecounty.gov/washoe-county/davis-fire-damage-assessment-survey-available/)
- [FEMA PDA Pocket Guide (2025)](https://www.fema.gov/sites/default/files/documents/fema_rd_pda-pocket-guide_07012025.pdf)
- [KYEM, FEMA PDA Guide fact sheet](<https://kyem.ky.gov/recovery/Documents/Preliminary%20Damage%20Assessment%20(PDA)%20Guide%20Fact%20Sheet.pdf>)
- [Kashani et al., earthquake damage classification from terrestrial images](https://www.citedrive.com/en/discovery/deep-learningbased-classification-of-earthquake-damaged-buildings-using-terrestrial-images/)
- [Good at captioning, bad at counting: GPT-4V on Earth observation](https://arxiv.org/pdf/2401.17600)
- [Pew Research, Mobile technology and home broadband (2024)](https://pewresearch.org/internet/2024/01/31/americans-use-of-mobile-technology-and-home-broadband)
- [Snopes on 54% below 6th-grade literacy](https://www.snopes.com/news/2022/08/02/us-literacy-rate/)
- [Boostlingo LEP map (ACS 2019–2023)](https://boostlingo.com/resources/lep-state-map/)
- [University of Pittsburgh, FEMA aid and the racial wealth gap](https://www.news.pitt.edu/node/35458)
- [UN Tech for Victims working group note (2026)](https://www.un.org/counterterrorism/sites/default/files/2026-05/TechforVictims_2026WorkingGroup-InformationNote.pdf)
- [Knox Systems, What is GovRAMP](https://knoxsystems.com/resources/govramp)
- [Spheron, GovRAMP control counts](https://www.spheron.network/blog/govramp-compliant-gpu-cloud-state-government-guide-2026/)
- [BleepingComputer, FBI CJIS v6.1](https://www.bleepingcomputer.com/news/security/fbis-cjis-v61-what-security-teams-need-to-know/amp/)
- [Invicti, OWASP Top 10 for LLMs 2025](https://www.invicti.com/blog/web-security/owasp-top-10-risks-llm-security-2025)
