# Resource discovery

How the platform finds places that could serve residents, and how they reach the facility registry (REC-13, REC-14; Q-06 as decided 2026-10-15). The code is in four places:

- the worker job: `services/worker/src/jobs/discovery.ts`;
- feed parsing and the pre-check: `services/worker/src/discovery/places.ts`;
- the API: `services/api/src/routes/discovery.ts`;
- the screen: `/console/discovery`.

## Sources, in order

1. **Partner posts.** Services partner organizations post appear at once on Find help (2026-10-15). They are also the first feed for the registry. A confidential site never leaves its own record.
2. **The county's own sources.** These are a 211 or HSDS service directory (`/locations`), an open-data CSV, or a GeoJSON point layer.
   - The administrator names each by its public https address.
   - Reads follow ADR-0042:
     - host names only, every resolved address public, and the connection pinned to the checked address;
     - redirects checked again;
     - 15 seconds per request; 5 MB at most.
3. **OpenAI web search.** It runs only when two things are true: the county lists it as a source, and the AI use register has `discovery.web_search` switched on for the provider in force. Switching it on needs the provider's evaluation first (AIG-06, AIG-08).
   - The search carries the county's area in words (`discovery.area`, else the organization's name), the kinds of place (`discovery.place_types`, else REC-13's list), and the names and street addresses of up to 25 registered public places to check for closures or changes. It never carries a person or anything a resident wrote (AIG-05).
   - A place is kept only with a page the search itself cited or consulted.
   - When a page tries to instruct the search, nothing from that search is kept.
   - Each search is recorded with its provider and model (AIG-01).

## When it runs

- Weekly by default, and daily while an event is active. The tenant can change this with `discovery.schedule`, as `{quietDays, activeDays}` between 1 and 90.
- Also within a minute of someone pressing "Find now".
- A tenant with no source and no partner post is not run.

## What a candidate holds

- The source links.
- What the source states. Nothing is guessed (REC-10); the rest is listed as unknown.
- The pre-check against the registry criteria. It uses the same rules as the recommendations (`docs/recommendations.md`) and says, for each use (shelter, feeding stop, POD, MARC), whether the place fits, needs information first, or does not fit, and why.
- Whether it lies within 3 km of open requests for food or a place to stay in an active event.

## Remembering

- A place already in the registry is not proposed.
- The same place found again refreshes its candidate. Its fingerprint is its name and ZIP code.
- A place set aside stays set aside until something about it changes: its content hash covers the name, kind, address, position, facts and note.
- When it does come back, the candidate says when it was set aside.

## Deciding

People with `discovery.review` decide each candidate:

- county EM;
- planning, who may set a place aside but not qualify it in.

Qualifying a place in also needs `facility.approve`:

- A new place enters the registry with source "discovery". Its notes carry the hours, the website and where it was found.
- A reported closure retires the registered place.
- A reported change applies what the source states.

Every decision has a reason and is audited.

## Who hears

- **Alert:** a candidate near unmet need in an active event is raised at once, by email, to the people who review discovery. It goes once per candidate.
- **Digest:** a summary of what is new goes daily during an active event and weekly otherwise. It goes once per period, and only when something is new.
- **Fallback recipients:** with no reviewer, the administrator hears; with no administrator, the security contact does.
- Both emails are in English and Spanish.

## Open

- Whether OpenAI's zero data retention covers live web search needs confirming before `discovery.web_search` is switched on. OpenAI's data-controls page does not establish it. The search carries no personal data.
