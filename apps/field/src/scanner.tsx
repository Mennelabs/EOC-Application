/**
 * Scanning a printed code (FL:FR-03 badges at a checkpoint, FL:FR-14 shelter
 * wristbands): the camera reads a QR code or a barcode and hands over its
 * text once. Typing the code always works too, so the camera is never the
 * only way (WCAG 2.5, FLD-15); a refused camera says so plainly.
 */
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useRef, useState } from 'react';
import { View } from 'react-native';
import { useField } from './field';
import { Alert, Button } from './ui';

export function Scanner({ onCode }: { onCode: (code: string) => void }) {
  const { t } = useField();
  const [permission, request] = useCameraPermissions();
  const [open, setOpen] = useState(false);
  const done = useRef(false);
  if (!open)
    return (
      <Button
        kind="secondary"
        label={t('scan.open')}
        onPress={() =>
          void (async () => {
            const p = permission?.granted ? permission : await request();
            if (p.granted) {
              done.current = false;
              setOpen(true);
            }
          })()
        }
      />
    );
  return (
    <View style={{ gap: 8 }}>
      {permission && !permission.granted ? <Alert tone="warn">{t('scan.denied')}</Alert> : null}
      <View
        aria-label={t('scan.view')}
        role="img"
        style={{ height: 260, borderRadius: 10, overflow: 'hidden' }}
      >
        <CameraView
          style={{ flex: 1 }}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr', 'code128', 'code39'] }}
          onBarcodeScanned={(r) => {
            if (done.current || !r.data) return;
            done.current = true;
            setOpen(false);
            onCode(r.data);
          }}
        />
      </View>
      <Button kind="secondary" label={t('scan.close')} onPress={() => setOpen(false)} />
    </View>
  );
}
