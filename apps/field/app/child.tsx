/**
 * Child-friendly space (FL:FR-26, plan §12.6): check a child in with the
 * minimum data and no photos; the guardian's pickup code is shown once, to
 * be read aloud and written on the guardian's card. Check-out needs the
 * code, checked by the server; a wrong code is refused and recorded, and the
 * child is not released. Needs signal: nothing about a child is kept on the
 * phone (FLD-14).
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { RadioGroup } from '../src/controls';
import { useField } from '../src/field';
import { problem, useOnline } from '../src/online';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

interface Site {
  id: string;
  name: string;
}
interface Child {
  id: string;
  childName: string | null;
  ageBand: string;
  guardian: { name: string } | null;
  checkedInAt: string;
}
const AGES = ['0-2', '3-5', '6-9', '10-13', '14-17'];

export default function ChildSpace() {
  const f = useField();
  const { t } = f;
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [age, setAge] = useState<string | null>(null);
  const [guardian, setGuardian] = useState('');
  const [phone, setPhone] = useState('');
  const [needs, setNeeds] = useState('');
  const [code, setCode] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn' | 'danger'; text: string } | null>(
    null,
  );
  const [out, setOut] = useState<string | null>(null);
  const [pickup, setPickup] = useState('');
  const [releasedTo, setReleasedTo] = useState('');
  useEffect(() => {
    void f.list<Site>('sites').then((s) => {
      setSites(s);
      if (s.length === 1) setSiteId(s[0]!.id);
    });
  }, [f]);
  const list = useOnline(siteId, () =>
    f.online<Child[]>(`/field-records/child_check_in?siteId=${siteId ?? ''}&open=true`),
  );
  const children = list.data;
  const load = list.reload;
  const checkIn = async () => {
    if (!siteId || !age) return;
    try {
      const r = await f.send<{ pickupCode: string }>('POST', '/field-records/child_check_in', {
        clientUuid: globalThis.crypto.randomUUID(),
        siteId,
        childName: name.trim(),
        ageBand: age,
        guardianName: guardian.trim(),
        ...(phone.trim() ? { guardianPhone: phone.trim() } : {}),
        ...(needs.trim() ? { needs: needs.trim() } : {}),
      });
      setCode(r.pickupCode);
      setName('');
      setAge(null);
      setGuardian('');
      setPhone('');
      setNeeds('');
      setMessage(null);
      void load();
    } catch (err) {
      setMessage({ tone: 'warn', text: problem(err, t) });
    }
  };
  const checkOut = async (id: string) => {
    try {
      await f.send('POST', `/field-records/child_check_in/${id}/check-out`, {
        pickupCode: pickup,
        releasedTo: releasedTo.trim(),
      });
      setMessage({ tone: 'info', text: t('child.released') });
      setOut(null);
      setPickup('');
      setReleasedTo('');
      void load();
    } catch (err) {
      setMessage({ tone: 'danger', text: problem(err, t) });
    }
  };
  return (
    <Page title={t('child.heading')}>
      <Body>{t('child.intro')}</Body>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {list.error ? <Alert tone="warn">{problem(list.error, t)}</Alert> : null}
      {code ? (
        <Card label={t('child.code')}>
          <Heading level={2}>{t('child.code')}</Heading>
          <Body live>{code.split('').join(' ')}</Body>
          <Body>{t('child.codeBody')}</Body>
          <Button kind="secondary" label={t('child.codeDone')} onPress={() => setCode(null)} />
        </Card>
      ) : null}
      <RadioGroup
        label={t('records.site')}
        options={sites.map((s) => ({ value: s.id, label: s.name }))}
        value={siteId}
        onChange={setSiteId}
      />
      <Card label={t('child.in')}>
        <Heading level={2}>{t('child.in')}</Heading>
        <Field label={t('child.name')} value={name} onChange={setName} />
        <RadioGroup
          label={t('child.age')}
          options={AGES.map((a) => ({ value: a, label: a }))}
          value={age}
          onChange={setAge}
        />
        <Field label={t('child.guardian')} value={guardian} onChange={setGuardian} />
        <Field label={t('child.phone')} value={phone} onChange={setPhone} numeric />
        <Field
          label={t('child.needs')}
          hint={t('child.needsHint')}
          value={needs}
          onChange={setNeeds}
          multiline
        />
        <Button
          label={t('child.checkIn')}
          disabled={!siteId || !age || name.trim().length < 1 || guardian.trim().length < 1}
          onPress={() => void checkIn()}
        />
      </Card>
      <Heading level={2}>{t('child.here')}</Heading>
      {children === null ? <Body muted>{t('records.needsSignal')}</Body> : null}
      {children?.length === 0 ? <Body muted>{t('child.none')}</Body> : null}
      {children?.map((c) => (
        <Card key={c.id} label={c.childName ?? ''}>
          <Heading level={3}>{`${c.childName ?? ''} · ${c.ageBand}`}</Heading>
          {out === c.id ? (
            <View style={{ gap: 8 }}>
              <Field
                label={t('child.pickup')}
                value={pickup}
                onChange={setPickup}
                autoComplete="off"
              />
              <Field label={t('child.releasedTo')} value={releasedTo} onChange={setReleasedTo} />
              <Button
                label={t('child.release')}
                disabled={pickup.trim().length < 4 || releasedTo.trim().length < 1}
                onPress={() => void checkOut(c.id)}
              />
            </View>
          ) : (
            <Button kind="secondary" label={t('child.checkOut')} onPress={() => setOut(c.id)} />
          )}
        </Card>
      ))}
      <NavBar current="home" />
    </Page>
  );
}
