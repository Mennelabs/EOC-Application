/**
 * National Weather Service active alerts (ADR-0039; event context and the
 * incident-period suggestion): watches, warnings and advisories for the
 * tenant's county zones (state abbreviation, "C", county code). Free; NWS
 * asks for a contact in the User-Agent (REFDATA_CONTACT). Refreshed often,
 * so each pull is a small snapshot.
 * https://www.weather.gov/documentation/services-web-api
 */
import type { Connector } from '../connector.ts';
import type { RawRow } from '../datasets.ts';
import { stateAbbr } from '../states.ts';

const HOST = 'api.weather.gov';

interface AlertFeature {
  geometry?: unknown;
  properties?: Record<string, unknown> | null;
}

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function alertRow(f: AlertFeature): RawRow {
  const p = f.properties ?? {};
  return {
    alertId: str(p['id']) ?? '',
    event: str(p['event']) ?? '',
    severity: str(p['severity']),
    urgency: str(p['urgency']),
    headline: str(p['headline']),
    areaDescription: str(p['areaDesc']),
    effective: str(p['effective']),
    expires: str(p['ends']) ?? str(p['expires']),
    geometry: f.geometry ?? null,
  };
}

export const nwsAlerts: Connector = {
  id: 'nws.alerts.active',
  dataset: 'alert',
  title: 'Active weather alerts (National Weather Service)',
  licence: 'U.S. government work (NOAA/NWS)',
  hosts: [HOST],
  refreshMs: 30 * 60_000,
  async fetch({ http, scope }) {
    const abbr = stateAbbr(scope.stateFips);
    const u = new URL(`https://${HOST}/alerts/active`);
    u.searchParams.set('zone', scope.countyFips.map((c) => `${abbr}C${c.slice(2)}`).join(','));
    const body = (await http.getJson(u.toString())) as { features?: AlertFeature[] };
    return { vintage: null, sourceUrl: u.toString(), rows: (body.features ?? []).map(alertRow) };
  },
};
