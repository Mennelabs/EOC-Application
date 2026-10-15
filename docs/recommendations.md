# Recommendations: rules, planning factors and weights

How the console recommends shelters, feeding stops, points of distribution (PODs) with walk-up points, and Multi-Agency Resource Centers (MARCs). The rules are in `packages/reporting/src/recommend.ts` and `recommend-sites.ts`; what they read is in `recommend-load.ts`; the API is `services/api/src/routes/recommendations.ts`; the screen is `/console/recommendations`.

Requirements: REC-02 to REC-12 (docs/02), with the walkthrough on Saturday night (shelter), Sunday noon (feeding), Monday 10 am (POD and walk-up) and Wednesday (MARC).

## What never changes

- **Rules, not a language model (REC-12).** The same inputs always give the same answer. Every number in a reason can be traced to an input.
- **Unknown is never guessed (REC-10).**
  - A must-have that is unknown sets a place aside, with that reason: accessibility for a shelter or MARC, semi-truck access for a POD, parking for a canteen stop, floor space.
  - Anything else unknown is listed beside the place.
  - Anything the registry cannot hold is listed as a check for a person: a POD's surface, hospital routes, a MARC's bus line.
- **Every input shows its age**, with a stale warning (REC-10).
- **Every answer carries the equity check (REC-11).** It shows households within reach by income band, renter share and limited English, and flags any high-need tract left out.
- **A named person decides (REC-04).**
  - The options are accept, edit or reject, always with a reason.
  - An edit names the other place. For feeding, it names the stop swapped and the place instead, which may be one the team knows that is not in the registry.
  - The decision is recorded once, needs the version it was made against, and is audited.
- **Nothing is changed by a recommendation.** No site, facility or team is touched.
- **The answer is stored exactly as shown,** with the rules version and the weights and factors in force.

## Hard filters (REC-02)

| Applies to   | Set aside when                                                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Every kind   | No location. Inside the damage area (a major or destroyed home within 250 m). In a flood zone (registry, or a high-risk FEMA zone A or V). A road blockage reported within its radius plus 200 m. |
| Shelter      | A parking lot. ADA no or unknown. In an open outage with no or unknown backup power. Floor space unknown.                                                                                         |
| Feeding stop | No parking, or parking unknown (a parking lot passes).                                                                                                                                            |
| POD          | Inside a reported debris area. No or unknown semi-truck access. Fewer parking spaces than the minimum, or parking unknown (a parking lot passes).                                                 |
| MARC         | A parking lot. ADA no or unknown. In an open outage with no or unknown backup power. Floor space unknown or smaller than the partner mix needs. No parking.                                       |

## Planning factors

Tenant setting: `recommendation.planning_factors` (any subset). A value that is not a positive number is ignored, and the default is used.

The source is docs/02's planning-factor table where it gives one. **Planning default** means no published source was found: the value is a starting point for the county to set.

| Factor                                               | Default | Source                                                        |
| ---------------------------------------------------- | ------- | ------------------------------------------------------------- |
| `shelterSqftPerPerson`                               | 40      | Florida sheltering guidance (short-term)                      |
| `peoplePerShower`                                    | 48      | Same                                                          |
| `personsPerHousehold`                                | 2.5     | Planning default (close to the US average household)          |
| `coverageKm` (shelter, POD, MARC equity check)       | 10      | Planning default                                              |
| `staleDays` (registry re-check)                      | 365     | REC-01                                                        |
| `mealsPerPersonPerStop`                              | 1       | Planning default (one meal per serving window)                |
| `stopsPerCanteen`                                    | 2       | Planning default (two serving windows a day)                  |
| `feedingFirstStartHour`                              | 11      | Planning default (docs/02 example: 11 am to 1:30 pm)          |
| `feedingWindowHours`                                 | 2.5     | Same                                                          |
| `feedingGapHours`                                    | 3       | Planning default (travel and restock)                         |
| `feedingClusterKm`                                   | 2       | Planning default                                              |
| `feedingSiteKm`                                      | 1.5     | Planning default                                              |
| `feedingCoverageKm`                                  | 3       | Planning default                                              |
| `languageNotePct`                                    | 30      | Planning default                                              |
| `chaplainMinRequests`                                | 2       | Planning default                                              |
| `podDailySharePct`                                   | 50      | Planning default (share of people without power served a day) |
| `podWaterGalPerPersonDay`                            | 1       | Ohio EMA POD guide                                            |
| `podIceLbMinPerPersonDay`, `podIceLbMaxPerPersonDay` | 6, 8    | Same                                                          |
| `podMealsPerPersonDay`                               | 2       | Same                                                          |
| `podDays`                                            | 3       | Same (first 72 hours)                                         |
| `podMinParkingSpaces`                                | 100     | Planning default                                              |
| `walkUpNoVehiclePct`                                 | 15      | Planning default (docs/02 example tract: 23%)                 |
| `walkUpKm`                                           | 1       | Planning default (walking distance)                           |
| `marcHouseholdsPerTable`                             | 25      | Planning default                                              |
| `marcMaxTablesPerService`                            | 4       | Planning default                                              |
| `marcSqftPerTable`                                   | 100     | Planning default                                              |
| `marcBaseSqft`                                       | 1,000   | Planning default (welcome desk, waiting, quiet room)          |
| `marcServices`                                       | 5       | Planning default                                              |

POD types follow the Ohio EMA POD guide: Type III serves up to 5,000 people a day, Type II up to 10,000 and Type I up to 20,000. Above 20,000 a day, the answer is more than one Type I.

## Weights (REC-03)

Tenant settings: `recommendation.weights.shelter`, `recommendation.weights.pod` and `recommendation.weights.marc`. Each score part runs from 0 to 1. The answer says what would put the runner-up first.

| Kind    | Default weights                                                                                            |
| ------- | ---------------------------------------------------------------------------------------------------------- |
| Shelter | capacity 0.35, proximity 0.25, amenities (kitchen, showers, backup power) 0.2, use agreement 0.1, pets 0.1 |
| POD     | proximity 0.4, room for queued cars 0.45, use agreement 0.15                                               |
| MARC    | proximity to the major and destroyed homes 0.5, parking 0.2, use agreement 0.15, backup power 0.15         |

Feeding has no weights. Stops go to the largest groups of requests, and each stop takes the nearest safe registered site with parking.

## What each kind reads

- **Shelter:** open requests for a place to stay tonight, and for help with pets.
- **Feeding:**
  - Open requests for food or water, grouped in cells of about a kilometre, with the language each was made in.
  - Requests for help with pets and for someone to talk to.
  - The active canteens on the roster visible to the county: its own, and partners' shared with it. Each canteen's declared meals an hour (REC-06) is unknown when not declared.
- **POD:**
  - Open power outages: customers out, and outages with no count.
  - Water outages.
  - The latest restoration estimate.
  - Tracts with households without a vehicle (ACS) that hold a report or request in the event.
- **MARC:**
  - Homes counted major or destroyed under the counting rule (the declaration's figures), by tenure and insurance.
  - Open requests by category.
  - The languages reports were made in.
- **All kinds:**
  - The facility registry and the event's live conditions: damage, flood zones, road blockages, debris and outages.
  - Census tracts and their profile.

## Not yet

- **A partner asking from its own workspace.** Its row security does not see the county's registry or requests, so the county asks on its behalf.
- **The AI-drafted explanation.** A language model may later word the explanation, checked against the computed reasons (REC-12, AIG-07). The reasons shown today are the rules' own words.
