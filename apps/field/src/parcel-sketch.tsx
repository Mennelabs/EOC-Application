/**
 * FLD-04: the lot on "Is this the property?", drawn from the area package as
 * vector outlines (no map tiles, so it works offline): the lot itself thick
 * and shaded, its neighbours thin, the pin as a ringed dot. It is one image
 * to assistive technology, named in words (the address, and whether the pin
 * is inside the lot or how far from it), so nothing depends on seeing it.
 */
import { View } from 'react-native';
import Svg, { Circle, Path } from 'react-native-svg';
import { parcelSketch, type Parcel, type Point } from '@cg/field-core';
import { useField } from './field';

export function ParcelSketch({
  parcel,
  parcels,
  pin,
  label,
}: {
  parcel: Parcel;
  parcels: readonly Parcel[];
  pin: Point | null;
  label: string;
}) {
  const { theme } = useField();
  const s = parcelSketch(parcel, parcels, pin);
  if (!s) return null;
  return (
    <View
      accessible
      accessibilityRole="image"
      accessibilityLabel={label}
      style={{
        width: s.width,
        maxWidth: '100%',
        aspectRatio: s.width / s.height,
        borderWidth: 1,
        borderColor: theme.border,
        borderRadius: 8,
        backgroundColor: theme.surface,
      }}
    >
      <Svg width="100%" height="100%" viewBox={`0 0 ${s.width} ${s.height}`}>
        {s.neighbours.map((d, i) => (
          <Path key={i} d={d} stroke={theme.muted} strokeWidth={1} fill="none" />
        ))}
        <Path
          d={s.lot}
          stroke={theme.primary}
          strokeWidth={3}
          fill={theme.primary}
          fillOpacity={0.15}
        />
        {s.pin ? (
          <>
            <Circle cx={s.pin.x} cy={s.pin.y} r={7} fill={theme.surface} />
            <Circle cx={s.pin.x} cy={s.pin.y} r={5} fill={theme.danger} />
          </>
        ) : null}
      </Svg>
    </View>
  );
}
