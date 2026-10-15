/**
 * The damage classifier's evaluation with fairness slices (AIG-08, PHO-12,
 * PHO-13). An operator supplies a labelled photo set: a manifest of cases,
 * each with its photos, the FEMA degree a credentialed assessor gave, and the
 * hazard, home type and neighbourhood income band. The set is licensed or
 * synthetic and lives outside the repository (SCL-12); nothing here stores a
 * photo. Each case goes to the classifier in force (OpenAI's vision model for
 * now, a validated model later) exactly as the worker sends it, and the report
 * gives accuracy overall and per group. It fails when a group with enough
 * cases is materially less accurate than the whole (PHO-13: more than the
 * margin below), or when overall accuracy fell against a saved baseline
 * (AIG-08: release blocks on regression).
 */
import type { DamageClassifier, DamageDegree } from '../types.ts';

export type LabelledDegree = Exclude<DamageDegree, 'cannot_tell'>;
const DEGREES: readonly LabelledDegree[] = ['affected', 'minor', 'major', 'destroyed'];
const RANK: Record<DamageDegree, number> = {
  affected: 1,
  minor: 2,
  major: 3,
  destroyed: 4,
  cannot_tell: 0,
};

export interface PhotoCase {
  id: string;
  /** Paths relative to the manifest, or whatever the loader understands. */
  files: string[];
  /** The degree a credentialed assessor gave from the FEMA matrix. */
  degree: LabelledDegree;
  hazard: string | null;
  homeType: 'conventional' | 'manufactured' | null;
  /** The home type as the intake answer gives it, which is what the classifier is told. */
  homeTypeAnswer: string | null;
  incomeBand: string | null;
}

export interface PhotoSlice {
  dimension: 'hazard' | 'home_type' | 'income_band';
  group: string;
  cases: number;
  exact: number;
  rate: number;
  behind: boolean;
}

export interface PhotoEvaluation {
  model: string;
  cases: number;
  /** Cases the classifier could not answer (error, timeout, refusal). */
  failed: number;
  exact: number;
  /** Suggested the assessor's degree. */
  exactRate: number;
  /** Within one degree of it. */
  withinOneRate: number;
  /** Said "cannot tell". */
  cannotTellRate: number;
  /** confusion[assessor][suggested] */
  confusion: Record<string, Record<string, number>>;
  slices: PhotoSlice[];
  settings: PhotoSettings;
  regression: string | null;
  passed: boolean;
  problems: string[];
}

export interface PhotoSettings {
  /** Cases a group needs before it can be called behind. */
  minimum: number;
  /** How far below overall accuracy a group may fall (PHO-13 "materially"). */
  margin: number;
  /** How far overall accuracy may fall against the baseline (AIG-08). */
  regression: number;
}

/** Planning defaults, the same as the production agreement alerts (plan reading 17). */
export const PHOTO_DEFAULTS: PhotoSettings = { minimum: 20, margin: 0.1, regression: 0.02 };

/**
 * Reads the manifest: a CSV with a header row and the columns
 * case,file,degree,hazard,home_type,income_band; several rows with the same
 * case are one case with several photos (the worker sends up to four).
 */
export function parsePhotoManifest(csv: string): PhotoCase[] {
  const rows = csv
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
  const head = (rows.shift() ?? '').split(',').map((h) => h.trim().toLowerCase());
  const col = (name: string) => {
    const i = head.indexOf(name);
    if (i < 0 && (name === 'case' || name === 'file' || name === 'degree'))
      throw new Error(`the manifest needs a "${name}" column`);
    return i;
  };
  const [ci, fi, di, hi, ti, bi] = [
    col('case'),
    col('file'),
    col('degree'),
    col('hazard'),
    col('home_type'),
    col('income_band'),
  ];
  const cases = new Map<string, PhotoCase>();
  rows.forEach((line, n) => {
    const cells = line.split(',').map((c) => c.trim());
    const at = (i: number) => (i >= 0 && cells[i] ? cells[i]! : null);
    const id = at(ci);
    const file = at(fi);
    const degree = at(di) as LabelledDegree | null;
    if (!id || !file) throw new Error(`row ${n + 2}: a case and a file are needed`);
    if (!degree || !DEGREES.includes(degree))
      throw new Error(`row ${n + 2}: degree must be one of ${DEGREES.join(', ')}`);
    const homeRaw = at(ti);
    const homeType =
      homeRaw === null
        ? null
        : homeRaw === 'manufactured' || homeRaw === 'mobile_home'
          ? 'manufactured'
          : 'conventional';
    const existing = cases.get(id);
    if (existing) {
      if (existing.degree !== degree)
        throw new Error(`row ${n + 2}: case ${id} has two different degrees`);
      existing.files.push(file);
      return;
    }
    cases.set(id, {
      id,
      files: [file],
      degree,
      hazard: at(hi),
      homeType,
      homeTypeAnswer: homeRaw,
      incomeBand: at(bi),
    });
  });
  return [...cases.values()];
}

interface Outcome {
  c: PhotoCase;
  suggested: DamageDegree | null;
}

const groupOf = (c: PhotoCase, d: PhotoSlice['dimension']) =>
  (d === 'hazard' ? c.hazard : d === 'home_type' ? c.homeType : c.incomeBand) ?? 'unknown';

/** Runs every case through the classifier, one at a time, and scores it. */
export async function evaluatePhotos(
  classifier: DamageClassifier,
  model: string,
  cases: PhotoCase[],
  load: (file: string) => Promise<{ data: Buffer; mimeType: string }>,
  settings: PhotoSettings = PHOTO_DEFAULTS,
  baseline?: { exactRate: number } | null,
): Promise<PhotoEvaluation> {
  const outcomes: Outcome[] = [];
  for (const c of cases) {
    try {
      const images = await Promise.all(c.files.slice(0, 4).map(load));
      const out = await classifier.classify(images, {
        ...(c.homeTypeAnswer ? { homeType: c.homeTypeAnswer } : {}),
        ...(c.hazard ? { hazard: c.hazard } : {}),
      });
      outcomes.push({ c, suggested: out.output.degree });
    } catch {
      outcomes.push({ c, suggested: null });
    }
  }
  return scorePhotos(model, outcomes, settings, baseline ?? null);
}

/** The scoring alone, so it can be tested without a classifier. */
export function scorePhotos(
  model: string,
  outcomes: { c: PhotoCase; suggested: DamageDegree | null }[],
  settings: PhotoSettings = PHOTO_DEFAULTS,
  baseline: { exactRate: number } | null = null,
): PhotoEvaluation {
  const n = outcomes.length;
  const right = (o: Outcome) => o.suggested === o.c.degree;
  const exact = outcomes.filter(right).length;
  const exactRate = n ? exact / n : 0;
  const withinOne = outcomes.filter(
    (o) =>
      o.suggested &&
      o.suggested !== 'cannot_tell' &&
      Math.abs(RANK[o.suggested] - RANK[o.c.degree]) <= 1,
  ).length;
  const cannotTell = outcomes.filter((o) => o.suggested === 'cannot_tell').length;
  const confusion: Record<string, Record<string, number>> = {};
  for (const o of outcomes) {
    const row = (confusion[o.c.degree] ??= {});
    const k = o.suggested ?? 'failed';
    row[k] = (row[k] ?? 0) + 1;
  }
  const slices: PhotoSlice[] = [];
  for (const dimension of ['hazard', 'home_type', 'income_band'] as const) {
    const groups = new Map<string, Outcome[]>();
    for (const o of outcomes) {
      const g = groupOf(o.c, dimension);
      groups.set(g, [...(groups.get(g) ?? []), o]);
    }
    for (const [group, os] of [...groups].sort(([a], [b]) => a.localeCompare(b))) {
      const ok = os.filter(right).length;
      const rate = ok / os.length;
      slices.push({
        dimension,
        group,
        cases: os.length,
        exact: ok,
        rate,
        behind:
          group !== 'unknown' &&
          os.length >= settings.minimum &&
          rate < exactRate - settings.margin - 1e-9,
      });
    }
  }
  const problems: string[] = [];
  for (const s of slices.filter((x) => x.behind))
    problems.push(
      `${s.dimension.replace('_', ' ')} ${s.group}: ${Math.round(s.rate * 100)}% of ${s.cases} cases, against ${Math.round(exactRate * 100)}% overall`,
    );
  const regression =
    baseline && exactRate < baseline.exactRate - settings.regression - 1e-9
      ? `accuracy ${Math.round(exactRate * 1000) / 10}% against ${Math.round(baseline.exactRate * 1000) / 10}% in the baseline`
      : null;
  if (regression) problems.push(regression);
  if (n === 0) problems.push('no cases');
  return {
    model,
    cases: n,
    failed: outcomes.filter((o) => o.suggested === null).length,
    exact,
    exactRate,
    withinOneRate: n ? withinOne / n : 0,
    cannotTellRate: n ? cannotTell / n : 0,
    confusion,
    slices,
    settings,
    regression,
    passed: problems.length === 0,
    problems,
  };
}
