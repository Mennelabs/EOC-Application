# ADR-0041: Reading reference files (CSV, GeoJSON, GeoPackage, zipped Shapefile) without new dependencies

- Status: accepted
- Date: 2026-10-14
- Requirements: SCL-09, SCL-13, SCL-11, SEC-15, RULE-02; ADR-0039 (file import for every reference dataset)

## Decision

Reference files are read inside the worker by `packages/refdata` with what Node already ships:

| Format                              | Reader                                                                                                            | Limits and refusals                                                                                         |
| ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| CSV (RFC 4180, UTF-8, optional BOM) | Our parser (quotes, doubled quotes, newlines in quotes)                                                           | Points from latitude and longitude columns; areas need a geometry format                                    |
| GeoJSON (RFC 7946)                  | `JSON.parse`                                                                                                      | A `FeatureCollection` only                                                                                  |
| GeoPackage (OGC 12-128)             | `node:sqlite`, read-only, from a private temporary copy removed at once; geometry blobs decoded by our WKB reader | First feature table (or a named one); WGS 84 (EPSG:4326) only                                               |
| Zipped Shapefile                    | Our zip reader on `node:zlib` (stored and deflated entries), `.shp`, `.dbf` and `.prj` readers                    | WGS 84 geographic `.prj` required; no ZIP64 or encryption; 512 MB unpacked at most; deleted records skipped |

A layer in any other coordinate system is refused with "reproject first". Reprojection would need PROJ (a native library or a large WebAssembly build) and would move data silently if it guessed wrong; counties' GIS staff reproject in seconds with the tools they already use, and the import wizard says so.

Values are coerced by the target field's type, empty cells are null (RULE-02), and errors name the row and field, never the value.

## Alternatives

- **GDAL (`ogr2ogr`) in the worker image.** Reads everything and reprojects, but adds a large native dependency with its own CVE stream to an image that must pass container scanning (SEC-15) and move unchanged to the government cloud (SCL-11). Rejected for release 1; a separate import container with GDAL stays possible if counties need more formats.
- **npm packages (`shapefile`, `@ngageoint/geopackage`, `better-sqlite3`, `sql.js`).** Each adds supply-chain surface (and `better-sqlite3` a native build on Alpine) for formats that take a few hundred lines to read correctly. Rejected.
- **Convert in the browser.** Moves parsing to the least controlled place and duplicates it. Rejected.

## Consequences

- `node:sqlite` is marked experimental in Node 22 and 24. It is used read-only for one query pattern; the tests build real GeoPackages with it, so a change in its API fails CI before release. If it changes, `sql.js` is the fallback.
- No new runtime dependency in the worker or API images.
- File Geodatabase (`.gdb`) and KML are not read; counties export to GeoPackage or Shapefile.
