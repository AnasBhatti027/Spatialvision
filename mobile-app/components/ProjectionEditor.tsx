import React, { memo, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Image, PanResponder, Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import Svg, { ClipPath, Defs, Image as SvgImage, Polygon } from 'react-native-svg';
import { ASPECT, Content, Fit, Pt, Quad, Scene, centroid, moveBy, rotateBy, scaleBy, squareToQuad } from './projection';
import PhoneHandCamera, { phoneCameraAvailable } from './PhoneHandCamera';

type Theme = { dark: boolean; bg: string; s1: string; s2: string; blue: string; cyan: string; violet: string; text: string; mute: string; line: string; err: string };
type Ic = React.ComponentProps<typeof Icon>['name'];
export type VisionStatus = { running: boolean; source?: string | null; fps: number | null; detect_ms: number | null; latency_ms?: number | null; error: string | null };

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
  sendLive: (q: Quad) => void; // sends corners to the TV during a drag, without re-rendering the whole screen
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
  send: (msg: object) => boolean; // to the PC; the phone camera sends its hand points with it
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

const COLS = 8, ROWS = 4; // checkerboard cells, same as before
const pts = (list: Pt[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');

type CanvasProps = {
  quad: Quad; cw: number; ch: number; sel: number | 'all';
  content: Content; grid: boolean; fit: Fit; previewSrc: string | null;
  onSelect: (s: number | 'all') => void;
  onCommit: (q: Quad) => void;     // finger lifted: store the final corners
  sendLive: (q: Quad) => void;     // finger moving: tell the TV only
  onDragging: (d: boolean) => void;
};

/**
 * The small copy of the TV screen. While a handle is dragged, the shape lives here only
 * (redrawn at most once per screen frame), so the rest of the app does not re-render on every move.
 */
const Canvas = memo(function Canvas(c: CanvasProps) {
  const [draft, setDraft] = useState<Quad | null>(null);
  const start = useRef<Quad>(c.quad);
  const next = useRef<Quad | null>(null);
  const frame = useRef<number | null>(null);
  useEffect(() => () => { if (frame.current != null) cancelAnimationFrame(frame.current); }, []);

  const quad = draft ?? c.quad;
  const px = quad.map(([x, y]) => [x * c.cw, y * c.ch] as Pt) as Quad;
  const [mx, my] = centroid(quad);

  const startDrag = (index: number | 'all') => {
    c.onSelect(index); start.current = c.quad; next.current = null; c.onDragging(true);
  };
  const drag = (index: number | 'all', dx: number, dy: number) => {
    const q = moveBy(start.current, index, dx / c.cw, dy / c.ch);
    next.current = q;
    c.sendLive(q);
    if (frame.current == null) {
      frame.current = requestAnimationFrame(() => { frame.current = null; if (next.current) setDraft(next.current); });
    }
  };
  const endDrag = () => {
    if (frame.current != null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (next.current) c.onCommit(next.current);
    next.current = null;
    setDraft(null);
    c.onDragging(false);
  };

  // Checkerboard cells warped with the same perspective as the TV, so they stay inside the shape.
  const cells = useMemo(() => {
    const map = squareToQuad(px);
    if (!map) return [];
    const out: { key: string; points: string; dark: boolean }[] = [];
    for (let r = 0; r < ROWS; r++) for (let k = 0; k < COLS; k++) {
      const u0 = k / COLS, u1 = (k + 1) / COLS, v0 = r / ROWS, v1 = (r + 1) / ROWS;
      out.push({ key: `${r}-${k}`, points: pts([map(u0, v0), map(u1, v0), map(u1, v1), map(u0, v1)]), dark: (k + r) % 2 === 1 });
    }
    return out;
  }, [px[0][0], px[0][1], px[1][0], px[1][1], px[2][0], px[2][1], px[3][0], px[3][1]]);

  const xs = px.map((q) => q[0]), ys = px.map((q) => q[1]);
  const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
  const outline = pts(px);

  return (
    <>
      <Svg width={c.cw} height={c.ch} style={StyleSheet.absoluteFill} pointerEvents="none">
        <Defs><ClipPath id="shape"><Polygon points={outline} /></ClipPath></Defs>
        {c.content === 'image' && c.previewSrc ? (
          <SvgImage href={{ uri: c.previewSrc }} x={bx} y={by} width={bw} height={bh} opacity={0.85}
            preserveAspectRatio={c.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'} clipPath="url(#shape)" />
        ) : c.content === 'pattern' ? (
          cells.map((cell) => <Polygon key={cell.key} points={cell.points} fill={cell.dark ? '#1B2550' : '#4D7CFE'} fillOpacity={0.55} />)
        ) : null}
        <Polygon points={outline} fill="none" stroke={c.sel === 'all' ? CYAN : 'rgba(69,217,245,0.75)'} strokeWidth={2} strokeLinejoin="round" />
      </Svg>
      {c.grid && Array.from({ length: 7 }, (_, i) => (
        <React.Fragment key={i}>
          <View pointerEvents="none" style={[gridStyles.v, { left: ((i + 1) * c.cw) / 8 }]} />
          {i < 3 && <View pointerEvents="none" style={[gridStyles.h, { top: ((i + 1) * c.ch) / 4 }]} />}
        </React.Fragment>
      ))}
      {px.map(([x, y], i) => (
        <Handle key={i} x={x} y={y} label={`Corner ${i + 1}`} active={c.sel === i}
          onStart={() => startDrag(i)} onMove={(dx, dy) => drag(i, dx, dy)} onEnd={endDrag} />
      ))}
      <Handle x={mx * c.cw} y={my * c.ch} label="Move whole shape" icon="cursor-move" active={c.sel === 'all'}
        onStart={() => startDrag('all')} onMove={(dx, dy) => drag('all', dx, dy)} onEnd={endDrag} />
    </>
  );
});

const gridStyles = StyleSheet.create({
  v: { position: 'absolute', top: 0, bottom: 0, width: 1, backgroundColor: 'rgba(69,217,245,0.35)' },
  h: { position: 'absolute', left: 0, right: 0, height: 1, backgroundColor: 'rgba(69,217,245,0.35)' },
});

export default function ProjectionEditor(p: Props) {
  const { T, scene } = p;
  const s = useMemo(() => makeStyles(T), [T]);
  const { width } = useWindowDimensions();
  const cw = Math.min(width - 48, 560), ch = cw / ASPECT; // canvas size in pixels
  const [sel, setSel] = useState<number | 'all'>(0);
  const [step, setStep] = useState(0.005);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');

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
        <Canvas quad={scene.corners} cw={cw} ch={ch} sel={sel} content={scene.content} grid={scene.grid} fit={scene.fit}
          previewSrc={previewSrc} onSelect={setSel} onCommit={p.setCorners} sendLive={p.sendLive} onDragging={p.onDragging} />
      </View>
      <Text style={[s.hint, { textAlign: 'center' }]}>Drag a corner, or the centre to move everything. The pattern follows the same perspective as the TV.</Text>

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

      {/* Touch-free control with hand gestures, seen by this phone's front camera */}
      <View style={s.card}>
        <View style={[s.row, { justifyContent: 'space-between' }]}>
          <Text style={s.ct}>Gesture control</Text>
          <Pill ok={p.vision.running} label={p.vision.running ? 'Camera on' : 'Off'} />
        </View>
        {p.vision.running ? (
          <Text style={[s.mute, { marginTop: 8 }]}>
            {p.vision.fps == null ? 'Starting the camera…'
              : p.vision.source === 'phone'
                ? `Measured on the PC: ${p.vision.fps} hand updates per second from this phone${p.vision.latency_ms != null ? `, PC to TV ${p.vision.latency_ms} ms` : ''}`
                : `Measured: ${p.vision.fps} fps, hand detection ${p.vision.detect_ms} ms per frame${p.vision.latency_ms != null ? `, delay to TV ${p.vision.latency_ms} ms` : ''}`}
          </Text>
        ) : (
          <Text style={[s.mute, { marginTop: 8 }]}>Uses this phone's front camera. Put the phone on a stand facing you and control the TV with your hand.</Text>
        )}
        {p.vision.running && p.vision.source === 'phone' && <PhoneHandCamera T={T} send={p.send} />}
        {p.vision.running && (
          <Text style={[s.ct, { marginTop: 10, color: T.cyan }]}>{p.lastGesture ? `Last gesture: ${GESTURE_NAMES[p.lastGesture] ?? p.lastGesture}` : 'No gesture yet'}</Text>
        )}
        <View style={{ marginTop: 10, gap: 4 }}>
          <Text style={s.hint}>✋  Move your whole hand to move the pointer on the TV</Text>
          <Text style={s.hint}>🤏  Pinch on a corner to drag it, inside the shape to move it all, on a side to resize</Text>
          <Text style={s.hint}>🖐️  Swipe an open hand left or right to change the content</Text>
        </View>
        <Pressable style={[s.btn, { marginTop: 12 }, p.vision.running && s.ghostSolo, (!p.connected || (!phoneCameraAvailable && !p.vision.running)) && { opacity: 0.45 }]}
          disabled={!p.connected || (!phoneCameraAvailable && !p.vision.running)} onPress={() => p.onGestures(!p.vision.running)} accessibilityRole="button"
          accessibilityLabel={p.vision.running ? 'Stop gesture control' : 'Start gesture control'}>
          <Icon name={p.vision.running ? 'stop' : 'hand-wave-outline'} size={18} color={p.vision.running ? T.blue : '#FFFFFF'} />
          <Text style={[s.btnT, p.vision.running && { color: T.blue }]}>{p.vision.running ? 'Stop gestures' : 'Start gestures'}</Text>
        </Pressable>
        {!phoneCameraAvailable && !p.vision.running && <PhoneHandCamera T={T} send={p.send} />}
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
