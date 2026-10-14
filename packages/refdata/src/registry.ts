/**
 * The connectors this build ships (ADR-0039). A tenant pulls each dataset
 * from its default connector unless its configuration names another, or
 * `import` (file imports only, no pulls). The union of the connectors' hosts
 * is the widest egress allowlist; a deployment narrows it in configuration.
 */
import { fileURLToPath } from 'node:url';
import type { Connector } from './connector.ts';
import { acsTractProfile, tigerwebTracts } from './connectors/census.ts';
import { cmsFacilities } from './connectors/cms.ts';
import { nfhlFloodZones } from './connectors/nfhl.ts';
import { nsiStructures } from './connectors/nsi.ts';
import { nwsAlerts } from './connectors/nws.ts';
import { openFemaDeclarations, openFemaNfip } from './connectors/openfema.ts';
import type { Dataset } from './datasets.ts';

/**
 * In dataset order, so a tenant's tracts (whose outline other sources need)
 * are asked for first. Not pulled, import only: National Risk Index and SVI
 * (released as files), FEMA USA Structures (served from ArcGIS Online, not a
 * source here; decision 2026-10-14), power outages (the ODIN feed's format
 * could not be checked from the build environment; it gets a connector
 * once verified).
 */
export const connectors: readonly Connector[] = [
  tigerwebTracts,
  acsTractProfile,
  nsiStructures,
  nfhlFloodZones,
  cmsFacilities,
  openFemaDeclarations,
  openFemaNfip,
  nwsAlerts,
];

/** Recorded synthetic WESTWIND responses shipped for development and CI (SCL-12). */
export const recordingsDir = fileURLToPath(new URL('../recordings', import.meta.url));

export function connectorById(id: string): Connector | undefined {
  return connectors.find((c) => c.id === id);
}

/**
 * The connector that fills a dataset for a tenant: the one its configuration
 * names, else the first shipped for the dataset. `import` means no pulls.
 */
export function connectorFor(
  dataset: Dataset,
  choice?: string | null,
): Connector | 'import' | undefined {
  if (choice === 'import') return 'import';
  if (choice) {
    const named = connectorById(choice);
    return named?.dataset === dataset ? named : undefined;
  }
  return connectors.find((c) => c.dataset === dataset);
}

export function connectorHosts(): string[] {
  return [...new Set(connectors.flatMap((c) => c.hosts))].sort();
}
