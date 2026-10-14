/**
 * Paged GeoJSON from an ArcGIS REST query endpoint (TIGERweb, the National
 * Flood Hazard Layer). The service caps each answer; pages are asked for by
 * offset until a short page arrives without the "more to come" flag.
 */
import type { EgressHttp } from '../http.ts';

export interface ArcgisFeature {
  type: 'Feature';
  geometry: unknown;
  properties: Record<string, unknown> | null;
}

interface ArcgisPage {
  features?: ArcgisFeature[];
  exceededTransferLimit?: boolean;
  properties?: { exceededTransferLimit?: boolean };
  error?: { code?: number; message?: string };
}

export function arcgisQueryUrl(
  base: string,
  params: Record<string, string>,
  offset: number,
  pageSize: number,
): string {
  const u = new URL(`${base}/query`);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  u.searchParams.set('outSR', '4326');
  u.searchParams.set('f', 'geojson');
  u.searchParams.set('resultOffset', String(offset));
  u.searchParams.set('resultRecordCount', String(pageSize));
  return u.toString();
}

export async function* arcgisFeatures(
  http: EgressHttp,
  base: string,
  params: Record<string, string>,
  pageSize = 1000,
): AsyncIterable<ArcgisFeature> {
  for (let offset = 0; ; offset += pageSize) {
    const page = (await http.getJson(arcgisQueryUrl(base, params, offset, pageSize))) as ArcgisPage;
    // ArcGIS answers some errors with 200 and an error body.
    if (page.error)
      throw new Error(
        `ArcGIS query failed: ${page.error.code ?? ''} ${page.error.message ?? ''}`.trim(),
      );
    const features = page.features ?? [];
    for (const f of features) yield f;
    const more = page.exceededTransferLimit ?? page.properties?.exceededTransferLimit ?? false;
    if (features.length === 0 || (!more && features.length < pageSize)) return;
  }
}
