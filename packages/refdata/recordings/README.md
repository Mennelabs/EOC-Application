# Recorded reference responses (synthetic)

Development and CI never call the federal services (SCL-12, ADR-0039). Each
file here is a response in the source's real format, filled with **synthetic
values for the fictional WESTWIND exercise county** (state FIPS `29`, county
FIPS `29999`, which no real county uses), derived from the seed's own
geography by `tools/seed/src/recordings.ts`. Disaster numbers sit in the
99xx range, outside FEMA's real numbering, and every title says EXERCISE.
Regenerate with `pnpm --filter @cg/seed recordings`; a test fails when the
files here differ from what the generator produces.

`index.json` maps a request (host, path and the query parameters that matter)
to a file. A request with no entry fails loudly instead of reaching the
network. Never commit a response recorded from a real county: the live smoke
test (`pnpm --filter @cg/refdata smoke -- --state 29 --county 29189`) prints
row counts and field names to the terminal only.
