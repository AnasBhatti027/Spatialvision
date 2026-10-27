import React, { useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable, ScrollView, StatusBar, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';

type Theme = {
  dark: boolean; bg: string; s1: string; s2: string; blue: string; cyan: string; violet: string;
  text: string; mute: string; line: string; err: string;
};
export type AuthUser = { username: string; token?: string; demo?: boolean; server?: string };

// In a browser on the same PC the backend is on localhost. On a phone you must type the PC's IP.
const DEFAULT_SERVER = Platform.OS === 'web' ? 'localhost:8000' : '';

/** Accepts "192.168.10.13:8000", "http://192.168.10.13:8000/" or just "192.168.10.13". */
export function cleanServer(raw: string): string {
  let v = raw.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  if (v && !/:\d+$/.test(v)) v += ':8000';
  return v;
}
const USER_RE = /^[a-z0-9_]{3,20}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const TOP = Platform.OS === 'android' ? (StatusBar.currentHeight ?? 24) : 48;

export function suggestUsernames(email: string): string[] {
  const local = email.split('@')[0].toLowerCase().split('+')[0];
  const parts = local.split(/[._-]+/).map((p) => p.replace(/[^a-z0-9]/g, '')).filter(Boolean);
  if (!parts.length) return [];
  const joined = parts.join('');
  const letters = joined.replace(/\d/g, '');
  const base = letters.length >= 3 ? letters : joined;
  const code = (joined.split('').reduce((a, c) => a + c.charCodeAt(0), 0) % 900) + 100;
  const list = [joined, parts.length > 1 ? parts.join('_') : '', base !== joined ? base : '', `${base}_sv`, `sv_${base}`, `${base}${code}`, `${base}26`];
  const out: string[] = [];
  list.forEach((n) => { const v = n.slice(0, 20); if (USER_RE.test(v) && !out.includes(v)) out.push(v); });
  return out.slice(0, 5);
}

async function fetchAvailable(server: string, names: string[]): Promise<string[] | null> {
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 3000);
    const res = await fetch(`http://${server}/auth/usernames/available?names=${names.join(',')}`, { signal: ctl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return Array.isArray(j.available) ? j.available : null;
  } catch { return null; }
}

export default function AuthScreens({ T, onDone, initialServer }: { T: Theme; onDone: (u: AuthUser) => void; initialServer?: string }) {
  const s = useMemo(() => makeStyles(T), [T]);
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [email, setEmail] = useState('');
  const [username, setUsername] = useState('');
  const [touched, setTouched] = useState(false);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [server, setServer] = useState(initialServer || DEFAULT_SERVER);
  // Open the server box straight away when no address is known yet.
  const [showServer, setShowServer] = useState(!(initialServer || DEFAULT_SERVER));
  const [sugg, setSugg] = useState<{ name: string; taken: boolean }[]>([]);
  const [known, setKnown] = useState(false);

  useEffect(() => {
    if (mode !== 'signup' || !EMAIL_RE.test(email.trim())) { setSugg([]); setKnown(false); return; }
    const names = suggestUsernames(email.trim());
    setSugg(names.map((n) => ({ name: n, taken: false })));
    setKnown(false);
    if (!touched && names[0]) setUsername(names[0]);
    let cancelled = false;
    const addr = cleanServer(server);
    if (!addr) return;
    const t = setTimeout(async () => {
      const avail = await fetchAvailable(addr, names);
      if (cancelled || !avail) return;
      setKnown(true);
      setSugg(names.map((n) => ({ name: n, taken: !avail.includes(n) })));
    }, 500);
    return () => { cancelled = true; clearTimeout(t); };
  }, [email, mode, server]);

  const submit = async () => {
    setErr('');
    const em = email.trim().toLowerCase();
    if (!EMAIL_RE.test(em)) return setErr('Enter a valid email address.');
    if (mode === 'signup' && !USER_RE.test(username)) return setErr('Username: 3 to 20 characters, lowercase letters, numbers or underscore.');
    if (password.length < 8) return setErr('Password must be at least 8 characters.');
    if (mode === 'signup' && password !== confirm) return setErr('Passwords do not match.');
    const addr = cleanServer(server);
    if (!addr) { setShowServer(true); return setErr('Enter your PC address under Server settings first, for example 192.168.10.13:8000.'); }
    setBusy(true);
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const res = await fetch(`http://${addr}/auth/${mode}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(mode === 'signup' ? { email: em, username, password } : { email: em, password }),
        signal: ctl.signal,
      });
      clearTimeout(t);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setErr(typeof data.detail === 'string' ? data.detail : 'Something went wrong. Try again.');
      else onDone({ username: data.username ?? username, token: data.token, server: addr });
    } catch {
      setShowServer(true);
      setErr(`Could not reach the server at ${addr}. Check that the backend is running, the address below is your PC's IPv4 address, and the phone is on the same Wi-Fi.`);
    } finally { setBusy(false); }
  };

  const switchMode = () => { setMode(mode === 'login' ? 'signup' : 'login'); setErr(''); };

  return (
    <View style={s.root}>
      <KeyboardAvoidingView behavior={Platform.OS === 'ios' ? 'padding' : undefined} style={{ flex: 1 }}>
        <ScrollView contentContainerStyle={s.scroll} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
          <View style={s.glow} />
          <View style={s.brand}>
            <View style={s.logo}><View style={s.logoOuter} /><View style={s.logoInner} /></View>
            <Text style={s.brandT}>SpatialVision</Text>
          </View>

          <Text style={s.h1}>{mode === 'login' ? 'Welcome back' : 'Create your account'}</Text>
          <Text style={s.mute}>{mode === 'login' ? 'Sign in to control your projection studio.' : 'A few details and you are in.'}</Text>

          <View style={s.card}>
            <Text style={s.label}>Email</Text>
            <TextInput style={s.input} value={email} onChangeText={setEmail} placeholder="you@example.com" placeholderTextColor={T.mute}
              keyboardType="email-address" autoCapitalize="none" autoCorrect={false} accessibilityLabel="Email" />

            {mode === 'signup' && (<>
              <Text style={s.label}>Username</Text>
              <TextInput style={s.input} value={username} onChangeText={(v) => { setTouched(true); setUsername(v.toLowerCase()); }}
                placeholder="choose a username" placeholderTextColor={T.mute} autoCapitalize="none" autoCorrect={false} maxLength={20} accessibilityLabel="Username" />
              {sugg.length > 0 && (<>
                <Text style={s.hint}>Suggestions from your email</Text>
                <View style={s.chips}>
                  {sugg.map((x) => (
                    <Pressable key={x.name} disabled={x.taken} onPress={() => { setTouched(true); setUsername(x.name); }}
                      accessibilityRole="button" accessibilityLabel={`Use username ${x.name}${x.taken ? ', taken' : ''}`}
                      style={[s.chip, username === x.name && s.chipOn, x.taken && { opacity: 0.4 }]}>
                      <Text style={[s.chipT, username === x.name && { color: '#FFFFFF' }, x.taken && { textDecorationLine: 'line-through' }]}>{x.name}</Text>
                    </Pressable>
                  ))}
                </View>
                {!known && <Text style={s.hint}>Availability is checked when the server is reachable.</Text>}
              </>)}
            </>)}

            <Text style={s.label}>Password</Text>
            <View>
              <TextInput style={[s.input, { paddingRight: 48 }]} value={password} onChangeText={setPassword} placeholder="At least 8 characters"
                placeholderTextColor={T.mute} secureTextEntry={!show} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Password"
                returnKeyType={mode === 'login' ? 'go' : 'next'} onSubmitEditing={mode === 'login' ? submit : undefined} />
              <Pressable style={s.eye} onPress={() => setShow(!show)} accessibilityLabel={show ? 'Hide password' : 'Show password'}>
                <Icon name={show ? 'eye-off-outline' : 'eye-outline'} size={22} color={T.mute} />
              </Pressable>
            </View>

            {mode === 'signup' && (<>
              <Text style={s.label}>Confirm password</Text>
              <TextInput style={s.input} value={confirm} onChangeText={setConfirm} placeholder="Repeat password" placeholderTextColor={T.mute}
                secureTextEntry={!show} autoCapitalize="none" autoCorrect={false} accessibilityLabel="Confirm password"
                returnKeyType="go" onSubmitEditing={submit} />
            </>)}

            {err ? <Text style={s.error}>{err}</Text> : null}

            <Pressable style={({ pressed }) => [s.btn, (pressed || busy) && { opacity: 0.8 }]} onPress={submit} disabled={busy}
              accessibilityRole="button" accessibilityLabel={mode === 'login' ? 'Log in' : 'Create account'}>
              {busy ? <ActivityIndicator color="#FFFFFF" /> : <Text style={s.btnT}>{mode === 'login' ? 'Log in' : 'Create account'}</Text>}
            </Pressable>
          </View>

          <Pressable onPress={switchMode} style={s.switch} accessibilityRole="button">
            <Text style={s.mute}>{mode === 'login' ? 'New here? ' : 'Already have an account? '}
              <Text style={{ color: T.cyan, fontWeight: '700' }}>{mode === 'login' ? 'Create account' : 'Log in'}</Text></Text>
          </Pressable>

          <Pressable onPress={() => setShowServer(!showServer)} style={s.switch} accessibilityRole="button">
            <Text style={s.small}>Server settings {showServer ? '▲' : '▼'}</Text>
          </Pressable>
          {showServer && (
            <View style={s.card}>
              <Text style={s.label}>Backend address (PC IP and port)</Text>
              <TextInput style={s.input} value={server} onChangeText={setServer} placeholder="e.g. 192.168.10.13:8000" placeholderTextColor={T.mute}
                autoCapitalize="none" autoCorrect={false} keyboardType="numbers-and-punctuation" accessibilityLabel="Server address" />
              <Text style={s.hint}>Run ipconfig on the PC and use the Wi-Fi IPv4 address. The app remembers it.</Text>
            </View>
          )}

          <Pressable onPress={() => onDone({ username: 'demo', demo: true })} style={s.switch} accessibilityRole="button">
            <Text style={s.small}>Continue in demo mode (no account, for development)</Text>
          </Pressable>
        </ScrollView>
      </KeyboardAvoidingView>
    </View>
  );
}

function makeStyles(T: Theme) {
  return StyleSheet.create({
    root: {
  ...StyleSheet.absoluteFill,
  backgroundColor: T.bg,
  zIndex: 5,
  paddingTop: TOP,
},
    scroll: { paddingHorizontal: 24, paddingBottom: 40, paddingTop: 12 },
    glow: { position: 'absolute', top: -60, right: -80, width: 260, height: 260, borderRadius: 130, backgroundColor: T.violet, opacity: T.dark ? 0.16 : 0.1 },
    brand: { flexDirection: 'row', alignItems: 'center', gap: 10, marginBottom: 28 },
    logo: { width: 30, height: 30, alignItems: 'center', justifyContent: 'center' },
    logoOuter: { width: 21, height: 21, borderWidth: 2, borderColor: T.cyan, borderRadius: 6, transform: [{ rotate: '45deg' }] },
    logoInner: { position: 'absolute', width: 8, height: 8, backgroundColor: T.blue, borderRadius: 3, transform: [{ rotate: '45deg' }] },
    brandT: { color: T.text, fontSize: 19, fontWeight: '800' },
    h1: { color: T.text, fontSize: 30, fontWeight: '800', letterSpacing: -0.6 },
    mute: { color: T.mute, fontSize: 14, lineHeight: 20, marginTop: 4 },
    small: { color: T.mute, fontSize: 13 },
    card: { backgroundColor: T.s1, borderRadius: 20, borderWidth: 1, borderColor: T.line, padding: 16, marginTop: 20 },
    label: { color: T.mute, fontSize: 12, marginTop: 14, marginBottom: 6 },
    hint: { color: T.mute, fontSize: 12, marginTop: 8 },
    input: { backgroundColor: T.bg, borderWidth: 1, borderColor: T.line, borderRadius: 12, color: T.text, paddingHorizontal: 14, height: 48, fontSize: 15 },
    eye: { position: 'absolute', right: 0, top: 0, width: 48, height: 48, alignItems: 'center', justifyContent: 'center' },
    chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, marginTop: 8 },
    chip: { borderWidth: 1, borderColor: T.line, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 12, backgroundColor: T.s2 },
    chipOn: { backgroundColor: T.blue, borderColor: T.blue },
    chipT: { color: T.text, fontSize: 13, fontWeight: '600' },
    error: { color: T.err, fontSize: 13, marginTop: 14, lineHeight: 18 },
    btn: { marginTop: 18, minHeight: 50, borderRadius: 25, backgroundColor: T.blue, alignItems: 'center', justifyContent: 'center' },
    btnT: { color: '#FFFFFF', fontSize: 16, fontWeight: '700' },
    switch: { alignItems: 'center', paddingVertical: 14 },
  });
}