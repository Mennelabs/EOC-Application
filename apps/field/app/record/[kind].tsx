/**
 * A frontline role module (layer-4 task J; FL:FR-01, FR-04, FR-05, FR-06,
 * FR-08, FR-09, FR-14, FR-15, FR-19, FR-24, FR-28; FLD-07, FLD-13, FLD-14):
 * the short form described in src/records.ts, photos first where the module
 * takes them, saved on the phone and sent when there is signal. Below the
 * form: what this phone saved for the module (a plain line each, with its
 * sync state), and the next steps that need the server (reopen a road, sign
 * a release, help a resident report).
 */
import * as Linking from 'expo-linking';
import { router, useLocalSearchParams } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import { CheckGroup, ChecklistRow, RadioGroup, Stepper } from '../../src/controls';
import { useField } from '../../src/field';
import { PhotoStrip } from '../../src/photos';
import { commandBody, missing, moduleByKind, type FieldKind } from '../../src/records';
import { SignaturePad } from '../../src/signature';
import {
  Alert,
  Body,
  Button,
  Card,
  Field,
  Heading,
  NavBar,
  Page,
  SyncBadge,
  Toggle,
} from '../../src/ui';

interface Site {
  id: string;
  name: string;
  kind: string;
}
interface Saved {
  id: string;
  kind: string;
  summary: string;
  at: string;
  syncState?: string;
}

function initialValues(fields: FieldKind[]): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.type === 'choice' && f.initial) v[f.key] = f.initial;
    if (f.type === 'number') v[f.key] = f.initial;
    if (f.type === 'multi') v[f.key] = [];
    if (f.type === 'toggle') v[f.key] = false;
    if (f.type === 'checklist') v[f.key] = {};
  }
  return v;
}

export default function RecordScreen() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const f = useField();
  const { t, locale } = f;
  const m = moduleByKind.get(kind ?? '');
  const [values, setValues] = useState<Record<string, unknown>>(() =>
    m ? initialValues(m.fields) : {},
  );
  const [photoIds, setPhotoIds] = useState<string[]>([]);
  const [landmark, setLandmark] = useState('');
  const [saved, setSaved] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [mine, setMine] = useState<Saved[]>([]);
  const [online, setOnline] = useState<Record<string, unknown>[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [formKey, setFormKey] = useState(0);
  useEffect(() => {
    void f.list<Site>('sites').then(setSites);
  }, [f]);
  useEffect(() => {
    void f
      .list<Saved>('role_records')
      .then((r) =>
        setMine(r.filter((x) => x.kind === kind).sort((a, b) => b.at.localeCompare(a.at))),
      );
  }, [f, kind, saved, f.outbox]);
  // Next steps that need the server: the person's own road reports and rights of entry.
  const needsList = kind === 'road_status' || kind === 'right_of_entry';
  useEffect(() => {
    if (!needsList || !m || !f.can(m.readAction)) return;
    const q = f.checkIn?.eventId ? `?eventId=${f.checkIn.eventId}&limit=20` : '?limit=20';
    f.online<Record<string, unknown>[]>(`/field-records/${kind}${q}`)
      .then(setOnline)
      .catch(() => setOnline(null));
  }, [needsList, m, f, kind, saved]);
  const lacking = useMemo(() => (m ? missing(m, values) : []), [m, values]);
  if (!m || !f.can(m.action))
    return (
      <Page title={t('records.unknown')}>
        <Alert tone="warn">{t('records.notAllowed')}</Alert>
        <NavBar current="home" />
      </Page>
    );
  const set = (key: string, v: unknown) => setValues((cur) => ({ ...cur, [key]: v }));
  const save = async () => {
    const body = commandBody(m, values);
    if (m.where && landmark.trim()) body['landmark'] = landmark.trim();
    await f.saveRecord(m.kind, body, m.summary(values, locale), {
      photoIds,
      attachPosition: m.where,
    });
    setSaved(true);
  };
  const again = () => {
    setValues(initialValues(m.fields));
    setPhotoIds([]);
    setLandmark('');
    setSaved(false);
    setFormKey((k) => k + 1);
  };
  const helpReport = async () => {
    if (!f.checkIn?.eventId) return;
    try {
      const links = await f.online<{ kioskUrl: string | null }>(
        `/events/${f.checkIn.eventId}/intake`,
      );
      if (links.kioskUrl) await Linking.openURL(links.kioskUrl);
      else setNotice(t('records.noKiosk'));
    } catch {
      setNotice(t('records.needsSignal'));
    }
  };
  const control = (fk: FieldKind) => {
    const label = fk.label[locale];
    switch (fk.type) {
      case 'choice':
        return (
          <RadioGroup
            key={fk.key}
            label={label}
            options={fk.options.map((o) => ({ value: o.value, label: o.label[locale] }))}
            value={(values[fk.key] as string | undefined) ?? null}
            onChange={(v) => set(fk.key, v)}
          />
        );
      case 'multi':
        return (
          <CheckGroup
            key={fk.key}
            label={label}
            options={fk.options.map((o) => ({ value: o.value, label: o.label[locale] }))}
            value={(values[fk.key] as string[] | undefined) ?? []}
            onChange={(v) => set(fk.key, v)}
          />
        );
      case 'number':
        return (
          <Stepper
            key={fk.key}
            label={label}
            min={fk.min}
            max={fk.max}
            value={(values[fk.key] as number | undefined) ?? fk.initial}
            onChange={(v) => set(fk.key, v)}
          />
        );
      case 'text':
      case 'multiline':
        return (
          <Field
            key={fk.key}
            label={fk.required ? label : label}
            {...(fk.hint ? { hint: fk.hint[locale] } : {})}
            value={(values[fk.key] as string | undefined) ?? ''}
            onChange={(v) => set(fk.key, v.slice(0, fk.max))}
            {...(fk.type === 'multiline' ? { multiline: true } : {})}
          />
        );
      case 'toggle':
        return (
          <Toggle
            key={fk.key}
            label={label}
            value={values[fk.key] === true}
            onChange={(v) => set(fk.key, v)}
          />
        );
      case 'site':
        return sites.length ? (
          <RadioGroup
            key={fk.key}
            label={label}
            options={sites.map((x) => ({ value: x.id, label: x.name }))}
            value={(values[fk.key] as string | undefined) ?? null}
            onChange={(v) => set(fk.key, v)}
          />
        ) : (
          <Body key={fk.key} muted>
            {t('records.noSites')}
          </Body>
        );
      case 'checklist': {
        const answers = (values[fk.key] as Record<string, 'yes' | 'no' | 'na'> | undefined) ?? {};
        return (
          <Card key={fk.key} label={label}>
            <Heading level={3}>{label}</Heading>
            {fk.items.map((it) => (
              <ChecklistRow
                key={it.value}
                label={it.label[locale]}
                value={answers[it.value]}
                onChange={(v) => set(fk.key, { ...answers, [it.value]: v })}
              />
            ))}
          </Card>
        );
      }
      case 'signature':
        return (
          <SignaturePad
            key={`${fk.key}-${formKey}`}
            label={label}
            onChange={(v) => set(fk.key, v)}
          />
        );
    }
  };
  if (saved)
    return (
      <Page title={m.title[locale]}>
        <Alert>{t('records.saved')}</Alert>
        <Button label={t('records.another')} onPress={again} />
        <Button kind="secondary" label={t('nav.home')} onPress={() => router.replace('/home')} />
        <NavBar current="home" />
      </Page>
    );
  return (
    <Page
      title={m.title[locale]}
      actions={
        <Button
          label={t('records.save')}
          disabled={lacking.length > 0}
          onPress={() => void save()}
        />
      }
    >
      <Body>{m.intro[locale]}</Body>
      {lacking.length ? <Body muted>{t('records.needs')}</Body> : null}
      {m.photos ? <PhotoStrip ids={photoIds} onChange={setPhotoIds} /> : null}
      <View key={formKey} style={{ gap: 12 }}>
        {m.fields.map(control)}
      </View>
      {m.where ? (
        <>
          <Body muted>{t('records.where')}</Body>
          <Field
            label={t('assess.landmark')}
            hint={t('assess.landmarkHint')}
            value={landmark}
            onChange={setLandmark}
          />
        </>
      ) : null}
      {kind === 'canvass_visit' && f.can('report.create_assisted') ? (
        <Card label={t('records.helpReport')}>
          <Body>{t('records.helpReportBody')}</Body>
          <Button
            kind="secondary"
            label={t('records.helpReport')}
            onPress={() => void helpReport()}
          />
        </Card>
      ) : null}
      {notice ? <Alert tone="warn">{notice}</Alert> : null}
      {online && online.length ? (
        <Card label={t('records.next')}>
          <Heading level={2}>{t('records.next')}</Heading>
          {online.map((r) => (
            <View key={String(r['id'])} style={{ gap: 4, paddingVertical: 4 }}>
              <Body>
                {kind === 'road_status'
                  ? `${String(r['name'])}: ${String(r['status']).replace(/_/g, ' ')}`
                  : `${String(r['signerRole'])} · ${String(r['scope']).slice(0, 60)}`}
              </Body>
              {kind === 'road_status' && r['status'] !== 'cleared' ? (
                <Button
                  kind="secondary"
                  label={t('records.reopen')}
                  onPress={() =>
                    void f
                      .recordStep('road_status.clear', String(r['id']))
                      .then(() => setNotice(t('records.stepSaved')))
                  }
                />
              ) : null}
              {kind === 'right_of_entry' && !r['releaseSignedAt'] ? (
                <Button
                  kind="secondary"
                  label={t('records.release')}
                  onPress={() =>
                    router.push({ pathname: '/release/[id]', params: { id: String(r['id']) } })
                  }
                />
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}
      {mine.length ? (
        <Card label={t('records.onPhone')}>
          <Heading level={2}>{t('records.onPhone')}</Heading>
          {mine.slice(0, 10).map((x) => (
            <View
              key={x.id}
              style={{ flexDirection: 'row', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
            >
              <Body>{x.summary}</Body>
              <SyncBadge state={x.syncState} />
            </View>
          ))}
        </Card>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}
