# ADR-0015: MapLibre + self-hosted OpenStreetMap PMTiles, Nominatim geocoding, USNG

- Status: proposed
- Date: 2026-10-12
- Requirements: SCL-13, FLD-04/05/13, CON-03, CON-17, BRD:INT-02, ACC-07, FR-03.*

## Decision

- **Display:** MapLibre GL JS (web) and MapLibre React Native (field), both using the same style.
- **Tiles:** vector tiles built from the region's OSM extract with Planetiler (OpenMapTiles schema) into a single **PMTiles** file, served as a static file over HTTP range requests by the gateway. Offline packages for the field app are cut by bounding box from the same file with `pmtiles extract`.
- **Geocoding:** Nominatim (`mediagis/nominatim` image) imports the same extract; parcels from county data live in PostGIS and take priority for snapping (FLD-04).
- **Routing:** a straight-line fallback first; Valhalla on the same extract later (finding Q-03).
- **USNG:** coordinates converted with the `usng` npm library (tested against NGA examples) and stored next to lat/lon (FLD-05).
- Every map task has a non-map equivalent (address entry, lists) for accessibility (FR-00.09, AC-03C).

## Alternatives considered

| Option                              | Why not                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------- |
| Tile server (Martin, TileServer GL) | An extra running service; PMTiles needs only static hosting and works offline as-is.              |
| Public OSM tile servers             | Not for production use (SCL-13).                                                                  |
| Esri basemaps                       | Fixed decision: Esri via import/export only.                                                      |
| Pelias / Photon geocoders           | Pelias needs Elasticsearch plus several services; Photon is fine for type-ahead and can be added. |

## Why it fits SCL-11 and the government-cloud move

Tiles are files in object storage behind the CDN; Nominatim is the same container in the cloud.

## Consequences

The first `docker compose --profile maps-build up` downloads the Missouri extract from Geofabrik and builds tiles (tens of minutes, a few GB). Data is © OpenStreetMap contributors (ODbL); attribution is shown on every map.
