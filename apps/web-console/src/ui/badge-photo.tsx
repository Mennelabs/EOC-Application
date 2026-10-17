/**
 * Badge photos (BRD:FR-13.01, FR-13.04): a person's approved photo, a
 * pending one waiting for approval, and the steps the viewer's role allows:
 * take or upload a photo (a phone opens its camera), or approve or reject
 * one someone else took. Images come through the API with the session, never
 * from a storage link; each has a text alternative naming the person.
 */
import { useCallback, useEffect, useState } from 'react';
import { api, describeFailure, fetchBlob, upload } from '../api/client.ts';
import { Status } from './primitives.tsx';

interface PhotoStatus {
  approved: boolean;
  approvedAt: string | null;
  pending: boolean;
  pendingAt: string | null;
}

/** An image the API serves, as an object URL released when it is replaced or the page closes. */
export function useImage(path: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!path) return;
    let live = true;
    let made: string | null = null;
    fetchBlob(path)
      .then((b) => {
        if (!live) return;
        made = URL.createObjectURL(b);
        setUrl(made);
      })
      .catch(() => live && setUrl(null));
    return () => {
      live = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [path]);
  return path ? url : null;
}

export function BadgePhoto({ personnelId, name }: { personnelId: string; name: string }) {
  const [status, setStatus] = useState<PhotoStatus | null>(null);
  const [actions, setActions] = useState<string[]>([]);
  const [msg, setMsg] = useState<{ kind: 'success' | 'error'; text: string } | null>(null);
  const [tick, setTick] = useState(0);
  const reload = useCallback(() => setTick((n) => n + 1), []);
  useEffect(() => {
    let live = true;
    Promise.all([
      api<PhotoStatus>(`/personnel/${personnelId}/photo/status`),
      api<{ actions: string[] }>('/me'),
    ])
      .then(([s, me]) => {
        if (!live) return;
        setStatus(s);
        setActions(me.actions);
      })
      .catch((e: unknown) => live && setMsg({ kind: 'error', text: describeFailure(e) }));
    return () => {
      live = false;
    };
  }, [personnelId, tick]);
  const canTake = actions.includes('personnel.photo');
  const canApprove = actions.includes('personnel.photo.approve');
  const approved = useImage(status?.approved ? `/personnel/${personnelId}/photo?t=${tick}` : null);
  const pending = useImage(
    status?.pending && (canTake || canApprove)
      ? `/personnel/${personnelId}/photo?which=pending&t=${tick}`
      : null,
  );
  const send = async (file: File | undefined) => {
    if (!file) return;
    try {
      await upload(`/personnel/${personnelId}/photo`, file, file.type || 'image/jpeg');
      setMsg({ kind: 'success', text: 'Photo saved. It waits for a second person to approve it.' });
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
    reload();
  };
  const decide = async (decision: 'approve' | 'reject') => {
    try {
      await api(`/personnel/${personnelId}/photo/decision`, { body: { decision } });
      setMsg({
        kind: 'success',
        text: decision === 'approve' ? 'Photo approved for badges.' : 'Photo rejected and deleted.',
      });
    } catch (e) {
      setMsg({ kind: 'error', text: describeFailure(e) });
    }
    reload();
  };
  return (
    <section aria-labelledby={`photo-h-${personnelId}`}>
      <h3 id={`photo-h-${personnelId}`}>Badge photo</h3>
      {msg ? <Status kind={msg.kind}>{msg.text}</Status> : null}
      {status === null ? null : status.approved ? (
        approved ? (
          <img src={approved} alt={`Badge photo of ${name}`} width={120} />
        ) : (
          <p className="hint">Approved photo on file.</p>
        )
      ) : (
        <p className="hint">No approved photo yet.</p>
      )}
      {status?.pending ? (
        <div>
          <p>A new photo waits for a second person to approve it.</p>
          {pending ? (
            <img src={pending} alt={`Photo of ${name} waiting for approval`} width={120} />
          ) : null}
          {canApprove ? (
            <div className="actions" style={{ justifyContent: 'flex-start' }}>
              <button type="button" onClick={() => void decide('approve')}>
                Approve photo of {name}
              </button>
              <button type="button" onClick={() => void decide('reject')}>
                Reject photo of {name}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
      {canTake ? (
        <label>
          Take or upload a badge photo
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="user"
            onChange={(e) => void send(e.target.files?.[0])}
          />
        </label>
      ) : null}
    </section>
  );
}
