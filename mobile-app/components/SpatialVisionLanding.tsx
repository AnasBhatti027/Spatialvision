import React, { useState, useRef, useEffect } from 'react';
import {
  StyleSheet, Text, View, TouchableOpacity, SafeAreaView, StatusBar,
  Alert, Linking, ScrollView, Animated, Easing, Dimensions,
} from 'react-native';
import { MaterialCommunityIcons, Ionicons, FontAwesome5 } from '@expo/vector-icons';

const APP_NAME = 'SpatialVision'; // change to 'spatialvision' if your team keeps the old name

// Palette taken from a projector's own test screen: no-signal blue + colour-bar primaries.
const C = {
  bg: '#081033',      // projector blue (base)
  stage: '#050A24',   // darker well the stage sits in
  panel: '#0F1A4D',
  line: '#26358F',
  text: '#F2F5FF',
  muted: '#8E9BD6',
  yellow: '#FFD23F',  // primary action
  cyan: '#3DDCFF',    // scanning / warp
  magenta: '#FF4FA3', // misaligned / presets
  green: '#4DFF9A',   // locked
};
const BARS = ['#E8ECFF', C.yellow, C.cyan, C.green, C.magenta, '#FF4B3E', '#3B5BFF'];

const W = Dimensions.get('window').width - 40;
const QUAD_W = W * 0.7;
const QUAD_H = 150;

type CalState = 'idle' | 'scanning' | 'locked';

const MODES: { key: string; title: string; desc: string; icon: any; color: string }[] = [
  { key: 'warp', title: 'Surface warp', desc: 'Fine-tune corners and edges', icon: 'vector-square', color: C.cyan },
  { key: 'gestures', title: 'Gestures', desc: 'Point, pinch, swipe', icon: 'gesture-swipe', color: C.yellow },
  { key: 'presets', title: 'Presets', desc: 'Scenes and saved layouts', icon: 'layers-outline', color: C.magenta },
  { key: 'games', title: 'Mini-games', desc: 'Play on the object', icon: 'gamepad-variant-outline', color: C.green },
];

const COPY = {
  idle: { head: 'Not calibrated', sub: 'Aim the camera at your object, then calibrate.' },
  scanning: { head: 'Finding the surface', sub: 'Hold still while markers are projected.' },
  locked: { head: 'Surface locked', sub: 'Tracking follows the object. Gestures are on.' },
};

const Logo = () => (
  <View style={styles.logo}>
    {[C.yellow, C.cyan, C.magenta, C.green].map((c, i) => (
      <View key={c} style={{ width: 5, height: 10 + (i % 2 ? 8 : 16), backgroundColor: c, borderRadius: 2 }} />
    ))}
  </View>
);

// Corner-pin brackets: the card border is the same gesture as pinning a projection corner.
const Brackets = ({ color }: { color: string }) => (
  <>
    {[
      { top: 0, left: 0, borderTopWidth: 2, borderLeftWidth: 2 },
      { top: 0, right: 0, borderTopWidth: 2, borderRightWidth: 2 },
      { bottom: 0, left: 0, borderBottomWidth: 2, borderLeftWidth: 2 },
      { bottom: 0, right: 0, borderBottomWidth: 2, borderRightWidth: 2 },
    ].map((s, i) => (
      <View key={i} style={[styles.bracket, { borderColor: color }, s]} />
    ))}
  </>
);

export default function SpatialVisionHome() {
  const [isConnected, setIsConnected] = useState(false);
  const [cal, setCal] = useState<CalState>('idle');
  const lock = useRef(new Animated.Value(0)).current;
  const scan = useRef(new Animated.Value(0)).current;
  const timer = useRef<any>(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  useEffect(() => {
    Animated.timing(lock, {
      toValue: cal === 'locked' ? 1 : 0,
      duration: 700,
      easing: Easing.out(Easing.cubic),
      useNativeDriver: true,
    }).start();
    if (cal === 'scanning') {
      scan.setValue(0);
      Animated.loop(
        Animated.timing(scan, { toValue: 1, duration: 1100, easing: Easing.inOut(Easing.quad), useNativeDriver: true })
      ).start();
    } else {
      scan.stopAnimation();
    }
  }, [cal]);

  const toggleLink = () => {
    setIsConnected((v) => !v);
    setCal('idle');
  };

  const calibrate = () => {
    if (!isConnected) {
      Alert.alert('Not connected', 'Connect to the projector PC first.');
      return;
    }
    // TODO: send "start_calibration" over the WebSocket; set 'locked' when the backend reports success.
    setCal('scanning');
    timer.current = setTimeout(() => setCal('locked'), 2400);
  };

  const soon = (name: string) => Alert.alert(name, 'This screen will open here.');

  const pin = cal === 'locked' ? C.green : cal === 'scanning' ? C.cyan : C.magenta;
  const rotY = lock.interpolate({ inputRange: [0, 1], outputRange: ['-26deg', '-9deg'] });
  const rotZ = lock.interpolate({ inputRange: [0, 1], outputRange: ['5deg', '0deg'] });
  const scanY = scan.interpolate({ inputRange: [0, 1], outputRange: [0, QUAD_H - 2] });
  const stats = cal === 'locked' ? ['58', '34 ms', '0.8 px'] : ['--', '--', '--'];

  return (
    <SafeAreaView style={styles.container}>
      <StatusBar barStyle="light-content" backgroundColor={C.bg} />

      <View style={styles.header}>
        <View style={styles.brand}>
          <Logo />
          <Text style={styles.brandText}>{APP_NAME}</Text>
        </View>
        <TouchableOpacity style={styles.linkChip} onPress={toggleLink} activeOpacity={0.8}>
          <View style={[styles.dot, { backgroundColor: isConnected ? C.green : C.magenta }]} />
          <Text style={styles.linkText}>{isConnected ? 'PC connected' : 'Connect to PC'}</Text>
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.scroll} showsVerticalScrollIndicator={false}>
        {/* Stage: corner pins snap into place when calibration locks. */}
        <View style={styles.stageWrap}>
          <View style={styles.barRow}>
            {BARS.map((c) => <View key={c} style={{ flex: 1, backgroundColor: c }} />)}
          </View>
          <View style={styles.stage}>
            <Animated.View
              style={[
                styles.quad,
                {
                  borderColor: pin,
                  backgroundColor: cal === 'locked' ? 'rgba(77,255,154,0.10)' : 'rgba(61,220,255,0.05)',
                  transform: [{ perspective: 700 }, { rotateY: rotY }, { rotateZ: rotZ }],
                },
              ]}
            >
              {[1, 2, 3, 4, 5, 6].map((i) => (
                <View key={`v${i}`} style={[styles.gridV, { left: `${(i * 100) / 7}%`, backgroundColor: pin }]} />
              ))}
              {[1, 2, 3, 4].map((i) => (
                <View key={`h${i}`} style={[styles.gridH, { top: `${(i * 100) / 5}%`, backgroundColor: pin }]} />
              ))}
              {cal === 'scanning' && (
                <Animated.View style={[styles.scanLine, { transform: [{ translateY: scanY }] }]} />
              )}
              {[
                { top: -8, left: -8 }, { top: -8, right: -8 },
                { bottom: -8, left: -8 }, { bottom: -8, right: -8 },
              ].map((p, i) => (
                <View key={i} style={[styles.pin, p, { backgroundColor: pin }]} />
              ))}
            </Animated.View>
          </View>
        </View>

        <Text style={styles.headline}>{COPY[cal].head}</Text>
        <Text style={styles.sub}>{COPY[cal].sub}</Text>

        <TouchableOpacity
          style={[styles.cta, cal === 'scanning' && { opacity: 0.55 }]}
          onPress={calibrate}
          disabled={cal === 'scanning'}
          activeOpacity={0.85}
        >
          <MaterialCommunityIcons name="cube-scan" size={22} color={C.bg} />
          <Text style={styles.ctaText}>
            {cal === 'scanning' ? 'Calibrating' : cal === 'locked' ? 'Recalibrate' : 'Calibrate surface'}
          </Text>
        </TouchableOpacity>

        {/* Live numbers, filled by the backend over WebSocket */}
        <View style={styles.statRow}>
          {[['Frames per second', stats[0]], ['Latency', stats[1]], ['Alignment error', stats[2]]].map(([label, val], i) => (
            <View key={label} style={[styles.stat, i > 0 && styles.statDivider]}>
              <Text style={styles.statVal}>{val}</Text>
              <Text style={styles.statLabel}>{label}</Text>
            </View>
          ))}
        </View>

        <Text style={styles.section}>What do you want to do?</Text>
        <View style={styles.grid}>
          {MODES.map((m) => (
            <TouchableOpacity key={m.key} style={styles.tile} onPress={() => soon(m.title)} activeOpacity={0.8}>
              <Brackets color={m.color} />
              <MaterialCommunityIcons name={m.icon} size={26} color={m.color} />
              <Text style={styles.tileTitle}>{m.title}</Text>
              <Text style={styles.tileDesc}>{m.desc}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <TouchableOpacity style={styles.guide} onPress={() => soon('Setup guide')}>
          <Ionicons name="book-outline" size={20} color={C.yellow} />
          <Text style={styles.guideText}>Setup and calibration guide</Text>
          <Ionicons name="chevron-forward" size={18} color={C.muted} style={{ marginLeft: 'auto' }} />
        </TouchableOpacity>

        <View style={styles.helpRow}>
          {[
            ['email-outline', 'Email', 'mailto:support@spatialvision.app', C.cyan, 'mci'],
            ['whatsapp', 'WhatsApp', 'https://wa.me/1234567890', '#25D366', 'fa'],
            ['instagram', 'Instagram', 'https://instagram.com', '#E1306C', 'fa'],
            ['facebook', 'Facebook', 'https://facebook.com', '#5B8DFF', 'fa'],
          ].map(([icon, label, url, color, kind]) => (
            <TouchableOpacity key={label} style={styles.helpBtn} onPress={() => Linking.openURL(url)}>
              {kind === 'mci'
                ? <MaterialCommunityIcons name={icon as any} size={20} color={color} />
                : <FontAwesome5 name={icon as any} size={18} color={color} />}
              <Text style={styles.helpLabel}>{label}</Text>
            </TouchableOpacity>
          ))}
        </View>

        <Text style={styles.version}>{APP_NAME} v1.0.0</Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: C.bg },
  header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, paddingTop: 16, paddingBottom: 10 },
  brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  logo: { flexDirection: 'row', alignItems: 'flex-end', gap: 3, height: 26 },
  brandText: { color: C.text, fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },
  linkChip: { flexDirection: 'row', alignItems: 'center', gap: 8, borderWidth: 1, borderColor: C.line, backgroundColor: C.panel, paddingVertical: 8, paddingHorizontal: 14, borderRadius: 20 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  linkText: { color: C.text, fontSize: 13, fontWeight: '600' },
  scroll: { paddingHorizontal: 20, paddingTop: 8, paddingBottom: 40 },

  stageWrap: { borderWidth: 1, borderColor: C.line },
  barRow: { flexDirection: 'row', height: 7 },
  stage: { height: 230, backgroundColor: C.stage, alignItems: 'center', justifyContent: 'center' },
  quad: { width: QUAD_W, height: QUAD_H, borderWidth: 2 },
  gridV: { position: 'absolute', top: 0, bottom: 0, width: 1, opacity: 0.22 },
  gridH: { position: 'absolute', left: 0, right: 0, height: 1, opacity: 0.22 },
  scanLine: { position: 'absolute', left: 0, right: 0, height: 2, backgroundColor: C.cyan },
  pin: { position: 'absolute', width: 16, height: 16, borderRadius: 8, borderWidth: 3, borderColor: C.stage },

  headline: { color: C.text, fontSize: 36, fontWeight: '800', letterSpacing: -1, marginTop: 22 },
  sub: { color: C.muted, fontSize: 15, lineHeight: 21, marginTop: 4 },
  cta: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 10, backgroundColor: C.yellow, paddingVertical: 16, marginTop: 18 },
  ctaText: { color: C.bg, fontSize: 17, fontWeight: '800' },

  statRow: { flexDirection: 'row', marginTop: 20, paddingVertical: 14, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.line },
  stat: { flex: 1, alignItems: 'center' },
  statDivider: { borderLeftWidth: 1, borderLeftColor: C.line },
  statVal: { color: C.text, fontSize: 20, fontWeight: '700' },
  statLabel: { color: C.muted, fontSize: 11, marginTop: 2 },

  section: { color: C.text, fontSize: 20, fontWeight: '700', marginTop: 30, marginBottom: 14 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 14 },
  tile: { flexBasis: '47%', flexGrow: 1, padding: 16, minHeight: 124, gap: 4, backgroundColor: C.panel },
  bracket: { position: 'absolute', width: 14, height: 14 },
  tileTitle: { color: C.text, fontSize: 16, fontWeight: '700', marginTop: 10 },
  tileDesc: { color: C.muted, fontSize: 13, lineHeight: 18 },

  guide: { flexDirection: 'row', alignItems: 'center', gap: 12, marginTop: 24, paddingVertical: 16, borderTopWidth: 1, borderBottomWidth: 1, borderColor: C.line },
  guideText: { color: C.text, fontSize: 15, fontWeight: '600' },
  helpRow: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 20 },
  helpBtn: { alignItems: 'center', gap: 6, flex: 1 },
  helpLabel: { color: C.muted, fontSize: 12 },
  version: { color: C.muted, fontSize: 12, textAlign: 'center', marginTop: 28, opacity: 0.7 },
});