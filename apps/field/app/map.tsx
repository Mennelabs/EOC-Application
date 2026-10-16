/**
 * Map of the volunteer's area (FLD-13, SCL-13, ADR-0015): the offline map
 * packages of their areas, the lots, their jobs and their own position, drawn
 * with MapLibre from the phone's own files, so it works without a signal. The
 * map is never the only way to a job: the screen says in words what it
 * shows, and the same jobs are listed on Home (FR-00.09, AC-03C).
 */
import { router } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import type { AreaMapJob, Parcel } from '@cg/field-core';
import { AreaMap } from '../src/area-map';
import { useField } from '../src/field';
import { Body, Button, NavBar, Page } from '../src/ui';

export default function MapScreen() {
  const f = useField();
  const { t, maps, assignments, fix } = f;
  const [parcels, setParcels] = useState<Parcel[]>([]);
  useEffect(() => {
    void f.list<Parcel>('parcels').then(setParcels);
    // Read once when the screen opens; the area package changes only on sync.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const jobs = useMemo<AreaMapJob[]>(
    () =>
      assignments.flatMap((a) =>
        a.mission?.location?.position
          ? [{ id: a.id, reference: a.mission.reference, position: a.mission.location.position }]
          : [],
      ),
    [assignments],
  );
  const me = useMemo(() => (fix ? { lat: fix.lat, lon: fix.lon } : null), [fix]);
  const lots = parcels.filter((p) => p.geometry).length;
  return (
    <Page title={t('map.heading')}>
      <Body>{t('map.summary', { jobs: jobs.length, lots })}</Body>
      {maps.length === 0 ? <Body muted>{t('map.noPackage')}</Body> : null}
      <AreaMap
        maps={maps}
        parcels={parcels}
        jobs={jobs}
        me={me}
        label={t('map.label', { jobs: jobs.length })}
      />
      <Body muted>{t('map.attribution')}</Body>
      <Button kind="secondary" label={t('map.back')} onPress={() => router.replace('/home')} />
      <NavBar current="home" />
    </Page>
  );
}
