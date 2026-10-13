/**
 * A small drawing of a home for each degree of damage (FLD-08: chosen from
 * pictures, never from definitions alone): the water line against the wall,
 * the share of the roof gone, or the walls down. Drawn with views so it
 * works offline on every platform; the picture has a text alternative with
 * the same description the card shows (WCAG 1.1.1). Manufactured homes sit
 * on piers so "water below the floor" is visible.
 */
import { View } from 'react-native';
import { picture, type Degree, type Structure, type SweepDegree } from './assessment';
import type { Theme } from './theme';

export function HouseDiagram({
  structure,
  degree,
  label,
  theme,
  size = 96,
}: {
  structure: Structure;
  degree: Degree | SweepDegree;
  label: string;
  theme: Theme;
  size?: number;
}) {
  const p = picture(structure, degree);
  const manufactured = structure === 'manufactured';
  const w = size;
  const h = size * 0.8;
  const piers = manufactured ? h * 0.12 : 0;
  const wallTop = h * (manufactured ? 0.38 : 0.42);
  const wallHeight = h - wallTop - piers;
  const line = theme.text;
  const water = '#2f6fb6';
  return (
    <View
      // With no label the drawing is decoration beside words that say the same (WCAG 1.1.1).
      {...(label ? { role: 'img' as const, 'aria-label': label } : { 'aria-hidden': true })}
      style={{ width: w, height: h, position: 'relative' }}
    >
      {/* roof: a band split into a kept and a lost part */}
      {!p.collapsed ? (
        <View
          style={{
            position: 'absolute',
            left: w * 0.06,
            right: w * 0.06,
            top: manufactured ? wallTop - h * 0.1 : h * 0.12,
            height: manufactured ? h * 0.1 : wallTop - h * 0.12,
            flexDirection: 'row',
          }}
        >
          <View style={{ flex: 1 - p.roofLoss, backgroundColor: line }} />
          <View
            style={{
              flex: p.roofLoss,
              borderWidth: p.roofLoss ? 2 : 0,
              borderStyle: 'dashed',
              borderColor: line,
            }}
          />
        </View>
      ) : null}
      {/* walls, or rubble when collapsed */}
      <View
        style={{
          position: 'absolute',
          left: w * 0.12,
          right: w * 0.12,
          top: p.collapsed ? h - wallHeight * 0.3 - piers : wallTop,
          height: p.collapsed ? wallHeight * 0.3 : wallHeight,
          borderWidth: 3,
          borderColor: line,
          transform: p.collapsed ? [{ rotate: '-8deg' }] : [],
        }}
      >
        {!p.collapsed ? (
          <View
            style={{
              position: 'absolute',
              left: '40%',
              width: '20%',
              bottom: 0,
              height: '55%',
              borderWidth: 2,
              borderColor: line,
            }}
          />
        ) : null}
      </View>
      {/* piers for a manufactured home */}
      {manufactured ? (
        <View
          style={{
            position: 'absolute',
            left: w * 0.18,
            right: w * 0.18,
            bottom: 0,
            height: piers,
            flexDirection: 'row',
            justifyContent: 'space-between',
          }}
        >
          <View style={{ width: 4, backgroundColor: line }} />
          <View style={{ width: 4, backgroundColor: line }} />
          <View style={{ width: 4, backgroundColor: line }} />
        </View>
      ) : null}
      {/* water against the house */}
      {p.water > 0 ? (
        <View
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: 0,
            height: piers + wallHeight * p.water,
            backgroundColor: water,
            opacity: 0.45,
          }}
        />
      ) : null}
      {/* ground */}
      <View
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 0,
          height: 2,
          backgroundColor: line,
        }}
      />
    </View>
  );
}
