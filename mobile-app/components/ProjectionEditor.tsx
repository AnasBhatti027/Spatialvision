import React, { createContext, memo, useContext, useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator, BackHandler, PanResponder, Pressable, ScrollView, Share, StyleSheet, Text, TextInput, View, useWindowDimensions,
} from 'react-native';
import { MaterialCommunityIcons as Icon } from '@expo/vector-icons';
import * as ImagePicker from 'expo-image-picker';
import Svg, { ClipPath, Defs, G, Image as SvgImage, Polygon, Polyline, Text as SvgText } from 'react-native-svg';
import {
  ASPECT, Content, MAX_MASK, MAX_MESH, MAX_SURFACES, ProjectionApi, Pt, Quad, RECT_MASK, SURFACE_COLORS, ShapeKind, Surface,
  centerQuad, centroid, FULL_QUAD, insertMaskPoint, maskShape, moveBy, quadToSquare, regularMesh, resampleMesh, rotateBy, scaleBy,
  sceneMessage, snapPoint, unwarp, warpOf,
} from './projection';
import PhoneHandCamera, { phoneCameraAvailable } from './PhoneHandCamera';

type Theme = { dark: boolean; bg: string; s1: string; s2: string; blue: string; cyan: string; violet: string; text: string; mute: string; line: string; err: string };
type Ic = React.ComponentProps<typeof Icon>['name'];
export type VisionStatus = { running: boolean; source?: string | null; fps: number | null; detect_ms: number | null; latency_ms?: number | null;
  gap_phone_ms?: number | null; gap_net_ms?: number | null; held_pct?: number | null; held_why?: string | null; error: string | null };
export type PresetItem = { id: number; name: string; created: number; surfaces: number };

const GESTURE_NAMES: Record<string, string> = {
  pinch: 'Pinch', point: 'Point', open_palm: 'Open palm', fist: 'Fist', swipe_left: 'Swipe left', swipe_right: 'Swipe right',
};

// The canvas is a small copy of the TV, so it stays dark in both themes (like the real screen).
const CANVAS_BG = '#0B1022';
const CYAN = '#45D9F5', VIOLET = '#9065FF', WHITE = '#F4F6FF';
const HANDLE = 40; // touch size of a handle
const STEPS = { fine: 0.002, normal: 0.006, big: 0.02 } as const;
type Mode = 'corners' | 'warp' | 'shape';
type Sheet = null | 'content' | 'gestures' | 'scenes' | 'help';

type Props = {
  T: Theme;
  proj: ProjectionApi;
  connected: boolean;     // phone paired with the backend
  tvConnected: boolean;   // TV page open and connected
  server: string;         // backend address, e.g. 192.168.10.13:8000
  token?: string;         // login token, needed to upload images
  onBack: () => void;
  onGoConnect: () => void;
  vision: VisionStatus;   // hand tracking status measured by the backend
  lastGesture: string;
  onGestures: (on: boolean) => void;
  send: (msg: object) => boolean; // to the PC; the phone camera sends its hand points with it
  presets: PresetItem[];
  presetsMsg: string;
};

/** A draggable handle. Drag reports the distance moved since the finger went down, in pixels. */
function Handle({ x, y, label, text, active, small, icon, onStart, onMove, onEnd }: {
  x: number; y: number; label: string; text?: string; active: boolean; small?: boolean; icon?: Ic;
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
  const d = small ? 16 : 26;
  return (
    <View {...pan.panHandlers} accessibilityLabel={label} accessibilityRole="adjustable"
      style={{ position: 'absolute', left: x - HANDLE / 2, top: y - HANDLE / 2, width: HANDLE, height: HANDLE, alignItems: 'center', justifyContent: 'center' }}>
      <View style={{ width: d, height: d, borderRadius: d / 2, backgroundColor: active ? CYAN : VIOLET, borderWidth: 2, borderColor: WHITE, alignItems: 'center', justifyContent: 'center' }}>
        {icon ? <Icon name={icon} size={14} color={WHITE} />
          : text && !small ? <Text style={{ color: active ? '#080B16' : WHITE, fontSize: 11, fontWeight: '800' }}>{text}</Text> : null}
      </View>
    </View>
  );
}

const COLS = 8, ROWS = 4; // checkerboard cells in the preview
const pts = (list: Pt[]) => list.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ');
/** Points along a closed outline in (u, v), each side cut into k pieces so curves from the warp show. */
function along(outline: Pt[], k: number): Pt[] {
  const out: Pt[] = [];
  outline.forEach((a, i) => {
    const b = outline[(i + 1) % outline.length];
    for (let s = 0; s < k; s++) out.push([a[0] + ((b[0] - a[0]) * s) / k, a[1] + ((b[1] - a[1]) * s) / k]);
  });
  return out;
}
function inside(p: Pt, poly: Pt[]) {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > p[1]) !== (yj > p[1]) && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) hit = !hit;
  }
  return hit;
}

type Drag = { id: string; part: Partial<Surface> } | null;
type CanvasProps = {
  surfaces: Surface[]; selected: string; mode: Mode; target: number | 'all';
  cw: number; ch: number; previews: Record<string, string>; server: string; snap: boolean; precise: boolean;
  onSelect: (id: string) => void;
  onTarget: (t: number | 'all') => void;
  onCommit: (id: string, part: Partial<Surface>) => void;  // finger lifted: store the change
  sendLive: (id: string, part: Partial<Surface>) => void;  // finger moving: tell the TV only
  onInsertPoint: (after: number) => void;
  onDragging: (d: boolean) => void;
};

/**
 * The small copy of the TV screen. While something is dragged, the change lives here only
 * (redrawn at most once per screen frame), so the rest of the app does not re-render on every move.
 */
function Canvas(c: CanvasProps) {
  const [draft, setDraft] = useState<Drag>(null);
  const next = useRef<Drag>(null);
  const frame = useRef<number | null>(null);
  const start = useRef<Surface | null>(null);
  useEffect(() => () => { if (frame.current != null) cancelAnimationFrame(frame.current); }, []);

  const shown = c.surfaces.map((s) => (draft && draft.id === s.id ? { ...s, ...draft.part } : s));
  const sel = shown.find((s) => s.id === c.selected) ?? shown[0];
  const toPx = ([x, y]: Pt): Pt => [x * c.cw, y * c.ch];

  // Everything needed to draw each surface, in screen pixels. Kept per surface, so during a drag only
  // the surface that moves is worked out and redrawn again (the others keep their old drawing).
  const cache = useRef(new WeakMap<Surface, { cw: number; ch: number; d: Drawn }>());
  const drawn = shown.map((s) => {
    const hit = cache.current.get(s);
    if (hit && hit.cw === c.cw && hit.ch === c.ch) return hit.d;
    const d = drawSurface(s, c.cw, c.ch);
    cache.current.set(s, { cw: c.cw, ch: c.ch, d });
    return d;
  });
  const commitPart = (part: Partial<Surface>) => {
    const id = start.current!.id;
    next.current = { id, part };
    c.sendLive(id, part);
    if (frame.current == null) frame.current = requestAnimationFrame(() => { frame.current = null; if (next.current) setDraft(next.current); });
  };
  const begin = (s: Surface) => { start.current = s; next.current = null; c.onDragging(true); };
  const end = () => {
    if (frame.current != null) { cancelAnimationFrame(frame.current); frame.current = null; }
    if (next.current) c.onCommit(next.current.id, next.current.part);
    next.current = null; start.current = null;
    setDraft(null);
    c.onDragging(false);
  };
  const f = c.precise ? 0.3 : 1; // precise drag: the handle moves a third of the finger's distance
  const snapTargets = (id: string) => c.surfaces.filter((s) => s.id !== id && s.visible).flatMap((s) => s.corners);

  const dragCorner = (i: number | 'all', dx: number, dy: number) => {
    const s0 = start.current!;
    let q = moveBy(s0.corners, i, (dx * f) / c.cw, (dy * f) / c.ch);
    if (c.snap && i !== 'all') q = q.map((p, k) => (k === i ? snapPoint(p, snapTargets(s0.id), 0.025) : p)) as Quad;
    commitPart({ corners: q });
  };
  const dragNode = (k: number, dx: number, dy: number) => {
    const s0 = start.current!, m = s0.mesh!;
    // A warp point sits in the corners' square, so its screen position is the perspective of its (u, v).
    const inv = quadToSquare(s0.corners);
    if (!inv) return;
    const base = squarePos(s0.corners, m.pts[k][0], m.pts[k][1]);
    const uv = inv(base[0] + (dx * f) / c.cw, base[1] + (dy * f) / c.ch);
    const ptsNew = m.pts.map((q, j) => (j === k ? [Math.min(1.5, Math.max(-0.5, uv[0])), Math.min(1.5, Math.max(-0.5, uv[1]))] : q)) as Pt[];
    commitPart({ mesh: { ...m, pts: ptsNew } });
  };
  const dragMask = (k: number, dx: number, dy: number) => {
    const s0 = start.current!, mask = s0.mask ?? RECT_MASK;
    const W = warpOf(s0, s0.corners);
    if (!W) return;
    const p0 = W(mask[k][0], mask[k][1]);
    const uv = unwarp(s0, s0.corners, [p0[0] + (dx * f) / c.cw, p0[1] + (dy * f) / c.ch], mask[k]);
    if (!uv) return;
    let p: Pt = [Math.min(1, Math.max(0, uv[0])), Math.min(1, Math.max(0, uv[1]))];
    if (c.snap) p = [p[0] < 0.02 ? 0 : p[0] > 0.98 ? 1 : p[0], p[1] < 0.02 ? 0 : p[1] > 0.98 ? 1 : p[1]];
    commitPart({ mask: mask.map((q, j) => (j === k ? p : q)) });
  };

  // Touching the picture itself: tap a surface to select it; drag the selected one to move it.
  // The touch handler is created once, so it reads the newest values (canvas size, surfaces) from here.
  const st = useRef({ c, drawn, sel, begin, dragCorner, end });
  st.current = { c, drawn, sel, begin, dragCorner, end };
  const bodyPan = useRef(PanResponder.create({
    onStartShouldSetPanResponder: () => true,
    onMoveShouldSetPanResponder: () => true,
    onPanResponderTerminationRequest: () => !start.current,
    onPanResponderGrant: (e) => {
      const { c: cc, drawn: dd, sel: ss } = st.current;
      const p: Pt = [e.nativeEvent.locationX, e.nativeEvent.locationY];
      // Topmost surface under the finger (the list is drawn bottom to top).
      const hit = [...dd].reverse().find((d) => d.ok && d.s.visible && inside(p, d.outline))?.s
        ?? [...dd].reverse().find((d) => inside(p, d.corners))?.s;
      if (hit && hit.id !== ss.id) { cc.onSelect(hit.id); return; }
      if (hit && hit.id === ss.id && !ss.locked) { cc.onTarget('all'); st.current.begin(ss); }
    },
    onPanResponderMove: (_, g) => { if (start.current) st.current.dragCorner('all', g.dx, g.dy); },
    onPanResponderRelease: () => { if (start.current) st.current.end(); },
    onPanResponderTerminate: () => { if (start.current) st.current.end(); },
  })).current;

  const selDrawn = drawn.find((d) => d.s.id === sel.id)!;
  const handles: React.ReactNode[] = [];
  if (!sel.locked && selDrawn.ok) {
    if (c.mode === 'corners') {
      sel.corners.forEach((p, i) => {
        const [x, y] = toPx(p);
        handles.push(<Handle key={`c${i}`} x={x} y={y} text={`${i + 1}`} label={`Corner ${i + 1}`} active={c.target === i}
          onStart={() => { c.onTarget(i); begin(sel); }} onMove={(dx, dy) => dragCorner(i, dx, dy)} onEnd={end} />);
      });
      const [mx, my] = toPx(centroid(sel.corners));
      handles.push(<Handle key="all" x={mx} y={my} icon="cursor-move" label="Move whole surface" active={c.target === 'all'}
        onStart={() => { c.onTarget('all'); begin(sel); }} onMove={(dx, dy) => dragCorner('all', dx, dy)} onEnd={end} />);
    } else if (c.mode === 'warp' && sel.mesh) {
      sel.mesh.pts.forEach((uv, k) => {
        const [x, y] = toPx(squarePos(sel.corners, uv[0], uv[1]));
        handles.push(<Handle key={`n${k}`} x={x} y={y} small label={`Warp point ${k + 1}`} active={c.target === k}
          onStart={() => { c.onTarget(k); begin(sel); }} onMove={(dx, dy) => dragNode(k, dx, dy)} onEnd={end} />);
      });
    } else if (c.mode === 'shape') {
      const mask = sel.mask ?? RECT_MASK;
      mask.forEach((uv, k) => {
        const [x, y] = selDrawn.map(uv[0], uv[1]);
        handles.push(<Handle key={`m${k}`} x={x} y={y} text={`${k + 1}`} label={`Shape point ${k + 1}`} active={c.target === k}
          onStart={() => { c.onTarget(k); begin(sel); }} onMove={(dx, dy) => dragMask(k, dx, dy)} onEnd={end} />);
      });
      // Small + on each side: tap it to add a point there.
      if (mask.length < MAX_MASK) mask.forEach((a, k) => {
        const b = mask[(k + 1) % mask.length];
        const [x, y] = selDrawn.map((a[0] + b[0]) / 2, (a[1] + b[1]) / 2);
        handles.push(
          <Pressable key={`add${k}`} onPress={() => c.onInsertPoint(k)} accessibilityLabel={`Add a point after point ${k + 1}`}
            style={{ position: 'absolute', left: x - 14, top: y - 14, width: 28, height: 28, alignItems: 'center', justifyContent: 'center' }}>
            <View style={{ width: 18, height: 18, borderRadius: 9, backgroundColor: 'rgba(8,11,22,0.8)', borderWidth: 1.5, borderColor: CYAN, alignItems: 'center', justifyContent: 'center' }}>
              <Icon name="plus" size={12} color={CYAN} />
            </View>
          </Pressable>,
        );
      });
    }
  }

  return (
    <>
      <View style={StyleSheet.absoluteFill} {...bodyPan.panHandlers} />
      <Svg width={c.cw} height={c.ch} style={StyleSheet.absoluteFill} pointerEvents="none">
        {drawn.map((d) => (
          <SurfaceShape key={d.s.id} d={d} isSel={d.s.id === sel.id} warpMode={c.mode === 'warp'} cw={c.cw} ch={c.ch}
            src={c.previews[d.s.id] ?? (d.s.image_url ? `http://${c.server}${d.s.image_url}` : null)} />
        ))}
      </Svg>
      {handles}
      {sel.locked && (
        <View pointerEvents="none" style={[cs.badge, { left: 8, top: 8 }]}><Icon name="lock" size={12} color={CYAN} /><Text style={cs.badgeT}>{sel.name} is locked</Text></View>
      )}
    </>
  );
}

type Drawn = ReturnType<typeof drawSurface>;
// Every new outline gets a new cut-out name. On Android, react-native-svg does not always redraw a
// cut-out (ClipPath) whose shape changed, so the picture stayed cut to the old outline (seen 10 Nov).
let clipCounter = 0;
/** Works out where a surface, its outline and its checkerboard cells are, in canvas pixels. */
function drawSurface(s: Surface, cw: number, ch: number) {
  const toPx = ([x, y]: Pt): Pt => [x * cw, y * ch];
  const W = warpOf(s, s.corners);
  const corners = s.corners.map(toPx) as Pt[];
  if (!W) return { s, ok: false as const, corners };
  const k = s.mesh ? 4 : 1;
  const map = (u: number, v: number) => toPx(W(u, v));
  const outline = along(s.mask ?? RECT_MASK, s.mask ? Math.max(1, k / 2) : k).map(([u, v]) => map(u, v));
  const cells: { key: string; points: string; dark: boolean }[] = [];
  if (s.content === 'pattern' || s.content === 'grid' || s.grid) {
    const kk = s.mesh ? 2 : 1;
    for (let r = 0; r < ROWS; r++) for (let q = 0; q < COLS; q++) {
      const u0 = q / COLS, u1 = (q + 1) / COLS, v0 = r / ROWS, v1 = (r + 1) / ROWS;
      cells.push({ key: `${r}-${q}`, points: pts(along([[u0, v0], [u1, v0], [u1, v1], [u0, v1]], kk).map(([u, v]) => map(u, v))), dark: (q + r) % 2 === 1 });
    }
  }
  return { s, ok: true as const, W, map, outline, outlinePts: pts(outline), cells, corners, clipId: `clip${++clipCounter}` };
}

/** One surface in the preview. Only redrawn when that surface (or its selection) changes. */
const SurfaceShape = memo(function SurfaceShape({ d, isSel, warpMode, cw, ch, src }: {
  d: Drawn; isSel: boolean; warpMode: boolean; cw: number; ch: number; src: string | null;
}) {
  const s = d.s;
  if (!d.ok) return <Polygon points={pts(d.corners)} fill="none" stroke="#FF7A8A" strokeWidth={2} strokeDasharray="6,4" />;
  const xs = d.outline.map((p) => p[0]), ys = d.outline.map((p) => p[1]);
  const bx = Math.min(...xs), by = Math.min(...ys), bw = Math.max(...xs) - bx, bh = Math.max(...ys) - by;
  const [lx, ly] = d.map(0.5, 0.5);
  // The cells already fill the surface exactly, so a cut-out is only needed for a custom shape or an image.
  const needClip = !!s.mask || s.content === 'image';
  const lines = (stroke: string) => d.cells.map((cell) => <Polygon key={`g${cell.key}`} points={cell.points} fill="none" stroke={stroke} strokeWidth={1} />);
  return (
    <G>
      {needClip && <Defs><ClipPath id={d.clipId}><Polygon points={d.outlinePts} /></ClipPath></Defs>}
      {s.visible && (
        <G opacity={s.opacity} clipPath={needClip ? `url(#${d.clipId})` : undefined}>
          {s.content === 'image' && src ? (
            <SvgImage href={{ uri: src }} x={bx} y={by} width={bw} height={bh}
              preserveAspectRatio={s.fit === 'cover' ? 'xMidYMid slice' : 'xMidYMid meet'} />
          ) : s.content === 'color' ? (
            <Polygon points={d.outlinePts} fill={s.color} />
          ) : s.content === 'pattern' ? (
            d.cells.map((cell) => <Polygon key={cell.key} points={cell.points} fill={cell.dark ? '#1B2550' : '#4D7CFE'} fillOpacity={0.6} />)
          ) : s.content === 'grid' ? lines('rgba(69,217,245,0.7)') : null}
          {s.grid && s.content !== 'grid' && lines('rgba(69,217,245,0.7)')}
        </G>
      )}
      <Polygon points={d.outlinePts} fill="none" stroke={isSel ? CYAN : 'rgba(144,101,255,0.7)'} strokeWidth={isSel ? 2 : 1.2}
        strokeDasharray={s.visible ? undefined : '5,4'} strokeLinejoin="round" />
      {!isSel && <SvgText x={lx} y={ly} fill={WHITE} fontSize={11} fontWeight="700" textAnchor="middle" opacity={0.85}>{s.name}</SvgText>}
      {isSel && warpMode && s.mesh && meshLines(s, cw, ch)}
    </G>
  );
});

/** Screen position of (u, v) through the 4 corners only (where a warp point sits). */
function squarePos(q: Quad, u: number, v: number): Pt {
  const W = warpOf({ mesh: null }, q);
  return W ? W(u, v) : [0, 0];
}
/** Thin lines joining the warp points, so the grid is easy to see. */
function meshLines(s: Surface, cw: number, ch: number) {
  const m = s.mesh!, P = (i: number, j: number) => {
    const [x, y] = squarePos(s.corners, ...(m.pts[j * (m.cols + 1) + i] as [number, number]));
    return [x * cw, y * ch] as Pt;
  };
  const lines: React.ReactNode[] = [];
  for (let j = 0; j <= m.rows; j++) lines.push(<Polyline key={`r${j}`} points={pts(Array.from({ length: m.cols + 1 }, (_, i) => P(i, j)))} fill="none" stroke="rgba(69,217,245,0.55)" strokeWidth={1} />);
  for (let i = 0; i <= m.cols; i++) lines.push(<Polyline key={`c${i}`} points={pts(Array.from({ length: m.rows + 1 }, (_, j) => P(i, j)))} fill="none" stroke="rgba(69,217,245,0.55)" strokeWidth={1} />);
  return lines;
}

const cs = StyleSheet.create({
  badge: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 4, backgroundColor: 'rgba(8,11,22,0.8)', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 4 },
  badgeT: { color: CYAN, fontSize: 11, fontWeight: '700' },
});

const SOON: { icon: Ic; label: string; what: string }[] = [
  { icon: 'video-outline', label: 'Video', what: 'Playing videos on a surface' },
  { icon: 'filmstrip', label: 'Video library', what: 'A library of uploaded videos' },
  { icon: 'timeline-clock-outline', label: 'Timeline', what: 'Changing content over time' },
  { icon: 'sync', label: 'Video sync', what: 'Starting videos on all surfaces together' },
  { icon: 'earth', label: '3D sphere', what: 'Mapping onto round objects' },
  { icon: 'gamepad-variant-outline', label: 'Games', what: 'Gesture mini-games' },
  { icon: 'gesture-tap-hold', label: 'Interactive', what: 'Content that reacts to your hand' },
  { icon: 'projector', label: 'Projector', what: 'Projector output (the TV works the same way now)' },
];
const SHAPES: { kind: ShapeKind; icon: Ic; label: string }[] = [
  { kind: 'rect', icon: 'square-outline', label: 'Rectangle' }, { kind: 'circle', icon: 'circle-outline', label: 'Circle' },
  { kind: 'triangle', icon: 'triangle-outline', label: 'Triangle' }, { kind: 'diamond', icon: 'rhombus-outline', label: 'Diamond' },
  { kind: 'hexagon', icon: 'hexagon-outline', label: 'Hexagon' }, { kind: 'star', icon: 'star-outline', label: 'Star' },
];
const CONTENTS: { c: Content; icon: Ic; label: string }[] = [
  { c: 'pattern', icon: 'checkerboard', label: 'Test pattern' }, { c: 'grid', icon: 'grid', label: 'Grid' },
  { c: 'color', icon: 'format-color-fill', label: 'Colour' }, { c: 'image', icon: 'image-outline', label: 'Image' },
  { c: 'blank', icon: 'square-rounded', label: 'Blank' },
];

type Ui = { T: Theme; s: ReturnType<typeof makeStyles> };
const UiCtx = createContext<Ui | null>(null);
const useUi = () => useContext(UiCtx)!;
function Tool({ icon, label, onPress, on, disabled, soon }: { icon: Ic; label: string; onPress: () => void; on?: boolean; disabled?: boolean; soon?: boolean }) {
  const { T, s } = useUi();
  return (
    <Pressable onPress={onPress} disabled={disabled} accessibilityRole="button" accessibilityLabel={soon ? `${label}, coming soon` : label}
      accessibilityState={{ selected: !!on, disabled: !!disabled }}
      style={({ pressed }) => [s.tool, on && s.toolOn, (disabled || soon) && { opacity: 0.45 }, pressed && { opacity: 0.7 }]}>
      <Icon name={icon} size={22} color={on ? '#FFFFFF' : T.cyan} />
      <Text style={[s.toolT, on && { color: '#FFFFFF' }]} numberOfLines={1}>{label}</Text>
      {soon && <Text style={s.soon}>SOON</Text>}
    </Pressable>
  );
}
function Chip({ on, label, onPress, icon }: { on: boolean; label: string; onPress: () => void; icon?: Ic }) {
  const { T, s } = useUi();
  return (
    <Pressable onPress={onPress} accessibilityRole="button" accessibilityState={{ selected: on }} accessibilityLabel={label}
      style={[s.chip, on && s.chipOn]}>
      {icon && <Icon name={icon} size={15} color={on ? '#FFFFFF' : T.mute} />}
      <Text style={[s.chipT, on && { color: '#FFFFFF' }]}>{label}</Text>
    </Pressable>
  );
}
function Strip({ children }: { children: React.ReactNode }) {
  const { s } = useUi();
  return <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={s.strip} keyboardShouldPersistTaps="handled">{children}</ScrollView>;
}
function Dot({ ok, label }: { ok: boolean; label: string }) {
  const { T, s } = useUi();
  return <View style={s.dotRow}><View style={[s.dot, { backgroundColor: ok ? T.cyan : T.mute }]} /><Text style={[s.dotT, { color: ok ? T.cyan : T.mute }]}>{label}</Text></View>;
}

export default function ProjectionEditor(p: Props) {
  const { T, proj } = p;
  const { scene, selected: cur } = proj;
  const s = useMemo(() => makeStyles(T), [T]);
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const [mode, setMode] = useState<Mode>('corners');
  const [target, setTarget] = useState<number | 'all'>(0);
  const [step, setStep] = useState<keyof typeof STEPS>('normal');
  const [snap, setSnap] = useState(true);
  const [precise, setPrecise] = useState(false);
  const [sheet, setSheet] = useState<Sheet>(null);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [toast, setToast] = useState('');
  const [presetName, setPresetName] = useState('');
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The phone's back button first closes an open panel, then leaves the editor (handled by the app).
  const sheetRef = useRef(sheet); sheetRef.current = sheet;
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (sheetRef.current) { setSheet(null); return true; }
      return false;
    });
    return () => sub.remove();
  }, []);
  useEffect(() => () => { if (toastTimer.current) clearTimeout(toastTimer.current); }, []);
  const say = (t: string) => {
    setToast(t);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(''), 2200);
  };

  // The canvas fills the free space, keeping the TV's 16:9 shape.
  const [area, setArea] = useState({ w: width - 16, h: 220 });
  const cw = Math.max(120, Math.min(area.w, area.h * ASPECT)), ch = cw / ASPECT;

  // A different surface or mode starts with a sensible handle chosen.
  useEffect(() => { setTarget(0); }, [mode, cur.id]);

  const locked = cur.locked;
  const needUnlocked = (fn: () => void) => () => { if (locked) say(`${cur.name} is locked. Unlock it first.`); else fn(); };
  const setCorners = (q: Quad) => proj.editSelected({ corners: q });

  // ---------- Arrow buttons: move the chosen handle (or the whole surface) a small step ----------
  const nudge = (dx: number, dy: number) => {
    if (locked) { say(`${cur.name} is locked.`); return; }
    const sx = dx * STEPS[step], sy = dy * STEPS[step] * ASPECT; // the same distance across and down on the TV
    if (target === 'all' || mode === 'corners') { setCorners(moveBy(cur.corners, target, sx, sy)); return; }
    if (mode === 'warp' && cur.mesh && typeof target === 'number') {
      const inv = quadToSquare(cur.corners);
      if (!inv) return;
      const [x, y] = squarePos(cur.corners, ...(cur.mesh.pts[target] as [number, number]));
      const uv = inv(x + sx, y + sy);
      proj.editSelected({ mesh: { ...cur.mesh, pts: cur.mesh.pts.map((q, j) => (j === target ? [Math.min(1.5, Math.max(-0.5, uv[0])), Math.min(1.5, Math.max(-0.5, uv[1]))] : q)) as Pt[] } });
    } else if (mode === 'shape' && typeof target === 'number') {
      const mask = cur.mask ?? RECT_MASK, W = warpOf(cur, cur.corners);
      if (!W || !mask[target]) return;
      const [x, y] = W(mask[target][0], mask[target][1]);
      const uv = unwarp(cur, cur.corners, [x + sx, y + sy], mask[target]);
      if (uv) proj.editSelected({ mask: mask.map((q, j) => (j === target ? [Math.min(1, Math.max(0, uv[0])), Math.min(1, Math.max(0, uv[1]))] : q)) as Pt[] });
    }
  };

  // ---------- Warp grid ----------
  const meshSize = (dc: number, dr: number) => needUnlocked(() => {
    const m = cur.mesh;
    const cols = Math.min(MAX_MESH, Math.max(1, (m?.cols ?? 1) + dc)), rows = Math.min(MAX_MESH, Math.max(1, (m?.rows ?? 1) + dr));
    if (!m && dc <= 0 && dr <= 0) return;
    proj.editSelected({ mesh: resampleMesh(m, cols, rows) });
    setTarget(0);
  })();

  // ---------- Shape outline ----------
  const insertPoint = (after: number) => {
    if (locked) return;
    const r = insertMaskPoint(cur.mask, after);
    proj.editSelected({ mask: r.mask });
    setTarget(r.index);
  };
  const deletePoint = needUnlocked(() => {
    const mask = cur.mask ?? RECT_MASK;
    if (typeof target !== 'number' || mask.length <= 3) { say('A shape needs at least 3 points.'); return; }
    proj.editSelected({ mask: mask.filter((_, j) => j !== target) });
    setTarget(Math.max(0, target - 1));
  });

  // ---------- Content ----------
  const pickImage = async () => {
    setMsg('');
    const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images'], quality: 0.7, base64: true });
    if (r.canceled || !r.assets?.length) return;
    const a = r.assets[0], id = cur.id;
    proj.setPreview(id, a.uri);
    proj.editSurface(id, { content: 'image', image_url: null });
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
      else proj.editSurface(id, { image_url: data.url });
    } catch {
      setMsg('Could not upload the image. Check that the backend is still running.');
    } finally { setBusy(false); }
  };
  const hasImage = !!(proj.previews[cur.id] || cur.image_url);

  const exportScene = async () => {
    try {
      await Share.share({ title: 'SpatialVision scene', message: JSON.stringify(sceneMessage(scene)) });
    } catch { say('Could not open the share menu.'); }
  };
  const openScenes = () => { setSheet('scenes'); if (p.connected) p.send({ type: 'list_presets' }); };

  const ui = useMemo(() => ({ T, s }), [T, s]);

  const targetName = target === 'all' ? 'whole surface'
    : mode === 'corners' ? `corner ${target + 1}` : mode === 'warp' ? `warp point ${target + 1}` : `shape point ${target + 1}`;

  // ---------- Sections ----------
  const topBar = (
    <View style={s.top}>
      <Pressable onPress={p.onBack} style={s.iconBtn} accessibilityRole="button" accessibilityLabel="Back"><Icon name="arrow-left" size={22} color={T.cyan} /></Pressable>
      <Pressable style={{ flex: 1 }} onPress={!p.connected ? p.onGoConnect : undefined} accessibilityRole={!p.connected ? 'button' : undefined}>
        <Text style={s.title}>Projection Editor</Text>
        <View style={{ flexDirection: 'row', gap: 10 }}>
          <Dot ok={p.connected} label={p.connected ? 'Paired' : 'Not paired · tap to connect'} />
          {p.connected && <Dot ok={p.tvConnected} label={p.tvConnected ? 'TV live' : 'TV page not open'} />}
          {p.vision.running && <Dot ok label="Gestures on" />}
        </View>
      </Pressable>
      <Pressable onPress={proj.undo} disabled={!proj.canUndo} style={[s.iconBtn, !proj.canUndo && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel="Undo"><Icon name="undo" size={22} color={T.cyan} /></Pressable>
      <Pressable onPress={proj.redo} disabled={!proj.canRedo} style={[s.iconBtn, !proj.canRedo && { opacity: 0.35 }]} accessibilityRole="button" accessibilityLabel="Redo"><Icon name="redo" size={22} color={T.cyan} /></Pressable>
    </View>
  );

  const surfaceTools = (
    <Strip>
      <Tool icon="restore" label="Reset" onPress={() => { proj.resetSurface(); setTarget(0); say(`${cur.name} is back to the start. Undo brings your changes back.`); }} />
      <Tool icon="backup-restore" label="Reset all" onPress={() => { proj.resetScene(); setTarget(0); say('Everything is back to one fresh surface. Undo brings it back.'); }} />
      <Tool icon="plus-box-outline" label="Add" onPress={proj.addSurface} disabled={scene.surfaces.length >= MAX_SURFACES} />
      <Tool icon="content-copy" label="Duplicate" onPress={proj.duplicateSurface} disabled={scene.surfaces.length >= MAX_SURFACES} />
      <Tool icon="trash-can-outline" label="Delete" onPress={proj.deleteSurface} disabled={scene.surfaces.length <= 1} />
      <Tool icon="arrange-bring-forward" label="Layer up" onPress={() => proj.moveLayer(1)} />
      <Tool icon="arrange-send-backward" label="Layer down" onPress={() => proj.moveLayer(-1)} />
      <Tool icon={cur.visible ? 'eye-outline' : 'eye-off-outline'} label={cur.visible ? 'Hide' : 'Show'} on={!cur.visible} onPress={() => proj.editSelected({ visible: !cur.visible })} />
      <Tool icon={locked ? 'lock-outline' : 'lock-open-variant-outline'} label={locked ? 'Unlock' : 'Lock'} on={locked} onPress={() => proj.editSelected({ locked: !locked })} />
      <Tool icon="fullscreen" label="Fill screen" onPress={needUnlocked(() => setCorners(FULL_QUAD))} />
      <Tool icon="image-filter-center-focus" label="Centre" onPress={needUnlocked(() => setCorners(centerQuad(cur.corners)))} />
      <Tool icon="flip-horizontal" label="Mirror" on={cur.flipX} onPress={() => proj.editSelected({ flipX: !cur.flipX })} />
      <Tool icon="flip-vertical" label="Flip" on={cur.flipY} onPress={() => proj.editSelected({ flipY: !cur.flipY })} />
      <Tool icon="lightbulb-off-outline" label="Blackout" on={scene.blackout} onPress={() => proj.setBlackout(!scene.blackout)} />
    </Strip>
  );

  const canvas = (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', minHeight: 140 }}
      onLayout={(e) => setArea({ w: e.nativeEvent.layout.width - 16, h: e.nativeEvent.layout.height - 8 })}>
      <View style={[s.canvas, { width: cw, height: ch }]}>
        <Canvas surfaces={scene.surfaces} selected={cur.id} mode={mode} target={target} cw={cw} ch={ch} previews={proj.previews}
          server={p.server} snap={snap} precise={precise} onSelect={proj.select} onTarget={setTarget}
          onCommit={(id, part) => proj.editSurface(id, part)} sendLive={proj.sendLive} onInsertPoint={insertPoint} onDragging={setDragging} />
        {scene.blackout && <View pointerEvents="none" style={[cs.badge, { right: 8, top: 8 }]}><Icon name="lightbulb-off-outline" size={12} color={CYAN} /><Text style={cs.badgeT}>Blackout: TV shows nothing</Text></View>}
      </View>
    </View>
  );

  const surfaceChips = (
    <Strip>
      {scene.surfaces.map((x, i) => (
        <Chip key={x.id} on={x.id === cur.id} label={x.name} icon={x.locked ? 'lock' : !x.visible ? 'eye-off-outline' : undefined} onPress={() => proj.select(x.id)} />
      ))}
      {scene.surfaces.length < MAX_SURFACES && <Chip on={false} label="New" icon="plus" onPress={proj.addSurface} />}
    </Strip>
  );

  const modes = (
    <View style={s.seg}>
      {([['corners', 'vector-square', 'Corners'], ['warp', 'grid', 'Warp points'], ['shape', 'vector-polygon', 'Shape']] as [Mode, Ic, string][]).map(([m, ic, l]) => (
        <Pressable key={m} onPress={() => setMode(m)} style={[s.segItem, mode === m && s.segOn]} accessibilityRole="button" accessibilityState={{ selected: mode === m }} accessibilityLabel={l}>
          <Icon name={ic} size={18} color={mode === m ? '#FFFFFF' : T.mute} />
          <Text style={[s.segT, mode === m && { color: '#FFFFFF' }]}>{l}</Text>
        </Pressable>
      ))}
    </View>
  );

  const modeTools = mode === 'corners' ? (
    <Strip>
      {[0, 1, 2, 3].map((i) => <Chip key={i} on={target === i} label={`${i + 1}`} onPress={() => setTarget(i)} />)}
      <Chip on={target === 'all'} label="All" onPress={() => setTarget('all')} />
      <Tool icon="rotate-left" label="Rotate" onPress={needUnlocked(() => setCorners(rotateBy(cur.corners, -2)))} />
      <Tool icon="rotate-right" label="Rotate" onPress={needUnlocked(() => setCorners(rotateBy(cur.corners, 2)))} />
      <Tool icon="format-rotate-90" label="Turn 90°" onPress={needUnlocked(() => { const q = cur.corners; setCorners([q[3], q[0], q[1], q[2]]); })} />
      <Tool icon="magnify-minus-outline" label="Smaller" onPress={needUnlocked(() => setCorners(scaleBy(cur.corners, 0.97)))} />
      <Tool icon="magnify-plus-outline" label="Bigger" onPress={needUnlocked(() => setCorners(scaleBy(cur.corners, 1.03)))} />
      <Tool icon="restore" label="Reset" onPress={needUnlocked(() => { proj.editSelected({ corners: [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]] }); setTarget(0); })} />
    </Strip>
  ) : mode === 'warp' ? (
    <Strip>
      <View style={s.info}><Text style={s.infoT}>{cur.mesh ? `${cur.mesh.cols} × ${cur.mesh.rows}` : 'Off'}</Text><Text style={s.infoS}>grid</Text></View>
      <Tool icon="table-column-plus-after" label="+ Column" onPress={() => meshSize(1, 0)} disabled={(cur.mesh?.cols ?? 1) >= MAX_MESH && !!cur.mesh} />
      <Tool icon="table-column-remove" label="− Column" onPress={() => meshSize(-1, 0)} disabled={!cur.mesh || cur.mesh.cols <= 1} />
      <Tool icon="table-row-plus-after" label="+ Row" onPress={() => meshSize(0, 1)} disabled={(cur.mesh?.rows ?? 1) >= MAX_MESH && !!cur.mesh} />
      <Tool icon="table-row-remove" label="− Row" onPress={() => meshSize(0, -1)} disabled={!cur.mesh || cur.mesh.rows <= 1} />
      <Tool icon="restore" label="Flatten" onPress={needUnlocked(() => cur.mesh && proj.editSelected({ mesh: regularMesh(cur.mesh.cols, cur.mesh.rows) }))} disabled={!cur.mesh} />
      <Tool icon="grid-off" label="Remove" onPress={needUnlocked(() => proj.editSelected({ mesh: null }))} disabled={!cur.mesh} />
    </Strip>
  ) : (
    <Strip>
      <Tool icon="plus-circle-outline" label="Add point" onPress={needUnlocked(() => insertPoint(typeof target === 'number' ? target : 0))} disabled={(cur.mask?.length ?? 4) >= MAX_MASK} />
      <Tool icon="minus-circle-outline" label="Delete point" onPress={deletePoint} disabled={(cur.mask?.length ?? 4) <= 3} />
      {SHAPES.map((sh) => <Tool key={sh.kind} icon={sh.icon} label={sh.label} onPress={needUnlocked(() => { proj.editSelected({ mask: maskShape(sh.kind) }); setTarget(0); })} />)}
      <Tool icon="blur-off" label="Sharp edge" on={cur.feather === 0} onPress={() => proj.editSelected({ feather: 0 })} />
      <Tool icon="blur" label="Soft edge" on={cur.feather > 0 && cur.feather < 0.06} onPress={() => proj.editSelected({ feather: 0.04 })} />
      <Tool icon="blur" label="Softer" on={cur.feather >= 0.06} onPress={() => proj.editSelected({ feather: 0.1 })} />
    </Strip>
  );

  const hint = mode === 'corners'
    ? 'Drag a corner, or drag inside the surface to move it. Tap another surface to choose it.'
    : mode === 'warp'
      ? (cur.mesh ? 'Drag the small points to bend the picture onto curved or uneven objects.' : 'Tap + Column or + Row to add warp points.')
      : 'Drag the numbered points to change the outline. Tap a small + to add a point there.';

  const nudgeRow = (
    <View style={s.nudge}>
      <Text style={s.nudgeT} numberOfLines={1}>Move {targetName}</Text>
      <View style={{ flexDirection: 'row', gap: 6 }}>
        <Pressable style={s.arrow} onPress={() => nudge(-1, 0)} accessibilityLabel={`Move ${targetName} left`}><Icon name="arrow-left" size={20} color={T.text} /></Pressable>
        <Pressable style={s.arrow} onPress={() => nudge(0, -1)} accessibilityLabel={`Move ${targetName} up`}><Icon name="arrow-up" size={20} color={T.text} /></Pressable>
        <Pressable style={s.arrow} onPress={() => nudge(0, 1)} accessibilityLabel={`Move ${targetName} down`}><Icon name="arrow-down" size={20} color={T.text} /></Pressable>
        <Pressable style={s.arrow} onPress={() => nudge(1, 0)} accessibilityLabel={`Move ${targetName} right`}><Icon name="arrow-right" size={20} color={T.text} /></Pressable>
      </View>
    </View>
  );
  const dragOptions = (
    <Strip>
      <Chip on={step === 'fine'} label="Fine steps" onPress={() => setStep('fine')} />
      <Chip on={step === 'normal'} label="Normal" onPress={() => setStep('normal')} />
      <Chip on={step === 'big'} label="Big steps" onPress={() => setStep('big')} />
      <Chip on={snap} label="Snap" icon="magnet" onPress={() => setSnap(!snap)} />
      <Chip on={precise} label="Precise drag" icon="crosshairs" onPress={() => setPrecise(!precise)} />
    </Strip>
  );

  const bottomBar = (
    <Strip>
      <Tool icon="palette-outline" label="Content" on={sheet === 'content'} onPress={() => setSheet(sheet === 'content' ? null : 'content')} />
      <Tool icon="hand-wave-outline" label="Gestures" on={sheet === 'gestures' || p.vision.running} onPress={() => setSheet(sheet === 'gestures' ? null : 'gestures')} />
      <Tool icon="folder-open-outline" label="Load scene" onPress={openScenes} />
      <Tool icon="content-save-outline" label="Save scene" onPress={openScenes} />
      <Tool icon="export-variant" label="Export" onPress={exportScene} />
      <Tool icon="help-circle-outline" label="Help" on={sheet === 'help'} onPress={() => setSheet(sheet === 'help' ? null : 'help')} />
      {SOON.map((x) => <Tool key={x.label} icon={x.icon} label={x.label} soon onPress={() => say(`Coming soon: ${x.what}.`)} />)}
    </Strip>
  );

  // ---------- Sheets (panels that slide over the bottom part) ----------
  const contentSheet = (
    <>
      <Text style={s.sheetH}>Content of {cur.name}</Text>
      <View style={s.wrap}>
        {CONTENTS.map((x) => (
          <Chip key={x.c} on={cur.content === x.c} label={x.label} icon={x.icon}
            onPress={() => (x.c === 'image' && !hasImage ? pickImage() : proj.editSelected({ content: x.c }))} />
        ))}
      </View>
      {cur.content === 'color' && (
        <View style={[s.wrap, { marginTop: 10 }]}>
          {SURFACE_COLORS.map((col) => (
            <Pressable key={col} onPress={() => proj.editSelected({ color: col })} accessibilityRole="button" accessibilityLabel={`Colour ${col}`}
              style={[s.swatch, { backgroundColor: col }, cur.color === col && { borderColor: T.text, borderWidth: 3 }]} />
          ))}
        </View>
      )}
      {cur.content === 'image' && (
        <View style={[s.wrap, { marginTop: 10 }]}>
          <Chip on={cur.fit === 'contain'} label="Fit" onPress={() => proj.editSelected({ fit: 'contain' })} />
          <Chip on={cur.fit === 'cover'} label="Fill" onPress={() => proj.editSelected({ fit: 'cover' })} />
          <Chip on={false} label={hasImage ? 'Replace image' : 'Upload from gallery'} icon="image-outline" onPress={pickImage} />
          {hasImage && <Chip on={false} label="Remove image" icon="trash-can-outline" onPress={() => { proj.setPreview(cur.id, null); proj.editSelected({ image_url: null, content: 'pattern' }); setMsg(''); }} />}
        </View>
      )}
      <Text style={s.label}>Brightness (opacity)</Text>
      <View style={s.wrap}>
        {[1, 0.75, 0.5, 0.25].map((o) => <Chip key={o} on={Math.abs(cur.opacity - o) < 0.01} label={`${Math.round(o * 100)}%`} onPress={() => proj.editSelected({ opacity: o })} />)}
      </View>
      <Text style={s.label}>Extras</Text>
      <View style={s.wrap}>
        <Chip on={cur.grid} label="Grid on top" icon="grid" onPress={() => proj.editSelected({ grid: !cur.grid })} />
        <Chip on={cur.flipX} label="Mirror" icon="flip-horizontal" onPress={() => proj.editSelected({ flipX: !cur.flipX })} />
        <Chip on={cur.flipY} label="Flip" icon="flip-vertical" onPress={() => proj.editSelected({ flipY: !cur.flipY })} />
      </View>
      {busy && <View style={[s.wrap, { marginTop: 10, alignItems: 'center' }]}><ActivityIndicator color={T.cyan} /><Text style={s.mute}>Sending image to the PC…</Text></View>}
      {cur.content === 'image' && cur.image_url && !busy ? <Text style={[s.hint, { color: T.cyan }]}>Image is on the PC and shown on the TV.</Text> : null}
      {msg ? <Text style={s.error}>{msg}</Text> : null}
    </>
  );

  const gestureSheet = (
    <>
      <Text style={s.sheetH}>Gesture control</Text>
      {p.vision.running ? (
        <Text style={s.mute}>
          {p.vision.fps == null ? 'Starting the camera…'
            : p.vision.source === 'phone'
              ? `Measured on the PC: ${p.vision.fps} hand updates per second from this phone${p.vision.latency_ms != null ? `, PC to TV ${p.vision.latency_ms} ms` : ''}`
                + (p.vision.gap_phone_ms != null || p.vision.gap_net_ms != null
                  ? `. Longest pause in the last second: phone ${p.vision.gap_phone_ms ?? '-'} ms, Wi-Fi ${p.vision.gap_net_ms ?? '-'} ms` : '')
                + (p.vision.held_pct ? `. Pointer held ${p.vision.held_pct}% (${p.vision.held_why ?? 'unclear hand'})` : '')
              : `Measured: ${p.vision.fps} fps, hand detection ${p.vision.detect_ms} ms per frame${p.vision.latency_ms != null ? `, delay to TV ${p.vision.latency_ms} ms` : ''}`}
        </Text>
      ) : (
        <Text style={s.mute}>Uses this phone's front camera. Put the phone on a stand facing you and control the TV with your hand. Gestures edit the selected surface ({cur.name}).</Text>
      )}
      {p.vision.running && p.vision.source === 'phone' && <PhoneHandCamera T={T} send={p.send} />}
      {p.vision.running && <Text style={[s.ct, { marginTop: 10, color: T.cyan }]}>{p.lastGesture ? `Last gesture: ${GESTURE_NAMES[p.lastGesture] ?? p.lastGesture}` : 'No gesture yet'}</Text>}
      <View style={{ marginTop: 8, gap: 2 }}>
        <Text style={s.hint}>✋  Move your whole hand to move the pointer on the TV</Text>
        <Text style={s.hint}>🤏  Pinch a corner to move that corner, a side to move only that side, inside to move it all</Text>
        <Text style={s.hint}>🖐️  Swipe an open hand left or right to change the content</Text>
      </View>
      <Pressable style={[s.btn, { marginTop: 12 }, p.vision.running && s.ghost, (!p.connected || (!phoneCameraAvailable && !p.vision.running)) && { opacity: 0.45 }]}
        disabled={!p.connected || (!phoneCameraAvailable && !p.vision.running)} onPress={() => p.onGestures(!p.vision.running)} accessibilityRole="button"
        accessibilityLabel={p.vision.running ? 'Stop gesture control' : 'Start gesture control'}>
        <Icon name={p.vision.running ? 'stop' : 'hand-wave-outline'} size={18} color={p.vision.running ? T.blue : '#FFFFFF'} />
        <Text style={[s.btnT, p.vision.running && { color: T.blue }]}>{p.vision.running ? 'Stop gestures' : 'Start gestures'}</Text>
      </Pressable>
      {!phoneCameraAvailable && !p.vision.running && <PhoneHandCamera T={T} send={p.send} />}
      {!p.connected && <Text style={s.hint}>Pair with the PC first.</Text>}
      {p.vision.error ? <Text style={s.error}>{p.vision.error}</Text> : null}
    </>
  );

  const scenesSheet = (
    <>
      <Text style={s.sheetH}>Saved scenes</Text>
      {!p.connected ? (
        <Text style={s.mute}>Scenes are saved on the PC. Pair with the PC to save or load them.</Text>
      ) : (
        <>
          <View style={[s.wrap, { alignItems: 'center' }]}>
            <TextInput value={presetName} onChangeText={setPresetName} placeholder="Name, for example Stage left" placeholderTextColor={T.mute}
              style={s.input} maxLength={40} accessibilityLabel="Scene name" />
            <Pressable style={[s.btn, { paddingHorizontal: 16 }]} accessibilityRole="button" accessibilityLabel="Save this scene"
              onPress={() => { p.send({ type: 'save_preset', name: presetName }); setPresetName(''); say('Scene saved on the PC.'); }}>
              <Icon name="content-save-outline" size={18} color="#FFFFFF" /><Text style={s.btnT}>Save</Text>
            </Pressable>
          </View>
          {p.presetsMsg ? <Text style={s.error}>{p.presetsMsg}</Text> : null}
          {p.presets.length === 0 ? <Text style={[s.hint, { marginTop: 10 }]}>No saved scenes yet.</Text> : p.presets.map((x) => (
            <View key={x.id} style={s.presetRow}>
              <View style={{ flex: 1 }}>
                <Text style={s.ct} numberOfLines={1}>{x.name}</Text>
                <Text style={s.hint}>{x.surfaces} surface{x.surfaces === 1 ? '' : 's'} · {new Date(x.created * 1000).toLocaleString()}</Text>
              </View>
              <Pressable style={s.iconBtn} onPress={() => { p.send({ type: 'load_preset', id: x.id }); say(`Loaded ${x.name}.`); setSheet(null); }} accessibilityRole="button" accessibilityLabel={`Load ${x.name}`}>
                <Icon name="folder-open-outline" size={22} color={T.cyan} />
              </Pressable>
              <Pressable style={s.iconBtn} onPress={() => p.send({ type: 'delete_preset', id: x.id })} accessibilityRole="button" accessibilityLabel={`Delete ${x.name}`}>
                <Icon name="trash-can-outline" size={22} color={T.err} />
              </Pressable>
            </View>
          ))}
        </>
      )}
    </>
  );

  const helpSheet = (
    <>
      <Text style={s.sheetH}>How the editor works</Text>
      {[
        ['Surfaces', 'Each surface is one picture on the TV. Add several, each with its own content. Layer up/down decides which is on top.'],
        ['Corners', 'The 4 corners set the perspective, for flat objects like a box side or a wall.'],
        ['Warp points', 'Extra points inside the surface bend the picture, for curved or uneven objects.'],
        ['Shape', 'Points around the edge cut the surface into any outline. Soft edge fades it out.'],
        ['Snap', 'A corner close to another surface\'s corner, or a screen edge, jumps onto it.'],
        ['Precise drag', 'The handle moves a third of your finger\'s distance, for fine adjustment.'],
        ['Save scene', 'Stores all surfaces on the PC, so you can load them again later.'],
      ].map(([h, t]) => (
        <View key={h} style={{ marginTop: 8 }}><Text style={s.ct}>{h}</Text><Text style={s.mute}>{t}</Text></View>
      ))}
    </>
  );

  // The gesture panel stays mounted while the camera runs, so closing the panel never stops the camera.
  const gesturePanelMounted = sheet === 'gestures' || p.vision.running;
  const sheetBody = sheet === 'content' ? contentSheet : sheet === 'scenes' ? scenesSheet : sheet === 'help' ? helpSheet : null;
  const panel = (body: React.ReactNode, visible: boolean, key: string) => (
    <View key={key} style={[s.sheet, landscape && { left: '45%' }, !visible && s.sheetHidden]} pointerEvents={visible ? 'auto' : 'none'}>
      <View style={s.sheetTop}>
        <View style={s.grabber} />
        <Pressable onPress={() => setSheet(null)} style={s.iconBtn} accessibilityRole="button" accessibilityLabel="Close panel"><Icon name="close" size={22} color={T.mute} /></Pressable>
      </View>
      <ScrollView contentContainerStyle={{ paddingBottom: 18 }} keyboardShouldPersistTaps="handled">{body}</ScrollView>
    </View>
  );

  const controls = (
    <>
      {surfaceChips}
      {modes}
      {modeTools}
      <Text style={s.hint2} numberOfLines={2}>{hint}</Text>
      {nudgeRow}
      {dragOptions}
    </>
  );

  return (
    <UiCtx.Provider value={ui}>
    <View style={s.root}>
      {topBar}
      {landscape ? (
        <View style={{ flex: 1, flexDirection: 'row' }}>
          <View style={{ flex: 1.2 }}>{surfaceTools}{canvas}</View>
          <ScrollView style={{ flex: 1 }} scrollEnabled={!dragging} contentContainerStyle={{ paddingBottom: 12 }}>{controls}{bottomBar}</ScrollView>
        </View>
      ) : (
        <>
          {surfaceTools}
          {canvas}
          {/* Scrolls on small phones, so the canvas always keeps its space */}
          <ScrollView style={{ flexGrow: 0, maxHeight: height * 0.42 }} scrollEnabled={!dragging} keyboardShouldPersistTaps="handled">{controls}</ScrollView>
          {bottomBar}
        </>
      )}
      {sheetBody && panel(sheetBody, true, 'sheet')}
      {gesturePanelMounted && panel(gestureSheet, sheet === 'gestures', 'gestures')}
      {toast ? <View pointerEvents="none" style={s.toast}><Text style={s.toastT}>{toast}</Text></View> : null}
    </View>
    </UiCtx.Provider>
  );
}

function makeStyles(T: Theme) {
  return StyleSheet.create({
    root: { flex: 1, backgroundColor: T.bg },
    top: { flexDirection: 'row', alignItems: 'center', gap: 6, paddingHorizontal: 8, paddingVertical: 6 },
    iconBtn: { width: 42, height: 42, borderRadius: 21, alignItems: 'center', justifyContent: 'center' },
    title: { color: T.text, fontSize: 18, fontWeight: '800' },
    dotRow: { flexDirection: 'row', alignItems: 'center', gap: 4 },
    dot: { width: 7, height: 7, borderRadius: 4 },
    dotT: { fontSize: 11, fontWeight: '700' },
    strip: { paddingHorizontal: 8, paddingVertical: 4, gap: 6, alignItems: 'center' },
    tool: { width: 66, height: 60, borderRadius: 14, backgroundColor: T.s1, borderWidth: 1, borderColor: T.line, alignItems: 'center', justifyContent: 'center', gap: 3, paddingHorizontal: 2 },
    toolOn: { backgroundColor: T.blue, borderColor: T.blue },
    toolT: { color: T.mute, fontSize: 10.5, fontWeight: '600' },
    soon: { position: 'absolute', top: 3, right: 3, fontSize: 7.5, fontWeight: '800', color: '#FFFFFF', backgroundColor: T.violet, borderRadius: 5, paddingHorizontal: 3, overflow: 'hidden' },
    canvas: { backgroundColor: CANVAS_BG, borderRadius: 12, borderWidth: 1, borderColor: T.line, overflow: 'hidden' },
    chip: { flexDirection: 'row', alignItems: 'center', gap: 5, borderWidth: 1, borderColor: T.line, borderRadius: 18, paddingVertical: 7, paddingHorizontal: 12, backgroundColor: T.s1 },
    chipOn: { backgroundColor: T.blue, borderColor: T.blue },
    chipT: { color: T.mute, fontSize: 12.5, fontWeight: '600' },
    seg: { flexDirection: 'row', marginHorizontal: 8, marginTop: 4, backgroundColor: T.s1, borderRadius: 22, borderWidth: 1, borderColor: T.line, padding: 3 },
    segItem: { flex: 1, flexDirection: 'row', gap: 5, alignItems: 'center', justifyContent: 'center', paddingVertical: 8, borderRadius: 19 },
    segOn: { backgroundColor: T.blue },
    segT: { color: T.mute, fontSize: 12.5, fontWeight: '700' },
    info: { width: 58, height: 60, alignItems: 'center', justifyContent: 'center' },
    infoT: { color: T.text, fontSize: 15, fontWeight: '800' },
    infoS: { color: T.mute, fontSize: 10.5 },
    hint2: { color: T.mute, fontSize: 11.5, lineHeight: 16, paddingHorizontal: 12 },
    nudge: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 12, paddingTop: 4 },
    nudgeT: { color: T.text, fontSize: 13, fontWeight: '700', flex: 1, marginRight: 8 },
    arrow: { width: 42, height: 38, borderRadius: 12, backgroundColor: T.s1, borderWidth: 1, borderColor: T.line, alignItems: 'center', justifyContent: 'center' },
    sheet: { position: 'absolute', left: 0, right: 0, bottom: 0, maxHeight: '62%', backgroundColor: T.s1, borderTopLeftRadius: 22, borderTopRightRadius: 22,
      borderWidth: 1, borderColor: T.line, paddingHorizontal: 16, elevation: 12, shadowColor: '#000', shadowOpacity: 0.3, shadowRadius: 12 },
    // Hidden but still on screen: an invisible view keeps the camera running (removing it would stop the camera).
    sheetHidden: { opacity: 0, transform: [{ translateY: 4000 }] },
    sheetTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', height: 40 },
    grabber: { position: 'absolute', left: '50%', marginLeft: -20, top: 8, width: 40, height: 4, borderRadius: 2, backgroundColor: T.line },
    sheetH: { color: T.text, fontSize: 17, fontWeight: '800', marginBottom: 8 },
    wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
    swatch: { width: 34, height: 34, borderRadius: 17, borderWidth: 1, borderColor: T.line },
    label: { color: T.mute, fontSize: 12, marginTop: 14, marginBottom: 6 },
    ct: { color: T.text, fontSize: 15, fontWeight: '700' },
    mute: { color: T.mute, fontSize: 13, lineHeight: 19 },
    hint: { color: T.mute, fontSize: 12, lineHeight: 17, marginTop: 4 },
    error: { color: T.err, fontSize: 13, lineHeight: 18, marginTop: 10 },
    input: { flex: 1, minWidth: 160, minHeight: 44, borderRadius: 14, borderWidth: 1, borderColor: T.line, backgroundColor: T.s2, color: T.text, paddingHorizontal: 12 },
    presetRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 10, padding: 10, borderRadius: 14, backgroundColor: T.s2 },
    btn: { minHeight: 44, borderRadius: 22, backgroundColor: T.blue, flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: 8, paddingHorizontal: 18 },
    ghost: { backgroundColor: 'transparent', borderWidth: 1.5, borderColor: T.blue },
    btnT: { color: '#FFFFFF', fontSize: 15, fontWeight: '700' },
    toast: { position: 'absolute', left: 24, right: 24, bottom: 90, alignItems: 'center' },
    toastT: { color: '#FFFFFF', backgroundColor: 'rgba(8,11,22,0.92)', borderRadius: 16, paddingHorizontal: 14, paddingVertical: 9, fontSize: 13, overflow: 'hidden', textAlign: 'center' },
  });
}
