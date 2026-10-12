import { useEffect, useState } from 'react';
import type { RuntimeConfig } from './runtime-config.ts';

/**
 * Console shell (CON-01): one console with role-based workspaces. The
 * workspace list follows the WESTWIND cast (docs/02). Each workspace arrives
 * with its layer; staff sign-in (SEC-07) and permissions (ADM-04/05) arrive
 * in layer 1, so nothing here shows data yet.
 */
const workspaces = [
  { name: 'Situation', layer: 3 },
  { name: 'Review queue', layer: 2 },
  { name: 'Needs board', layer: 3 },
  { name: 'Mass care', layer: 3 },
  { name: 'Sites', layer: 3 },
  { name: 'Messaging', layer: 3 },
  { name: 'Dispatch', layer: 4 },
  { name: 'Declaration', layer: 6 },
  { name: 'Facility registry', layer: 7 },
  { name: 'Event log', layer: 8 },
  { name: 'Administration', layer: 1 },
] as const;

interface Meta {
  version: string;
  dataMode: string;
}

export function App({ config }: { config: RuntimeConfig }) {
  const [meta, setMeta] = useState<Meta | null>(null);
  const product = config.productName || 'Console';

  useEffect(() => {
    document.title = `${product} — ${config.countyName || 'Console'}`;
    fetch('/api/meta')
      .then((r) => (r.ok ? (r.json() as Promise<Meta>) : null))
      .then(setMeta)
      .catch(() => setMeta(null));
  }, [product, config.countyName]);

  return (
    <>
      <a className="skip" href="#main">
        Skip to main content
      </a>
      <header className="top">
        <p className="product">{product}</p>
        <p className="county">
          {config.countyName ? `${config.countyName} Emergency Management` : ''}
        </p>
      </header>
      <div className="layout">
        <nav aria-label="Workspaces">
          <ul>
            {workspaces.map((w) => (
              <li key={w.name}>
                <span aria-disabled="true">
                  {w.name} <span className="soon">(layer {w.layer})</span>
                </span>
              </li>
            ))}
          </ul>
        </nav>
        <main id="main">
          <h1>Staff console</h1>
          <p>
            Staff sign-in with your organization’s single sign-on and a passkey is being built in
            layer 1. No resident data is shown before sign-in and permission checks exist.
          </p>
          <dl className="meta">
            <dt>API</dt>
            <dd>
              <span role="status">
                {meta ? `reachable, version ${meta.version}` : 'not reachable'}
              </span>
            </dd>
            <dt>Data</dt>
            <dd>{meta?.dataMode === 'synthetic' ? 'Synthetic exercise data only' : '—'}</dd>
          </dl>
        </main>
      </div>
    </>
  );
}
