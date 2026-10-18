/**
 * Canteen route (FL:FR-17): check in at a stop, count meals as they go out,
 * then check out with what is left on the truck and an allergen note, and
 * see the next stop on the route. Everything is saved on the phone and sent
 * when there is signal; the check-out names the check-in by the phone's id.
 * The allergen note is about the food (what it contains, how many asked for
 * a special diet), never about who has an allergy. Stops are public places,
 * never a household.
 */
import * as Linking from 'expo-linking';
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { nextStop, routeOf, type Stop } from '../src/canteen';
import { useField, type Mission } from '../src/field';
import { clock } from '../src/format';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

interface Current {
  id: string;
  /** The stop the crew is at, or none. */
  stopId: string | null;
  name: string | null;
  missionId: string | null;
  at: string | null;
  meals: number;
  visited: string[];
}
const EMPTY: Current = {
  id: 'current',
  stopId: null,
  name: null,
  missionId: null,
  at: null,
  meals: 0,
  visited: [],
};

export default function Canteen() {
  const f = useField();
  const { t, locale } = f;
  const [current, setCurrent] = useState<Current>(EMPTY);
  const [route, setRoute] = useState<{ missionId: string | null; stops: Stop[] }>({
    missionId: null,
    stops: [],
  });
  const [stopName, setStopName] = useState('');
  const [supplies, setSupplies] = useState('');
  const [allergens, setAllergens] = useState('');
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    void (async () => {
      const saved = (await f.list<Current>('canteen')).find((c) => c.id === 'current');
      const now = { ...EMPTY, ...saved };
      const r = routeOf(await f.list<Mission & { route?: { stops?: unknown } | null }>('missions'));
      setCurrent(now);
      setRoute(r);
      // The stop name starts as the route's next stop; the crew can change it. A name the
      // crew already typed while the route was loading is kept (functional update).
      if (!now.stopId)
        setStopName((typed) => typed || (nextStop(r.stops, now.visited)?.name ?? ''));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);
  const next = nextStop(route.stops, current.visited);
  const persist = async (c: Current) => {
    setCurrent(c);
    await f.saveDoc('canteen', { ...c });
  };
  const arrive = async () => {
    const name = stopName.trim();
    if (!name) return;
    const stopId = await f.saveRecord(
      'canteen_stop',
      {
        stopName: name,
        arrivedAt: new Date().toISOString(),
        ...(route.missionId ? { missionId: route.missionId } : {}),
      },
      t('canteen.summary', { stop: name }),
      { attachPosition: true },
    );
    await persist({
      ...current,
      stopId,
      name,
      missionId: route.missionId,
      at: new Date().toISOString(),
      meals: 0,
    });
    setMessage(t('canteen.arrived', { stop: name }));
  };
  const meals = async (n: number) => {
    await f.logService('meal', n);
    await persist({ ...current, meals: current.meals + n });
  };
  const leave = async () => {
    if (!current.stopId) return;
    await f.canteenCheckOut(current.stopId, {
      mealsServed: current.meals,
      ...(supplies.trim() ? { suppliesLeft: supplies.trim() } : {}),
      ...(allergens.trim() ? { allergenNote: allergens.trim() } : {}),
    });
    const name = current.name ?? '';
    const visited = name ? [...current.visited, name] : current.visited;
    await persist({ ...EMPTY, visited });
    setSupplies('');
    setAllergens('');
    setStopName(nextStop(route.stops, visited)?.name ?? '');
    setMessage(t('canteen.left', { stop: name, meals: current.meals }));
  };
  const directions = (s: Stop) => {
    if (s.lat === undefined || s.lon === undefined) return;
    void Linking.openURL(
      `geo:${s.lat},${s.lon}?q=${s.lat},${s.lon}(${encodeURIComponent(s.name)})`,
    );
  };
  return (
    <Page title={t('canteen.heading')}>
      <Body>{t('canteen.intro')}</Body>
      {message ? <Alert>{message}</Alert> : null}
      {current.stopId ? (
        <Card label={t('canteen.atStop', { stop: current.name ?? '' })}>
          <Heading level={2}>{t('canteen.atStop', { stop: current.name ?? '' })}</Heading>
          {current.at ? (
            <Body muted>{t('canteen.since', { time: clock(current.at, locale) })}</Body>
          ) : null}
          <Body live>{t('canteen.meals', { n: current.meals })}</Body>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button label={t('canteen.plusOne')} onPress={() => void meals(1)} />
            <Button kind="secondary" label={t('canteen.plusTen')} onPress={() => void meals(10)} />
          </View>
          <Field
            label={t('canteen.supplies')}
            hint={t('canteen.suppliesHint')}
            value={supplies}
            onChange={setSupplies}
            multiline
          />
          <Field
            label={t('canteen.allergens')}
            hint={t('canteen.allergensHint')}
            value={allergens}
            onChange={setAllergens}
            multiline
          />
          <Button label={t('canteen.leave')} onPress={() => void leave()} />
        </Card>
      ) : (
        <Card label={t('canteen.arrive')}>
          <Heading level={2}>{t('canteen.arrive')}</Heading>
          <Field
            label={t('canteen.stopName')}
            hint={t('canteen.stopHint')}
            value={stopName}
            onChange={setStopName}
          />
          <Button
            label={t('canteen.checkIn')}
            disabled={!stopName.trim()}
            onPress={() => void arrive()}
          />
        </Card>
      )}
      <Card label={t('canteen.next')}>
        <Heading level={2}>{t('canteen.next')}</Heading>
        {next ? (
          <>
            <Body>{next.name}</Body>
            {next.lat !== undefined && next.lon !== undefined ? (
              <Button
                kind="secondary"
                label={t('canteen.directions', { stop: next.name })}
                onPress={() => directions(next)}
              />
            ) : null}
          </>
        ) : (
          <Body muted>{route.stops.length ? t('canteen.routeDone') : t('canteen.noRoute')}</Body>
        )}
      </Card>
      <NavBar current="home" />
    </Page>
  );
}
