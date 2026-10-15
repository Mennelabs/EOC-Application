/**
 * The state liaison's view (layer-6 task F; DCL:DEC-13, SCL-01, WCAG 2.2
 * AA): the declaration figures of each county that has signed an agreement
 * with the liaison's tenant, read-only and de-identified: the same totals as
 * the county's own Declaration screen, confirmed outages only, public damage
 * by category, and the joint assessment's progress as counts. Never a name,
 * contact, address or individual site. Each view is recorded in the
 * county's audit log.
 */
import { useEffect, useState } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { Status, fmt } from '../ui/primitives.tsx';
import {
  Casualties,
  Clock,
  Damage,
  Donated,
  Outages,
  Profile,
  PublicDamage,
  type View,
} from './declaration.tsx';

interface Shared {
  tenantId: string;
  tenantName: string;
  events: { id: string; name: string; status: string }[];
}

interface SharedView extends View {
  county: { id: string; name: string };
  jointAssessment: {
    startsOn: string | null;
    endsOn: string | null;
    areas: string[];
    status: 'planned' | 'in_progress' | 'done';
    summary: {
      stops: number;
      validated: number;
      different: number;
      notSeen: number;
      pending: number;
    };
  };
}

const noRun = async () => false;

export function SharedDeclarationsScreen() {
  const [shared, setShared] = useState<Shared[] | null>(null);
  const [eventId, setEventId] = useState<string | null>(null);
  const [view, setView] = useState<SharedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api<Shared[]>('/shared-declarations')
      .then((s) => {
        if (!live) return;
        setShared(s);
        setEventId((cur) => cur ?? s.flatMap((x) => x.events)[0]?.id ?? null);
      })
      .catch((err: unknown) => live && setError(describeFailure(err)));
    return () => {
      live = false;
    };
  }, []);
  useEffect(() => {
    if (!eventId) return;
    let live = true;
    api<SharedView>(`/shared-declarations/${eventId}`)
      .then((v) => {
        if (!live) return;
        setView(v);
        setError(null);
      })
      .catch((err: unknown) => live && setError(describeFailure(err)));
    return () => {
      live = false;
    };
  }, [eventId]);
  const j = view?.jointAssessment;

  return (
    <section aria-labelledby="shared-h">
      <h1 id="shared-h">Shared declaration figures</h1>
      <p>
        Figures from counties that have signed an agreement with your organization: counts only,
        read-only, the same totals the county sees. No names, contact details or addresses. Each
        time you open a county’s figures it is recorded in that county’s audit log.
      </p>
      {error ? <Status kind="error">{error}</Status> : null}
      {shared && shared.length === 0 ? (
        <p className="empty">No county has shared its declaration figures with you yet.</p>
      ) : null}
      {shared && shared.length > 0 ? (
        <label className="inline">
          Event
          <select
            value={eventId ?? ''}
            onChange={(e) => {
              setView(null);
              setEventId(e.target.value);
            }}
          >
            {shared.map((c) => (
              <optgroup key={c.tenantId} label={c.tenantName}>
                {c.events.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </label>
      ) : null}
      {!view && !error && eventId ? <p role="status">Loading the figures…</p> : null}
      {view ? (
        <>
          <p className="hint">
            {view.county.name}. {view.declaration?.reviewLabel ?? 'Draft for state review'}. Figures
            as of {fmt(view.asOf)}.
          </p>
          <Clock view={view} />
          <Damage view={view} />
          <Profile view={view} />
          <Outages view={view} editable={false} run={noRun} />
          <Casualties view={view} editable={false} run={noRun} />
          <PublicDamage view={view} sites={null} editable={false} run={noRun} />
          <Donated view={view} />
          {j ? (
            <section aria-labelledby="shared-joint">
              <h2 id="shared-joint">Joint damage assessment</h2>
              <dl className="meta">
                <dt>Dates</dt>
                <dd>
                  {j.startsOn
                    ? `${j.startsOn}${j.endsOn && j.endsOn !== j.startsOn ? ` to ${j.endsOn}` : ''}`
                    : 'Not scheduled'}
                </dd>
                <dt>Areas</dt>
                <dd>{j.areas.length ? j.areas.join('; ') : 'Not set'}</dd>
                <dt>Sample</dt>
                <dd>
                  {j.summary.stops
                    ? `${j.summary.stops} stops: ${j.summary.validated} validated, ${j.summary.different} at a different degree, ${j.summary.notSeen} not seen, ${j.summary.pending} not marked yet`
                    : 'No sample drawn yet'}
                </dd>
              </dl>
            </section>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
