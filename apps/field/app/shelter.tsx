/**
 * The shelter door (CON-16, FL:FR-14): register a household with its cots,
 * needs and pets, and hand over a wristband code; find a guest by that code
 * and check them out; see the census from the stays still open. Access needs
 * are restricted to the roles that may see them. Needs signal: the household
 * is never kept on the phone (FLD-14).
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { RadioGroup, Stepper } from '../src/controls';
import { useField } from '../src/field';
import { problem, useOnline } from '../src/online';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

interface Site {
  id: string;
  name: string;
}
interface Stay {
  id: string;
  householdName: string | null;
  householdSize: number;
  cots: string[];
  accessNeeds: string | null;
  checkedOutAt: string | null;
}
interface Census {
  households: number;
  people: number;
  children: number;
  pets: number;
  cotsInUse: string[];
}

export default function Shelter() {
  const f = useField();
  const { t } = f;
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [message, setMessage] = useState<{ tone: 'info' | 'warn'; text: string } | null>(null);
  const [band, setBand] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [adults, setAdults] = useState(1);
  const [children, setChildren] = useState(0);
  const [pets, setPets] = useState(0);
  const [cots, setCots] = useState('');
  const [diet, setDiet] = useState('');
  const [access, setAccess] = useState('');
  const [code, setCode] = useState('');
  const [found, setFound] = useState<Stay | null>(null);
  useEffect(() => {
    void f.list<Site>('sites').then((s) => {
      setSites(s);
      if (s.length === 1) setSiteId(s[0]!.id);
    });
  }, [f]);
  const censusQuery = useOnline(siteId, () =>
    f.online<Census>(`/field-records/shelter_stay/census?siteId=${siteId ?? ''}`),
  );
  const census = censusQuery.data;
  const loadCensus = censusQuery.reload;
  const register = async () => {
    if (!siteId) return;
    try {
      const r = await f.send<{ wristbandCode: string }>('POST', '/field-records/shelter_stay', {
        clientUuid: globalThis.crypto.randomUUID(),
        siteId,
        householdSize: adults + children,
        adults,
        children,
        pets,
        cots: cots
          .split(/[,\s]+/)
          .map((c) => c.trim())
          .filter(Boolean),
        ...(name.trim() ? { householdName: name.trim() } : {}),
        ...(diet.trim() ? { dietaryNeeds: diet.trim() } : {}),
        ...(access.trim() ? { accessNeeds: access.trim() } : {}),
        ...(f.checkIn?.eventId ? { eventId: f.checkIn.eventId } : {}),
      });
      setBand(r.wristbandCode);
      setName('');
      setAdults(1);
      setChildren(0);
      setPets(0);
      setCots('');
      setDiet('');
      setAccess('');
      setMessage(null);
      void loadCensus();
    } catch (err) {
      setMessage({ tone: 'warn', text: problem(err, t) });
    }
  };
  const lookup = async () => {
    try {
      setFound(
        await f.send<Stay>('POST', '/field-records/shelter_stay/lookup', {
          code: code.trim(),
          ...(siteId ? { siteId } : {}),
        }),
      );
      setMessage(null);
    } catch (err) {
      setFound(null);
      setMessage({ tone: 'warn', text: problem(err, t) });
    }
  };
  const checkOut = async () => {
    if (!found) return;
    try {
      await f.send('POST', `/field-records/shelter_stay/${found.id}/check-out`, {});
      setMessage({ tone: 'info', text: t('shelter.checkedOut') });
      setFound(null);
      setCode('');
      void loadCensus();
    } catch (err) {
      setMessage({ tone: 'warn', text: problem(err, t) });
    }
  };
  return (
    <Page title={t('shelter.heading')}>
      {message ? <Alert tone={message.tone}>{message.text}</Alert> : null}
      {censusQuery.error ? <Alert tone="warn">{problem(censusQuery.error, t)}</Alert> : null}
      <RadioGroup
        label={t('records.site')}
        options={sites.map((s) => ({ value: s.id, label: s.name }))}
        value={siteId}
        onChange={setSiteId}
      />
      {census ? (
        <Card label={t('shelter.census')}>
          <Heading level={2}>{t('shelter.census')}</Heading>
          <Body live>
            {t('shelter.censusLine', {
              households: census.households,
              people: census.people,
              children: census.children,
              pets: census.pets,
              cots: census.cotsInUse.length,
            })}
          </Body>
        </Card>
      ) : null}
      {band ? (
        <Card label={t('shelter.band')}>
          <Heading level={2}>{t('shelter.band')}</Heading>
          <Body live>{band.split('').join(' ')}</Body>
          <Body>{t('shelter.bandBody')}</Body>
          <Button kind="secondary" label={t('child.codeDone')} onPress={() => setBand(null)} />
        </Card>
      ) : null}
      <Card label={t('shelter.register')}>
        <Heading level={2}>{t('shelter.register')}</Heading>
        <Field
          label={t('shelter.name')}
          hint={t('shelter.nameHint')}
          value={name}
          onChange={setName}
        />
        <Stepper label={t('shelter.adults')} min={0} max={30} value={adults} onChange={setAdults} />
        <Stepper
          label={t('shelter.children')}
          min={0}
          max={30}
          value={children}
          onChange={setChildren}
        />
        <Stepper label={t('shelter.pets')} min={0} max={20} value={pets} onChange={setPets} />
        <Field
          label={t('shelter.cots')}
          hint={t('shelter.cotsHint')}
          value={cots}
          onChange={setCots}
        />
        <Field label={t('shelter.diet')} value={diet} onChange={setDiet} />
        {f.can('shelter_stay.write') ? (
          <Field
            label={t('shelter.access')}
            hint={t('shelter.accessHint')}
            value={access}
            onChange={setAccess}
            multiline
          />
        ) : null}
        <Button
          label={t('shelter.registerButton')}
          disabled={!siteId || adults + children < 1}
          onPress={() => void register()}
        />
      </Card>
      <Card label={t('shelter.door')}>
        <Heading level={2}>{t('shelter.door')}</Heading>
        <Field label={t('shelter.code')} value={code} onChange={setCode} autoComplete="off" />
        <Button
          kind="secondary"
          label={t('shelter.find')}
          disabled={code.trim().length < 4}
          onPress={() => void lookup()}
        />
        {found ? (
          <View style={{ gap: 6 }}>
            <Body>
              {t('shelter.foundLine', {
                name: found.householdName ?? t('shelter.noName'),
                size: found.householdSize,
                cots: found.cots.join(', ') || '—',
              })}
            </Body>
            {found.accessNeeds ? (
              <Body>{t('shelter.accessShown', { needs: found.accessNeeds })}</Body>
            ) : null}
            {found.checkedOutAt ? (
              <Body muted>{t('shelter.alreadyOut')}</Body>
            ) : (
              <Button label={t('shelter.checkOut')} onPress={() => void checkOut()} />
            )}
          </View>
        ) : null}
      </Card>
      <NavBar current="home" />
    </Page>
  );
}
