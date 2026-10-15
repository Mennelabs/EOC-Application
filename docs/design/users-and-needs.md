# The people who use Common Ground, and what the design owes them

Evidence gathered 2026-10-15 for the design foundation (decision of 2026-10-15 in `docs/decisions.md`; ADR-0045). Every visual and interaction decision in `packages/ui` cites a line here. The product name is configuration (ADM-03); the people are the same whatever the county calls it.

Method: about sixty web searches on 2026-10-15; the build environment's proxy blocked direct page fetches, so figures come from search-engine extracts of the cited pages. _(secondary)_ marks a number confirmed only through a summary of the named primary source; _(unverified)_ marks one that could not be confirmed. Nothing here is invented, and the gaps are listed at the end.

## 1. EOC staff: emergency managers, planners, PIOs, mass-care leads

What the evidence says:

1. Operational periods are "commonly 8 to 12 hrs in length and not to exceed 24 hours", and action planning repeats every period (Lancaster County PSC Handbook; FEMA IS-200.C). Activations past 12 hours need shift rotation at once (GovTech). A 2023 grand jury found "long hours, often without meal breaks … less than optimal lighting, and crowding have created stress and fatigue" in one county's EOC.
2. Interruptions of only 2.8 seconds roughly doubled sequence errors in a 300-person experiment (Altmann, Trafton and Hambrick, _J. Exp. Psych: General_, 2013).
3. Observed county EOC exercises show "asymmetric information flow … fragmented situation awareness, and information displays" as the core coordination problems (Militello et al., _Cognition, Technology & Work_, 2007).
4. A 2024 study of FEMA-region IT leaders concludes that the common operating picture works when displays are "tailored to specific user roles and responsibilities" (McCue, 2024).
5. Dark text on a light background gives better acuity and proofreading for young and old adults alike, "recommended for all ages" (Piepenbrock, Mayr and Buchner, _Ergonomics_, 2013 and 2014); Nielsen Norman Group reaches the same conclusion and notes dark mode can help some people with cataracts or low vision.
6. Distance legibility: about 16 arc-minutes minimum, 20 optimal (ISO 9241-3); for a wall display about 25 mm of text height per 4.5 m of viewing distance (Extron).

What it means for the design:

- **Role-scoped views, not one picture for everyone.** The home screen opens on the person's own work; the situation page serves the roles whose question is "how bad, where, do we need help".
- **A briefing mode for the wall** (CON-11): status, counts and the map only, type sized for 3 to 5 m (about 29 mm capital height at 5 m, which is roughly a 110 px font on a 65-inch 4K panel), nothing personal, refreshed on its own.
- **Light theme by default; dark as a choice** for overnight rooms, both at WCAG AA contrast or better.
- **Design for interruption:** every panel says when it was last updated and from where; actions can be undone (the command window already does this); alerts are non-modal unless a life is at risk (the dispatch takeover stays).
- **Dense but scannable:** 15 to 16 px in tables, state by text and shape as well as colour, keyboard-first.

## 2. Older volunteers: CERT, VOAD, Red Cross, ARES, faith groups

What the evidence says:

1. 28.3% of Americans 16 and over formally volunteered in 2022–23; the Silent Generation volunteered least and Boomers had the highest rate of informal helping, 62.2% (AmeriCorps and Census CEV 2023). Red Cross regional data for 2026 shows a two-humped base: Gen Z about half of volunteers, Boomers 12–19%. Amateur radio skews old: about 90% of ARRL's 2018 survey respondents were over 61. CERT rosters run "18 to 89" (Washoe County). No national CERT, ARES or VOAD age survey was found.
2. Presbyopia affected 89% of US adults 45 and over (ASCRS systematic review); contrast sensitivity declines from about age 40–50 and "becomes more accentuated with each advanced decade" (_Annual Review of Vision Science_).
3. Tremor rises from 6.3% at 60–65 to 21.7% at 95 and over; tapping error rates "start to converge at 12 mm" (Nicolau and Jorge, 2012). On 4.9 mm targets older adults erred 62.4% of the time against 24.9% for younger adults (Sultana and Moffatt, _ACM TACCESS_, 2019).
4. Nielsen Norman Group (123 participants aged 65 and over): the common failures are "illegible text, tiny targets, startling sounds"; many were unsure of terms such as "homepage"; older users were 43% slower _(secondary)_.
5. 78% of adults 65 and over own a smartphone (Pew, 2025); in 2021 it was 71% for 65–74 but 43% for 75 and over.
6. NIA and NLM "senior friendly" guidance: sans-serif, not condensed, body 12–14 pt at least, size adjustable by the person.
7. Most icons have no standard meaning, so a text label removes the guesswork (Nielsen Norman Group, "Icon Usability") _(secondary)_.

What it means for the design:

- **Body text 18 px or more on volunteer-facing screens**, no weight below 400, line height 1.5 or more, 7:1 contrast for body ink.
- **Targets 48 px or more with 8 px gaps** (about 12 mm on a phone); list rows 56 px.
- **Every icon carries a visible label;** plain words ("Save", "Send to team"); jargon explained where it appears.
- **No time-outs on forms;** explicit save with a confirmation message; undo rather than "Are you sure?".
- **Honour the device's text size to 200%** without clipping (WCAG 1.4.4, 1.4.10); never rely on hover or long-press.

## 3. Low-income survivors: the resident app, Find help, text and phone

What the evidence says:

1. 16% of US adults reach the internet only through a smartphone (2025); about a third of households under $30,000, 28% of Hispanic adults (up from 20% in 2023), 19% of Black adults; only 54% of the lowest-income group has home broadband (Pew, January 2026).
2. Affordability: the ACP subsidy ended on 1 June 2024 for about 23 million households (FCC) and a year later about 5 million had dropped internet service (Brattle via Benton). Lifeline's minimum mobile data standard is 4.5 GB a month (FCC DA-25-619). In 2015, 44% of smartphone owners under $30,000 had let service lapse over cost and 15% often hit their data cap (Pew).
3. After Hurricane Helene 21.7% of cell sites were out across the affected area, over 48% in North Carolina, overwhelmingly from power loss (FCC DIRS, 1 October 2024); Asheville had "lines at charging stations" and outages lasting weeks (AP).
4. Literacy: 28% of US adults aged 16–65 scored at Level 1 or below in 2023, up from 19% in 2017 (NCES PIAAC, December 2024). Level 1 means locating one piece of information in a short text; below it, a person may be unable to "complete simple forms".
5. Language: about 28 million residents have limited English proficiency (MPI, 2023). Among Spanish speakers aged 65 and over, 41.6% speak English "very well" (Census ACS 2018–22).
6. Stress: acute stress impairs working memory and cognitive flexibility (Shields, Sazma and Yonelinas, 2016, meta-analysis); Camp Fire survivors showed impaired long-horizon decision-making and slower responses on conflict tasks (UC San Diego, _Scientific Reports_, n = 27).
7. About 7 million Americans have a vision impairment, including 1 million who are blind; about 12 million aged 40 and over (CDC).
8. Aid access: the GAO (22 April 2026) found Helene, Milton and Texas-flood survivors "faced long wait times and could not reach a representative" on FEMA's helpline; unanswered calls peaked at 84% with hour-long waits _(secondary)_; 47% went unanswered in one 2024 week (E&E News). FEMA itself names barriers for "low-income neighborhoods, communities of color, people with disabilities, older adults, those with language barriers, and … rural" survivors. Immigrant families avoid applying because FEMA forms say data "may be subject to sharing within DHS" (2017 California fires; 2025 Texas floods). No recent figure for the share of registrations by channel was found.
9. Reading level: the CDC, AMA and NIH recommend eighth grade or below, sixth for emergency material; government COVID pages ran about three grades higher (JAMA Network Open, 2020). The CDC Clear Communication Index passes at 90 or more.
10. The CDC/ATSDR Social Vulnerability Index flags socioeconomic status, household characteristics, minority status and language, housing type and transportation.

What it means for the design:

- **Mobile-first at 320–360 px**, body 17 px or more, one question per screen, 48 px targets, no sideways scroll (already the intake's shape; the restyle keeps it).
- **Sixth-grade reading level**, scored; Spanish as a first-class locale with the language choice on the first screen and in every text keyword.
- **A data budget:** first load at or under 300 KB (PUB-07 already holds the public page to it), the whole intake flow about 1 MB on the wire, photos compressed on the device and sent after the text, one font subset only.
- **Offline-tolerant and resumable** (already built: encrypted device outbox, pause and resume codes); never an account or password for a resident; never re-ask what is known.
- **Text and phone parity** for every step, because outages are power-driven and phones die.
- **Privacy in plain words before any personal question:** who sees it, that it is not required to get help, and "If this is an emergency, call 911" (CON-10).
- **Light theme on public pages**, AA contrast minimum and 7:1 for body text; screen-reader tested; voice input for free text.

## 4. Field workers: damage assessors, canvassers, chainsaw crews

What the evidence says:

1. NIST PSCR _Voices of First Responders_: touch is "a poor primary input for responders who are constantly in motion and often have hands … occupied, such as by gloves"; operation "should be active with or without gloves", with voice or physical buttons as alternates (NISTIR 8340, 2021). Responders want tools that do not distract from the primary task (NISTIR 8216), find "overly complex interfaces" frustrating (NISTIR 8245), and rank mapping and navigation among the most essential apps (NISTIR 8314, 7,182 responders).
2. Walking: "performance decreases, cognitive load increases significantly when reading and selecting targets when walking"; larger targets compensate, larger text did not help reading because of the extra scrolling (Schildbach and Rukzio, MobileHCI 2010). Single words must be 47% larger when walking for equal legibility (Fraunhofer FKIE, 2018).
3. Grip: 49% of observed phone use was one-handed, 36% cradled, 15% two-handed (Hoober, 2013) _(secondary)_.
4. Light text on a dark background is less legible at a glance, "likely because the dilation of the pupils under low illumination produces optical blurring" (Dobres et al., _Ergonomics_, 2016). Phones peak at roughly 400–670 nits; outdoor readability depends on brightness and low reflectance.
5. Preliminary damage assessment practice: local assessments due within 36 hours (Minnesota HSEM); photos "with timestamps and GPS coordinates" (Connecticut DEMHS); FEMA street sheet and tick sheet (Kentucky; FEMA PDA Guide, July 2025).
6. Connectivity is least reliable where damage is worst (the Helene figures above).

What it means for the design (the field app's own restyle follows this foundation):

- **Targets 56 px or more**, primary actions in the bottom third of the screen, no drag-only gestures (WCAG 2.5.7), swipe never the only way.
- **A glove mode:** larger hit areas, the hardware volume button as the shutter, dictation for notes, haptic confirmation.
- **A sunlight theme:** black on white, 7:1 or better, bold weights, no light-grey text, thick strokes on map markers.
- **A walking mode** that scales type by 1.5 and shows one decision per screen.
- **Offline-first** (built in layer 4: area packages, queued writes with visible sync state) with battery-aware GPS.
- **Camera-first capture** with time, GPS and USNG stamped into the record.

## 5. Shelter and reception workers

What the evidence says:

1. In a shelter-like gymnasium, 53–74% of one-minute periods exceeded 40 dB during lights-out (PMC5201327; small sample). No field noise data for US disaster shelters was found.
2. Red Cross practice: do not ask every arrival sensitive questions; a sign at the desk invites disclosure and workers "discreetly refer" to the manager, who meets the client "in a private location"; first-time volunteers are given registration data entry; local shifts run 4–12 hours.
3. California's Attorney General: clients "may avoid services if they fear their personal information could be exposed".
4. The standard registration record: name or chosen name, approximate age, primary language, medical needs, consent to share with partners.

What it means for the design:

- **Registration in two minutes with six required fields or fewer**; everything else deferred.
- **A counter privacy mode:** no roster on the shared screen, the previous client cleared on submit, sensitive flags shown as neutral words ("talk to the manager"), the tablet handed over for medical or legal fields.
- **No audio-only cues;** visual confirmation; large targets for standing use; sign-out on idle.

## Standards and type

- **WCAG 2.2 AA** is the floor (ACC-01): 1.4.3 contrast 4.5:1 (3:1 large); 1.4.11 non-text 3:1; 1.4.12 text spacing; 1.4.10 reflow at 320 px; 2.4.11 focus not obscured; 2.5.7 dragging alternatives; 2.5.8 targets 24 × 24 px (44 at AAA); 3.3.7 redundant entry; 3.3.8 accessible authentication. The DOJ ADA Title II web rule (WCAG 2.1 AA) now binds counties from 26 April 2027 (population 50,000 and over) and 26 April 2028 (smaller entities); Section 508 incorporates WCAG 2.0 AA.
- **USWDS** patterns (a 16 px base, labelled form controls, plain banners) are the conventions government buyers recognise; no county adoption data was found, so they guide rather than bind.
- **Fonts:** for dyslexic readers sans-serif roman fonts read fastest and italics worst; a special dyslexia font gave no benefit (Rello and Baeza-Yates, 2013, n = 48). For macular degeneration, letter spacing predicts reading performance (Xiong et al., _IOVS_, 2018). Atkinson Hyperlegible's rationale (distinct I, l and 1) is sound; its quantitative study is a 2024 conference abstract _(unverified)_. The practical choice is a wide-spaced sans with disambiguated glyphs, no thin weights, no italic body text.
- **Dark mode:** dark-on-light by default and for outdoor use; dark as a person's option for cataracts, low vision and night rooms.

## Finding → design implication → source

| Finding                                                       | Design implication                                  | Source                                      |
| ------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------- |
| Operational periods 8–12 h; longer activations need rotations | Shift hand-over summary; fatigue-tolerant light UI  | Lancaster PSC Handbook; GovTech             |
| 2.8-second interruptions double errors                        | Timestamps on every panel, undo, non-modal alerts   | Altmann et al. 2013                         |
| Fragmented situation awareness in county EOCs                 | Role-scoped views, one source of truth              | Militello 2007; McCue 2024                  |
| 16–20 arc-minutes legibility; 25 mm per 4.5 m                 | Briefing mode sized for 3–5 m                       | Extron; ISO 9241-3                          |
| Dark-on-light better for all ages                             | Light default; dark as a choice at AA contrast      | Piepenbrock 2013/2014; NN/g                 |
| Presbyopia 89% at 45+; contrast sensitivity falls with age    | 18 px body on volunteer screens; 7:1 body ink       | ASCRS; Annual Review of Vision Science      |
| 12 mm targets for tremor; 62% error on 4.9 mm                 | 48 px targets with 8 px gaps; 56 px in the field    | Nicolau and Jorge 2012; Sultana and Moffatt |
| Older users unsure of web jargon; tiny targets fail           | Labelled icons, plain words                         | NN/g older adults                           |
| 75+ smartphone ownership 43% (2021); 65+ 78% (2025)           | Keep phone, text and assisted intake                | Pew                                         |
| A third of under-$30k households are smartphone-only          | Mobile-first at 320 px                              | Pew 2026                                    |
| Lifeline 4.5 GB; ACP ended; service lapses                    | 300 KB first load, photos after text                | FCC; Benton; Pew 2015                       |
| 21.7% of cell sites out after Helene; charging lines          | Offline drafts, text and phone parity, resume codes | FCC DIRS; AP                                |
| 28% of adults at Level 1 or below                             | Sixth-grade copy, one question per screen           | NCES PIAAC 2023                             |
| 28 million LEP; Spanish speakers 65+ 42% fluent               | Spanish parity, language first                      | MPI; Census ACS                             |
| Stress impairs working memory                                 | Short steps, no memory load, progress shown         | Shields 2016; UC San Diego                  |
| 7 million vision-impaired                                     | Screen-reader parity, 200% zoom, reflow             | CDC                                         |
| Helpline 47–84% unanswered                                    | Self-serve web and text must work without a call    | GAO 2026; E&E News                          |
| Immigrants fear data sharing                                  | Plain-language privacy screen, minimal data         | GovTech 2017; Spectrum 2025                 |
| Touch poor with gloves; voice and buttons needed              | Glove mode, dictation, hardware shutter             | NISTIR 8340                                 |
| Walking: targets fix tapping, not reading; words 47% larger   | Walking mode, glance screens                        | Schildbach 2010; Fraunhofer 2018            |
| 49% one-handed grip                                           | Bottom-anchored actions                             | Hoober 2013                                 |
| Light-on-dark blurs under dilation; 400–670 nits              | Sunlight theme black on white, 7:1                  | Dobres 2016                                 |
| Photos need time and GPS; 36-hour deadline                    | Auto-stamped capture, fast queue sync               | CT DEMHS; MN HSEM                           |
| Shelter noise above 40 dB most of the night; privacy fears    | No audio cues; counter privacy mode                 | PMC5201327; CA AG; Red Cross                |
| WCAG 2.2 target 24 px (44 AAA); Title II 2027/2028            | 44–48 px as the house minimum                       | W3C; Federal Register                       |

## Design principles, ranked

1. **Never lose a resident's work:** autosave, resumable drafts, text and phone parity (SCL-06).
2. **Design for the smartphone-only, data-capped person:** 320 px first, 300 KB first load, photos deferred.
3. **Write for Level 1 readers in English and Spanish:** sixth grade, one idea per screen.
4. **Big, labelled, spaced targets everywhere:** 44–48 px minimum, 56 px in the field, every icon labelled.
5. **Type that survives presbyopia and glare:** 17 px resident body, 18 px volunteer, 7:1 contrast, no thin weights or italic body.
6. **Light theme by default, dark as an option,** both at AA contrast.
7. **Interruption-proof console:** persistent state, undo, non-modal alerts, a timestamp on every panel.
8. **Role-scoped views and a briefing mode** sized for 3–5 m.
9. **Hands-busy, eyes-busy field design:** glove mode, voice, glance-level screens, offline-first maps.
10. **Privacy visible at the point of entry:** minimal fields, plain sharing statement, counter privacy mode.
11. **No cognitive-function gates:** no passwords for residents, no CAPTCHAs, no re-entry, no time-outs.
12. **WCAG 2.2 AA and the Title II deadlines as the floor,** USWDS conventions where buyers expect them.
13. **Support assisted intake:** staff and volunteers will enter data for residents; kiosk and proxy modes stay first-class.
14. **Test with real users from each group** before each layer's gate: older volunteers, Spanish-speaking residents, gloved field staff.

## What the foundation takes from this

| Decision in `packages/ui`                                                                           | Grounded in           |
| --------------------------------------------------------------------------------------------------- | --------------------- |
| Body ink 7:1 or better; every other text 4.5:1; lines and focus 3:1                                 | §2.2, §3.7, standards |
| Light default; dark follows the device and can be fixed by the person                               | §1.5, §4.4            |
| 16 px console base, 15 px tables; 18 px resident and public body                                    | §1, §2.1, §3          |
| 44 px staff targets, 48 px public, 56 px field                                                      | §2.3, §4.2            |
| IBM Plex Sans for staff; Atkinson Hyperlegible Next for the public; no thin weights, no italic body | standards, §2.2       |
| Every navigation item and icon has a visible text label                                             | §2.7                  |
| "As of hh:mm" and the source on every panel; undo in the command window                             | §1.2, §1.3            |
| Briefing mode: 150% root size, 4.5 rem numbers, no personal details                                 | §1.6, CON-11          |
| Self-hosted fonts, one subset per app, inside the public budget                                     | §3.2, PUB-07, SCL-11  |

## Gaps still open

A national age profile of CERT, ARES and VOAD volunteers; the share of FEMA registrations by channel after 2005; the age of devices in low-income households (Android version share is the only proxy); how often phones are shared; measured noise in US disaster shelters; peer-reviewed results for Atkinson Hyperlegible.

## Sources

- https://www.lancaster.ne.gov/DocumentCenter/View/27233/PSC-Handbook-08012021a
- https://emilms.fema.gov/is_0200c/groups/80.html
- https://www.govtech.com/em/emergency-blogs/disaster-zone/youneedsleeptobeeffective.html
- https://nrt.org/sites/21/files/NRT_TechAssist_Document.pdf
- https://ocgrandjury.org/sites/jury/files/2023-08/GJLomaRidge.pdf
- https://msutoday.msu.edu/news/2013/brief-interruptions-spawn-errors
- https://researchers.mq.edu.au/en/publications/information-flow-during-crisis-management-challenges-to-coordinat/
- https://scholarworks.waldenu.edu/dissertations/16593
- https://madoc.bib.uni-mannheim.de/26118/
- https://www.nngroup.com/articles/dark-mode/
- https://azwebdev.extron.com/article/videowallfontsize
- https://userfocus.co.uk/resources/iso9241/part3.html
- https://www.fema.gov/sites/default/files/documents/fema_eoc-quick-reference-guide.pdf
- https://americorps.gov/sites/default/files/document/CEV2023_HeadlineReport_11052024_final_508.pdf
- https://www.census.gov/library/stories/2024/11/civic-engagement-and-volunteerism.html
- https://www.redcross.org/local/california/central-california/about-us/news-and-events/press/new-red-cross-data-shows-multigenerational-portrait-of-volunteer.html
- https://ARRL.org/files/file/QEX_Next_Issue/May-Jun2018/Perspectives.pdf
- https://washoecounty.gov/bcc/volunteer_opportunities.php
- https://ascrs.org/clinical-education/presbyopia/2020/2020-pod-sps-107-64522-global-prevalence-patient-and-economic-burden-of-presbyopia-a-sys
- https://annualreviews.org/doi/pdf/10.1146/annurev-vision-111815-114550
- https://web.tecnico.ulisboa.pt/hugo.nicolau/project/touchmotor.html
- https://par.nsf.gov/biblio/10134432
- https://www.nngroup.com/articles/usability-for-senior-citizens/
- https://www.nngroup.com/articles/icon-usability/
- https://www.w3.org/WAI/older-users/
- https://www.pewresearch.org/internet/fact-sheet/mobile/
- https://www.pewresearch.org/short-reads/2026/01/08/internet-use-smartphone-ownership-digital-divides-in-u-s/
- https://www.pewresearch.org/internet/2024/01/31/americans-use-of-mobile-technology-and-home-broadband/
- https://www.pewresearch.org/internet/2021/06/03/mobile-technology-and-home-broadband-2021/
- https://www.pewresearch.org/internet/2015/04/01/us-smartphone-use-in-2015/
- https://www.benton.org/headlines/one-year-without-affordable-connectivity-program
- https://docs.fcc.gov/public/attachments/DA-25-619A1.docx
- https://docs.fcc.gov/public/attachments/DOC-406055A1.pdf
- https://www.aol.com/asheville-storm-waiting-hardest-part-224210182.html
- https://ies.ed.gov/learn/press-release/u-s-adults-score-par-international-average-literacy-skills-below-international-average-numeracy-and
- https://nces.ed.gov/surveys/piaac/litproficiencylevel.asp
- https://www.census.gov/newsroom/press-releases/2023/language-at-home-acs-5-year.html
- https://www.migrationpolicy.org/data-tool/limited-english-proficient-persons
- https://hmlpubs.faculty.ucdavis.edu/wp-content/uploads/sites/214/2022/07/2016_Shields_Yonelinas.pdf
- https://today.ucsd.edu/story/climate-related-trauma-can-have-lasting-effects-on-decision-making-study-finds
- https://www.cdc.gov/vision-health/data-research/vision-loss-facts/index.html
- https://www.gao.gov/products/gao-26-108154
- https://www.eenews.net/articles/fema-didnt-answer-almost-half-the-calls-it-received-for-disaster-aid/
- https://www.govtech.com/em/safety/Some-Immigrant-Fire-Victims-Forgo-Aid-Fearing-Language-on-FEMA-Forms.html
- https://spectrumlocalnews.com/tx/south-texas-el-paso/news/2025/07/24/undocumented-families-hesitant-to-seek-aid-after-floods
- https://oag.ca.gov/system/files/media/shelter.pdf
- https://home.dartmouth.edu/news/2020/08/federal-and-state-websites-flunk-covid-19-reading-level-review
- https://www.cdc.gov/ccindex/tool/faq.html
- https://www.plainlanguage.gov/guidelines/
- https://www.atsdr.cdc.gov/place-health/php/svi/
- https://nvlpubs.nist.gov/nistpubs/ir/2021/NIST.IR.8340.pdf
- https://nvlpubs.nist.gov/nistpubs/ir/2018/NIST.IR.8216.pdf
- https://nvlpubs.nist.gov/nistpubs/ir/2019/NIST.IR.8245.pdf
- https://nvlpubs.nist.gov/nistpubs/ir/2020/NIST.IR.8314.pdf
- https://www.uni-ulm.de/fileadmin/website_uni_ulm/iui.inst.100/institut/Papers/Prof_Rukzio/2010/SchildbachMobileHCI2010.pdf
- https://www.fraunhofer.de/en/press/research-news/2018/March/lower-accident-risk-through-variable-interfaces-for-smartphone-apps.html
- https://www.uxmatters.com/mt/archives/2013/02/how-do-users-really-hold-mobile-devices.php
- https://pmc.ncbi.nlm.nih.gov/articles/PMC5213401
- https://www.fema.gov/sites/default/files/documents/fema_rd_pda-guide_07012025.pdf
- https://dps.mn.gov/divisions/hsem/disaster-recovery/Documents/preliminary-damage-assessment-field-guide-with-pa.pdf
- https://portal.ct.gov/-/media/demhs/_docs/leop/damageassessmentprocesspdf.pdf
- https://www.ncbi.nlm.nih.gov/pmc/articles/PMC5201327/
- https://washingtoncountyor.gov/emcwc/documents/american-red-cross-tip-sheet-providing-shelter-client-dignity/download
- https://nationalmasscarestrategy.org/wp-content/uploads/2016/08/ShelterDormitoryRegistrationForm.pdf
- https://www.w3.org/TR/WCAG22/
- https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html
- https://www.federalregister.gov/documents/2026/04/20/2026-07663/extension-of-compliance-dates-for-nondiscrimination-on-the-basis-of-disability-accessibility-of-web
- https://www.access-board.gov/ict/
- https://designsystem.digital.gov/design-principles/
- https://doi.org/10.1145/2513383.2513447
- https://pmc.ncbi.nlm.nih.gov/articles/PMC6100668
- https://www.csun.edu/cod/conference/sessions/2024/index.php/public/presentations/view/3108.html
