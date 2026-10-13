/**
 * Needs done (FLD-12, NED-07): the needs the crew's organization holds, each
 * marked done with a short note (a photo can follow). The list needs a
 * connection; marking done is saved on the phone and sent with the next sync.
 */
import { useEffect, useState } from 'react';
import { useField } from '../src/field';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

interface Need {
  id: string;
  category: string;
  status: string;
  area: { city: string | null; postal: string | null } | null;
  address: { line1: string | null; city: string | null; landmark: string | null } | null;
  referenceCode: string | null;
}

export default function Needs() {
  const f = useField();
  const { t } = f;
  const [needs, setNeeds] = useState<Need[] | null>(null);
  const [offline, setOffline] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [done, setDone] = useState<string[]>([]);
  useEffect(() => {
    // Shown as the server allows (NED-04, CON-15) and never kept on the phone (FLD-14).
    f.online<Need[]>(`/needs?status=claimed&claimedBy=${f.me?.tenantId ?? ''}&limit=50`)
      .then(setNeeds)
      .catch(() => setOffline(true));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);
  return (
    <Page title={t('needs.heading')}>
      {offline ? <Alert tone="warn">{t('needs.offline')}</Alert> : null}
      {needs && needs.length === 0 ? <Body muted>{t('needs.none')}</Body> : null}
      {(needs ?? []).map((n) => (
        <Card key={n.id} label={n.category}>
          <Heading level={3}>{n.category.replace(/_/g, ' ')}</Heading>
          {n.address?.line1 ? (
            <Body>
              {[n.address.line1, n.address.city, n.address.landmark].filter(Boolean).join(', ')}
            </Body>
          ) : n.area ? (
            <Body muted>{[n.area.city, n.area.postal].filter(Boolean).join(' ')}</Body>
          ) : null}
          {done.includes(n.id) ? (
            <Body>✓ {t('needs.markedDone')}</Body>
          ) : open === n.id ? (
            <>
              <Field label={t('needs.note')} value={note} onChange={setNote} />
              <Button
                label={t('needs.done')}
                disabled={note.trim().length < 3}
                onPress={() =>
                  void f.needDone(n.id, note.trim()).then(() => {
                    setDone((d) => [...d, n.id]);
                    setOpen(null);
                    setNote('');
                  })
                }
              />
            </>
          ) : (
            <Button kind="secondary" label={t('needs.markDone')} onPress={() => setOpen(n.id)} />
          )}
        </Card>
      ))}
      <NavBar current="home" />
    </Page>
  );
}
