import { useSafeAreaInsets } from 'react-native-safe-area-context';
import React, { useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated, BackHandler, Easing, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View, useColorScheme, useWindowDimensions,
} from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as NavBar from 'expo-navigation-bar';
import AuthScreens, { AuthUser } from './AuthScreens';
import { BrandEmblem, BrandLoader, BrandLogo } from './Brand';
import ProjectionEditor from './ProjectionEditor';
import { useProjectionScene } from './projection';
import type { PresetItem, VisionStatus } from './ProjectionEditor';

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
  });
}
type Styles = ReturnType<typeof makeStyles>;
const ThemeCtx = React.createContext<{ T: Palette; s: Styles }>({ T: DARK, s: makeStyles(DARK) });
const useTheme = () => useContext(ThemeCtx);

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
  const { T } = useTheme();
  const { width } = useWindowDimensions();
  const show = useRef(new Animated.Value(0)).current;
  const out = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    Animated.sequence([
      Animated.timing(show, { toValue: 1, duration: 700, easing: Easing.out(Easing.cubic), useNativeDriver: true }),
      Animated.delay(1400),
      Animated.timing(out, { toValue: 0, duration: 500, useNativeDriver: true }),
    ]).start(() => done());
  }, []);
  // The official logo for the current theme: light text in Dark Mode, dark text in Light Mode.
  return (
    <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: T.bg, opacity: out, zIndex: 10, alignItems: 'center', justifyContent: 'center' }]}>
      <Animated.View style={{ opacity: show, transform: [{ scale: show.interpolate({ inputRange: [0, 1], outputRange: [0.94, 1] }) }] }}>
        <BrandLogo dark={T.dark} width={Math.min(width - 64, 340)} />
      </Animated.View>
    </Animated.View>
  );
};

/* ---------- App ---------- */
export default function SpatialVisionHome() {
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();

  // The Android navigation bar is hidden (App.tsx) and appears when the user swipes up from the bottom.
  // The tab bar sits at the very bottom while it is hidden and slides up above it while it shows.
  const [navShown, setNavShown] = useState(false);
  const navLift = useRef(new Animated.Value(0)).current;
  const NAV_BAR_FALLBACK = 48; // used only if Android reports no height for the bar while it shows
  const navBarHeight = insets.bottom > 0 ? insets.bottom : NAV_BAR_FALLBACK;
  useEffect(() => {
    if (Platform.OS !== 'android') return;
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const sub = NavBar.addVisibilityListener(({ visibility }) => {
      const shown = visibility === 'visible';
      setNavShown(shown);
      clearTimeout(hideTimer);
      // Hide the bar again after a few seconds if Android leaves it showing.
      if (shown) hideTimer = setTimeout(() => { NavBar.setVisibilityAsync('hidden').catch(() => {}); }, 3000);
    });
    return () => { clearTimeout(hideTimer); sub.remove(); };
  }, []);
  useEffect(() => {
    Animated.timing(navLift, {
      toValue: Platform.OS === 'android' ? (navShown ? navBarHeight : 0) : insets.bottom,
      duration: 220, easing: Easing.out(Easing.cubic), useNativeDriver: false,
    }).start();
  }, [navShown, navBarHeight]);
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
  // Pages visited, so the phone's back button (and the on-screen Back) go one step back at a time
  // until Home; on Home, back closes the app as usual.
  const [history, setHistory] = useState<Route[]>([]);
  const setRoute = (r: Route) => {
    if (r === route) return;
    if (r === 'home') { setHistory([]); setRouteRaw('home'); return; } // Home starts fresh
    setHistory((h) => [...h, route]);
    setRouteRaw(r);
  };
  const goBack = (): boolean => {
    if (route === 'home') return false; // let Android close the app
    const prev = history.length ? history[history.length - 1] : 'home';
    setHistory(history.slice(0, -1));
    setRouteRaw(prev);
    return true;
  };
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

  // Android's back button: one page back at a time. Read through a ref so it always sees the current page.
  const backRef = useRef(goBack);
  backRef.current = goBack;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => backRef.current());
    return () => sub.remove();
  }, []);

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
          // At most 4 s: if the PC is off or its address changed, Android could otherwise wait over a minute
          // here with only a dark screen showing.
          const ctrl = new AbortController();
          const timer = setTimeout(() => ctrl.abort(), 4000);
          try {
            const res = await fetch(`http://${saved.server}/auth/me`, { headers: { Authorization: `Bearer ${saved.token}` }, signal: ctrl.signal });
            if (res.status === 401) { clearTimeout(timer); await AsyncStorage.removeItem(KEY_SESSION); setLoaded(true); return; }
          } catch {}
          clearTimeout(timer);
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
    setHistory([]);
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
    setHistory([]);
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
  const [presets, setPresets] = useState<PresetItem[]>([]);   // saved scenes on the PC
  const [presetsMsg, setPresetsMsg] = useState('');
  onServerMessage.current = (m) => {
    if (m.type === 'scene') proj.applyRemote(m);
    else if (m.type === 'presets') { setPresets(Array.isArray(m.items) ? m.items : []); setPresetsMsg(''); }
    else if (m.type === 'presets_error') setPresetsMsg(String(m.message ?? 'Something went wrong with saved scenes.'));
    else if (m.type === 'vision_status') setVision({ running: !!m.running, source: m.source ?? null, fps: m.fps ?? null, detect_ms: m.detect_ms ?? null, latency_ms: m.latency_ms ?? null,
      gap_phone_ms: m.gap_phone_ms ?? null, gap_net_ms: m.gap_net_ms ?? null,
      held_pct: m.held_pct ?? null, held_why: m.held_why ?? null, error: m.error ?? null });
    else if (m.type === 'gesture') setLastGesture(m.name);
  };
  const P = PRESETS[preset];
  const level = (bright / 100) * (0.4 + inten / 160);
  const tab = (['home', 'connect', 'studio', 'settings'] as Route[]).includes(route) ? route : route === 'projects' ? 'home' : 'studio';
  const NAV: [Route, string, Ic][] = [['home', 'Home', 'home-variant'], ['connect', 'Connect', 'lan-connect'], ['studio', 'Studio', 'cube-scan'], ['settings', 'Settings', 'cog-outline']];
  const Head = ({ t, sub }: { t: string; sub: string }) => (
    <View style={{ marginBottom: 16 }}>
      {route !== 'connect' && route !== 'studio' && route !== 'settings' && route !== 'home' ? (
        <Pressable onPress={goBack} style={s.back} accessibilityLabel="Back">
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
        {!loaded && !splash && (
          <View style={[StyleSheet.absoluteFill, { alignItems: 'center', justifyContent: 'center' }]}>
            <BrandLoader dark={isDark} label="Loading…" color={T.mute} />
          </View>
        )}
        {loaded && !user && <AuthScreens T={T} onDone={login} initialServer={savedServer} />}
        {user && route === 'calibration' && (
          // The Projection Editor uses the whole screen (its own toolbars instead of the tab bar).
          <Animated.View style={{ flex: 1, paddingBottom: navLift }}>
            <ProjectionEditor T={T} proj={proj} connected={connected} tvConnected={tvConnected} server={`${ip.trim()}:${port}`} token={user?.token}
              onBack={goBack} onGoConnect={() => setRoute('connect')}
              vision={vision} lastGesture={lastGesture} onGestures={(on) => send(on ? { type: 'start_gestures', source: 'phone' } : { type: 'stop_gestures' })} send={send}
              presets={presets} presetsMsg={presetsMsg} />
          </Animated.View>
        )}
        {user && route !== 'calibration' && (<>
        <ScrollView contentContainerStyle={s.scroll} showsVerticalScrollIndicator={false} scrollEnabled={!dragging}>
          {route === 'home' && (<>
            <View style={s.topRow}>
              <View style={s.brand}><BrandEmblem dark={isDark} size={34} /><Text style={s.brandT}>SpatialVision</Text></View>
              <View style={s.topIcons}>
                <Pressable onPress={() => setThemeMode(isDark ? 'light' : 'dark')} hitSlop={10} accessibilityRole="button" accessibilityLabel={isDark ? 'Switch to light mode' : 'Switch to dark mode'}>
                  <Icon name={isDark ? 'white-balance-sunny' : 'weather-night'} size={24} color={T.mute} />
                </Pressable>
                <Pressable onPress={() => setRoute('settings')} hitSlop={10} accessibilityLabel="Settings"><Icon name="cog-outline" size={24} color={T.mute} /></Pressable>
              </View>
            </View>
            <Text style={s.h1}>Your Spatial Studio</Text><Text style={s.mute}>Connect, calibrate, and create.</Text>

            <View style={s.feature}>
              <View style={{ position: 'absolute', right: 14, top: 18, opacity: 0.9 }}><BrandEmblem dark size={150} /></View>
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
              {conn === 'connecting' && <BrandLoader dark={isDark} size={56} label="Connecting to your PC…" color={T.mute} />}
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
              <View style={s.switchRow}>
                <BrandEmblem dark={isDark} size={40} />
                <View style={{ flex: 1 }}><Text style={s.ct}>SpatialVision</Text><Text style={s.mute}>Version 1.0.0 (student prototype)</Text></View>
              </View>
              <Text style={[s.mute, { marginTop: 8 }]}>Target display: Haier Android TV. Projector output is coming soon.</Text>
            </View>
            <View style={s.card}>
              <Text style={s.ct}>Connection</Text><Text style={s.mute}>{connected ? `Connected to ${ip}:${port}` : 'Not connected'}</Text>
            </View>
            <View style={{ marginTop: 16 }}><Btn label="Reset app data" ghost icon="restore" onPress={resetAll} /></View>
          </>)}
        </ScrollView>

        <Animated.View style={[s.nav, { paddingBottom: Animated.add(8, navLift) }]}>
          {NAV.map(([r, l, ic]) => (
            <Pressable key={r} style={s.navItem} onPress={() => setRoute(r)} accessibilityRole="button" accessibilityState={{ selected: tab === r }} accessibilityLabel={l}>
              <Icon name={ic} size={24} color={tab === r ? T.blue : T.mute} />
              <Text style={{ fontSize: 11, color: tab === r ? T.blue : T.mute, fontWeight: tab === r ? '700' : '500' }}>{l}</Text>
            </Pressable>
          ))}
        </Animated.View>
        </>)}
        {splash && <Splash done={() => setSplash(false)} />}
      </View>
    </ThemeCtx.Provider>
  );
}
