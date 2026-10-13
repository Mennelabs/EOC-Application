/**
 * Layer-3 acceptance against the running stack (`docker compose up`, the
 * synthetic WESTWIND seed). The real chain every time: public API → queue →
 * worker → grants → partner API through the policy engine; the text channel
 * through the simulator; Mailpit for what the worker sends.
 *
 * Cases (plan §9): NED-04/05 and AC-17C sharing end to end with consent
 * withdrawal on the web and by text (NOSHARE); FL-10/FL-11 and AC-17A
 * resident updates with states and referrals with notices; CON-08 overlap
 * warning, NED-07 board actions, the confirmed and audited export, CON-04
 * key counts; PUB-01 a change visible on the web, by text and in the feed
 * within two minutes; PUB-04 next nearest; PUB-03 hidden when unconfirmed;
 * PUB-05 confidential sites absent from every public output; PUB-08
 * `SHELTER 63001`; PUB-10/17 feeds; AC-16A/B/C resources. Requirement IDs
 * are in the test names.
 */
import { describe, expect, it } from 'vitest';
import {
  api,
  filed,
  mailFor,
  next,
  ownHome,
  pub,
  RUN,
  sql,
  submit,
  text,
  token,
  v,
  waitFor,
} from './support.ts';

const priya = () => token('county', 'priya.assessment@example.org');
const luis = () => token('county', 'luis.masscare@example.org');
const tomas = () => token('county', 'tomas.pio@example.org');
const ruth = () => token('canteen', 'ruth.canteen@example.org');
const nurse = () => token('shelter-ngo', 'nurse@example.org');
const jen = () => token('coad', 'jen.coad@example.org');

const DIGITS = String(Date.now() % 10000).padStart(4, '0');
const residentPhone = `+1314556${DIGITS}`;
const residentEmail = `rosa-${RUN}@example.org`;
const bystander = `+1314558${DIGITS}`;

interface SharedView {
  reportId: string;
  referenceCode: string;
  name: string | null;
  contact: { phone?: string; email?: string } | null;
  address: { line1?: string | null } | null;
  area: { city: string | null; postal: string | null } | null;
  householdBand: string | null;
  accessNeeds: string[] | null;
}
interface Need {
  id: string;
  category: string;
  status: string;
  claim: { tenantName: string } | null;
  sharedWith: { name: string }[];
}
interface Msg {
  template: string;
  state: string;
  channel: string;
  deliveredAt: string | null;
}
interface Site {
  name: string;
  status: string;
  distanceKm: number | null;
  nextNearest: { name: string } | null;
}

const activeGrants = (reportId: string) =>
  Number(
    sql(
      `select count(*) from cg.share_grant where report_id = '${reportId}' and revoked_at is null`,
    )[0],
  );

let code: string;
let reportId: string;

describe('sharing through grants (NED-04, AC-17C, SEC-05/06)', () => {
  it('each partner sees the consented report with only its sections; the coordination partner and county staff get nothing through the partner route', async () => {
    const n = next();
    const s = await submit({
      answers: ownHome(n, {
        address: v({ line1: `${n} Share Ln`, city: 'Westwind', postal: '63002' }),
        contact_name: v('Rosa Delgado'),
        contact: v({ phone: residentPhone, email: residentEmail, preferred: 'text' }),
      }),
      needs: ['cleanup_tarp', 'food_water', 'shelter_tonight'],
      consent: { volunteer_cleanup: true, relief_agencies: true },
      afterSubmission: { household_size: v(5), access_needs: v(['mobility']) },
      ownWords: 'The roof is open over the kitchen.',
    });
    code = s.code;
    reportId = await filed(await priya(), code);
    // Cleanup, the canteen, the shelter alliance and legal aid: one grant each (NED-04).
    await waitFor(async () => (activeGrants(reportId) >= 4 ? true : undefined), 60_000);

    const canteen = (await api(await ruth(), '/shared/reports')).body as unknown as SharedView[];
    const feeding = canteen.find((r) => r.reportId === reportId);
    expect(feeding, 'the canteen sees the record').toBeDefined();
    expect(feeding!.referenceCode).toBe(code);
    expect(feeding!.area).toEqual({ city: 'Westwind', postal: '63002' });
    expect(feeding!.householdBand).toBe('5-7');
    expect(feeding!.name).toBeNull();
    expect(feeding!.contact).toBeNull();
    expect(feeding!.address).toBeNull();

    const shelter = await api(await nurse(), `/shared/reports/${reportId}`);
    expect(shelter.status, JSON.stringify(shelter.body)).toBe(200);
    const view = shelter.body as unknown as SharedView;
    expect(view.contact?.phone).toBe(residentPhone);
    expect(view.accessNeeds).toEqual(['mobility']);
    expect(view.address).toBeNull();
    expect(view.name).toBeNull();

    const coad = (await api(await jen(), '/shared/reports')).body as unknown as SharedView[];
    expect(coad.find((r) => r.reportId === reportId)).toBeUndefined();
    expect((await api(await priya(), '/shared/reports')).status).toBe(403);
    expect([403, 404]).toContain((await api(await nurse(), `/reports/${reportId}`)).status);
  }, 180_000);
});

describe('resident updates and referrals (FL-10, FL-11, AC-17A, FR-17.05)', () => {
  it('an update reaches the resident by email with its state recorded and no delivery claimed without evidence; a referral is accepted by the partner after a notice', async () => {
    const l = await luis();
    const sent = await api(l, `/reports/${reportId}/messages`, {
      body: {
        text: 'A cleanup crew is scheduled for Tuesday morning. Reply if that does not suit.',
      },
    });
    expect(sent.status, JSON.stringify(sent.body)).toBe(202);
    expect(sent.body['channel']).toBe('email'); // no text opt-in: email it is
    const row = await waitFor(async () => {
      const rows = (await api(l, `/reports/${reportId}/messages`)).body as unknown as Msg[];
      const m = rows.find((x) => x.template === 'staff_update');
      return m && m.state !== 'queued' ? m : undefined;
    }, 90_000);
    expect(row.state).toBe('sent');
    expect(row.deliveredAt).toBeNull(); // AC-17A: email has no delivery evidence
    expect(await mailFor(residentEmail, 'update', 'Tuesday morning')).toContain('911');

    const canteenId = (await api(await ruth(), '/me')).body['tenantId'] as string;
    const ref = await api(l, '/referrals', {
      body: {
        reportId,
        toTenantId: canteenId,
        purpose: 'Meals for a family of five while the roof is open',
      },
    });
    expect(ref.status, JSON.stringify(ref.body)).toBe(201);
    const refId = ref.body['id'] as string;
    const r = await ruth();
    const inbox = (await api(r, '/referrals?direction=in')).body as unknown as { id: string }[];
    expect(inbox.some((x) => x.id === refId)).toBe(true);
    expect(await mailFor('ruth.canteen@example.org', 'referral', code)).toContain('accept');
    expect(
      [403, 404].includes(
        (await api(await nurse(), `/referrals/${refId}/accept`, { body: { note: 'not ours' } }))
          .status,
      ),
    ).toBe(true);
    const accepted = await api(r, `/referrals/${refId}/accept`, {
      body: { note: 'Canteen delivers from Tuesday' },
    });
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200);
    expect(accepted.body['status']).toBe('accepted');
    const done = await api(r, `/referrals/${refId}/done`, {
      body: { note: 'Delivered through Friday' },
    });
    expect(done.body['status']).toBe('done');
  }, 240_000);
});

describe('needs board (CON-04, CON-08, CON-15, NED-07, AC-17B)', () => {
  it('the county assigns a need to the cleanup partner; the canteen claiming at the same address is warned; a held need conflicts; the export is confirmed and audited; key counts carry an as-of time', async () => {
    const n = next();
    const s = await submit({
      answers: ownHome(n, {
        address: v({ line1: `${n} Board Ct`, city: 'Harmon City', postal: '63003' }),
        contact: v({ phone: `+1314557${DIGITS}`, preferred: 'text' }),
      }),
      needs: ['cleanup_tarp', 'food_water'],
      consent: { volunteer_cleanup: true, relief_agencies: true },
    });
    await filed(await priya(), s.code);
    const l = await luis();
    const needs = await waitFor(async () => {
      const rows = (await api(l, `/needs?reference=${s.code}`)).body as unknown as Need[];
      return rows.length >= 2 ? rows : undefined;
    }, 60_000);
    const tarp = needs.find((x) => x.category === 'cleanup_tarp')!;
    const food = needs.find((x) => x.category === 'food_water')!;
    expect(tarp.sharedWith.map((p) => p.name)).toEqual(
      expect.arrayContaining(['Gateway Cleanup Volunteers', 'Hope Canteen Services']),
    );

    const cleanupId = sql(`select id from cg.tenant where slug = 'cleanup'`)[0]!;
    const assigned = await api(l, `/needs/${tarp.id}/assign`, {
      body: { toTenantId: cleanupId, note: 'Gateway crew on Tuesday' },
    });
    expect(assigned.status, JSON.stringify(assigned.body)).toBe(200);
    expect((assigned.body['need'] as Need).claim?.tenantName).toBe('Gateway Cleanup Volunteers');

    const r = await ruth();
    const claim = await api(r, `/needs/${food.id}/claim`, {
      body: { note: 'Canteen covers Harmon City' },
    });
    expect(claim.status, JSON.stringify(claim.body)).toBe(200);
    expect(claim.body['warnings']).toEqual([
      {
        kind: 'same_address',
        needId: tarp.id,
        category: 'cleanup_tarp',
        claimedByTenantName: 'Gateway Cleanup Volunteers',
      },
    ]);
    expect((await api(r, `/needs/${tarp.id}/claim`, { body: {} })).status).toBe(409);
    const partnerView = (await api(r, `/needs?reference=${s.code}`)).body as unknown as Need[];
    expect(partnerView.map((x) => x.category).sort()).toEqual(['cleanup_tarp', 'food_water']);
    expect(partnerView[0]!.sharedWith).toEqual([]); // the county's partner list is the county's
    const done = await api(r, `/needs/${food.id}/done`, {
      body: { note: 'Meals delivered twice daily' },
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect((done.body['need'] as Need).status).toBe('done');

    expect((await api(l, `/needs.csv?reference=${s.code}`)).status).toBe(428);
    const csv = await api(l, `/needs.csv?reference=${s.code}`, { confirm: 'Weekly VOAD call' });
    expect(csv.status, csv.text).toBe(200);
    expect(csv.headers['content-type']).toContain('text/csv');
    expect(csv.text).toContain(s.code);
    expect(
      Number(sql(`select count(*) from cg.audit_event where action = 'need.export'`)[0]),
    ).toBeGreaterThan(0);
    const counts = await api(l, '/dashboard/counts');
    expect(counts.status).toBe(200);
    expect(counts.body['asOf']).toBeTruthy();
  }, 240_000);
});

describe('consent withdrawal (NED-05, RULE-12)', () => {
  it('withdrawing on the web recalls the relief agencies with a notice; NOSHARE by text recalls the cleanup partner; a stranger learns nothing', async () => {
    await pub('/intake/county/lookup/start', {
      body: { referenceCode: code, contact: residentEmail },
    });
    const otp = (await mailFor(residentEmail, 'one-time code')).match(/\b(\d{6})\b/)?.[1];
    expect(otp).toBeTruthy();
    const verified = await pub('/intake/county/lookup/verify', {
      body: { referenceCode: code, code: otp },
    });
    expect(verified.status, JSON.stringify(verified.body)).toBe(200);
    const resident = { 'x-resident-token': verified.body['token'] as string };
    const me = await pub('/intake/county/me', { headers: resident });
    expect(me.body['consent']).toMatchObject({ relief_agencies: true, volunteer_cleanup: true });

    const before = activeGrants(reportId);
    const withdrawn = await pub('/intake/county/me/consent', {
      method: 'PATCH',
      headers: resident,
      body: { orgType: 'relief_agencies', granted: false },
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    await waitFor(async () => (activeGrants(reportId) < before ? true : undefined), 90_000);
    expect(activeGrants(reportId)).toBe(1); // cleanup keeps its grant
    const canteen = (await api(await ruth(), '/shared/reports')).body as unknown as SharedView[];
    expect(canteen.find((r) => r.reportId === reportId)).toBeUndefined();
    expect((await api(await nurse(), `/shared/reports/${reportId}`)).status).toBe(404);
    expect(await mailFor('ruth.canteen@example.org', 'recalled', code)).toContain('delete');
    expect(await mailFor('nurse@example.org', 'recalled', code)).toContain('delete');

    const stranger = await text(bystander, `NOSHARE ${code}`);
    expect(stranger[0]).toContain('found no report');
    expect(activeGrants(reportId)).toBe(1);
    const reply = await text(residentPhone, `NOSHARE ${code}`);
    expect(reply[0]).toContain('no longer shared');
    await waitFor(async () => (activeGrants(reportId) === 0 ? true : undefined), 90_000);
    // Nobody at the cleanup partner holds a role yet: the notice goes to its security contact.
    expect(await mailFor('security+cleanup@example.org', 'recalled', code)).toContain(
      'Gateway Cleanup Volunteers',
    );
  }, 300_000);
});

describe('public information (PUB-01/03/04/05/08/10/17, AC-16A/B/C)', () => {
  const siteName = `Stack Shelter ${RUN}`;
  let siteId: string;
  let version: number;
  const listed = async (near?: string) =>
    (await pub(`/help/county${near ? `?near=${near}` : ''}`)).body['sites'] as Site[];
  const shelterText = async (zip: string) => (await text(bystander, `SHELTER ${zip}`)).join('\n');

  it('PUB-01/08/10/17: a published site is on the page, in the SHELTER reply and in both feeds within two minutes, and so is every change; PUB-04 a full site names the next nearest; PUB-03 an unconfirmed site is hidden until confirmed', async () => {
    const t = await tomas();
    const created = await api(t, '/sites', {
      body: {
        kind: 'shelter',
        name: siteName,
        slug: `stack-shelter-${RUN}`,
        status: 'open',
        address: { line1: '1 Stack Way', city: 'Willow Bend', postal: '63001' },
        position: { lat: 38.79, lon: -90.905 }, // the 63001 centroid
        hours: { always: true },
        services: ['cots', 'meals'],
        pets: 'no',
        confirmEveryHours: 1,
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    siteId = created.body['id'] as string;
    const published = await api(t, `/sites/${siteId}/publish`, {
      body: {},
      confirm: 'open for the exercise',
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    version = published.body['version'] as number;

    const t0 = Date.now();
    const near = await waitFor(
      async () => ((await listed('63001')).some((s) => s.name === siteName) ? true : undefined),
      120_000,
    );
    expect(near).toBe(true);
    const first = (await listed('63001'))[0]!;
    expect(first.name).toBe(siteName);
    expect(first.distanceKm).toBeLessThan(0.5);
    const reply = await shelterText('63001');
    expect(reply).toContain(siteName);
    expect(reply).toContain('/county/help');
    expect((await pub('/help/county/sites.geojson')).text).toContain(siteName);
    expect((await pub('/help/county/hsds.json')).text).toContain(siteName);
    expect(Date.now() - t0).toBeLessThan(120_000);

    const t1 = Date.now();
    const limited = await api(t, `/sites/${siteId}`, {
      method: 'PATCH',
      body: { status: 'limited' },
      version,
    });
    expect(limited.status, JSON.stringify(limited.body)).toBe(200);
    version = limited.body['version'] as number;
    await waitFor(
      async () =>
        (await listed('63001')).find((s) => s.name === siteName)?.status === 'limited'
          ? true
          : undefined,
      120_000,
    );
    expect(await shelterText('63001')).toMatch(/limited/i);
    expect(Date.now() - t1).toBeLessThan(120_000);

    const full = await api(t, `/sites/${siteId}`, {
      method: 'PATCH',
      body: { status: 'full' },
      version,
    });
    expect(full.status).toBe(200);
    version = full.body['version'] as number;
    const asFull = await waitFor(async () => {
      const s = (await listed('63001')).find((x) => x.name === siteName);
      return s?.status === 'full' ? s : undefined;
    }, 60_000);
    expect(asFull.nextNearest?.name).toBe('Harmon High School gym');

    // PUB-03: the window cannot be waited for, so the clock moves on the row (the suite's one write).
    sql(`update cg.site set last_confirmed_at = now() - interval '2 hours' where id = '${siteId}'`);
    await waitFor(
      async () => ((await listed()).some((s) => s.name === siteName) ? undefined : true),
      60_000,
    );
    expect(await shelterText('63001')).not.toContain(siteName);
    expect((await pub('/help/county/sites.geojson')).text).not.toContain(siteName);
    const staffView = await api(t, `/sites/${siteId}`);
    expect(staffView.body['stale']).toBe(true);
    const confirmed = await api(t, `/sites/${siteId}/confirm`, { body: {} });
    expect(confirmed.status, JSON.stringify(confirmed.body)).toBe(200);
    await waitFor(
      async () => ((await listed()).some((s) => s.name === siteName) ? true : undefined),
      60_000,
    );
  }, 300_000);

  it('PUB-05: a confidential site is never published and appears on no public output; the seeded one is absent too', async () => {
    const t = await tomas();
    const name = `Quiet Harbor ${RUN}`;
    const created = await api(t, '/sites', {
      body: {
        kind: 'shelter',
        name,
        slug: `quiet-harbor-${RUN}`,
        status: 'open',
        confidential: true,
        address: { line1: 'Withheld', city: 'Westwind', postal: '63003' },
        position: { lat: 38.797, lon: -90.86 },
        hours: { always: true },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const refused = await api(t, `/sites/${created.body['id']}/publish`, {
      body: {},
      confirm: 'must be refused',
    });
    expect(refused.status).toBe(400);
    for (const path of [
      '/help/county',
      '/help/county?near=63003',
      '/help/county/sites.geojson',
      '/help/county/hsds.json',
      '/help/county/media?lang=en',
    ]) {
      const res = await pub(path);
      expect(res.status, path).toBe(200);
      expect(res.text, path).not.toContain(name);
      expect(res.text, path).not.toContain('Safe Harbor');
    }
    const reply = await shelterText('63003');
    expect(reply).not.toContain(name);
    expect(reply).not.toContain('Safe Harbor');
  }, 120_000);

  it('AC-16A/B/C: a draft is not public, an expired resource answers 410 with its date, the essential text stays when the outside link is dead, and nothing withdrawn reads as current', async () => {
    const t = await tomas();
    expect((await pub('/help/county/resources/county-help-line?lang=en')).status).toBe(200);
    const expired = await pub('/help/county/resources/boil-water-notice?lang=en');
    expect(expired.status).toBe(410);
    expect(expired.text).toMatch(/expired on \d{4}-\d{2}-\d{2}/i);

    const slug = `stack-guide-${RUN}`;
    const created = await api(t, '/resources', {
      body: {
        slug,
        type: 'guidance',
        category: 'general',
        referenceUrl: 'https://example.invalid/guide.pdf',
        texts: {
          en: {
            title: `Stack guide ${RUN}`,
            summary: 'How to document damage before cleaning up',
            bodyHtml:
              '<h2>Before you clean up</h2><p>Photograph every room before you move anything.</p>',
            humanReviewed: true,
          },
        },
      },
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body['id'] as string;
    expect((await pub(`/help/county/resources/${slug}?lang=en`)).status).toBe(404); // AC-16A
    expect((await api(t, `/resources/${id}`)).status).toBe(200);
    const published = await api(t, `/resources/${id}/publish`, {
      body: {},
      confirm: 'reviewed for the exercise',
    });
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    const page = await pub(`/help/county/resources/${slug}?lang=en`);
    expect(page.status).toBe(200);
    expect(page.text).toContain('Photograph every room');
    const checked = await api(t, `/resources/${id}/check-link`, { body: {} });
    expect(checked.status, JSON.stringify(checked.body)).toBe(200);
    expect(checked.body['linkStatus']).toBe('broken');
    expect((await pub(`/help/county/resources/${slug}?lang=en`)).text).toContain(
      'Photograph every room',
    ); // AC-16C
    const withdrawn = await api(t, `/resources/${id}/unpublish`, {
      body: {},
      confirm: 'exercise over',
    });
    expect(withdrawn.status, JSON.stringify(withdrawn.body)).toBe(200);
    expect((await pub(`/help/county/resources/${slug}?lang=en`)).status).toBe(410); // AC-16B
  }, 120_000);

  it('leaves the public page as the seed made it', async () => {
    const t = await tomas();
    const gone = await api(t, `/sites/${siteId}/unpublish`, { body: {}, confirm: 'exercise over' });
    expect(gone.status, JSON.stringify(gone.body)).toBe(200);
    await waitFor(
      async () => ((await listed()).some((s) => s.name === siteName) ? undefined : true),
      60_000,
    );
  });
});
