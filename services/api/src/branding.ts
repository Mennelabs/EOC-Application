/**
 * A county's branding and languages as residents see them (ADM-01 "languages
 * and branding, all audited"; NFR-09, EQ-07). Branding is a short list of
 * known fields, never free-form: the name of the agency in each language, its
 * website, and the colour of the page header. White text on that colour must
 * reach 4.5:1 (WCAG 2.2 SC 1.4.3), so no county can make the header
 * unreadable. Only these fields ever leave for the public pages.
 *
 * Languages are those the resident and public pages have reviewed
 * translations for (EQ-07). A county, city or region always offers English
 * and Spanish, the launch languages; a partner organization needs English.
 */
import { z } from 'zod';

/** Languages with resident and public catalogs; a new one is added here with its translations. */
export const OFFERED_LOCALES = ['en', 'es'] as const;
export type OfferedLocale = (typeof OFFERED_LOCALES)[number];
/** The launch languages every resident-facing tenant offers. */
export const LAUNCH_LOCALES: readonly OfferedLocale[] = ['en', 'es'];

const channel = (hex: string, i: number) => {
  const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
};
const luminance = (hex: string) =>
  0.2126 * channel(hex, 0) + 0.7152 * channel(hex, 1) + 0.0722 * channel(hex, 2);

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const HEX = /^#[0-9a-fA-F]{6}$/;
const name = z.string().trim().min(2).max(120);

export const brandingIn = z
  .object({
    /** The agency's name as residents read it in the page header, per language. */
    publicName: z.object({ en: name.optional(), es: name.optional() }).strict().optional(),
    /** The county's own website, linked from the resident and help pages. */
    website: z
      .url({ protocol: /^https$/, error: 'an https address' })
      .max(300)
      .optional(),
    /** The page header's background; its text is white. */
    headerColor: z
      .string()
      .regex(HEX, 'a colour like #0b4f6c')
      .refine(
        (c) => contrastRatio(c.toLowerCase(), '#ffffff') >= 4.5,
        'white text on this colour is too faint: it needs a contrast of 4.5:1 (WCAG 1.4.3)',
      )
      .optional(),
  })
  .strict();
export type Branding = z.infer<typeof brandingIn>;

/**
 * What the public pages receive: the known fields that still pass the checks,
 * nothing else stored on the tenant.
 */
export function publicBranding(raw: unknown): Branding {
  if (!raw || typeof raw !== 'object') return {};
  const r = raw as Record<string, unknown>;
  const out: Branding = {};
  const names = brandingIn.shape.publicName.safeParse(r['publicName']);
  if (names.success && names.data && Object.keys(names.data).length) out.publicName = names.data;
  const website = brandingIn.shape.website.safeParse(r['website']);
  if (website.success && website.data) out.website = website.data;
  const color = brandingIn.shape.headerColor.safeParse(r['headerColor']);
  if (color.success && color.data) out.headerColor = color.data.toLowerCase();
  return out;
}

/** The agency name for a language, or null to use the tenant's name. */
export const publicNameIn = (branding: unknown, lang: string): string | null =>
  publicBranding(branding).publicName?.[lang as OfferedLocale] ?? null;

/** Why a list of languages cannot be saved, or null when it can. */
export function localeProblem(locales: string[], kind: string): string | null {
  const unknown = locales.filter((l) => !(OFFERED_LOCALES as readonly string[]).includes(l));
  if (unknown.length)
    return `not offered yet: ${unknown.join(', ')}. A language is added once its resident and public pages are translated and reviewed (EQ-07).`;
  const needed = kind === 'partner_org' ? ['en'] : LAUNCH_LOCALES;
  const missing = needed.filter((l) => !locales.includes(l));
  if (missing.length)
    return kind === 'partner_org'
      ? 'English is always offered.'
      : 'English and Spanish are always offered to residents (the launch languages).';
  return null;
}
