/**
 * Peer support (FL-16): the peer-support role's list of workers who asked,
 * privately, to be reached. Each shows the name, agency, how and when they
 * want to be reached and, for a call or a text, the phone from their roster
 * entry. Nothing else about the request exists: no words, no reason. Marking
 * a request contacted or closed is audited; a closed request is deleted after
 * the county's `peer_support` period. Any other role is refused.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, describeFailure } from '../api/client.ts';
import { DataTable, Status, Toolbar, fmt } from '../ui/primitives.tsx';

interface Request {
  id: string;
  version: number;
  name: string;
  agency: string | null;
  phone: string | null;
  eventName: string | null;
  reachBy: 'call' | 'text' | 'in_person';
  reachWhen: 'now' | 'after_shift';
  status: 'open' | 'contacted' | 'closed';
  requestedAt: string;
  contactedAt: string | null;
}

const REACH_BY: Record<Request['reachBy'], string> = {
  call: 'Phone call',
  text: 'Text message',
  in_person: 'In person',
};
const REACH_WHEN: Record<Request['reachWhen'], string> = {
  now: 'As soon as possible',
  after_shift: 'After their shift',
};

export function PeerSupportScreen() {
  const [rows, setRows] = useState<Request[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const load = useCallback(() => {
    api<Request[]>('/peer-support')
      .then((r) => {
        setRows(r);
        setError(null);
      })
      .catch((e: unknown) => setError(describeFailure(e)));
  }, []);
  useEffect(load, [load]);
  const step = async (r: Request, to: 'contacted' | 'close', done: string) => {
    try {
      await api(`/peer-support/${r.id}/${to}`, { body: {}, version: r.version });
      setMsg(done);
    } catch (e) {
      setError(describeFailure(e));
    }
    load();
  };
  return (
    <section aria-labelledby="peer-h">
      <h1 id="peer-h">Peer support</h1>
      <p>
        Workers who asked, privately, for a peer supporter to reach them. Only the peer support team
        sees this list; their lead, dispatch and coordinators are not told.
      </p>
      {msg ? <Status kind="success">{msg}</Status> : null}
      {error ? <Status kind="error">{error}</Status> : null}
      <Toolbar>
        <button type="button" onClick={load}>
          Refresh
        </button>
      </Toolbar>
      <DataTable
        caption="Open requests, oldest first"
        rows={rows ?? []}
        rowKey={(r) => r.id}
        empty={rows === null && !error ? 'Loading…' : 'Nobody is waiting.'}
        columns={[
          { key: 'n', header: 'Name', render: (r) => r.name },
          { key: 'a', header: 'Agency', render: (r) => r.agency ?? '—' },
          {
            key: 'h',
            header: 'Reach them by',
            render: (r) => `${REACH_BY[r.reachBy]}${r.phone ? `: ${r.phone}` : ''}`,
          },
          { key: 'w', header: 'When', render: (r) => REACH_WHEN[r.reachWhen] },
          { key: 'r', header: 'Asked', render: (r) => fmt(r.requestedAt) },
          {
            key: 's',
            header: 'Status',
            render: (r) =>
              r.status === 'contacted' ? `Contacted ${fmt(r.contactedAt)}` : 'Waiting',
          },
          {
            key: 'x',
            header: 'Action',
            render: (r) => (
              <span style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                {r.status === 'open' ? (
                  <button
                    type="button"
                    onClick={() => void step(r, 'contacted', `Marked ${r.name} as contacted.`)}
                  >
                    Contacted {r.name}
                  </button>
                ) : null}
                <button
                  type="button"
                  onClick={() => void step(r, 'close', `Closed the request from ${r.name}.`)}
                >
                  Close request from {r.name}
                </button>
              </span>
            ),
          },
        ]}
      />
    </section>
  );
}
