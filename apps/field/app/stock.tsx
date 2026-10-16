/**
 * Stock at a site (FL:FR-21, FR-22): what is on hand, how fast it went out
 * over the last day and how long what is left lasts at that rate, and one
 * tap to record stock received, handed out or counted. An item is found by
 * scanning or typing its barcode. Each movement is kept on the phone with its
 * own id and counted once when it arrives; the lists themselves need signal.
 * "Running low" shows at the reorder point, where the site's resupply request
 * is started with a suggested quantity; nothing is sent until a person sends
 * it. Warehouse staff see the requests sent by sites and mark them filled.
 */
import { useEffect, useState } from 'react';
import { View } from 'react-native';
import { RadioGroup, Stepper } from '../src/controls';
import { useField } from '../src/field';
import { problem, useOnline } from '../src/online';
import { Scanner } from '../src/scanner';
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
  barcode: string | null;
  runningLow: boolean;
  usedLastDay: number;
  hoursLeft: number | null;
}
interface Line {
  stockItemId: string;
  name: string;
  unit: string;
  quantity: number;
  suggested: number | null;
}
interface SupplyRequest {
  id: string;
  version: number;
  siteName: string | null;
  status: 'draft' | 'sent' | 'filled' | 'canceled';
  draftedAutomatically: boolean;
  lines: Line[];
}

const RETAIL = ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128', 'code39', 'qr'] as const;

export default function Stock() {
  const f = useField();
  const { t } = f;
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState<string | null>(null);
  const [amount, setAmount] = useState<Record<string, number>>({});
  const [message, setMessage] = useState<string | null>(null);
  const [sku, setSku] = useState('');
  const [name, setName] = useState('');
  const [barcode, setBarcode] = useState('');
  const [qty, setQty] = useState(1);
  const [code, setCode] = useState('');
  const [found, setFound] = useState<string | null>(null);
  const [asked, setAsked] = useState<Record<string, number>>({});
  useEffect(() => {
    void f.list<Site>('sites').then((s) => {
      setSites(s);
      if (s.length === 1) setSiteId(s[0]!.id);
    });
  }, [f]);
  const query = useOnline(siteId, () =>
    f.online<Item[]>(`/field-records/stock_item?siteId=${siteId ?? ''}`),
  );
  const mine = useOnline(siteId ? `requests:${siteId}` : null, () =>
    f.online<SupplyRequest[]>(`/supply-requests?siteId=${siteId ?? ''}&open=true`),
  );
  const fromSites = useOnline(f.can('stock.write') ? 'requests:sent' : null, () =>
    f.online<SupplyRequest[]>('/supply-requests?status=sent'),
  );
  const items = query.data;
  const shown = found ? (items ?? []).filter((it) => it.barcode === found) : items;
  const draft = mine.data?.find((r) => r.status === 'draft') ?? null;
  const reload = () => {
    void query.reload();
    void mine.reload();
    void fromSites.reload();
  };
  const move = async (body: Record<string, unknown>) => {
    await f.saveRecord('stock_movement', body, t('stock.saved'));
    setMessage(t('stock.saved'));
    setTimeout(reload, 1500);
  };
  const lookUp = (value: string) => {
    const v = value.trim();
    if (!v) return;
    setCode(v);
    setFound(v);
    if (!(items ?? []).some((it) => it.barcode === v)) {
      setMessage(t('stock.noBarcode'));
      setBarcode(v);
      setSku(v);
    } else setMessage(null);
  };
  const step = async (r: SupplyRequest, to: 'send' | 'fill', body: unknown, done: string) => {
    try {
      await f.send('POST', `/supply-requests/${r.id}/${to}`, body, {
        'if-match': `"${r.version}"`,
      });
      setMessage(done);
    } catch (err) {
      setMessage(problem(err, t));
    }
    reload();
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
        onChange={(v) => {
          setSiteId(v);
          setFound(null);
        }}
      />
      {siteId ? (
        <Card label={t('stock.find')}>
          <Heading level={2}>{t('stock.find')}</Heading>
          <Scanner kinds={[...RETAIL]} onCode={lookUp} />
          <Field label={t('stock.barcode')} value={code} onChange={setCode} />
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            <Button kind="secondary" label={t('stock.lookUp')} onPress={() => lookUp(code)} />
            {found ? (
              <Button
                kind="secondary"
                label={t('stock.showAll')}
                onPress={() => {
                  setFound(null);
                  setCode('');
                }}
              />
            ) : null}
          </View>
        </Card>
      ) : null}
      {items === null && siteId ? <Body muted>{t('records.needsSignal')}</Body> : null}
      {items?.length === 0 ? <Body muted>{t('stock.none')}</Body> : null}
      {shown?.map((it) => {
        const n = amount[it.id] ?? 1;
        return (
          <Card key={it.id} label={it.name}>
            <Heading level={3}>{it.name}</Heading>
            <Body>
              {t('stock.onHand', { quantity: it.quantity, unit: it.unit })}
              {it.runningLow ? ` · ⚠ ${t('stock.low')}` : ''}
            </Body>
            <Body muted>
              {t('stock.rate', { used: it.usedLastDay, unit: it.unit })}
              {it.hoursLeft !== null ? ` · ${t('stock.lasts', { hours: it.hoursLeft })}` : ''}
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
      {draft ? (
        <Card label={t('stock.draft')}>
          <Heading level={2}>{t('stock.draft')}</Heading>
          <Body>{t('stock.draftIntro')}</Body>
          {draft.lines.map((l) => (
            <Stepper
              key={l.stockItemId}
              label={t('stock.ask', { name: l.name, unit: l.unit })}
              min={0}
              max={100_000}
              value={asked[l.stockItemId] ?? l.quantity}
              onChange={(v) => setAsked({ ...asked, [l.stockItemId]: v })}
            />
          ))}
          <Button
            label={t('stock.send')}
            onPress={() =>
              void step(
                draft,
                'send',
                {
                  lines: draft.lines.map((l) => ({
                    stockItemId: l.stockItemId,
                    quantity: asked[l.stockItemId] ?? l.quantity,
                  })),
                },
                t('stock.sent'),
              )
            }
          />
        </Card>
      ) : null}
      {mine.data
        ?.filter((r) => r.status === 'sent')
        .map((r) => (
          <Body key={r.id} muted>
            {t('stock.waiting', {
              items: r.lines.map((l) => `${l.quantity} ${l.unit} ${l.name}`).join(', '),
            })}
          </Body>
        ))}
      {siteId ? (
        <Card label={t('stock.new')}>
          <Heading level={2}>{t('stock.new')}</Heading>
          <Field label={t('stock.sku')} hint={t('stock.skuHint')} value={sku} onChange={setSku} />
          <Field label={t('stock.name')} value={name} onChange={setName} />
          <Field label={t('stock.barcode')} value={barcode} onChange={setBarcode} />
          <Stepper label={t('stock.arrived')} min={0} max={100_000} value={qty} onChange={setQty} />
          <Button
            label={t('stock.add')}
            disabled={!sku.trim() || !name.trim()}
            onPress={() =>
              void move({
                item: {
                  siteId,
                  sku: sku.trim(),
                  name: name.trim(),
                  ...(barcode.trim() ? { barcode: barcode.trim() } : {}),
                },
                kind: 'received',
                quantity: qty,
              }).then(() => {
                setSku('');
                setName('');
                setBarcode('');
                setQty(1);
              })
            }
          />
        </Card>
      ) : null}
      {fromSites.data?.length ? (
        <Card label={t('stock.fromSites')}>
          <Heading level={2}>{t('stock.fromSites')}</Heading>
          {fromSites.data.map((r) => (
            <View key={r.id} style={{ gap: 6 }}>
              <Body>
                {`${r.siteName ?? ''}: ${r.lines.map((l) => `${l.quantity} ${l.unit} ${l.name}`).join(', ')}`}
              </Body>
              <Button
                kind="secondary"
                label={t('stock.fill', { site: r.siteName ?? '' })}
                onPress={() => void step(r, 'fill', {}, t('stock.filled'))}
              />
            </View>
          ))}
        </Card>
      ) : null}
      <NavBar current="home" />
    </Page>
  );
}
