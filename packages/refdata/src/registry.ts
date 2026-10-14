/**
 * The connectors this build ships (ADR-0039). A tenant pulls each dataset
 * from its default connector unless its configuration names another, or
 * `import` (file imports only, no pulls). The union of the connectors' hosts
 * is the widest egress allowlist; a deployment narrows it in configuration.
 */
import { fileURLToPath } from 'node:url';
import type { Connector } from './connector.ts';
import { openFemaDeclarations } from './connectors/openfema.ts';
import type { Dataset } from './datasets.ts';

export const connectors: readonly Connector[] = [openFemaDeclarations];

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
