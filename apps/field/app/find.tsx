/**
 * Find a survivor's record (FL-02). For someone without their reference
 * code: they show it is them before anything is shown, by reading back a code
 * the county texts to their phone, or by recognising a report when the worker
 * reads back only the day it came in and how. The reference code is then
 * shown so the worker can write it on a card for them. Needs signal; nothing
 * is kept on the phone.
 */
import { router } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';
import { RadioGroup } from '../src/controls';
import { codeFrom } from '../src/format';
import { Scanner } from '../src/scanner';
import { useField } from '../src/field';
import type { MessageKey } from '../src/i18n';
import { problem } from '../src/online';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

interface Found {
  reportId: string;
  referenceCode: string;
  submittedAt: string;
  channel: string;
  reviewState: string;
}
interface Candidate {
  reportId: string;
  submittedAt: string;
  channel: string;
}

type Mode = 'code' | 'phone' | 'address';

export default function Find() {
  const f = useField();
  const { t, locale } = f;
  const [mode, setMode] = useState<Mode>(f.can('report.read') ? 'code' : 'phone');
  const [typed, setTyped] = useState('');
  const [phone, setPhone] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);
  const [line1, setLine1] = useState('');
  const [postal, setPostal] = useState('');
  const [name, setName] = useState('');
  const [candidates, setCandidates] = useState<Candidate[] | null>(null);
  const [found, setFound] = useState<Found[] | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const day = (iso: string) =>
    new Date(iso).toLocaleDateString(locale, { weekday: 'long', month: 'long', day: 'numeric' });
  const how = (c: string) => t(`find.channel.${c}` as MessageKey);
  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setMessage(null);
    try {
      await fn();
    } catch (err) {
      setMessage({ tone: 'warn', text: problem(err, t) });
    } finally {
      setBusy(false);
    }
  };

  const byCode = (raw: string) =>
    run(async () => {
      const ref = codeFrom(raw);
      const rows = await f.online<
        {
          id: string;
          referenceCode: string;
          submittedAt: string;
          channelOfOrigin: string;
          reviewState: string;
        }[]
      >(`/reports?limit=5&reference=${encodeURIComponent(ref)}`);
      setFound(
        rows.map((r) => ({
          reportId: r.id,
          referenceCode: r.referenceCode,
          submittedAt: r.submittedAt,
          channel: r.channelOfOrigin,
          reviewState: r.reviewState,
        })),
      );
      if (!rows.length) setMessage({ tone: 'warn', text: t('find.codeUnknown') });
    });
  const text = () =>
    run(async () => {
      await f.send('POST', '/survivor-lookup/phone', { phone: phone.trim() });
      setSent(true);
      setFound(null);
      setMessage({ tone: 'info', text: t('find.sent') });
    });
  const check = () =>
    run(async () => {
      const r = await f.send<{ reports: Found[] }>('POST', '/survivor-lookup/phone/verify', {
        phone: phone.trim(),
        code: code.trim(),
      });
      setFound(r.reports);
      setCode('');
    });
  const search = () =>
    run(async () => {
      const r = await f.send<{ candidates: Candidate[] }>('POST', '/survivor-lookup/address', {
        line1: line1.trim(),
        name: name.trim(),
        ...(postal.trim() ? { postal: postal.trim() } : {}),
      });
      setCandidates(r.candidates);
      setFound(null);
    });
  const confirm = (c: Candidate) =>
    run(async () => {
      const r = await f.send<Found>('POST', '/survivor-lookup/confirm', { reportId: c.reportId });
      setFound([r]);
      setCandidates(null);
    });

  return (
    <Page title={t('find.heading')}>
      <Body>{t('find.intro')}</Body>
      <RadioGroup
        label={t('find.how')}
        value={mode}
        onChange={(v) => {
          setMode(v as Mode);
          setMessage(null);
          setFound(null);
          setCandidates(null);
        }}
        options={[
          ...(f.can('report.read') ? [{ value: 'code', label: t('find.byCode') }] : []),
          { value: 'phone', label: t('find.byPhone') },
          { value: 'address', label: t('find.byAddress') },
        ]}
      />
      {mode === 'code' ? (
        <>
          {/* FL-01: the QR code on their confirmation or card; typing it always works too. */}
          <Scanner onCode={(c) => void byCode(c)} />
          <Field label={t('find.typeCode')} value={typed} onChange={setTyped} autoComplete="off" />
          <Button
            label={t('find.open')}
            disabled={busy || typed.trim().length < 8}
            onPress={() => void byCode(typed)}
          />
        </>
      ) : mode === 'phone' ? (
        <>
          <Field label={t('find.phone')} value={phone} onChange={setPhone} autoComplete="off" />
          <Button
            label={t('find.text')}
            disabled={busy || phone.trim().length < 7}
            onPress={() => void text()}
          />
          {sent ? (
            <>
              <Field
                label={t('find.code')}
                hint={t('find.codeHint')}
                value={code}
                onChange={setCode}
                numeric
                autoComplete="one-time-code"
              />
              <Button
                kind="secondary"
                label={t('find.check')}
                disabled={busy || !/^\d{6}$/.test(code.trim())}
                onPress={() => void check()}
              />
            </>
          ) : null}
        </>
      ) : (
        <>
          <Field label={t('find.street')} value={line1} onChange={setLine1} autoComplete="off" />
          <Field label={t('find.zip')} value={postal} onChange={setPostal} numeric />
          <Field label={t('find.name')} value={name} onChange={setName} autoComplete="off" />
          <Button
            label={t('find.search')}
            disabled={busy || line1.trim().length < 3 || name.trim().length < 2}
            onPress={() => void search()}
          />
        </>
      )}
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {candidates && candidates.length === 0 ? <Body muted>{t('find.none')}</Body> : null}
      {candidates && candidates.length > 0 ? (
        <Card label={t('find.readBack')}>
          <Heading level={2}>{t('find.readBack')}</Heading>
          <Body>{t('find.readBackHint')}</Body>
          {candidates.map((c) => (
            <Button
              key={c.reportId}
              kind="secondary"
              label={t('find.theirs', { day: day(c.submittedAt), how: how(c.channel) })}
              disabled={busy}
              onPress={() => void confirm(c)}
            />
          ))}
        </Card>
      ) : null}
      {found && found.length === 0 ? <Body muted>{t('find.nothingOnPhone')}</Body> : null}
      {found && found.length > 0 ? (
        <Card label={t('find.found')}>
          <Heading level={2}>{t('find.found')}</Heading>
          {found.map((r) => (
            <View key={r.reportId} style={{ gap: 6 }}>
              <Body>
                {t('find.code.is', {
                  code: r.referenceCode,
                  day: day(r.submittedAt),
                  how: how(r.channel),
                })}
              </Body>
              {f.can('document.capture') ? (
                // FL-09: a document they choose to share goes straight into this record.
                <Button
                  kind="secondary"
                  label={t('find.addDocument')}
                  onPress={() =>
                    router.push({
                      pathname: '/document',
                      params: { reportId: r.reportId, code: r.referenceCode },
                    })
                  }
                />
              ) : null}
            </View>
          ))}
          <Body muted>{t('find.giveCard')}</Body>
        </Card>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}
