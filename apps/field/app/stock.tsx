/**
 * Stock at a site (FL:FR-21, FR-22): what is on hand, and one tap to record
 * stock received, handed out or counted. Each movement is kept on the phone
 * with its own id and counted once when it arrives; the list itself needs
 * signal. "Running low" shows at the reorder point.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { RadioGroup, Stepper } from '../src/controls';
import { useField } from '../src/field';
import { problem, useOnline } from '../src/online';
import { Alert, Body, Button, Card, Field, Heading, NavBar, Page } from '../src/ui';

interface Site {
  id: string;
  name: string;
}
interface Item {
  id: string;
  sku: string;
  name: string;
  unit: string;
  quantity: number;
  runningLow: boolean;
}

export default function Stock() {
  const f = useField();
  const { t } = f;
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [amount, setAmount] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [qty, setQty] = useState(1);
  useEffect(() => {
    void f.list<Site>('sites').then((s) => {
      setSites(s);
      if (s.length === 1) setSiteId(s[0]!.id);
    });
  }, [f]);
  const query = useOnline(siteId, () =>
    f.online<Item[]>(`/field-records/stock_item?siteId=${siteId ?? ''}`),
  );
  const items = query.data;
  const load = query.reload;
  const move = async (body: Record<string, unknown>) => {
    await f.saveRecord('stock_movement', body, t('stock.saved'));
    setMessage(t('stock.saved'));
    setTimeout(() => void load(), 1500);
  };
  return (
    <Page title={t('stock.heading')}>
      <Body>{t('stock.intro')}</Body>
      {message ? <Alert>{message}</Alert> : null}
      {query.error ? <Alert tone="warn">{problem(query.error, t)}</Alert> : null}
      <RadioGroup
        label={t('records.site')}
        options={sites.map((s) => ({ value: s.id, label: s.name }))}
        value={siteId}
        onChange={setSiteId}
      />
      {items === null && siteId ? <Body muted>{t('records.needsSignal')}</Body> : null}
      {items?.length === 0 ? <Body muted>{t('stock.none')}</Body> : null}
      {items?.map((it) => {
        const n = amount[it.id] ?? 1;
        return (
          <Card key={it.id} label={it.name}>
            <Heading level={3}>{it.name}</Heading>
            <Body>
              {t('stock.onHand', { quantity: it.quantity, unit: it.unit })}
              {it.runningLow ? ` · ⚠ ${t('stock.low')}` : ''}
            </Body>
            <Stepper
              label={t('stock.howMany', { name: it.name })}
              min={0}
              max={100_000}
              value={n}
              onChange={(v) => setAmount({ ...amount, [it.id]: v })}
            />
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              <Button
                kind="secondary"
                label={t('stock.received')}
                onPress={() => void move({ stockItemId: it.id, kind: 'received', quantity: n })}
              />
              <Button
                kind="secondary"
                label={t('stock.issued')}
                onPress={() => void move({ stockItemId: it.id, kind: 'issued', quantity: n })}
              />
              <Button
                kind="secondary"
                label={t('stock.counted')}
                onPress={() => void move({ stockItemId: it.id, kind: 'counted', quantity: n })}
              />
            </View>
          </Card>
        );
      })}
      {siteId ? (
        <Card label={t('stock.new')}>
          <Heading level={2}>{t('stock.new')}</Heading>
          <Field label={t('stock.sku')} hint={t('stock.skuHint')} value={sku} onChange={setSku} />
          <Field label={t('stock.name')} value={name} onChange={setName} />
          <Stepper label={t('stock.arrived')} min={0} max={100_000} value={qty} onChange={setQty} />
          <Button
            label={t('stock.add')}
            disabled={!sku.trim() || !name.trim()}
            onPress={() =>
              void move({
                item: { siteId, sku: sku.trim(), name: name.trim() },
                kind: 'received',
                quantity: qty,
              }).then(() => {
                setSku('');
                setName('');
                setQty(1);
              })
            }
          />
        </Card>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}
