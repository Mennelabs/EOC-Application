/** Continue a paused report with its code (INT-20, ACC-41). */
import { useState } from 'react';
import { useT, type Shell } from '../App.tsx';
import { loadDraft } from '../api/public.ts';
import type { FlowState } from '../intake/state.ts';
import { ButtonRow, Field } from '../ui/primitives.tsx';

export function Resume({ shell, tenant, event }: { shell: Shell; tenant: string; event: string }) {
  const t = useT();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const go = async () => {
    setError(null);
    try {
      const r = await loadDraft(tenant, code.replace(/[^a-z0-9]/gi, '').toUpperCase());
      const saved = r.payload as Partial<FlowState>;
      if (!saved || saved.executionId !== r.executionId || !saved.answers) throw new Error('shape');
      await shell.store.set('flow', { ...saved, channel: 'web', current: null } as FlowState);
      shell.navigate(`/${tenant}/${event}/report`);
    } catch {
      setError(t('resume.notFound'));
    }
  };
  return (
    <main id="main" tabIndex={-1}>
      <h1>{t('resume.heading')}</h1>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        <Field label={t('resume.label')} error={error ?? undefined}>
          {({ id, describedBy, invalid }) => (
            <input
              id={id}
              type="text"
              autoComplete="off"
              autoCapitalize="characters"
              value={code}
              aria-describedby={describedBy}
              aria-invalid={invalid || undefined}
              onChange={(e) => setCode(e.target.value)}
            />
          )}
        </Field>
        <ButtonRow>
          <button
            type="submit"
            className="primary"
            disabled={code.replace(/[^a-z0-9]/gi, '').length < 6}
          >
            {t('resume.button')}
          </button>
          <button
            type="button"
            className="quiet"
            onClick={() => shell.navigate(`/${tenant}/${event}`)}
          >
            {t('back')}
          </button>
        </ButtonRow>
      </form>
    </main>
  );
}
