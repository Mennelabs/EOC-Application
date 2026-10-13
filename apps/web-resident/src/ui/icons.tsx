/**
 * Picture choices (INT-11) and need icons: simple line glyphs, decorative
 * (the text label carries the meaning, ACC-09). Keys match the graph's
 * `picture` and `icon` values; an unknown key shows nothing.
 */
const PATHS: Record<string, string> = {
  house: 'M3 11 12 4l9 7v9H3z M9 20v-6h6v6',
  apartment: 'M4 20V4h16v16 M8 8h2 M14 8h2 M8 12h2 M14 12h2 M8 16h2 M14 16h2',
  mobile_home: 'M2 10h18l2 3v4H2z M6 17v3 M18 17v3 M6 10V7h8v3',
  storefront:
    'M3 9l2-5h14l2 5 M3 9v11h18V9 M3 9a3 3 0 0 0 6 0 3 3 0 0 0 6 0 3 3 0 0 0 6 0 M9 20v-6h6v6',
  other:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18 M12 16h0 M9.5 9.5a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1.2-1.5 2.5',
  wind: 'M3 8h11a3 3 0 1 0-3-3 M3 12h16a3 3 0 1 1-3 3 M3 16h8a2 2 0 1 1-2 2',
  flood: 'M3 12c3-3 6 3 9 0s6 3 9 0 M3 17c3-3 6 3 9 0s6 3 9 0 M12 3v6 M9 6l3-3 3 3',
  fire: 'M12 21c-4 0-6-3-6-6 0-4 4-6 4-10 2 1 3 3 3 5 1-1 2-3 2-4 2 2 3 5 3 8 0 4-2 7-6 7',
  snow: 'M12 2v20 M2 12h20 M5 5l14 14 M19 5 5 19',
  roof: 'M2 12 12 4l10 8 M5 10v10h14V10',
  window: 'M4 4h16v16H4z M12 4v16 M4 12h16',
  water: 'M4 20h16 M4 20V9l8-5 8 5v11 M4 15c3-2 5 2 8 0s5 2 8 0',
  tree: 'M12 22v-6 M12 16c-5 0-7-3-7-6 2 0 3-1 3-3 2 1 3 0 4-3 1 3 2 4 4 3 0 2 1 3 3 3 0 3-2 6-7 6',
  shifted: 'M4 20h16 M6 17l2-10h9l1 10 M9 11l-5 6',
  wall: 'M3 4h18v16H3z M3 9h18 M3 14h18 M8 4v5 M14 9v5 M8 14v6',
  yard: 'M3 20h18 M6 20v-5 M6 15c-2 0-3-2-3-4 2 0 3 1 3 1s1-1 3-1c0 2-1 4-3 4 M14 20v-8 M11 12c0-3 3-5 3-5s3 2 3 5z',
  roof_ok: 'M2 12 12 4l10 8 M6 12v8h12v-8 M9 16l2 2 4-4',
  roof_shingles: 'M2 12 12 4l10 8 M6 12v8h12v-8 M8 9l2 2 M12 7l2 2 M16 10l-2 2',
  roof_hole: 'M2 12 12 4l10 8 M6 12v8h12v-8 M10 8l4 4 M14 8l-4 4',
  roof_gone: 'M6 20V10 M18 20V10 M6 20h12 M4 6l16 0 M8 4l8 4',
  bed: 'M3 18V8 M21 18v-6a3 3 0 0 0-3-3H9v6 M3 15h18 M6 9a2 2 0 1 0 0 .1',
  food: 'M6 3v8a3 3 0 0 0 6 0V3 M9 3v18 M17 3c-2 2-2 6-2 8h4c0-2 0-6-2-8z M17 11v10',
  tarp: 'M3 16 12 6l9 10 M3 16h18 M6 16v4 M18 16v4 M12 6v10',
  medical: 'M12 4v16 M4 12h16 M5 5h14v14H5z',
  car: 'M3 15l2-6h14l2 6 M3 15v4h2v-2h14v2h2v-4 M7 15h0 M17 15h0',
  paw: 'M8 7a2 2 0 1 0 0 .1 M16 7a2 2 0 1 0 0 .1 M4 11a2 2 0 1 0 0 .1 M20 11a2 2 0 1 0 0 .1 M12 20c-4 0-6-2-6-4s3-4 6-4 6 2 6 4-2 4-6 4',
  chat: 'M4 5h16v10H9l-5 4z',
  more: 'M6 12h0 M12 12h0 M18 12h0',
};

export function Icon({ name }: { name: string }) {
  const d = PATHS[name];
  if (!d) return null;
  return (
    <svg
      className="icon"
      viewBox="0 0 24 24"
      width="40"
      height="40"
      aria-hidden="true"
      focusable="false"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={d} />
    </svg>
  );
}
