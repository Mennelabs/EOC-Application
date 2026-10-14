# ADR-0039: Reference data from free public services, with file import for every dataset

- Status: proposed (direction from Adam 2026-10-14; the source list awaits his pick)
- Date: 2026-10-14
- Requirements: SCL-09, SCL-13, DCL:DEC-05, DCL:DEC-06, DCL:DEC-07, DCL:DEC-11, DCL:DEC-12, DCL:DEC-16, CON-07, EQ-11, EQ-12, RULE-10, SCL-06, SCL-11, SCL-12

## Decision

Layer 6 needs facts about a county that residents and staff do not enter: census population profiles per tract, the structures inside a damage footprint, flood zones, critical facilities, power outages, earlier declarations and flood-insurance coverage. Following Adam's direction (2026-10-14: "pull it in from another service as well as have the ability to do imports"), each of these **reference datasets** can be filled two ways, with the same normalized schema and provenance:

1. **Pull** from a free public service through a connector run by the worker, on a schedule and on demand.
2. **Import** a file (CSV, GeoJSON, GeoPackage, zipped Shapefile) with a column mapping, for counties whose own GIS data is better, for air-gapped or restricted-egress deployments, and for sources without an API.

Recommended sources (all free; the federal ones are public-domain U.S. government works):

| Dataset (normalized)              | Primary pull source                                                                                  | Notes                                                                                                                                                                          |
| --------------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Tract population profile          | U.S. Census Bureau Data API, ACS 5-year (`api.census.gov`)                                           | Free key; up to 50 variables per call; tracts queried per state and county. Population, households, renters, income, poverty, age 65+, disability, limited-English households. |
| Tract and county boundaries       | Census TIGERweb REST (`tigerweb.geo.census.gov`)                                                     | ArcGIS REST protocol, no key.                                                                                                                                                  |
| Structures (points or footprints) | USACE National Structure Inventory API (`nsi.sec.usace.army.mil`); FEMA USA Structures (footprints)  | NSI: county or bounding-box queries; occupancy type, stories, foundation, value, year built (public subset). USA Structures: footprints over 450 sq ft with occupancy.         |
| Flood zones                       | FEMA National Flood Hazard Layer, ArcGIS REST (`hazards.fema.gov/arcgis/rest/services/public/NFHL`)  | No key; effective flood zones and base flood elevations.                                                                                                                       |
| Declarations, flood insurance     | OpenFEMA API (`www.fema.gov/api/open`)                                                               | No key; disaster declarations since 1953; NFIP policies and claims (field-level geography to confirm against the live schema).                                                 |
| Risk and vulnerability            | FEMA National Risk Index; CDC/ATSDR Social Vulnerability Index                                       | Tract-level downloads and ArcGIS services; imported per release rather than polled.                                                                                            |
| Critical facilities               | CMS Provider Data API (hospitals, nursing homes, home health, dialysis); OpenStreetMap (self-hosted) | HIFLD Open shut down in 2025; its last snapshot (HIFLD Next, DataLumos) is an import, not a live source.                                                                       |
| Weather alerts                    | National Weather Service API (`api.weather.gov`)                                                     | No key; requires a contact `User-Agent`.                                                                                                                                       |
| Power outages                     | DOE/ORNL Outage Data Initiative Nationwide (ODIN) public feed                                        | No key; county level, about 15 minutes behind; coverage depends on which utilities participate.                                                                                |
| Anything else in a county's GIS   | ArcGIS REST connector (generic FeatureServer query), with the county's own ArcGIS Online credentials | Reaches the county's own layers and ArcGIS Living Atlas content; ArcGIS Online is FedRAMP Moderate. Per-item terms apply; Living Atlas use under a county's own subscription.  |

Connector rules:

- **Only geography goes out.** A request carries a state or county FIPS code, a tract list or a bounding box, never a resident, report or account value (SCL-12, privacy). Each connector names the hosts it may reach; the worker refuses any other host (an egress allowlist in configuration).
- **Snapshots, not live reads.** Every pull or import writes a versioned, per-tenant snapshot with its source, URL, dataset vintage, retrieval time, licence and checksum. Screens and official reports read snapshots; an issued report cites the snapshot ids it used, so later pulls never change it (RULE-10, BRD:FR-15.05).
- **Degrade, never block.** If a source is down, slow or blocked, the last good snapshot stays in use and its age is shown; nothing in intake or review waits on a source (SCL-06).
- **Fakes for tests.** Each connector has a deterministic stand-in that replays recorded responses in the real formats with synthetic values for the fictional WESTWIND county (SCL-12); CI never calls the live services. A live smoke test against a real county is a manual, opt-in command whose results are not committed.
- **Free only.** A source that charges (for example parcel, outage or property-data aggregators) is added only after Adam approves it.

## Alternatives considered

| Option                                             | Why not                                                                                                                                                                          |
| -------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Import only (the earlier fixed decision for Esri)  | Adam prefers live pulls; reference data would go stale between manual imports during an event.                                                                                   |
| ArcGIS Living Atlas as the single source           | Richest single catalogue and FedRAMP Moderate, but a commercial platform with per-item terms and conditions on commercial use; better as an option under a county's own account. |
| Paid aggregators (parcels, outages, property data) | Cost and contracts; ask Adam first (CLAUDE.md rule 10).                                                                                                                          |
| HIFLD Open                                         | Discontinued August 2025; archives are snapshots without an API.                                                                                                                 |
| Calling the sources directly from screens          | Leaks staff browsing to third parties, breaks when a source is down, and makes issued reports unreproducible.                                                                    |

## Why it fits SCL-11 and the government-cloud move

Connectors run inside the existing worker image; hosts and keys (the Census key, a county's ArcGIS credentials) come from configuration and secrets. In the government cloud, egress to the listed public hosts goes through the boundary's allowlisted outbound proxy, or a tenant switches a dataset to import mode with no egress at all.

## Consequences

Counties get current reference data without manual work, and every official number can be traced to a dated source. The cost is a connector per source to maintain as those services change their schemas; the recorded-response tests and a per-connector schema check catch drift. The Census key and any county ArcGIS credentials are secrets.
