/**
 * Layer 5 against the running stack (layer-5 plan §9; SEC-12, SCL-12,
 * PPL-01, ADM-05, SEC-10, SEC-18, ADR-0021, ADR-0038). The platform and the
 * enclave never call each other: the liaison links a mission on the
 * platform, an enclave officer records the criminal-justice details against
 * the same opaque reference in the enclave, and then
 * - the synthetic marker strings appear nowhere in the platform database,
 *   only as ciphertext in the enclave database, and in no service's log;
 * - a token from either side is refused by the other;
 * - phones (field sync) never learn about the link;
 * - the enclave audit holds the reads and writes and its chain verifies.
 * Synthetic data only (SCL-12).
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { CJIS, CJIS_URL, enclaveApi, enclaveToken } from '../support/cjis.ts';
import { api, compose, token, waitFor } from './support.ts';

const MARKER = `ZZCJIMARK${randomBytes(4).toString('hex').toUpperCase()}`;

const liaison = () => token('county', 'liaison@example.org');
const coordinator = () => token('county', 'casey.dispatch@example.org');

/** Rows of a whole database dump that contain the needle (superuser, read-only). */
function dumpContains(service: 'db' | 'cjis-db', database: string, needle: string): boolean {
  const out = compose('exec', '-T', service, 'pg_dump', '-U', 'postgres', '--data-only', database);
  expect(out.length).toBeGreaterThan(1000);
  return out.includes(needle);
}

describe('layer 5: the CJIS enclave beside the platform', () => {
  let missionId = '';
  let reference = '';
  let ref = '';

  it('SEC-12: a liaison links a mission; the platform answers an opaque reference and the enclave address', async () => {
    const staff = await coordinator();
    const events = await api(staff, '/events');
    const eventId = (events.body as unknown as { id: string }[])[0]!.id;
    const created = await api(staff, '/missions', {
      idempotencyKey: randomUUID(),
      body: {
        eventId,
        kind: 'other',
        source: 'staff',
        summary: 'Law-enforcement support at a damaged pharmacy (layer-5 stack case)',
        save: 'draft',
      },
    });
    expect(created.status, created.text).toBe(201);
    missionId = created.body['id'] as string;
    reference = created.body['reference'] as string;
    const linked = await api(await liaison(), `/missions/${missionId}/cji-link`, {
      method: 'POST',
      confirm: 'Deputies requested (stack case)',
    });
    expect(linked.status, linked.text).toBe(200);
    ref = linked.body['ref'] as string;
    expect(ref).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(linked.body['url']).toBe(
      `${CJIS_URL}/records/${ref}?mission=${reference}&county=county`,
    );
    const asReader = await api(staff, `/missions/${missionId}`);
    expect(asReader.body['cjis']).toEqual({ restricted: true });
  });

  it('PPL-01: an enclave officer records the law-enforcement details against the same reference', async () => {
    const officer = await enclaveToken(CJIS.officer);
    const rec = await enclaveApi(officer, '/records', {
      body: {
        ref,
        platformMissionReference: reference,
        platformCounty: 'county',
        origin: 'officer_initiated',
        classification: 'burglary',
        caseNumber: `CASE-${MARKER}`,
        summary: `Stack-case summary ${MARKER}`,
      },
    });
    expect(rec.status, JSON.stringify(rec.body)).toBe(201);
    let version = rec.body['version'] as number;
    const person = await enclaveApi(officer, `/records/${ref}/people`, {
      body: { role: 'arrestee', name: `Stack Person ${MARKER}`, identifiers: `DL-${MARKER}` },
      version,
    });
    expect(person.status).toBe(201);
    version = (person.body['record'] as { version: number }).version;
    const weapon = await enclaveApi(officer, `/records/${ref}/weapons`, {
      body: { kind: 'edged', serialNumber: `SN-${MARKER}`, disposition: 'seized' },
      version,
    });
    expect(weapon.status).toBe(201);
    version = (weapon.body['record'] as { version: number }).version;
    const cam = await enclaveApi(officer, `/records/${ref}/bodycams`, {
      body: { cameraLabel: 'BWC-STACK', evidenceReference: `EV-${MARKER}` },
      version,
    });
    expect(cam.status).toBe(201);
    // Narratives are append-only and take no expected version.
    const narrative = await enclaveApi(officer, `/records/${ref}/narratives`, {
      body: { body: `Stack narrative ${MARKER}` },
    });
    expect(narrative.status).toBe(201);
    version = (narrative.body['record'] as { version: number }).version;
    const disposition = await enclaveApi(officer, `/records/${ref}/disposition`, {
      body: { disposition: 'arrest_made', note: `Booked ${MARKER}` },
      version,
      confirm: 'Stack case arrest',
    });
    expect(disposition.status).toBe(200);
    const read = await enclaveApi(officer, `/records/${ref}`);
    expect(read.body['caseNumber']).toBe(`CASE-${MARKER}`);
    const city = await enclaveApi(await enclaveToken(CJIS.cityOfficer), `/records/${ref}`);
    expect(city.status).toBe(404);
  });

  it('SEC-12: the marker is nowhere in the platform database', () => {
    expect(dumpContains('db', 'cg', MARKER)).toBe(false);
    // Only the opaque reference crossed over (the liaison's link), never a detail.
    expect(dumpContains('db', 'cg', ref)).toBe(true);
  });

  it('SEC-10: the enclave database holds the marker only as ciphertext', () => {
    expect(dumpContains('cjis-db', 'cjis', MARKER)).toBe(false);
    expect(dumpContains('cjis-db', 'cjis', ref)).toBe(true);
  });

  it('no service writes a criminal-justice value to its log', () => {
    const logs = compose(
      'logs',
      '--no-color',
      'api',
      'worker',
      'gateway',
      'cjis-api',
      'cjis-worker',
      'cjis-gateway',
    );
    expect(logs.length).toBeGreaterThan(1000);
    expect(logs).not.toContain(MARKER);
  });

  it('a platform token is refused by the enclave, and an enclave token by the platform', async () => {
    const platform = await liaison();
    const atEnclave = await enclaveApi(platform, '/me');
    expect(atEnclave.status).toBe(401);
    const enclave = await enclaveToken(CJIS.officer);
    const atPlatform = await api(enclave, '/me');
    expect(atPlatform.status).toBe(401);
  });

  it('phones never learn about the link: field sync carries no enclave reference', async () => {
    const field = await token('county', 'rowan.field@example.org');
    const sync = await api(field, '/field/sync');
    expect(sync.status, sync.text).toBe(200);
    expect(sync.text).not.toContain(ref);
    expect(sync.text).not.toContain('WESTWIND-EXERCISE-CJIS-LINK');
    expect(sync.text).not.toMatch(/"cjis"|cji_ref/);
  });

  it('SEC-18: the enclave audit holds the reads and writes, by field name, and its chain verifies', async () => {
    const security = await enclaveToken(CJIS.security);
    const rows = await waitFor(async () => {
      const r = await enclaveApi(security, `/audit?target=${ref}&limit=100`);
      const actions = (r.body as unknown as { action: string }[]).map((x) => x.action);
      return actions.includes('record.disposition')
        ? (r.body as unknown as { action: string; fields: string[]; reason: string | null }[])
        : undefined;
    });
    const actions = rows.map((r) => r.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'record.create',
        'record.read',
        'record.narrative',
        'record.disposition',
      ]),
    );
    expect(JSON.stringify(rows)).not.toContain(MARKER);
    const verified = await enclaveApi(security, '/audit/verify', { method: 'POST' });
    expect(verified.body).toMatchObject({ ok: true });
  });

  it('the exercise link: the seeded mission and the sheriff’s exercise record share one reference', async () => {
    const seeded = await api(await liaison(), '/missions?limit=200');
    const mission = (seeded.body as unknown as { id: string; summary: string | null }[]).find(
      (m) => m.summary === 'Law-enforcement support at the Commercial Row distribution point',
    );
    expect(mission).toBeDefined();
    const detail = await api(await liaison(), `/missions/${mission!.id}`);
    const exerciseRef = (detail.body['cjis'] as { ref: string }).ref;
    const record = await enclaveApi(await enclaveToken(CJIS.officer), `/records/${exerciseRef}`);
    expect(record.status).toBe(200);
    expect(record.body['classification']).toBe('looting');
  });
});
