# ADR-0046: Routing and travel times from a self-hosted OSRM built on the same OpenStreetMap extract as the tiles

- Status: accepted as the default in force (layer-8 plan §13 question 2; Adam may choose Google Maps Platform instead)
- Date: 2026-10-17
- Requirements: CON-14, DSP-04, SCL-06, SCL-11, SCL-13, SCL-15, NFR-04

## Decision

1. **Routing is a container, not a paid API.** The `routing` compose profile runs [OSRM](https://project-osrm.org/) (`osrm/osrm-backend`, BSD-2) with a graph built once by `routing-build` from the same OpenStreetMap extract (`OSM_PBF_URL`) that `tiles-build` turns into vector tiles, so the roads the map draws are the roads the router drives. The API reaches it at `ROUTING_URL` on the platform network; nothing leaves the stack.
2. **One endpoint, one source label.** `GET /routing/route` returns a distance, a driving time and a line, with `source` saying what computed it. Without the container, or when the router finds no road or does not answer in two seconds, the answer is the straight-line distance at a county-road speed and `source` says so (SCL-06: maps off, work goes on). A result is never silently downgraded.
3. **Closures are shown, not routed around.** Live conditions (CON-14) are listed beside a route with their source and age; the router's graph is the extract as built. Routing around a closure needs a rebuilt or dynamically weighted graph, which is a later step if a county asks.
4. **Google Maps Platform only if Adam approves the paid service** (plan §13 question 2). It would sit behind the same endpoint and `source` label; nothing in the console depends on which router answers.

## Alternatives considered

| Option                                         | Why not                                                                                                                                                          |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Google Maps Platform Directions and Routes API | Paid per request, a key to protect, traffic data that is good but needs an egress rule and a contract in a government cloud; waits on Adam.                      |
| Valhalla                                       | Also self-hosted and open; richer costing (time-dependent, multimodal) but a heavier build and more memory than a county's laptop stack needs for driving times. |
| GraphHopper                                    | Capable, but its free build lacks the features that would justify switching from OSRM for one driving profile.                                                   |
| Straight-line estimates only                   | What the dispatch board used so far; fine for "nearest team" ranking, misleading for a time to a shelter across a river.                                         |
| pgRouting on the county's own road centrelines | Needs a routable centreline network per county, which most do not keep; the OpenStreetMap extract is already in the stack for the tiles.                         |

## Consequences

- The first build downloads the state extract (hundreds of MB) and takes minutes; both profiles are opt-in like `maps` and `maps-build`, and `scripts/init-env.sh` leaves them off.
- The government cloud runs the same two images from the same extract; `ROUTING_URL` is the only setting.
- The graph is as fresh as the last `routing-build`; the README says to run it when the tiles are rebuilt.
