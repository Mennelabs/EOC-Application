/**
 * Subscription (SCL-10, WCAG 2.2 AA): the organization's contracts, read
 * only. Each is an annual subscription per jurisdiction, tiered by
 * population served; a state or coalition contract can cover its member
 * jurisdictions, and a county sees the one that covers it (but not the
 * other members by name). The screen says plainly that resident reports are
 * never counted or capped: reporting stays open in any surge, whatever the
 * plan, and whether or not a contract is in force. Contracts are changed by
 * the account manager, never from here.
 */
import { useEffect, useState } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Status } from '../ui/primitives.tsx';

interface Contract {
  id: string;
  holder: { id: string; name: string; kind: string };
  own: boolean;
  tier: string;
  populationServed: number | null;
  termStart: string;
  termEnd: string;
  status: 'active' | 'expired' | 'cancelled';
  inForce: boolean;
  covered: { id: string; name: string }[];
  coveredCount: number;
}

interface Coverage {
  contracts: Contract[];
  inForce: boolean;
  residentReportsNeverCapped: true;
}

/** A contract date (YYYY-MM-DD) as words, the same day wherever the browser is. */
const longDate = (d: string) =>
  new Date(`${d}T00:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'long' });

const today = () => {
  const n = new Date();
  const p = (x: number) => String(x).padStart(2, '0');
  return `${n.getFullYear()}-${p(n.getMonth() + 1)}-${p(n.getDate())}`;
};

function standing(c: Contract): string {
  if (c.inForce) return 'In force';
  if (c.status === 'cancelled') return 'Cancelled';
  if (c.status === 'expired') return 'Expired';
  return c.termStart > today()
    ? `Signed; starts ${longDate(c.termStart)}`
    : `Term ended ${longDate(c.termEnd)}`;
}

function coverage(c: Contract): string {
  const names = c.covered.map((t) => t.name);
  const others = c.coveredCount - names.length;
  if (c.own && c.coveredCount === 0) return 'Your organization only';
  const listed = names.join(', ');
  if (others <= 0) return c.own ? `Your organization and ${listed}` : listed;
  const rest = `${others} other member ${others === 1 ? 'jurisdiction' : 'jurisdictions'}`;
  return listed ? `${listed}, and ${rest}` : rest;
}

export function SubscriptionScreen() {
  const [actions, setActions] = useState<string[] | null>(null);
  const [data, setData] = useState<Coverage | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api<{ actions: string[] }>('/me')
      .then((me) => {
        if (!live) return;
        setActions(me.actions);
        if (me.actions.includes('license.read'))
          return api<Coverage>('/license').then((c) => live && setData(c));
      })
      .catch((err: unknown) => live && setError(describeFailure(err)));
    return () => {
      live = false;
    };
  }, []);
  const allowed = actions?.includes('license.read') ?? false;

  return (
    <section aria-labelledby="sub-h">
      <h1 id="sub-h">Subscription</h1>
      <p>
        Each contract is an annual subscription for a jurisdiction, tiered by the population it
        serves. A state or coalition contract can cover its member jurisdictions. Your account
        manager records contract changes; each one is in the audit log.
      </p>
      <section aria-labelledby="sub-reports" className="panel">
        <h2 id="sub-reports">Resident reports are never counted or capped</h2>
        <p>
          Residents can always report, by web, text or phone, however many reports come in and
          whatever the plan or term. Nothing on this screen slows or stops a report.
        </p>
      </section>
      {error ? <Status kind="error">{error}</Status> : null}
      {actions && !allowed ? <p>You do not have access to the subscription.</p> : null}
      {allowed && data === null && !error ? <p role="status">Loading the subscription…</p> : null}
      {data ? (
        <>
          <p>
            {data.inForce
              ? 'A subscription is in force today.'
              : 'No subscription is in force today. Resident reports are still accepted; ask your account manager about renewal.'}
          </p>
          <DataTable
            caption="Contracts"
            rows={data.contracts}
            rowKey={(c) => c.id}
            empty="No contract is recorded for your organization."
            columns={[
              {
                key: 'holder',
                header: 'Contract',
                render: (c) => (c.own ? 'Your organization’s' : `Covered by ${c.holder.name}`),
              },
              { key: 'tier', header: 'Tier', render: (c) => c.tier },
              {
                key: 'population',
                header: 'Population served',
                render: (c) =>
                  c.populationServed === null
                    ? 'Not stated'
                    : c.populationServed.toLocaleString('en-US'),
              },
              {
                key: 'term',
                header: 'Term',
                render: (c) => `${longDate(c.termStart)} to ${longDate(c.termEnd)}`,
              },
              { key: 'standing', header: 'Status', render: standing },
              { key: 'covers', header: 'Covers', render: coverage },
            ]}
          />
        </>
      ) : null}
    </section>
  );
}
