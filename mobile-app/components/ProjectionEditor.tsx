import React, { useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import { ASPECT, Content, Pt, Quad, Scene, centroid, moveBy, rotateBy, scaleBy } from './projection';

type Theme = { dark: boolean; bg: string; s1: string; s2: string; blue: string; cyan: string; violet: string; text: string; mute: string; line: string; err: string };
type Ic = React.ComponentProps<typeof Icon>['name'];
export type VisionStatus = { running: boolean; fps: number | null; detect_ms: number | null; latency_ms?: number | null; error: string | null };

const GESTURE_NAMES: Record<string, string> = {
  pinch: 'Pinch', point: 'Point', open_palm: 'Open palm', fist: 'Fist', swipe_left: 'Swipe left', swipe_right: 'Swipe right',
};

const CANVAS_BG = '#0B1022';
const CYAN = '#45D9F5', VIOLET = '#9065FF', WHITE = '#F4F6FF';
const HANDLE = 40; // touch size of a corner handle

type Props = {
  T: Theme;
  scene: Scene;
  update: (part: Partial<Scene>) => void;
  setCorners: (q: Quad) => void;
  reset: () => void;
  connected: boolean;     // phone paired with the backend
  tvConnected: boolean;   // TV page open and connected
  server: string;         // backend address, e.g. 192.168.10.13:8000
  token?: string;         // login token, needed to upload images
  onGoConnect: () => void;
  onDragging: (dragging: boolean) => void; // lets the screen stop scrolling while a handle is dragged
  vision: VisionStatus;        // hand tracking status measured by the backend
  lastGesture: string;
  onGestures: (on: boolean) => void;
};

/** A draggable handle. Drag reports the distance moved since the finger went down, in pixels. */
function Handle({ x, y, label, active, icon, onStart, onMove, onEnd }: {
  x: number; y: number; label: string; active: boolean; icon?: Ic;
  onStart: () => void; onMove: (dx: number, dy: number) => void; onEnd: () => void;
}) {
  const cb = useRef({ onStart, onMove, onEnd });
  cb.current = { onStart, onMove, onEnd };
  const pan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => false,
    onPanResponderGrant: () => cb.current.onStart(),
    onPanResponderMove: (_, g) => cb.current.onMove(g.dx, g.dy),
    onPanResponderRelease: () => cb.current.onEnd(),
    onPanResponderTerminate: () => cb.current.onEnd(),
  })).current;
  return (
    <View {...pan.panHandlers} accessibilityLabel={label} accessibilityRole="adjustable"
      style={{ position: 'absolute', left: x - HANDLE / 2, top: y - HANDLE / 2, width: HANDLE, height: HANDLE, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: 26, height: 26, borderRadius: 13, backgroundColor: active ? CYAN : VIOLET, borderWidth: 2, borderColor: WHITE, alignItems: 'center', justifyContent: 'center' }}>
        {icon ? <Icon name={icon} size={14} color={WHITE} /> : <Text style={{ color: active ? '#080B16' : WHITE, fontSize: 11, fontWeight: '800' }}>{label.slice(-1)}</Text>}
      </View>
    </View>
  );
}

const Edge = ({ a, b, color }: { a: Pt; b: Pt; color: string }) => {
  const dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
  return <View pointerEvents="none" style={{ position: 'absolute', left: (a[0] + b[0]) / 2 - len / 2, top: (a[1] + b[1]) / 2 - 1, width: len, height: 2, backgroundColor: color, transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }] }} />;
};

export default function ProjectionEditor(p: Props) {
  const { T, scene } = p;
  const s = useMemo(() => makeStyles(T), [T]);
  const { width } = useWindowDimensions();
  const cw = Math.min(width - 48, 560), ch = cw / ASPECT; // canvas size in pixels
  const [sel, setSel] = useState<number | 'all'>(0);
  const [step, setStep] = useState(0.005);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const dragStart = useRef<Quad>(scene.corners);

  const px = scene.corners.map(([x, y]) => [x * cw, y * ch] as Pt);
  const [mx, my] = centroid(scene.corners);
  const xs = px.map((q) => q[0]), ys = px.map((q) => q[1]);
  const box = { left: Math.min(...xs), top: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };

  const startDrag = (index: number | 'all') => { setSel(index); dragStart.current = scene.corners; p.onDragging(true); };
  const drag = (index: number | 'all', dx: number, dy: number) => p.setCorners(moveBy(dragStart.current, index, dx / cw, dy / ch));
  const endDrag = () => p.onDragging(false);

  const pickImage = async () => {
    setMsg('');
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, base64: true });
    if (r.canceled || !r.assets?.length) return;
    const a = r.assets[0];
    p.update({ localUri: a.uri, imageUrl: null, content: 'image' });
    if (!p.token) { setMsg('Image shown on the phone only. Log in with an account (not demo mode) to send images to the TV.'); return; }
    if (!p.connected) { setMsg('Image shown on the phone only. Connect to the PC to send it to the TV.'); return; }
    if (!a.base64) { setMsg('Could not read this image. Try another one.'); return; }
    setBusy(true);
    try {
      const res = await fetch(`http://${p.server}/assets`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.token}` },
        body: JSON.stringify({ data: a.base64, mime: a.mimeType ?? 'image/jpeg' }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) setMsg(typeof data.detail === 'string' ? data.detail : 'Upload failed. Try again.');
      else p.update({ imageUrl: data.url });
    } catch {
      setMsg('Could not upload the image. Check that the backend is still running.');
    } finally { setBusy(false); }
  };

  const Tool = ({ icon, label, onPress, disabled }: { icon: Ic; label: string; onPress: () => void; disabled?: boolean }) => (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={label}
      style={({ pressed }) => [s.tool, disabled && { opacity: 0.4 }, pressed && { opacity: 0.7 }]}>
      <Icon name={icon} size={20} color={T.text} />
      <Text style={s.toolT}>{label}</Text>
    </Pressable>
  );
  const Chip = ({ on, label, onPress }: { on: boolean; label: string; onPress: () => void }) => (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={label}>
      <Text style={[s.chip, on && s.chipOn]}>{label}</Text>
    </Pressable>
  );
  const Pill = ({ ok, label }: { ok: boolean; label: string }) => (
    <View style={[s.pill, { borderColor: ok ? T.cyan : T.line }]}>
      <View style={[s.dot, { backgroundColor: ok ? T.cyan : T.mute }]} />
      <Text style={[s.pillT, { color: ok ? T.cyan : T.mute }]}>{label}</Text>
    </View>
  );

  const nudge = (dx: number, dy: number) => p.setCorners(moveBy(scene.corners, sel, dx * step, dy * step * ASPECT));
  const target = sel === 'all' ? 'whole shape' : `corner ${sel + 1}`;
  const previewSrc = scene.localUri ?? (scene.imageUrl ? `http://${p.server}${scene.imageUrl}` : null);
  const setContent = (c: Content) => p.update({ content: c });

  return (
    <View>
      {/* Connection status */}
      <View style={s.row}>
        <Pill ok={p.connected} label={p.connected ? 'Phone paired' : 'Not paired'} />
        <Pill ok={p.connected && p.tvConnected} label={p.connected && p.tvConnected ? 'TV page live' : 'TV page not open'} />
      </View>
      {!p.connected ? (
        <View style={[s.card, { marginTop: 10 }]}>
          <Text style={s.mute}>You can edit here, but nothing reaches the TV until you pair with the PC. Open http://{'<PC-IP>'}:8000/tv on the TV, then connect.</Text>
          <Pressable onPress={p.onGoConnect} style={s.link} accessibilityRole="button"><Text style={{ color: T.cyan, fontWeight: '700' }}>Go to Connect</Text></Pressable>
        </View>
      ) : !p.tvConnected ? (
        <View style={[s.card, { marginTop: 10 }]}>
          <Text style={s.mute}>Paired, but no TV page is open. On the TV (or a PC browser) open http://{p.server}/tv</Text>
        </View>
      ) : null}

      {/* Canvas: a small copy of the TV screen */}
      <View style={[s.canvas, { width: cw, height: ch }]}>
        {scene.content === 'image' && previewSrc ? (
          <Image source={{ uri: previewSrc }} resizeMode={scene.fit} style={{ position: 'absolute', ...box, opacity: 0.85 }} />
        ) : scene.content === 'pattern' ? (
          <View pointerEvents="none" style={{ position: 'absolute', ...box, flexDirection: 'row', flexWrap: 'wrap', opacity: 0.55 }}>
            {Array.from({ length: 32 }, (_, i) => (
              <View key={i} style={{ width: '12.5%', height: '25%', backgroundColor: (i + Math.floor(i / 8)) % 2 ? '#1B2550' : '#4D7CFE' }} />
            ))}
          </View>
        ) : null}
        {scene.grid && Array.from({ length: 7 }, (_, i) => (
          <React.Fragment key={i}>
            <View pointerEvents="none" style={[s.gridV, { left: ((i + 1) * cw) / 8 }]} />
            {i < 3 && <View pointerEvents="none" style={[s.gridH, { top: ((i + 1) * ch) / 4 }]} />}
          </React.Fragment>
        ))}
        {[0, 1, 2, 3].map((i) => <Edge key={i} a={px[i]} b={px[(i + 1) % 4]} color={sel === 'all' ? CYAN : 'rgba(69,217,245,0.75)'} />)}
        {px.map(([x, y], i) => (
          <Handle key={i} x={x} y={y} label={`Corner ${i + 1}`} active={sel === i}
            onStart={() => startDrag(i)} onMove={(dx, dy) => drag(i, dx, dy)} onEnd={endDrag} />
        ))}
        <Handle x={mx * cw} y={my * ch} label="Move whole shape" icon="cursor-move" active={sel === 'all'}
          onStart={() => startDrag('all')} onMove={(dx, dy) => drag('all', dx, dy)} onEnd={endDrag} />
      </View>
      <Text style={[s.hint, { textAlign: 'center' }]}>Drag a corner, or the centre to move everything. The phone shows a simple preview; the exact perspective is on the TV.</Text>

      {/* Fine adjustment */}
      <View style={s.card}>
        <Text style={s.ct}>Adjust {target}</Text>
        <View style={[s.row, { marginTop: 10, flexWrap: 'wrap' }]}>
          {[0, 1, 2, 3].map((i) => <Chip key={i} on={sel === i} label={`${i + 1}`} onPress={() => setSel(i)} />)}
          <Chip on={sel === 'all'} label="All" onPress={() => setSel('all')} />
        </View>
        <View style={s.padRow}>
          <View style={s.pad}>
            <Pressable style={s.arrow} onPress={() => nudge(0, -1)} accessibilityLabel={`Move ${target} up`}><Icon name="arrow-up" size={20} color={T.text} /></Pressable>
            <View style={{ flexDirection: 'row', gap: 44 }}>
              <Pressable style={s.arrow} onPress={() => nudge(-1, 0)} accessibilityLabel={`Move ${target} left`}><Icon name="arrow-left" size={20} color={T.text} /></Pressable>
              <Pressable style={s.arrow} onPress={() => nudge(1, 0)} accessibilityLabel={`Move ${target} right`}><Icon name="arrow-right" size={20} color={T.text} /></Pressable>
            </View>
            <Pressable style={s.arrow} onPress={() => nudge(0, 1)} accessibilityLabel={`Move ${target} down`}><Icon name="arrow-down" size={20} color={T.text} /></Pressable>
          </View>
          <View style={{ gap: 8 }}>
            <Chip on={step === 0.005} label="Small steps" onPress={() => setStep(0.005)} />
            <Chip on={step === 0.02} label="Big steps" onPress={() => setStep(0.02)} />
          </View>
        </View>
        <View style={s.tools}>
          <Tool icon="magnify-minus-outline" label="Smaller" onPress={() => p.setCorners(scaleBy(scene.corners, 0.97))} />
          <Tool icon="magnify-plus-outline" label="Bigger" onPress={() => p.setCorners(scaleBy(scene.corners, 1.03))} />
          <Tool icon="rotate-left" label="Rotate" onPress={() => p.setCorners(rotateBy(scene.corners, -2))} />
          <Tool icon="rotate-right" label="Rotate" onPress={() => p.setCorners(rotateBy(scene.corners, 2))} />
          <Tool icon="restore" label="Reset" onPress={() => { p.reset(); setSel(0); }} />
        </View>
      </View>

      {/* What is shown */}
      <View style={s.card}>
        <Text style={s.ct}>Content</Text>
        <View style={[s.row, { marginTop: 10, flexWrap: 'wrap' }]}>
          <Chip on={scene.content === 'pattern'} label="Test pattern" onPress={() => setContent('pattern')} />
          <Chip on={scene.content === 'image'} label="Image" onPress={() => (scene.localUri || scene.imageUrl ? setContent('image') : pickImage())} />
          <Chip on={scene.content === 'blank'} label="Blank" onPress={() => setContent('blank')} />
          <Chip on={scene.grid} label="Grid" onPress={() => p.update({ grid: !scene.grid })} />
        </View>

        {scene.content === 'image' && (scene.localUri || scene.imageUrl) ? (
          <>
            <View style={[s.row, { marginTop: 12 }]}>
              <Chip on={scene.fit === 'contain'} label="Fit" onPress={() => p.update({ fit: 'contain' })} />
              <Chip on={scene.fit === 'cover'} label="Fill" onPress={() => p.update({ fit: 'cover' })} />
            </View>
            <View style={[s.row, { marginTop: 12 }]}>
              <Pressable style={[s.btn, s.ghost]} onPress={pickImage} disabled={busy} accessibilityRole="button" accessibilityLabel="Replace image">
                <Icon name="image-edit-outline" size={18} color={T.blue} /><Text style={[s.btnT, { color: T.blue }]}>Replace</Text>
              </Pressable>
              <Pressable style={[s.btn, s.ghost]} onPress={() => { p.update({ localUri: null, imageUrl: null, content: 'pattern' }); setMsg(''); }} accessibilityRole="button" accessibilityLabel="Remove image">
                <Icon name="trash-can-outline" size={18} color={T.blue} /><Text style={[s.btnT, { color: T.blue }]}>Remove</Text>
              </Pressable>
            </View>
          </>
        ) : (
          <Pressable style={[s.btn, { marginTop: 12 }]} onPress={pickImage} disabled={busy} accessibilityRole="button" accessibilityLabel="Upload from Gallery">
            <Icon name="image-plus" size={18} color="#FFFFFF" /><Text style={s.btnT}>Upload from Gallery</Text>
          </Pressable>
        )}
        {busy && <View style={[s.row, { marginTop: 10 }]}><ActivityIndicator color={T.cyan} /><Text style={s.mute}>Sending image to the PC…</Text></View>}
        {scene.content === 'image' && scene.imageUrl && !busy ? <Text style={[s.hint, { color: T.cyan }]}>Image is on the PC and shown on the TV.</Text> : null}
        {msg ? <Text style={s.error}>{msg}</Text> : null}
      </View>

      {/* Touch-free control with hand gestures (webcam on the PC) */}
      <View style={s.card}>
        <View style={[s.row, { justifyContent: 'space-between' }]}>
          <Text style={s.ct}>Gesture control</Text>
          <Pill ok={p.vision.running} label={p.vision.running ? 'Camera on' : 'Off'} />
        </View>
        {p.vision.running ? (
          <Text style={[s.mute, { marginTop: 8 }]}>
            {p.vision.fps == null ? 'Starting the camera…' : `Measured: ${p.vision.fps} fps, hand detection ${p.vision.detect_ms} ms per frame${p.vision.latency_ms != null ? `, delay to TV ${p.vision.latency_ms} ms` : ''}`}
          </Text>
        ) : (
          <Text style={[s.mute, { marginTop: 8 }]}>Uses the PC webcam. Stand in front of it and control the TV with your hand.</Text>
        )}
        {p.vision.running && (
          <Text style={[s.ct, { marginTop: 10, color: T.cyan }]}>{p.lastGesture ? `Last gesture: ${GESTURE_NAMES[p.lastGesture] ?? p.lastGesture}` : 'No gesture yet'}</Text>
        )}
        <View style={{ marginTop: 10, gap: 4 }}>
          <Text style={s.hint}>☝️  Index finger moves the pointer on the TV</Text>
          <Text style={s.hint}>🤏  Pinch and move drags the whole shape</Text>
          <Text style={s.hint}>🖐️  Swipe an open hand left or right to change the content</Text>
        </View>
        <Pressable style={[s.btn, { marginTop: 12 }, p.vision.running && s.ghostSolo, !p.connected && { opacity: 0.45 }]}
          disabled={!p.connected} onPress={() => p.onGestures(!p.vision.running)} accessibilityRole="button"
          accessibilityLabel={p.vision.running ? 'Stop gesture control' : 'Start gesture control'}>
          <Icon name={p.vision.running ? 'stop' : 'hand-wave-outline'} size={18} color={p.vision.running ? T.blue : '#FFFFFF'} />
          <Text style={[s.btnT, p.vision.running && { color: T.blue }]}>{p.vision.running ? 'Stop gestures' : 'Start gestures'}</Text>
        </Pressable>
        {!p.connected && <Text style={s.hint}>Pair with the PC first.</Text>}
        {p.vision.error ? <Text style={s.error}>{p.vision.error}</Text> : null}
      </View>
    </View>
  );
}

function makeStyles(T: Theme) {
  return StyleSheet.create({
    row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    card: { backgroundColor: T.s1, borderRadius: 20, borderWidth: 1, borderColor: T.line, padding: 16, marginTop: 14 },
    ct: { color: T.text, fontSize: 16, fontWeight: '700' },
    mute: { color: T.mute, fontSize: 13, lineHeight: 19 },
    hint: { color: T.mute, fontSize: 12, lineHeight: 17, marginTop: 8 },
    error: { color: T.err, fontSize: 13, lineHeight: 18, marginTop: 10 },
    link: { marginTop: 10, alignSelf: 'flex-start', paddingVertical: 4 },
    pill: { flexDirection: 'row', alignItems: 'center', gap: 6, borderWidth: 1, borderRadius: 14, paddingVertical: 5, paddingHorizontal: 10 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    pillT: { fontSize: 12, fontWeight: '700' },
    canvas: { marginTop: 14, alignSelf: 'center', backgroundColor: CANVAS_BG, borderRadius: 12, borderWidth: 1, borderColor: T.line, overflow: 'hidden' },
    gridV: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(69,217,245,0.35)' },
    gridH: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(69,217,245,0.35)' },
    chip: { color: T.mute, borderWidth: 1, borderColor: T.line, borderRadius: 18, paddingVertical: 8, paddingHorizontal: 14, overflow: 'hidden', fontSize: 13, textAlign: 'center' },
    chipOn: { color: '#FFFFFF', backgroundColor: T.blue, borderColor: T.blue },
    padRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-around', marginTop: 12 },
    pad: { alignItems: 'center', gap: 6 },
    arrow: { width: 46, height: 46, borderRadius: 23, backgroundColor: T.s2, borderWidth: 1, borderColor: T.line, alignItems: 'center', justifyContent: 'center' },
    tools: { flexDirection: 'row', justifyContent: 'space-between', marginTop: 14 },
    tool: { alignItems: 'center', gap: 4, minWidth: 52, paddingVertical: 6 },
    toolT: { color: T.mute, fontSize: 11 },
    btn: { minHeight: 46, borderRadius: 23, backgroundColor: T.blue, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18 },
    ghost: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: T.blue, flex: 1 },
    ghostSolo: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: T.blue },
    btnT: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
  });
}
