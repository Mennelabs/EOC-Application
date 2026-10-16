/** Find help near you: the county line now; open sites arrive with the public "Find help" layer (PUB). */
import { useHelpPhone, useT, type Shell } from '../App.tsx';
import { Card } from '../ui/primitives.tsx';

export function Help({ shell }: { shell: Shell }) {
  const t = useT();
  const phone = useHelpPhone(shell);
  return (
    <main id="main" tabIndex={-1}>
      <h1>{t('help.heading')}</h1>
      <Card tone="safety">
        <p>{t('help.911')}</p>
      </Card>
      <p>{t('help.body', { phone })}</p>
    </main>
  );
}
