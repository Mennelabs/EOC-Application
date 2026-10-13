/**
 * Checkpoint (FL:FR-03, BDG-02, RULE-11): scan or type a badge code and see
 * valid, expired, revoked, not yet printed or unknown, with never more than
 * the name, agency and labels. The answer comes from the server (badges can
 * be revoked at any time), so this needs signal; each check is recorded.
 */
import { useState } from 'react';
import { useField } from '../src/field';
import { problem } from '../src/online';
import { Scanner } from '../src/scanner';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

interface Result {
  result: 'valid' | 'expired' | 'revoked' | 'not_yet_printed' | 'unknown';
  displayName?: string;
  agency?: string | null;
  roleLabel?: string | null;
  accessLabel?: string | null;
  validTo?: string;
}

export default function Checkpoint() {
  const f = useField();
  const { t } = f;
  const [code, setCode] = useState('');
  const [where, setWhere] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const verify = async (value: string) => {
    try {
      setResult(
        await f.send<Result>('POST', '/badges/verify', {
          code: value.trim(),
          ...(where.trim() ? { checkpoint: where.trim() } : {}),
        }),
      );
      setMessage(null);
    } catch (err) {
      setResult(null);
      setMessage(problem(err, t));
    }
  };
  const tone = result?.result === 'valid' ? 'info' : 'danger';
  return (
    <Page title={t('check.heading')}>
      <Body>{t('check.intro')}</Body>
      {message ? <Alert tone="warn">{message}</Alert> : null}
      {result ? (
        <Card label={t(`check.result.${result.result}`)}>
          <Alert tone={tone}>{t(`check.result.${result.result}`)}</Alert>
          {result.displayName ? <Heading level={2}>{result.displayName}</Heading> : null}
          {result.agency ? <Body>{result.agency}</Body> : null}
          {result.roleLabel ? <Body>{result.roleLabel}</Body> : null}
          {result.accessLabel ? (
            <Body>{t('check.access', { label: result.accessLabel })}</Body>
          ) : null}
        </Card>
      ) : null}
      <Field label={t('check.where')} value={where} onChange={setWhere} />
      <Scanner
        onCode={(c) => {
          setCode(c);
          void verify(c);
        }}
      />
      <Field
        label={t('check.code')}
        hint={t('check.codeHint')}
        value={code}
        onChange={setCode}
        autoComplete="off"
      />
      <Button
        label={t('check.verify')}
        disabled={code.replace(/[^a-z0-9]/gi, '').length < 8}
        onPress={() => void verify(code)}
      />
      <NavBar current="home" />
    </Page>
  );
}
