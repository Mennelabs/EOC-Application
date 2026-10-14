/**
 * Layer 5 in the console (SEC-12, ADM-05, RULE-14, ADR-0038, GATE-03): the
 * console holds no criminal-justice information and only links to the CJIS
 * enclave. A law-enforcement liaison opens the exercise mission that is
 * linked to the enclave and follows its link to the enclave's own address;
 * links another mission through the confirmation dialog; a field coordinator
 * sees "Restricted: CJIS" and no link. Axe runs on each screen.
 */
import { expect, test } from '@playwright/test';
import { api, expectNoViolations, onboard, token } from './support/console.ts';
import { CJIS_URL } from '../support/cjis.ts';

const EXERCISE_REF = 'WESTWIND-EXERCISE-CJIS-LINK-000000000000100';
const tag = Date.now().toString(36);

interface MissionRow {
  id: string;
  reference: string;
  summary: string | null;
  cjis?: { restricted: true; ref?: string; url?: string } | null;
}

async function exerciseMission(): Promise<MissionRow> {
  const coordinator = await token('county', 'casey.dispatch@example.org');
  const list = await api(coordinator, '/missions?limit=200');
  const row = (list.body as unknown as MissionRow[]).find(
    (m) => m.summary === 'Law-enforcement support at the Commercial Row distribution point',
  );
  expect(row, 'the exercise mission linked to the enclave is seeded').toBeDefined();
  return row!;
}

test.describe('layer 5 console: the CJIS enclave link', () => {
  test('a liaison opens the linked mission in the enclave and links another one', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    const exercise = await exerciseMission();
    await onboard(
      page,
      context,
      'law_enforcement_liaison',
      `Liaison ${tag}`,
      `l5-${testInfo.project.name}`,
    );

    await page.goto(`/console/missions/${exercise.id}`);
    const panel = page.getByRole('region', { name: 'Law enforcement (CJIS)' });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    const link = panel.getByRole('link', { name: 'Open in the CJIS enclave (new tab)' });
    await expect(link).toHaveAttribute(
      'href',
      `${CJIS_URL}/records/${EXERCISE_REF}?mission=${exercise.reference}&county=county`,
    );
    await expect(link).toHaveAttribute('rel', /noreferrer/);
    await expectNoViolations(page);

    // The link lands on the enclave's own address, which asks for its own sign-in.
    const [enclave] = await Promise.all([context.waitForEvent('page'), link.click()]);
    await enclave.waitForLoadState();
    expect(new URL(enclave.url()).origin).toBe(CJIS_URL);
    await expect(enclave.getByRole('heading', { name: 'System use notification' })).toBeVisible();
    await enclave.close();

    // Linking a mission asks for a reason (RULE-14) and answers an enclave link.
    const coordinator = await token('county', 'casey.dispatch@example.org');
    const events = await api(coordinator, '/events');
    const eventId = (events.body as unknown as { id: string; intakeSlug?: string }[])[0]!.id;
    const created = await api(coordinator, '/missions', {
      body: {
        eventId,
        kind: 'other',
        source: 'staff',
        summary: `Law-enforcement support, exercise ${tag}`,
        save: 'draft',
      },
    });
    expect(created.status).toBe(201);
    await page.goto(`/console/missions/${created.body['id'] as string}`);
    await expect(page.getByText('No law-enforcement involvement is linked')).toBeVisible({
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Link to the CJIS enclave' }).click();
    const dialog = page.getByRole('dialog', { name: 'Please confirm' });
    await expect(dialog).toBeVisible();
    await expectNoViolations(page);
    await dialog.getByLabel('Reason').fill('Deputies on scene (exercise)');
    await dialog.getByRole('button', { name: 'Confirm' }).click();
    await expect(page.getByText('Linked to the CJIS enclave')).toBeVisible();
    await expect(
      page.getByRole('link', { name: 'Open in the CJIS enclave (new tab)' }),
    ).toHaveAttribute('href', new RegExp(`^${CJIS_URL}/records/[A-Za-z0-9_-]{43}\\?mission=M-`));
    await expectNoViolations(page);
  });

  test('a field coordinator sees only that the details are restricted', async ({
    page,
    context,
  }, testInfo) => {
    test.setTimeout(240_000);
    const exercise = await exerciseMission();
    await onboard(
      page,
      context,
      'field_coordinator',
      `Coordinator ${tag}`,
      `l5c-${testInfo.project.name}`,
    );
    await page.goto(`/console/missions/${exercise.id}`);
    const panel = page.getByRole('region', { name: 'Law enforcement (CJIS)' });
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByText('Restricted: CJIS.')).toBeVisible();
    await expect(panel.getByRole('link')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Link to the CJIS enclave' })).toHaveCount(0);
    await expectNoViolations(page);
    await page.goto('/console/missions');
    await expect(page.getByRole('cell', { name: 'Restricted: CJIS' }).first()).toBeVisible({
      timeout: 30_000,
    });
    await expectNoViolations(page);
  });
});
