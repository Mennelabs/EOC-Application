/**
 * A QR code drawn in the browser from text (FLD-03 staging check-in, BDG-01
 * badges). The text is always printed beside it as well, so the code is never
 * the only way to read it (AC-13C, WCAG 1.1.1).
 */
import QRCode from 'qrcode';
import { useEffect, useState } from 'react';

export function QrImage({ text, alt, size = 160 }: { text: string; alt: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    QRCode.toDataURL(text, { margin: 1, width: size })
      .then((url) => live && setSrc(url))
      .catch(() => live && setSrc(null));
    return () => {
      live = false;
    };
  }, [text, size]);
  return src ? <img src={src} alt={alt} width={size} height={size} /> : null;
}
