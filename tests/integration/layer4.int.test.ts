/**
 * Layer-4 acceptance against the running stack (`docker compose up`, the
 * synthetic WESTWIND seed): Keycloak tokens, the gateway, the API, the
 * worker's timers on its own clock, and the live stream over RabbitMQ.
 *
 * Cases (layer-4 plan §9, stack suite): a field lead checks in by the event
 * code and shares positions that dispatch sees (FLD-03, DSP-08); a help
 * alert reaches a dispatcher's open stream (FLD-16, NFR-07); a field command
 * batch replayed changes nothing and a stale command gets the current record
 * (FLD-13, AC-00B/C); an agency dispatcher sees only their agency's teams
 * (DSP-09); a net-control position lands on the team (DSP-10, FLD-17); a
 * silent team turns overdue on the worker's timer and raises one alert
 * (DSP-07); positions stop at check-out (DSP-08). Requirement IDs are in the
 * test names. The field lead's team is the seed's Field Exercise Team, kept
 * apart from the rosters other suites check.
 */
import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import { api, BASE, sql, token, waitFor } from './support.ts';

const priya = () => token('county', 'priya.assessment@example.org');
const rowan = () => token('county', 'rowan.field@example.org');
const pat = () => token('county', 'pat.netcontrol@example.org');
const cleanupDispatch = () => token('cleanup', 'dispatch.cleanup@example.org');

interface BoardTeam {
  id: string;
  key: string;
  agencyTenantId: string | null;
  status: string;
  position: { lat: number; lon: number } | null;
}
interface Board {
  teams: BoardTeam[];
  alerts: { id: string; kind: string; teamId: string | null }[];
}
interface CommandResult {
  id: string;
  result: 'applied' | 'duplicate' | 'conflict' | 'rejected';
  status: number;
  record: { type: string; id: string; version: number } | null;
  current?: { version?: number };
}

let eventId = '';
let teamId = '';
let checkInId = '';

/** Reads the stream for `ms` and returns its change frames. */
async function streamFor(tok: string, ms: number, during: () => Promise<void>) {
  const reading = fetch(`${BASE}/api/v1/stream?maxMs=${ms}`, {
    headers: { authorization: `Bearer ${tok}`, accept: 'text/event-stream' },
  }).then(async (res) => ({ status: res.status, text: await res.text() }));
  await new Promise((r) => setTimeout(r, 1500));
  await during();
  const { status, text } = await reading;
  const frames = text
    .split('\n\n')
    .filter((f) => /^event: change$/m.test(f))
    .map((f) => JSON.parse(/^data: (.*)$/m.exec(f)![1]!) as Record<string, unknown>);
  return { status, frames };
}

beforeAll(async () => {
  const events = await api(await priya(), '/events');
  expect(events.status, events.text).toBe(200);
  eventId = (events.body as { id: string; name: string }[]).find((e) =>
    e.name.toUpperCase().includes('WESTWIND'),
  )!.id;
  teamId = sql(`select id from cg.team where key = 'field-exercise'`)[0]!;
  expect(teamId).toBeTruthy();
  // A rerun against the same stack starts from a clean shift.
  const open = await api(await rowan(), '/check-ins?mine=true');
  for (const c of open.body as { id: string; endedAt: string | null }[])
    if (!c.endedAt)
      await api(await rowan(), `/check-ins/${c.id}/end`, { body: { reason: 'checked_out' } });
});

describe('layer 4 against the stack', () => {
  it('FLD-03, DSP-08: the field lead checks in by the event code; their positions reach dispatch, not the field', async () => {
    const tok = await rowan();
    const res = await api(tok, '/check-ins', { body: { eventCode: 'westwind', teamId } });
    expect(res.status, res.text).toBe(201);
    checkInId = res.body['id'] as string;
    const sent = await api(tok, '/positions', {
      body: {
        positions: [
          { lat: 38.7952, lon: -90.8711, accuracyM: 7, recordedAt: new Date().toISOString() },
        ],
      },
    });
    expect(sent.status, sent.text).toBe(202);
    const board = await api(await priya(), `/dispatch/board?eventId=${eventId}`);
    expect(board.status, board.text).toBe(200);
    const mine = (board.body as unknown as Board).teams.find((t) => t.id === teamId)!;
    expect(mine.position).not.toBeNull();
    expect(mine.position!.lat).toBeCloseTo(38.7952, 2);
    expect((await api(tok, `/positions/latest?eventId=${eventId}`)).status).toBe(403);
  });

  it('FLD-16, NFR-07: a help alert reaches a dispatcher through the live stream, with the exact position', async () => {
    const clientUuid = randomUUID();
    const field = await rowan();
    let alertId = '';
    const { status, frames } = await streamFor(await priya(), 8000, async () => {
      const raised = await api(field, '/safety-alerts', {
        body: {
          clientUuid,
          position: { lat: 38.79531, lon: -90.87123, accuracyM: 5 },
          note: 'Exercise: help button test',
        },
      });
      expect(raised.status, raised.text).toBe(201);
      alertId = raised.body['id'] as string;
    });
    expect(status).toBe(200);
    expect(
      frames.some((f) => f['recordType'] === 'safety_alert' && f['recordId'] === alertId),
      JSON.stringify(frames.slice(-5)),
    ).toBe(true);
    const open = await api(await priya(), '/safety-alerts?open=true');
    const seen = (
      open.body as unknown as { id: string; position: { lat: number; lon: number } | null }[]
    ).find((a) => a.id === alertId)!;
    expect(seen.position?.lat).toBeCloseTo(38.79531, 5);
    const ack = await api(await priya(), `/safety-alerts/${alertId}/acknowledge`, { body: {} });
    expect(ack.status, ack.text).toBeLessThan(300);
  });

  it('FLD-13, AC-00B, AC-00C: a command batch sent twice applies once; a stale command gets the current record', async () => {
    const staff = await priya();
    const mission = await api(staff, '/missions', {
      idempotencyKey: randomUUID(),
      body: {
        eventId,
        kind: 'outreach_sweep',
        source: 'staff',
        summary: 'Exercise: door hangers, stack suite',
        location: { landmark: 'Harmon community center', state: 'manual' },
      },
    });
    expect(mission.status, mission.text).toBe(201);
    const missionId = mission.body['id'] as string;
    const assigned = await api(staff, `/missions/${missionId}/assignments`, {
      idempotencyKey: randomUUID(),
      body: { resources: [{ kind: 'team', id: teamId }], dispatch: { method: 'app' } },
    });
    expect(assigned.status, assigned.text).toBe(201);
    const [assignmentId, version] = sql(
      `select id || ',' || version from cg.assignment where mission_id = '${missionId}' and team_id = '${teamId}'`,
    )[0]!.split(',');
    const v = Number(version);
    const field = await rowan();
    const batch = {
      commands: [
        {
          id: randomUUID(),
          kind: 'assignment.acknowledge',
          targetId: assignmentId,
          version: v,
          body: { accept: true },
        },
        {
          id: randomUUID(),
          kind: 'position.batch',
          body: {
            positions: [{ lat: 38.7955, lon: -90.8714, recordedAt: new Date().toISOString() }],
          },
        },
      ],
    };
    const first = await api(field, '/field/commands', { body: batch });
    expect(first.status, first.text).toBe(200);
    const r1 = first.body['results'] as unknown as CommandResult[];
    expect(r1.map((r) => r.result)).toEqual(['applied', 'applied']);
    const positions = sql(`select count(*) from cg.position where check_in_id = '${checkInId}'`)[0];
    const again = await api(field, '/field/commands', { body: batch });
    const r2 = again.body['results'] as unknown as CommandResult[];
    expect(r2.map((r) => r.result)).toEqual(['duplicate', 'duplicate']);
    expect(sql(`select count(*) from cg.position where check_in_id = '${checkInId}'`)[0]).toBe(
      positions,
    );
    expect(sql(`select version from cg.assignment where id = '${assignmentId}'`)[0]).toBe(
      String(v + 1),
    );
    const stale = await api(field, '/field/commands', {
      body: {
        commands: [
          {
            id: randomUUID(),
            kind: 'assignment.status',
            targetId: assignmentId,
            version: v,
            body: { to: 'en_route' },
          },
        ],
      },
    });
    const r3 = (stale.body['results'] as unknown as CommandResult[])[0]!;
    expect(r3.result).toBe('conflict');
    expect(r3.status).toBe(409);
    expect(r3.current?.version).toBe(v + 1);
  });

  it('DSP-09, SEC-05: an agency dispatcher sees only their own agency on the board', async () => {
    const board = await api(await cleanupDispatch(), `/dispatch/board?eventId=${eventId}`);
    expect(board.status, board.text).toBe(200);
    const teams = (board.body as unknown as Board).teams;
    const cleanup = sql(`select agency_tenant_id from cg.team where key = 'chainsaw-a'`)[0];
    expect(teams.length).toBeGreaterThan(0);
    expect(teams.every((t) => t.agencyTenantId === cleanup)).toBe(true);
    expect(teams.some((t) => t.id === teamId)).toBe(false);
  });

  it('DSP-10, FLD-17: a position heard on the radio net lands on the team', async () => {
    const res = await api(await pat(), '/comms-log', {
      body: {
        eventId,
        net: 'County ARES',
        kind: 'position_heard',
        fromStation: 'FX-1',
        toStation: 'NET',
        teamId,
        position: { lat: 38.801, lon: -90.861 },
      },
    });
    expect(res.status, res.text).toBe(201);
    expect(res.body['positionRecordedAt']).not.toBeNull();
    const latest = await api(
      await priya(),
      `/positions/latest?eventId=${eventId}&teamId=${teamId}`,
    );
    expect(
      (latest.body as unknown as { source: string }[]).some((p) => p.source === 'net_control'),
    ).toBe(true);
  });

  it('DSP-07: a silent team turns overdue on the worker clock and raises one missed check-in alert; "we are OK" clears it', async () => {
    // The team was last heard two hours ago (its interval is 60 minutes); the worker looks every minute.
    sql(
      `update cg.team_status set created_at = now() - interval '2 hours' where team_id = '${teamId}'`,
    );
    sql(`update cg.check_in set started_at = now() - interval '2 hours' where id = '${checkInId}'`);
    const staff = await priya();
    const alert = await waitFor(async () => {
      const open = await api(staff, '/safety-alerts?open=true');
      const mine = (open.body as unknown as { id: string; kind: string; teamId: string }[]).filter(
        (a) => a.teamId === teamId && a.kind === 'missed_check_in',
      );
      return mine.length ? mine : undefined;
    }, 150_000);
    expect(alert).toHaveLength(1);
    const team = await api(staff, `/teams/${teamId}`);
    expect((team.body['current'] as { status: string; source: string }).status).toBe('overdue');
    const ok = await api(await rowan(), `/teams/${teamId}/status`, {
      body: { status: 'on_task', source: 'app', note: 'Exercise: all well' },
    });
    expect(ok.status, ok.text).toBe(200);
    const after = await api(staff, '/safety-alerts?open=true');
    expect(
      (after.body as unknown as { teamId: string; kind: string }[]).filter(
        (a) => a.teamId === teamId && a.kind === 'missed_check_in',
      ),
    ).toHaveLength(0);
  }, 180_000);

  it('DSP-08: positions stop at check-out', async () => {
    const tok = await rowan();
    const ended = await api(tok, `/check-ins/${checkInId}/end`, {
      body: { reason: 'checked_out' },
    });
    expect(ended.status, ended.text).toBe(200);
    const refused = await api(tok, '/positions', {
      body: { positions: [{ lat: 38.79, lon: -90.87, recordedAt: new Date().toISOString() }] },
    });
    expect(refused.status).toBe(409);
    expect(refused.body['code']).toBe('not_checked_in');
  });
});
