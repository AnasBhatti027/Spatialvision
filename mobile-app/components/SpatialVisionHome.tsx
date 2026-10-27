import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, Easing, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View, useColorScheme, useWindowDimensions,
} from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import AuthScreens, { AuthUser } from './AuthScreens';
import ProjectionEditor from './ProjectionEditor';
import { useProjectionScene } from './projection';
import type { VisionStatus } from './ProjectionEditor';

// Keys for things the app remembers between launches.
const KEY_SESSION = 'sv.session';
const KEY_THEME = 'sv.themeMode'; // 'system', 'light' or 'dark'
type ThemeMode = 'system' | 'light' | 'dark';
const KEY_SERVER = 'sv.server';

type Ic = React.ComponentProps<typeof Icon>['name'];
type Route = 'home' | 'connect' | 'studio' | 'settings' | 'calibration' | 'tracking' | 'effects' | 'projects';
type Conn = 'idle' | 'connecting' | 'connected' | 'failed';
type Palette = {
  dark: boolean; bg: string; s1: string; s2: string; blue: string; cyan: string; violet: string;
  pink: string; text: string; mute: string; line: string; err: string;
};

const DARK: Palette = {
  dark: true, bg: '#080B16', s1: '#111729', s2: '#171F35', blue: '#4D7CFE', cyan: '#45D9F5', violet: '#9065FF',
  pink: '#E04FB8', text: '#F4F6FF', mute: '#A4ADC5', line: 'rgba(120,140,200,0.18)', err: '#FF7A8A',
};
const LIGHT: Palette = {
  dark: false, bg: '#F4F6FC', s1: '#FFFFFF', s2: '#EDF0FA', blue: '#254CE9', cyan: '#0A8FAE', violet: '#6D45E6',
  pink: '#C23C9B', text: '#18265B', mute: '#586386', line: 'rgba(24,38,91,0.12)', err: '#D63A4E',
};
const PRESETS = [
  { n: 'Geometric Neon', c: [DARK.blue, DARK.cyan, DARK.pink] },
  { n: 'Cyan Grid', c: [DARK.cyan, '#1B7F96', DARK.blue] },
  { n: 'Violet Prism', c: [DARK.violet, DARK.pink, DARK.blue] },
  { n: 'Fluid Light', c: [DARK.cyan, DARK.violet, DARK.blue] },
  { n: 'Heritage Gold', c: ['#E3B04B', '#2BB5A6', DARK.violet] },
];
const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 48;
const PREVIEW_BG = '#0B1022';

function makeStyles(T: Palette) {
  const lift = T.dark ? {} : { shadowColor: '#18265B', shadowOpacity: 0.07, shadowRadius: 12, shadowOffset: { width: 0, height: 4 }, elevation: 2 };
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: T.bg, paddingTop: TOP },
    scroll: { paddingHorizontal: 24, paddingBottom: 28 },
    topRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingVertical: 12 },
    topIcons: { flexDirection: 'row', alignItems: 'center', gap: 18 },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    brandT: { color: T.text, fontSize: 19, fontWeight: '800' },
    h1: { color: T.text, fontSize: 28, fontWeight: '800', letterSpacing: -0.5 },
    mute: { color: T.mute, fontSize: 14, lineHeight: 20 },
    feature: { height: 220, borderRadius: 24, backgroundColor: '#0E1430', borderWidth: 1, borderColor: 'rgba(120,140,200,0.18)', overflow: 'hidden', padding: 20, marginTop: 20, justifyContent: 'flex-end' },
    eyebrow: { color: '#45D9F5', fontSize: 11, fontWeight: '700', letterSpacing: 1.5, marginBottom: 4 },
    fh: { color: '#F4F6FF', fontSize: 22, fontWeight: '800', marginBottom: 4 },
    featMute: { color: '#A4ADC5', fontSize: 14, lineHeight: 20, maxWidth: 210 },
    card: { backgroundColor: T.s1, borderRadius: 20, borderWidth: 1, borderColor: T.line, padding: 16, marginTop: 14, ...lift },
    ct: { color: T.text, fontSize: 16, fontWeight: '700' },
    devRow: { flexDirection: 'row', alignItems: 'center', gap: 12, marginVertical: 12 },
    status: { color: T.mute, fontSize: 13, marginLeft: 'auto', fontWeight: '600' },
    grid: { flexDirection: 'row', flexWrap: 'wrap', gap: 12, marginTop: 14 },
    fcard: { backgroundColor: T.s2, borderRadius: 18, borderWidth: 1, borderColor: T.line, padding: 14, minHeight: 138 },
    ft: { color: T.text, fontSize: 15, fontWeight: '700', marginTop: 8 },
    fd: { color: T.mute, fontSize: 12, lineHeight: 17, marginTop: 2, flex: 1 },
    fa: { color: T.cyan, fontSize: 13, fontWeight: '700', marginTop: 8 },
    split: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 26 },
    btn: { minHeight: 48, borderRadius: 24, backgroundColor: T.blue, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 20 },
    ghost: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: T.blue },
    btnT: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
    btnTGhost: { color: T.blue },
    label: { color: T.mute, fontSize: 12, marginTop: 14, marginBottom: 6 },
    input: { backgroundColor: T.bg, borderWidth: 1, borderColor: T.line, borderRadius: 12, color: T.text, paddingHorizontal: 14, height: 48, fontSize: 15 },
    error: { color: T.err, fontSize: 13, marginTop: 10 },
    chips: { flexDirection: 'row', gap: 10, flexWrap: 'wrap' },
    chip: { color: T.mute, borderWidth: 1, borderColor: T.line, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14, marginRight: 8, overflow: 'hidden', fontSize: 13 },
    chipOn: { color: '#FFFFFF', backgroundColor: T.blue, borderColor: T.blue },
    preview: { height: 210, borderRadius: 20, backgroundColor: PREVIEW_BG, borderWidth: 1, borderColor: T.line, overflow: 'hidden', padding: 6 },
    badge: { position: 'absolute', bottom: 8, left: 10, color: '#45D9F5', fontSize: 10, fontWeight: '700', letterSpacing: 1, backgroundColor: 'rgba(8,11,22,0.85)', paddingVertical: 3, paddingHorizontal: 8, borderRadius: 6, overflow: 'hidden' },
    stepRow: { flexDirection: 'row', alignItems: 'center', gap: 10, marginTop: 14 },
    stepLab: { color: T.mute, width: 78, fontSize: 13 },
    step: { width: 44, height: 44, borderRadius: 22, backgroundColor: T.s2, borderWidth: 1, borderColor: T.line, alignItems: 'center', justifyContent: 'center' },
    bar: { flex: 1, height: 6, borderRadius: 3, backgroundColor: T.bg, overflow: 'hidden' },
    fill: { height: 6, backgroundColor: T.cyan },
    pad: { alignItems: 'center', gap: 8, marginVertical: 14 },
    back: { flexDirection: 'row', alignItems: 'center', paddingVertical: 8 },
    switchRow: { flexDirection: 'row', alignItems: 'center', gap: 12 },
    nav: { flexDirection: 'row', backgroundColor: T.s1, borderTopWidth: 1, borderColor: T.line, paddingTop: 8, paddingBottom: Platform.OS === 'android' ? 16 : 28 },
    navItem: { flex: 1, alignItems: 'center', gap: 2, minHeight: 52, justifyContent: 'center' },
    splashName: { color: T.text, fontSize: 34, fontWeight: '800', letterSpacing: -0.8, marginTop: 14 },
    splashSub: { color: T.cyan, fontSize: 15, fontWeight: '600', marginTop: 4 },
    tag: { color: T.mute, fontSize: 12, marginTop: 8 },
    placeholder: { position: 'absolute', bottom: 28, color: T.mute, fontSize: 10, opacity: 0.7 },
  });
}
type Styles = ReturnType<typeof makeStyles>;
const ThemeCtx = React.createContext<{ T: Palette; s: Styles }>({ T: DARK, s: makeStyles(DARK) });
const useTheme = () => useContext(ThemeCtx);

/* ---------- Placeholder artwork: a faceted sculpture built from triangles ---------- */
const Tri = ({ w, h, color, style }: { w: number; h: number; color: string; style?: object }) => (
  <View style={[{ width: 0, height: 0, borderLeftWidth: w / 2, borderRightWidth: w / 2, borderBottomWidth: h,
    borderLeftColor: 'transparent', borderRightColor: 'transparent', borderBottomColor: color }, style]} />
);
const FACETS: [number, number, number, number, string, number, number][] = [
  [70, 80, 170, 190, '#2B4FD8', 0, 1], [115, 40, 110, 150, DARK.cyan, 0, 0.8], [40, 160, 120, 110, DARK.violet, 0, 0.9],
  [150, 150, 120, 120, DARK.blue, 180, 0.85], [175, 95, 70, 90, DARK.pink, 0, 0.85], [110, 130, 90, 120, '#0E1430', 0, 0.7],
  [20, 210, 90, 70, DARK.cyan, 0, 0.5],
];
const Sculpture = ({ scale = 1 }: { scale?: number }) => (
  <View style={{ width: 300 * scale, height: 300 * scale, alignItems: 'center', justifyContent: 'center' }}>
    <View style={{ width: 300, height: 300, transform: [{ scale }] }}>
      <View style={{ position: 'absolute', left: 30, right: 30, bottom: 18, height: 30, borderRadius: 150, backgroundColor: DARK.cyan, opacity: 0.16 }} />
      {FACETS.map(([l, t, w, h, c, r, o], i) => (
        <Tri key={i} w={w} h={h} color={c} style={{ position: 'absolute', left: l, top: t, opacity: o, transform: [{ rotate: `${r}deg` }] }} />
      ))}
    </View>
  </View>
);
const Logo = ({ size = 30 }: { size?: number }) => {
  const { T } = useTheme();
  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: size * 0.7, height: size * 0.7, borderWidth: 2, borderColor: T.cyan, borderRadius: 6, transform: [{ rotate: '45deg' }] }} />
      <View style={{ position: 'absolute', width: size * 0.28, height: size * 0.28, backgroundColor: T.blue, borderRadius: 3, transform: [{ rotate: '45deg' }] }} />
    </View>
  );
};
const Pattern = ({ c, level }: { c: string[]; level: number }) => (
  <View style={{ flex: 1, flexDirection: 'row', flexWrap: 'wrap', opacity: 0.25 + level * 0.75 }}>
    {Array.from({ length: 24 }, (_, i) => (
      <View key={i} style={{ width: '16.66%', height: '25%', padding: 2 }}>
        <View style={{ flex: 1, backgroundColor: c[(i * 5 + Math.floor(i / 6)) % 3], opacity: 0.35 + ((i * 7) % 5) * 0.16, borderRadius: i % 3 === 0 ? 10 : 2 }} />
      </View>
    ))}
  </View>
);

/* ---------- Shared components ---------- */
const Btn = ({ label, onPress, icon, ghost, disabled }: { label: string; onPress: () => void; icon?: Ic; ghost?: boolean; disabled?: boolean }) => {
  const { T, s } = useTheme();
  return (
    <Pressable disabled={disabled} onPress={onPress} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [s.btn, ghost && s.ghost, disabled && { opacity: 0.45 }, pressed && { opacity: 0.8 }]}>
      {icon ? <Icon name={icon} size={18} color={ghost ? T.blue : '#FFFFFF'} /> : null}
      <Text style={[s.btnT, ghost && s.btnTGhost]}>{label}</Text>
    </Pressable>
  );
};
const Stepper = ({ label, v, set }: { label: string; v: number; set: (n: number) => void }) => {
  const { T, s } = useTheme();
  return (
    <View style={s.stepRow}>
      <Text style={s.stepLab}>{label}</Text>
      <Pressable style={s.step} onPress={() => set(Math.max(0, v - 10))} accessibilityLabel={`Decrease ${label}`}><Icon name="minus" size={18} color={T.text} /></Pressable>
      <View style={s.bar}><View style={[s.fill, { width: `${v}%` }]} /></View>
      <Pressable style={s.step} onPress={() => set(Math.min(100, v + 10))} accessibilityLabel={`Increase ${label}`}><Icon name="plus" size={18} color={T.text} /></Pressable>
    </View>
  );
};

const Splash = ({ done }: { done: () => void }) => {
  const { T, s } = useTheme();
  const art = useRef(new Animated.Value(0)).current;
  const br = useRef(new Animated.Value(0)).current;
  const out = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(art, { toValue: 1, duration: 700, useNativeDriver: true }),
      Animated.timing(br, { toValue: 1, duration: 600, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(1300),
      Animated.timing(out, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start(() => done());
  }, []);
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: T.bg, opacity: out, zIndex: 10, alignItems: 'center' }]}>
      <Animated.View style={{ opacity: art, marginTop: TOP + 70 }}>
        <View style={{ position: 'absolute', top: 40, left: 20, right: 20, height: 280, borderRadius: 140, backgroundColor: T.violet, opacity: T.dark ? 0.18 : 0.1 }} />
        <Sculpture scale={1.15} />
      </Animated.View>
      <View style={{ position: 'absolute', bottom: 0, left: 0, right: 0, height: 300, backgroundColor: T.dark ? 'rgba(8,11,22,0.6)' : 'rgba(244,246,252,0.6)' }} />
      <Animated.View style={{ position: 'absolute', bottom: 90, alignItems: 'center', opacity: br, transform: [{ scale: br.interpolate({ inputRange: [0, 1], outputRange: [0.92, 1] }) }] }}>
        <View style={{ width: 46, height: 46, alignItems: 'center', justifyContent: 'center' }}>
          <View style={{ width: 32, height: 32, borderWidth: 2, borderColor: T.cyan, borderRadius: 6, transform: [{ rotate: '45deg' }] }} />
          <View style={{ position: 'absolute', width: 13, height: 13, backgroundColor: T.blue, borderRadius: 3, transform: [{ rotate: '45deg' }] }} />
        </View>
        <Text style={s.splashName}>SpatialVision</Text>
        <Text style={s.splashSub}>Intelligent Projection Mapping</Text>
        <Text style={s.tag}>Transform surfaces. Create experiences.</Text>
      </Animated.View>
      <Text style={s.placeholder}>Placeholder artwork</Text>
    </Animated.View>
  );
};

/* ---------- App ---------- */
export default function SpatialVisionHome() {
  const { width } = useWindowDimensions();
  const colW = width < 360 ? '100%' : '48%';
  // Follows the phone's light/dark setting unless the user picks one in Settings.
  const phone = useColorScheme();
  const [themeMode, setThemeMode] = useState<ThemeMode>('system');
  const isDark = themeMode === 'system' ? phone === 'dark' : themeMode === 'dark';
  const T = isDark ? DARK : LIGHT;
  const s = useMemo(() => makeStyles(T), [isDark]);

  const [splash, setSplash] = useState(true);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loaded, setLoaded] = useState(false); // true once saved login and settings are read
  const [savedServer, setSavedServer] = useState('');
  const [route, setRouteRaw] = useState<Route>('home');
  const [backTo, setBackTo] = useState<Route>('home');
  const setRoute = (r: Route) => { setBackTo(route); setRouteRaw(r); };
  const [preset, setPreset] = useState(0);
  const [bright, setBright] = useState(70), [inten, setInten] = useState(60), [speed, setSpeed] = useState(50);
  const [playing, setPlaying] = useState(true);
  const [projects, setProjects] = useState<{ name: string; date: string }[]>([]);
  const [pname, setPname] = useState('');
  const [ip, setIp] = useState(''), [port, setPort] = useState('8000'), [code, setCode] = useState('');
  const [conn, setConn] = useState<Conn>('idle'), [err, setErr] = useState('');
  const ws = useRef<WebSocket | null>(null);
  const [tvConnected, setTvConnected] = useState(false);
  const [vision, setVision] = useState<VisionStatus>({ running: false, fps: null, detect_ms: null, error: null });
  const [lastGesture, setLastGesture] = useState('');
  // Handles messages from the backend after pairing. Kept in a ref so it always sees the newest state.
  const onServerMessage = useRef<(m: any) => void>(() => {});
  const [dragging, setDragging] = useState(false);
  const [tracking, setTracking] = useState(false);
  const pulse = useRef(new Animated.Value(1)).current;
  const track = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!playing) { pulse.setValue(1); return; }
    const a = Animated.loop(Animated.sequence([
      Animated.timing(pulse, { toValue: 0.55, duration: 2200 - speed * 15, useNativeDriver: true }),
      Animated.timing(pulse, { toValue: 1, duration: 2200 - speed * 15, useNativeDriver: true }),
    ]));
    a.start();
    return () => a.stop();
  }, [playing, speed]);

  useEffect(() => {
    if (!tracking) { track.setValue(0); return; }
    const a = Animated.loop(Animated.timing(track, { toValue: 1, duration: 3500, easing: Easing.linear, useNativeDriver: true }));
    a.start();
    return () => a.stop();
  }, [tracking]);

  useEffect(() => () => { ws.current?.close(); }, []);

  // On launch: restore theme, last server address and the saved login.
  useEffect(() => {
    (async () => {
      try {
        const [theme, server, raw] = await Promise.all([
          AsyncStorage.getItem(KEY_THEME), AsyncStorage.getItem(KEY_SERVER), AsyncStorage.getItem(KEY_SESSION),
        ]);
        if (theme === 'light' || theme === 'dark' || theme === 'system') setThemeMode(theme);
        if (server) { setSavedServer(server); fillConnect(server); }
        const saved: AuthUser | null = raw ? JSON.parse(raw) : null;
        if (saved?.token && saved.server) {
          // Ask the backend if the saved login is still valid. If the PC is off, keep the user signed in.
          try {
            const res = await fetch(`http://${saved.server}/auth/me`, { headers: { Authorization: `Bearer ${saved.token}` } });
            if (res.status === 401) { await AsyncStorage.removeItem(KEY_SESSION); setLoaded(true); return; }
          } catch {}
        }
        if (saved) setUser(saved);
      } catch {}
      setLoaded(true);
    })();
  }, []);

  useEffect(() => { if (loaded) AsyncStorage.setItem(KEY_THEME, themeMode).catch(() => {}); }, [themeMode, loaded]);

  // Pre-fills the Connect screen from an address like "192.168.10.13:8000".
  const fillConnect = (server: string) => {
    const [h, p] = server.split(':');
    if (h && h !== 'localhost') setIp(h);
    if (p) setPort(p);
  };

  const login = (u: AuthUser) => {
    setUser(u);
    setRouteRaw('home');
    if (u.server) { setSavedServer(u.server); fillConnect(u.server); AsyncStorage.setItem(KEY_SERVER, u.server).catch(() => {}); }
    AsyncStorage.setItem(KEY_SESSION, JSON.stringify(u)).catch(() => {});
  };

  const logout = async () => {
    if (user?.token && user.server) {
      fetch(`http://${user.server}/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${user.token}` } }).catch(() => {});
    }
    disconnect();
    await AsyncStorage.removeItem(KEY_SESSION).catch(() => {});
    setUser(null);
    setRouteRaw('home');
  };

  const connect = () => {
    if (!/^(\d{1,3}\.){3}\d{1,3}$/.test(ip.trim())) { setConn('failed'); setErr('Enter a valid IPv4 address, e.g. 192.168.1.20'); return; }
    if (!/^\d{4}$/.test(code)) { setConn('failed'); setErr('Enter the 4-digit pairing code shown by the display.'); return; }
    setConn('connecting'); setErr('');
    let ok = false;
    const sock = new WebSocket(`ws://${ip.trim()}:${port}/ws/phone?code=${code}`);
    ws.current = sock;
    const t = setTimeout(() => { if (!ok) { sock.close(); setConn('failed'); setErr('No response. Check the IP, port and Wi-Fi.'); } }, 6000);
    sock.onmessage = (e) => {
      try {
        const m = JSON.parse(e.data as string);
        if (m.type === 'paired') { ok = true; clearTimeout(t); setConn('connected'); setTvConnected(!!m.tv_connected); }
        else if (m.type === 'tv_status') setTvConnected(!!m.connected);
        else if (m.type === 'error') { clearTimeout(t); setConn('failed'); setErr(m.message); }
        else onServerMessage.current(m);
      } catch {}
    };
    sock.onerror = () => { clearTimeout(t); setConn('failed'); setErr('Could not reach the server.'); };
    sock.onclose = () => { setTvConnected(false); setVision({ running: false, fps: null, detect_ms: null, error: null }); if (ok) setConn('idle'); };
  };
  const disconnect = () => { ws.current?.close(); ws.current = null; setConn('idle'); };
  // Sends a message to the TV through the backend. Returns false when not connected.
  const send = (msg: object) => {
    if (ws.current?.readyState !== WebSocket.OPEN) return false;
    ws.current.send(JSON.stringify(msg));
    return true;
  };
  const resetAll = () => { setPreset(0); setBright(70); setInten(60); setSpeed(50); setProjects([]); proj.resetAll(); };

  const connected = conn === 'connected';
  const proj = useProjectionScene(send, connected);
  onServerMessage.current = (m) => {
    if (m.type === 'scene') proj.applyRemote(m);
    else if (m.type === 'vision_status') setVision({ running: !!m.running, fps: m.fps ?? null, detect_ms: m.detect_ms ?? null, error: m.error ?? null });
    else if (m.type === 'gesture') setLastGesture(m.name);
  };
  const P = PRESETS[preset];
  const level = (bright / 100) * (0.4 + inten / 160);
  const tab = (['home', 'connect', 'studio', 'settings'] as Route[]).includes(route) ? route : route === 'projects' ? 'home' : 'studio';
  const NAV: [Route, string, Ic][] = [['home', 'Home', 'home-variant'], ['connect', 'Connect', 'lan-connect'], ['studio', 'Studio', 'cube-scan'], ['settings', 'Settings', 'cog-outline']];
  const Head = ({ t, sub }: { t: string; sub: string }) => (
    <View style={{ marginBottom: 16 }}>
      {route !== 'connect' && route !== 'studio' && route !== 'settings' && route !== 'home' ? (
        <Pressable onPress={() => setRouteRaw(backTo === route ? 'home' : backTo)} style={s.back} accessibilityLabel="Back">
          <Icon name="chevron-left" size={22} color={T.cyan} /><Text style={{ color: T.cyan }}>Back</Text>
        </Pressable>
      ) : null}
      <Text style={s.h1}>{t}</Text><Text style={s.mute}>{sub}</Text>
    </View>
  );
  const Tag = ({ t }: { t: string }) => <Text style={s.badge}>{t}</Text>;

  return (
    <ThemeCtx.Provider value={{ T, s }}>
      <View style={s.root}>
        <StatusBar barStyle={isDark ? 'light-content' : 'dark-content'} />
        {loaded && !user && <AuthScreens T={T} onDone={login} initialServer={savedServer} />}
        {user && (<>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} scrollEnabled={!dragging}>
          {route === 'home' && (<>
            <View style={s.topRow}>
              <View style={s.brand}><Logo /><Text style={s.brandT}>SpatialVision</Text></View>
              <View style={s.topIcons}>
                <Pressable onPress={() => setThemeMode(isDark ? 'light' : 'dark')} hitSlop={10} accessibilityRole="button" accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
                  <Icon name={isDark ? 'white-balance-sunny' : 'weather-night'} size={24} color={T.mute} />
                </Pressable>
                <Pressable onPress={() => setRoute('settings')} hitSlop={10} accessibilityLabel="Settings"><Icon name="cog-outline" size={24} color={T.mute} /></Pressable>
              </View>
            </View>
            <Text style={s.h1}>Your Spatial Studio</Text><Text style={s.mute}>Connect, calibrate, and create.</Text>

            <View style={s.feature}>
              <View style={{ position: 'absolute', right: -50, top: -20 }}><Sculpture scale={0.85} /></View>
              <View style={[StyleSheet.absoluteFill, { backgroundColor: 'rgba(8,11,22,0.55)' }]} />
              <Text style={s.eyebrow}>PROJECTION STUDIO</Text>
              <Text style={s.fh}>Bring surfaces to life</Text>
              <Text style={s.featMute}>Create and control immersive projection experiences.</Text>
              <View style={{ marginTop: 14, alignSelf: 'flex-start' }}><Btn label="Open Studio" icon="arrow-top-right" onPress={() => setRoute('studio')} /></View>
            </View>

            <View style={s.card}>
              <Text style={s.ct}>Device Connection</Text>
              <View style={s.devRow}>
                <Icon name="cellphone" size={26} color={T.text} /><Icon name="wifi" size={18} color={connected ? T.cyan : T.mute} />
                <Icon name="monitor" size={26} color={T.text} />
                <Text style={[s.status, { color: connected ? T.cyan : T.mute }]}>{connected ? 'Connected to PC' : 'Not Connected'}</Text>
              </View>
              <Btn label={connected ? 'Manage Connection' : 'Connect Device'} onPress={() => setRoute('connect')} />
            </View>

            <View style={s.grid}>
              {([
                ['Projection Mapping', 'Preview and manage projection content.', 'Open Studio', 'cube-outline', 'studio'],
                ['Projection Editor', 'Map an image onto a surface.', 'Open Editor', 'vector-square', 'calibration'],
                ['Object Tracking', 'Access the tracking interface.', 'Start Tracking', 'crosshairs-gps', 'tracking'],
                ['Effects and Presets', 'Colors, patterns and animation presets.', 'Explore', 'palette-swatch-outline', 'effects'],
                ['Projects', 'Organize saved projects.', 'View Projects', 'folder-outline', 'projects'],
              ] as [string, string, string, Ic, Route][]).map(([t, d, a, ic, r]) => (
                <Pressable key={t} style={[s.fcard, { width: colW }]} onPress={() => setRoute(r)} accessibilityRole="button" accessibilityLabel={`${t}. ${a}`}>
                  <Icon name={ic} size={24} color={T.cyan} />
                  <Text style={s.ft}>{t}</Text><Text style={s.fd}>{d}</Text>
                  <Text style={s.fa}>{a}</Text>
                </Pressable>
              ))}
            </View>

            <View style={s.split}><Text style={s.ct}>Recent Projects</Text>
              <Pressable onPress={() => setRoute('projects')}><Text style={{ color: T.cyan }}>View All</Text></Pressable></View>
            {projects.length === 0 ? (
              <View style={s.card}><Text style={s.mute}>No projects yet. Create your first one to see it here.</Text>
                <View style={{ marginTop: 12, alignSelf: 'flex-start' }}><Btn label="Create Project" icon="plus" onPress={() => setRoute('projects')} /></View></View>
            ) : projects.slice(0, 2).map((p, i) => (
              <View key={i} style={[s.card, { marginTop: 8 }]}><Text style={s.ct}>{p.name}</Text><Text style={s.mute}>Created {p.date}</Text></View>
            ))}
          </>)}

          {route === 'connect' && (<>
            <Head t="Connect" sub="Pair this phone with the PC running the SpatialVision backend." />
            <View style={s.card}>
              <View style={s.chips}>
                <Text style={[s.chip, s.chipOn]}>Manual IP</Text>
                <Text style={[s.chip, { opacity: 0.4 }]}>Auto-discover (coming soon)</Text>
              </View>
              <Text style={s.label}>PC IP address</Text>
              <TextInput style={s.input} value={ip} onChangeText={setIp} placeholder="192.168.1.20" placeholderTextColor={T.mute} keyboardType="numbers-and-punctuation" autoCapitalize="none" />
              <Text style={s.label}>Port</Text>
              <TextInput style={s.input} value={port} onChangeText={setPort} keyboardType="number-pad" placeholderTextColor={T.mute} />
              <Text style={s.label}>Pairing code</Text>
              <TextInput style={s.input} value={code} onChangeText={setCode} placeholder="4 digits" placeholderTextColor={T.mute} keyboardType="number-pad" maxLength={4} />
              {conn === 'failed' && <Text style={s.error}>{err}</Text>}
              {conn === 'connected' && <Text style={[s.status, { color: T.cyan, marginLeft: 0, marginTop: 10 }]}>Paired with the backend.</Text>}
              <View style={{ marginTop: 14 }}>
                {connected ? <Btn label="Disconnect" ghost onPress={disconnect} />
                  : <Btn label={conn === 'connecting' ? 'Connecting...' : conn === 'failed' ? 'Retry' : 'Connect'} disabled={conn === 'connecting'} onPress={connect} />}
              </View>
            </View>
          </>)}

          {route === 'studio' && (<>
            <Head t="Projection Studio" sub="Preview content before it reaches a display." />
            <View style={s.preview}>
              <Animated.View style={{ flex: 1, opacity: pulse }}><Pattern c={P.c} level={level} /></Animated.View>
              <Tag t={connected ? 'CONNECTED TO PC, NO PROJECTOR OUTPUT YET' : 'SIMULATED PREVIEW'} />
            </View>
            <View style={[s.card, { marginTop: 14 }]}>
              <Btn label={playing ? 'Pause' : 'Play'} icon={playing ? 'pause' : 'play'} ghost onPress={() => setPlaying(!playing)} />
              <Stepper label="Brightness" v={bright} set={setBright} />
              <Stepper label="Intensity" v={inten} set={setInten} />
              <Stepper label="Speed" v={speed} set={setSpeed} />
            </View>
            <Text style={s.label}>Preset</Text>
            <ScrollView horizontal showsHorizontalScrollIndicator={false}>
              {PRESETS.map((p, i) => <Pressable key={p.n} onPress={() => setPreset(i)} accessibilityLabel={p.n}><Text style={[s.chip, i === preset && s.chipOn]}>{p.n}</Text></Pressable>)}
            </ScrollView>
            <View style={[s.chips, { marginTop: 14 }]}>
              <Btn label="Editor" ghost icon="vector-square" onPress={() => setRoute('calibration')} />
              <Btn label="Tracking" ghost icon="crosshairs-gps" onPress={() => setRoute('tracking')} />
            </View>
          </>)}

          {route === 'calibration' && (<>
            <Head t="Projection Editor" sub="Drag the corners onto the surface. The TV updates live." />
            <ProjectionEditor T={T} scene={proj.scene} update={proj.update} setCorners={proj.setCorners} reset={proj.reset}
              connected={connected} tvConnected={tvConnected} server={`${ip.trim()}:${port}`} token={user?.token}
              onGoConnect={() => setRoute('connect')} onDragging={setDragging}
              vision={vision} lastGesture={lastGesture} onGestures={(on) => send({ type: on ? 'start_gestures' : 'stop_gestures' })} />
          </>)}

          {route === 'tracking' && (<>
            <Head t="Object Tracking" sub="Simulation mode. The live camera pipeline is not built yet." />
            <View style={[s.preview, { height: 200 }]}>
              {tracking && (
                <Animated.View style={{ position: 'absolute', width: 64, height: 64, borderWidth: 2, borderColor: DARK.cyan, borderRadius: 8,
                  transform: [{ translateX: track.interpolate({ inputRange: [0, 0.5, 1], outputRange: [20, 220, 20] }) }, { translateY: track.interpolate({ inputRange: [0, 0.5, 1], outputRange: [30, 100, 30] }) }] }} />
              )}
              {!tracking && (
                <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
                  <Text style={{ color: DARK.mute, fontSize: 14 }}>Tracking is off</Text>
                </View>
              )}
              <Tag t="SIMULATED, NO CAMERA FEED" />
            </View>
            <View style={{ marginTop: 14 }}><Btn label={tracking ? 'Stop Tracking' : 'Start Tracking'} icon={tracking ? 'stop' : 'play'} onPress={() => setTracking(!tracking)} /></View>
          </>)}

          {route === 'effects' && (<>
            <Head t="Effects and Presets" sub="Tap a preset to select it for the Studio preview." />
            {PRESETS.map((p, i) => (
              <Pressable key={p.n} onPress={() => setPreset(i)} accessibilityRole="button" accessibilityLabel={p.n}
                style={[s.card, { marginBottom: 10, marginTop: 0, flexDirection: 'row', alignItems: 'center', gap: 14 }, i === preset && { borderColor: T.blue }]}>
                <View style={{ width: 96, height: 56, borderRadius: 10, overflow: 'hidden', backgroundColor: PREVIEW_BG }}><Pattern c={p.c} level={0.8} /></View>
                <Text style={[s.ct, { flex: 1 }]}>{p.n}</Text>
                {i === preset && <Icon name="check-circle" size={22} color={T.cyan} />}
              </Pressable>
            ))}
          </>)}

          {route === 'projects' && (<>
            <Head t="Projects" sub="Saved in memory for now. They reset when the app closes." />
            <View style={s.card}>
              <TextInput style={s.input} value={pname} onChangeText={setPname} placeholder="Project name" placeholderTextColor={T.mute} />
              <View style={{ marginTop: 12 }}>
                <Btn label="Create Project" icon="plus" disabled={!pname.trim()} onPress={() => { setProjects([{ name: pname.trim(), date: new Date().toLocaleDateString() }, ...projects]); setPname(''); }} />
              </View>
            </View>
            {projects.length === 0 ? <Text style={[s.mute, { marginTop: 16 }]}>No projects yet.</Text>
              : projects.map((p, i) => <View key={i} style={[s.card, { marginTop: 10 }]}><Text style={s.ct}>{p.name}</Text><Text style={s.mute}>Created {p.date}</Text></View>)}
          </>)}

          {route === 'settings' && (<>
            <Head t="Settings" sub="App information and preferences." />
            <View style={s.card}>
              <View style={s.switchRow}>
                <Icon name="account-circle-outline" size={28} color={T.cyan} />
                <View style={{ flex: 1 }}>
                  <Text style={s.ct}>{user?.demo ? 'Demo mode' : `@${user?.username}`}</Text>
                  <Text style={s.mute}>{user?.demo ? 'No account. Nothing is saved on the server.' : `Signed in on ${user?.server ?? 'this device'}`}</Text>
                </View>
              </View>
              <View style={{ marginTop: 14 }}>
                <Btn label={user?.demo ? 'Exit demo mode' : 'Log out'} ghost icon="logout" onPress={logout} />
              </View>
            </View>
            <View style={s.card}>
              <View style={s.switchRow}>
                <Icon name={isDark ? 'weather-night' : 'white-balance-sunny'} size={24} color={T.cyan} />
                <View style={{ flex: 1 }}>
                  <Text style={s.ct}>Appearance</Text>
                  <Text style={s.mute}>{themeMode === 'system' ? `Following your phone (${isDark ? 'dark' : 'light'})` : isDark ? 'Dark' : 'Light'}</Text>
                </View>
              </View>
              <View style={[s.chips, { marginTop: 12 }]}>
                {([['system', 'Phone setting'], ['light', 'Light'], ['dark', 'Dark']] as [ThemeMode, string][]).map(([m, l]) => (
                  <Pressable key={m} onPress={() => setThemeMode(m)} accessibilityRole="button" accessibilityState={{ selected: themeMode === m }} accessibilityLabel={`Appearance: ${l}`}>
                    <Text style={[s.chip, themeMode === m && s.chipOn]}>{l}</Text>
                  </Pressable>
                ))}
              </View>
            </View>
            <View style={s.card}>
              <Text style={s.ct}>SpatialVision</Text><Text style={s.mute}>Version 1.0.0 (student prototype)</Text>
              <Text style={[s.mute, { marginTop: 8 }]}>Target display: Haier Android TV. Projector output is coming soon.</Text>
            </View>
            <View style={s.card}>
              <Text style={s.ct}>Connection</Text><Text style={s.mute}>{connected ? `Connected to ${ip}:${port}` : 'Not connected'}</Text>
            </View>
            <View style={{ marginTop: 16 }}><Btn label="Reset app data" ghost icon="restore" onPress={resetAll} /></View>
          </>)}
        </ScrollView>

        <View style={s.nav}>
          {NAV.map(([r, l, ic]) => (
            <Pressable key={r} style={s.navItem} onPress={() => setRoute(r)} accessibilityRole="button" accessibilityState={{ selected: tab === r }} accessibilityLabel={l}>
              <Icon name={ic} size={24} color={tab === r ? T.blue : T.mute} />
              <Text style={{ fontSize: 11, color: tab === r ? T.blue : T.mute, fontWeight: tab === r ? '700' : '500' }}>{l}</Text>
            </Pressable>
          ))}
        </View>
        </>)}
        {splash && <Splash done={() => setSplash(false)} />}
      </View>
    </ThemeCtx.Provider>
  );
}