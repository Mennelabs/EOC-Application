/**
 * Partner counts: roll up all, or choose (decided 2026-10-15; DCL:DEC-09,
 * F15, RULE-10). One checkbox, ticked by default; unticked, the county
 * chooses the partner organizations and the categories the figures include.
 * Used on the declaration view and on each official report while it is a
 * draft; the server states what the figures include.
 */
import { useState, type FormEvent } from 'react';

export type PartnerCategory = 'needs_met' | 'services' | 'sheltered' | 'teams' | 'donated';

export const PARTNER_CATEGORIES: { key: PartnerCategory; label: string }[] = [
  { key: 'needs_met', label: 'Households helped (needs met)' },
  { key: 'services', label: 'Meals and other services served' },
  { key: 'sheltered', label: 'People and households sheltered' },
  { key: 'teams', label: 'Teams checked in' },
  { key: 'donated', label: 'Donated equipment and hours' },
];

export type PartnerRollup =
  { all: true } | { all: false; partners: string[]; categories: PartnerCategory[] };

/** The choice as the API returns it (partners and categories present only when chosen). */
export interface RollupValue {
  all: boolean;
  partners?: string[];
  categories?: string[];
}

export function PartnerRollupChooser({
  id,
  value,
  organizations,
  statement,
  editable,
  onSave,
}: {
  id: string;
  value: RollupValue;
  organizations: { id: string; organization: string }[];
  statement: string | null;
  editable: boolean;
  onSave: (rollup: PartnerRollup) => Promise<boolean>;
}) {
  const [all, setAll] = useState(value.all);
  const [partners, setPartners] = useState<string[]>(
    value.all ? organizations.map((o) => o.id) : (value.partners ?? []),
  );
  const [categories, setCategories] = useState<PartnerCategory[]>(
    value.all
      ? PARTNER_CATEGORIES.map((c) => c.key)
      : ((value.categories ?? []) as PartnerCategory[]),
  );
  const [busy, setBusy] = useState(false);
  const toggle = <T,>(list: T[], item: T, on: boolean) =>
    on ? [...new Set([...list, item])] : list.filter((x) => x !== item);

  const save = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    await onSave(all ? { all: true } : { all: false, partners, categories });
    setBusy(false);
  };

  if (!editable)
    return statement ? (
      <p className="hint" id={`${id}-statement`}>
        {statement}
      </p>
    ) : null;
  return (
    <form onSubmit={save} aria-labelledby={`${id}-legend`}>
      <fieldset>
        <legend id={`${id}-legend`}>Partner counts</legend>
        {statement ? <p className="hint">{statement}</p> : null}
        <label className="inline" style={{ flexDirection: 'row', alignItems: 'center' }}>
          <input type="checkbox" checked={all} onChange={(e) => setAll(e.target.checked)} /> Roll up
          all partner counts
        </label>
        {all ? null : (
          <>
            <fieldset>
              <legend>Organizations included</legend>
              {organizations.length === 0 ? (
                <p>This county has no partner organizations.</p>
              ) : (
                organizations.map((o) => (
                  <label
                    key={o.id}
                    className="inline"
                    style={{ flexDirection: 'row', alignItems: 'center' }}
                  >
                    <input
                      type="checkbox"
                      checked={partners.includes(o.id)}
                      onChange={(e) => setPartners(toggle(partners, o.id, e.target.checked))}
                    />{' '}
                    {o.organization}
                  </label>
                ))
              )}
            </fieldset>
            <fieldset>
              <legend>Counts included</legend>
              {PARTNER_CATEGORIES.map((c) => (
                <label
                  key={c.key}
                  className="inline"
                  style={{ flexDirection: 'row', alignItems: 'center' }}
                >
                  <input
                    type="checkbox"
                    checked={categories.includes(c.key)}
                    onChange={(e) => setCategories(toggle(categories, c.key, e.target.checked))}
                  />{' '}
                  {c.label}
                </label>
              ))}
            </fieldset>
          </>
        )}
        <div className="actions">
          <button type="submit" disabled={busy}>
            Save the partner counts choice
          </button>
        </div>
      </fieldset>
    </form>
  );
}
