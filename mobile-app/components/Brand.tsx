import React, { useEffect, useRef } from 'react';
import { Animated, Easing, Image, StyleSheet, Text, View } from 'react-native';

/**
 * SpatialVision branding, from the two official logos (assets/brand):
 *   logo-dark-mode.png  = light text and glow  -> shown in Dark Mode (the app icon uses this one too)
 *   logo-light-mode.png = dark text            -> shown in Light Mode
 * The logos came with their own background colour baked in, which showed as a box on the app's
 * background. These PNGs are the same artwork with that background removed (transparent), and solid
 * parts keep their exact original colours, so the logo sits directly on any screen or card.
 * The emblem images are square crops of the hexagon from the same files. Proportions are kept ("contain").
 */
const LOGO = {
  dark: { src: require('../assets/brand/logo-dark-mode.png'), ratio: 672 / 591 },
  light: { src: require('../assets/brand/logo-light-mode.png'), ratio: 696 / 610 },
};
const EMBLEM = { dark: require('../assets/brand/emblem-dark-mode.png'), light: require('../assets/brand/emblem-light-mode.png') };

/** Full logo (emblem, name and tagline). `dark`: the app is in Dark Mode. */
export function BrandLogo({ dark, width }: { dark: boolean; width: number }) {
  const logo = dark ? LOGO.dark : LOGO.light;
  return (
    <Image source={logo.src} resizeMode="contain" accessibilityLabel="SpatialVision"
      style={{ width, height: width / logo.ratio }} />
  );
}

/** The hexagon emblem, for headers and cards (transparent, so it sits on any background). */
export function BrandEmblem({ dark, size = 32 }: { dark: boolean; size?: number }) {
  return (
    <Image source={dark ? EMBLEM.dark : EMBLEM.light} resizeMode="contain" accessibilityLabel="SpatialVision logo"
      style={{ width: size, height: size }} />
  );
}

/** Loading or waiting: the emblem pulses gently, with a short message under it. */
export function BrandLoader({ dark, label, color, size = 72 }: { dark: boolean; label?: string; color?: string; size?: number }) {
  const pulse = useRef(new Animated.Value(0.55)).current;
  useEffect(() => {
    const a = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 1, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 0.55, duration: 750, easing: Easing.inOut(Easing.quad), useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, []);
  return (
    <View style={styles.loader} accessibilityRole="progressbar" accessibilityLabel={label ?? 'Loading'}>
      <Animated.View style={{ opacity: pulse }}><BrandEmblem dark={dark} size={size} /></Animated.View>
      {label ? <Text style={[styles.label, color ? { color } : null]}>{label}</Text> : null}
    </View>
  );
}

const styles = StyleSheet.create({
  loader: { alignItems: 'center', justifyContent: 'center', gap: 10, paddingVertical: 12 },
  label: { fontSize: 13, color: '#A4ADC5' },
});
