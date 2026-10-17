/**
 * Reviewer agreement with the AI severity suggestion (layer-7 task I; PHO-13
 * as decided 2026-10-15, Section 19, AIG-09). For each model version (the
 * provider, model and prompt version that made the suggestion), the share of
 * degrees reviewers set that matched the suggestion, overall and by hazard,
 * home type (conventional or manufactured, as the FEMA matrix splits them)
 * and neighbourhood income band (poverty quintile of the report's census
 * tract among the county's tracts). A group with enough decisions whose
 * agreement falls more than the margin below the model's overall agreement is
 * "behind": the administrator is alerted, and the reviewers keep deciding.
 */
import { sql, type Transaction } from 'kysely';
import type { Database } from '@cg/db';
import { currentSnapshot } from './area.ts';

export type AgreementDimension = 'hazard' | 'home_type' | 'income_band';

export interface AgreementRow {
  /** provider / model / prompt version */
  model: string;
  hazard: string | null;
  homeType: 'conventional' | 'manufactured' | null;
  /** 1 = the highest poverty share … 5 = the lowest; null when unknown. */
  incomeBand: number | null;
  agreed: boolean;
}

export interface AgreementSlice {
  dimension: AgreementDimension;
  group: string;
  decisions: number;
  agreed: number;
  rate: number;
  behind: boolean;
}

export interface ModelAgreement {
  model: string;
  decisions: number;
  agreed: number;
  rate: number;
  slices: AgreementSlice[];
}

export interface AgreementSettings {
  /** Decisions a group needs before it can be called behind. */
  minimum: number;
  /** How far below the model's overall agreement a group may fall. */
  margin: number;
}

export const AGREEMENT_DEFAULTS: AgreementSettings = { minimum: 20, margin: 0.1 };

const groupOf = (r: AgreementRow, d: AgreementDimension): string =>
  d === 'hazard'
    ? (r.hazard ?? 'unknown')
    : d === 'home_type'
      ? (r.homeType ?? 'unknown')
      : r.incomeBand === null
        ? 'unknown'
        : `band ${r.incomeBand}`;

export function agreementByModel(
  rows: AgreementRow[],
  settings: AgreementSettings = AGREEMENT_DEFAULTS,
): ModelAgreement[] {
  const byModel = new Map<string, AgreementRow[]>();
  for (const r of rows) byModel.set(r.model, [...(byModel.get(r.model) ?? []), r]);
  return [...byModel]
    .map(([model, rs]) => {
      const agreed = rs.filter((r) => r.agreed).length;
      const rate = agreed / rs.length;
      const slices: AgreementSlice[] = [];
      for (const dimension of ['hazard', 'home_type', 'income_band'] as const) {
        const groups = new Map<string, AgreementRow[]>();
        for (const r of rs) {
          const g = groupOf(r, dimension);
          groups.set(g, [...(groups.get(g) ?? []), r]);
        }
        for (const [group, gs] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
          const ok = gs.filter((r) => r.agreed).length;
          const gr = ok / gs.length;
          slices.push({
            dimension,
            group,
            decisions: gs.length,
            agreed: ok,
            rate: gr,
            // A group exactly on the margin is not behind (1e-9 absorbs 0.8 - 0.1 > 0.7).
            behind:
              group !== 'unknown' &&
              gs.length >= settings.minimum &&
              gr < rate - settings.margin - 1e-9,
          });
        }
      }
      return { model, decisions: rs.length, agreed, rate, slices };
    })
    .sort((a, b) => a.model.localeCompare(b.model));
}

/**
 * The tenant's reviewer decisions on reports that had a suggestion. The
 * suggestion counted is the one the decision names (review_decision.
 * ai_suggestion_id), so a later suggestion never rewrites history.
 */
export async function loadSeverityAgreement(
  trx: Transaction<Database>,
  tenantId: string,
): Promise<AgreementRow[]> {
  const tracts = await currentSnapshot(trx, tenantId, 'tract');
  const profiles = await currentSnapshot(trx, tenantId, 'tract_profile');
  const rows = (
    await sql<{
      provider: string;
      model: string;
      template_version: string | null;
      hazard: string | null;
      home_type: string | null;
      geoid: string | null;
      agreed: boolean;
    }>`
      select s.provider, s.model, s.template_version, e.hazard_type as hazard,
        r.answers->>'home_type' as home_type, g.tract_geoid as geoid, d.agreed_with_ai as agreed
      from cg.review_decision d
      join cg.damage_suggestion s on s.id = d.ai_suggestion_id
      join cg.report r on r.id = d.report_id
      left join cg.event e on e.id = r.event_id
      left join cg.location_geo g on g.location_id = r.location_id
        ${tracts ? sql`and g.tract_snapshot_id = ${tracts.id}::uuid` : sql`and false`}
      where d.tenant_id = ${tenantId}::uuid and d.decision = 'set_degree'
        and d.agreed_with_ai is not null`.execute(trx)
  ).rows;
  // Income bands: poverty quintiles over the county's tracts, as the equity view ranks them.
  const band = new Map<string, number>();
  if (profiles) {
    const ranked = (
      await sql<{ geoid: string; poverty_pct: string | null }>`
        select geoid, poverty_pct from cg.ref_tract_profile
        where snapshot_id = ${profiles.id}::uuid and poverty_pct is not null`.execute(trx)
    ).rows
      .map((p) => ({ geoid: p.geoid, poverty: Number(p.poverty_pct) }))
      .sort((a, b) => b.poverty - a.poverty || a.geoid.localeCompare(b.geoid));
    ranked.forEach((x, i) => band.set(x.geoid, Math.floor((i * 5) / ranked.length) + 1));
  }
  return rows.map((r) => ({
    model: [r.provider, r.model, r.template_version].filter(Boolean).join(' / '),
    hazard: r.hazard,
    homeType: r.home_type
      ? r.home_type === 'mobile_home'
        ? 'manufactured'
        : 'conventional'
      : null,
    incomeBand: r.geoid ? (band.get(r.geoid) ?? null) : null,
    agreed: r.agreed,
  }));
}
