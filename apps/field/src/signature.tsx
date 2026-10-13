/**
 * A signature drawn with a finger, a stylus or a mouse (FL:FR-19). The
 * strokes become SVG path data that the server keeps encrypted. "Clear"
 * starts again. Someone who cannot sign by drawing (or a keyboard or switch
 * user) signs by typing their name and confirming it instead; the witness
 * (the signed-in volunteer) is always recorded beside it.
 */
import { useEffect, useRef, useState } from 'react';
import { View, type GestureResponderEvent } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useField } from './field';
import { Body, Button, Field, Toggle } from './ui';

export function SignaturePad({
  label,
  onChange,
}: {
  label: string;
  onChange: (svgPath: string | null) => void;
}) {
  const { t, theme } = useField();
  const [paths, setPaths] = useState<string[]>([]);
  const [typed, setTyped] = useState(false);
  const [name, setName] = useState('');
  const [agreed, setAgreed] = useState(false);
  const current = useRef('');
  const width = 320;
  const height = 140;
  const strokes = useRef<string[]>([]);
  const changed = useRef(onChange);
  useEffect(() => {
    changed.current = onChange;
  });
  // The view's own responder events; the strokes live in a ref and are read only in handlers.
  const point = (e: GestureResponderEvent) =>
    `${e.nativeEvent.locationX.toFixed(1)} ${e.nativeEvent.locationY.toFixed(1)}`;
  const handlers = {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderGrant: (e: GestureResponderEvent) => {
      current.current = `M${point(e)}`;
      strokes.current = [...strokes.current, current.current];
      setPaths(strokes.current);
    },
    onResponderMove: (e: GestureResponderEvent) => {
      current.current += ` L${point(e)}`;
      strokes.current = [...strokes.current.slice(0, -1), current.current];
      setPaths(strokes.current);
    },
    onResponderRelease: () => {
      const joined = strokes.current.join(' ');
      changed.current(joined.length >= 10 ? joined : null);
    },
  };
  // WCAG 2.1.1: signing must not depend on drawing. A typed name the signer confirms is the alternative.
  if (typed)
    return (
      <View style={{ gap: 6 }}>
        <Body>{label}</Body>
        <Field
          label={t('sign.typedName')}
          value={name}
          onChange={(v) => {
            setName(v);
            onChange(agreed && v.trim().length >= 2 ? `typed:${v.trim()}` : null);
          }}
        />
        <Toggle
          label={t('sign.typedAgree')}
          value={agreed}
          onChange={(v) => {
            setAgreed(v);
            onChange(v && name.trim().length >= 2 ? `typed:${name.trim()}` : null);
          }}
        />
        <Button
          kind="secondary"
          label={t('sign.draw')}
          onPress={() => {
            setTyped(false);
            onChange(null);
          }}
        />
      </View>
    );
  return (
    <View style={{ gap: 6 }}>
      <Body>{label}</Body>
      <Body muted>{t('sign.hint')}</Body>
      <View
        {...handlers}
        role="img"
        aria-label={paths.length ? t('sign.done') : t('sign.empty')}
        style={{
          width,
          maxWidth: '100%',
          height,
          borderWidth: 2,
          borderColor: theme.border,
          borderRadius: 8,
          backgroundColor: '#ffffff',
        }}
      >
        <Svg width="100%" height={height} viewBox={`0 0 ${width} ${height}`}>
          {paths.map((d, i) => (
            <Path key={i} d={d} stroke="#111111" strokeWidth={3} fill="none" />
          ))}
        </Svg>
      </View>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
        <Button
          kind="secondary"
          label={t('sign.clear')}
          onPress={() => {
            strokes.current = [];
            setPaths([]);
            onChange(null);
          }}
        />
        <Button
          kind="secondary"
          label={t('sign.type')}
          onPress={() => {
            strokes.current = [];
            setPaths([]);
            setTyped(true);
            onChange(null);
          }}
        />
      </View>
    </View>
  );
}
