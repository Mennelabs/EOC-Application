/**
 * Job aids offline (FL-15): the checklists, FEMA matrix, safety briefings
 * and standards for the volunteer's role and language, from the area
 * package. Tenant content is shown as text (headings, paragraphs and
 * bullets), never as markup. Only aids the county approved reach a phone; an
 * exercise draft (synthetic stack only) says it is not yet reviewed.
 */
import { useEffect, useState } from 'react';
import { useField } from '../src/field';
import { htmlToLines } from '../src/format';
import { Body, Button, Card, Heading, NavBar, Page } from '../src/ui';

interface JobAid {
  id: string;
  key: string;
  title: string;
  bodyHtml: string;
  reviewed?: boolean;
}

export default function JobAids() {
  const f = useField();
  const { t } = f;
  const [aids, setAids] = useState<JobAid[]>([]);
  const [open, setOpen] = useState<string | null>(null);
  useEffect(() => {
    void f
      .list<JobAid>('job_aids')
      .then((a) => setAids(a.sort((x, y) => x.title.localeCompare(y.title))));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once
  }, []);
  return (
    <Page title={t('aids.heading')}>
      {aids.length === 0 ? <Body muted>{t('aids.none')}</Body> : null}
      {aids.map((a) => (
        <Card key={a.id} label={a.title}>
          <Heading level={2}>{a.title}</Heading>
          {a.reviewed === false ? <Body muted>{t('aids.unreviewed')}</Body> : null}
          {open === a.id ? (
            htmlToLines(a.bodyHtml).map((line, i) => <Body key={i}>{line}</Body>)
          ) : (
            <Button kind="secondary" label={t('aids.open')} onPress={() => setOpen(a.id)} />
          )}
        </Card>
      ))}
      <NavBar current="home" />
    </Page>
  );
}
