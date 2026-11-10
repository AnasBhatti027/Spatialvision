import { useEffect, useRef, useState } from 'react';

/** A point as fractions of the output screen: x and y go from 0 (left/top) to 1 (right/bottom). */
export type Pt = [number, number];
/** Four corners in order: 1 top-left, 2 top-right, 3 bottom-right, 4 bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];
export type Content = 'pattern' | 'grid' | 'color' | 'image' | 'blank';
export type Fit = 'contain' | 'cover';
/** Warp points: (cols+1) x (rows+1) points, row by row, in the surface's own square (u, v from 0 to 1). */
export type Mesh = { cols: number; rows: number; pts: Pt[] };

/**
 * One projected surface. Its corners are on the screen; its warp points (mesh) and outline (mask) are in
 * its own square, so they move with the corners. The backend (scene_model.py) checks the same fields.
 */
export type Surface = {
  id: string; name: string; corners: Quad;
  mesh: Mesh | null;        // null = no warp, a flat (perspective-only) surface
  mask: Pt[] | null;        // null = the whole rectangle
  content: Content; color: string; image_url: string | null; fit: Fit; grid: boolean;
  opacity: number;          // 0..1
  feather: number;          // soft edge, 0..0.25 of the surface size
  flipX: boolean; flipY: boolean; visible: boolean; locked: boolean;
};
export type Scene = { surfaces: Surface[]; selected: string; blackout: boolean; guides: boolean }; // guides: outlines shown on the TV

export const ASPECT = 16 / 9; // the TV's shape
export const MAX_SURFACES = 8, MAX_MESH = 6, MAX_MASK = 32;
export const DEFAULT_QUAD: Quad = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
export const FULL_QUAD: Quad = [[0, 0], [1, 0], [1, 1], [0, 1]];
export const RECT_MASK: Pt[] = [[0, 0], [1, 0], [1, 1], [0, 1]];
/** Colours offered for "Colour" content: the app's own palette. */
export const SURFACE_COLORS = ['#4D7CFE', '#45D9F5', '#9065FF', '#E04FB8', '#F4F6FF', '#171F35'];

const clamp = (v: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v));
const copyPts = <T extends Pt[]>(p: T) => p.map(([x, y]) => [x, y]) as T;

export function newId() { return 's' + Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36); }

export function makeSurface(id: string, name: string, corners: Quad = DEFAULT_QUAD): Surface {
  return {
    id, name, corners: copyPts(corners), mesh: null, mask: null, content: 'pattern', color: SURFACE_COLORS[0], image_url: null,
    fit: 'contain', grid: false, opacity: 1, feather: 0, flipX: false, flipY: false, visible: true, locked: false,
  };
}
export const DEFAULT_SCENE: Scene = { surfaces: [makeSurface('s1', 'Surface 1')], selected: 's1', blackout: false, guides: false };

// ---------- Checking data from the PC (same rules as backend/scene_model.py) ----------
const isNum = (v: any) => typeof v === 'number' && Number.isFinite(v);
const point = (p: any, lo: number, hi: number): Pt | null =>
  Array.isArray(p) && p.length === 2 && isNum(p[0]) && isNum(p[1]) ? [clamp(p[0], lo, hi), clamp(p[1], lo, hi)] : null;
function cleanSurface(raw: any, i: number): Surface {
  const s = makeSurface(`s${i + 1}`, `Surface ${i + 1}`);
  if (!raw || typeof raw !== 'object') return s;
  if (typeof raw.id === 'string' && raw.id) s.id = raw.id;
  if (typeof raw.name === 'string' && raw.name) s.name = raw.name.slice(0, 40);
  const c = Array.isArray(raw.corners) && raw.corners.length === 4 ? raw.corners.map((p: any) => point(p, 0, 1)) : null;
  if (c && c.every(Boolean)) s.corners = c as Quad;
  const m = raw.mesh;
  if (m && Number.isInteger(m.cols) && Number.isInteger(m.rows) && m.cols >= 1 && m.rows >= 1 && m.cols <= MAX_MESH && m.rows <= MAX_MESH
    && Array.isArray(m.pts) && m.pts.length === (m.cols + 1) * (m.rows + 1)) {
    const pts = m.pts.map((p: any) => point(p, -0.5, 1.5));
    if (pts.every(Boolean)) s.mesh = { cols: m.cols, rows: m.rows, pts };
  }
  if (Array.isArray(raw.mask) && raw.mask.length >= 3 && raw.mask.length <= MAX_MASK) {
    const pts = raw.mask.map((p: any) => point(p, 0, 1));
    if (pts.every(Boolean)) s.mask = pts;
  }
  if (['pattern', 'grid', 'color', 'image', 'blank'].includes(raw.content)) s.content = raw.content;
  if (typeof raw.color === 'string' && /^#[0-9a-fA-F]{6}$/.test(raw.color)) s.color = raw.color;
  if (raw.image_url === null || typeof raw.image_url === 'string') s.image_url = raw.image_url;
  if (raw.fit === 'contain' || raw.fit === 'cover') s.fit = raw.fit;
  for (const k of ['grid', 'flipX', 'flipY', 'visible', 'locked'] as const) if (typeof raw[k] === 'boolean') s[k] = raw[k];
  if (isNum(raw.opacity)) s.opacity = clamp(raw.opacity);
  if (isNum(raw.feather)) s.feather = clamp(raw.feather, 0, 0.25);
  return s;
}

// ---------- Maths (the TV page uses exactly the same) ----------
/** Coefficients of the perspective map from the unit square to the quad, or null if the shape is folded. */
function homography(q: Quad): number[] | null {
  const [[x0, y0], [x1, y1], [x2, y2], [x3, y3]] = q;
  const dx1 = x1 - x2, dx2 = x3 - x2, dx3 = x0 - x1 + x2 - x3;
  const dy1 = y1 - y2, dy2 = y3 - y2, dy3 = y0 - y1 + y2 - y3;
  let g = 0, h = 0;
  if (Math.abs(dx3) > 1e-9 || Math.abs(dy3) > 1e-9) {
    const det = dx1 * dy2 - dx2 * dy1;
    if (Math.abs(det) < 1e-9) return null;
    g = (dx3 * dy2 - dx2 * dy3) / det;
    h = (dx1 * dy3 - dx3 * dy1) / det;
  }
  if ([[0, 0], [1, 0], [1, 1], [0, 1]].some(([u, v]) => g * u + h * v + 1 <= 1e-6)) return null;
  return [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h];
}

/**
 * Perspective map from the unit square to the quad.
 * (u, v) = (0,0) top-left, (1,0) top-right, (1,1) bottom-right, (0,1) bottom-left.
 * Returns null when the shape is folded over itself, because no flat picture fits it.
 */
export function squareToQuad(q: Quad): ((u: number, v: number) => Pt) | null {
  const H = homography(q);
  if (!H) return null;
  const [a, b, c, d, e, f, g, h] = H;
  return (u, v) => { const w = g * u + h * v + 1; return [(a * u + b * v + c) / w, (d * u + e * v + f) / w]; };
}

/** The opposite: a screen point to (u, v) in the quad's square. */
export function quadToSquare(q: Quad): ((x: number, y: number) => Pt) | null {
  const H = homography(q);
  if (!H) return null;
  const [a, b, c, d, e, f, g, h] = H; // matrix [[a b c] [d e f] [g h 1]]; its inverse via the adjugate
  const A = e - f * h, B = c * h - b, C = b * f - c * e, D = f * g - d, E = a - c * g, F = c * d - a * f, G = d * h - e * g, Hh = b * g - a * h, I = a * e - b * d;
  return (x, y) => { const w = G * x + Hh * y + I; return [(A * x + B * y + C) / w, (D * x + E * y + F) / w]; };
}

// Smooth curve through the warp points (Catmull-Rom), so a bent surface has no creases between cells.
const crv = (a: number, b: number, c: number, d: number, t: number) => {
  const t2 = t * t, t3 = t2 * t;
  return 0.5 * (2 * b + (c - a) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (3 * b - a - 3 * c + d) * t3);
};
function node(m: Mesh, a: number, b: number): Pt {
  const ext = (p: Pt, q: Pt): Pt => [2 * p[0] - q[0], 2 * p[1] - q[1]];
  if (a < 0) return ext(node(m, 0, b), node(m, 1, b));
  if (a > m.cols) return ext(node(m, m.cols, b), node(m, m.cols - 1, b));
  if (b < 0) return ext(node(m, a, 0), node(m, a, 1));
  if (b > m.rows) return ext(node(m, a, m.rows), node(m, a, m.rows - 1));
  return m.pts[b * (m.cols + 1) + a];
}
export function meshAt(m: Mesh, u: number, v: number): Pt {
  const i = clamp(Math.floor(u * m.cols), 0, m.cols - 1), j = clamp(Math.floor(v * m.rows), 0, m.rows - 1);
  const s = u * m.cols - i, t = v * m.rows - j, rows: Pt[] = [];
  for (let k = -1; k <= 2; k++) {
    const P = [node(m, i - 1, j + k), node(m, i, j + k), node(m, i + 1, j + k), node(m, i + 2, j + k)];
    rows.push([crv(P[0][0], P[1][0], P[2][0], P[3][0], s), crv(P[0][1], P[1][1], P[2][1], P[3][1], s)]);
  }
  return [crv(rows[0][0], rows[1][0], rows[2][0], rows[3][0], t), crv(rows[0][1], rows[1][1], rows[2][1], rows[3][1], t)];
}

/** Where (u, v) of a surface lands on the screen: warp points first, then the 4-corner perspective. */
export function warpOf(s: { mesh: Mesh | null }, corners: Quad): ((u: number, v: number) => Pt) | null {
  const H = squareToQuad(corners);
  if (!H) return null;
  const m = s.mesh;
  return m ? (u, v) => { const p = meshAt(m, u, v); return H(p[0], p[1]); } : H;
}

/** The (u, v) that lands on screen point p (a few steps of Newton's method; exact without warp points). */
export function unwarp(s: { mesh: Mesh | null }, corners: Quad, p: Pt, guess: Pt): Pt | null {
  const inv = quadToSquare(corners);
  if (!inv) return null;
  if (!s.mesh) return inv(p[0], p[1]);
  const W = warpOf(s, corners)!;
  let [u, v] = guess;
  for (let k = 0; k < 6; k++) {
    const [x, y] = W(u, v), e = 1e-4;
    const [xu, yu] = W(u + e, v), [xv, yv] = W(u, v + e);
    const a = (xu - x) / e, b = (xv - x) / e, c = (yu - y) / e, d = (yv - y) / e, det = a * d - b * c;
    if (Math.abs(det) < 1e-9) break;
    const rx = p[0] - x, ry = p[1] - y;
    u += (d * rx - b * ry) / det; v += (a * ry - c * rx) / det;
  }
  return [u, v];
}

export function regularMesh(cols: number, rows: number): Mesh {
  const pts: Pt[] = [];
  for (let j = 0; j <= rows; j++) for (let i = 0; i <= cols; i++) pts.push([i / cols, j / rows]);
  return { cols, rows, pts };
}
/** A finer or coarser warp grid that keeps the current bend. */
export function resampleMesh(m: Mesh | null, cols: number, rows: number): Mesh {
  const out = regularMesh(cols, rows);
  if (m) out.pts = out.pts.map(([u, v]) => meshAt(m, u, v));
  return out;
}

export type ShapeKind = 'rect' | 'circle' | 'triangle' | 'diamond' | 'hexagon' | 'star';
export function maskShape(kind: ShapeKind): Pt[] | null {
  const ring = (n: number, r: (i: number) => number, start = -Math.PI / 2): Pt[] =>
    Array.from({ length: n }, (_, i) => {
      const a = start + (i * 2 * Math.PI) / n;
      return [clamp(0.5 + 0.5 * r(i) * Math.cos(a)), clamp(0.5 + 0.5 * r(i) * Math.sin(a))] as Pt;
    });
  switch (kind) {
    case 'rect': return null;
    case 'circle': return ring(24, () => 1);
    case 'triangle': return [[0.5, 0], [1, 1], [0, 1]];
    case 'diamond': return [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]];
    case 'hexagon': return ring(6, () => 1, 0);
    case 'star': return ring(10, (i) => (i % 2 ? 0.42 : 1));
  }
}
/** Adds an outline point halfway along the side after point `after`. */
export function insertMaskPoint(mask: Pt[] | null, after: number): { mask: Pt[]; index: number } {
  const m = copyPts(mask ?? RECT_MASK);
  if (m.length >= MAX_MASK) return { mask: m, index: after };
  const a = m[after], b = m[(after + 1) % m.length];
  m.splice(after + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  return { mask: m, index: after + 1 };
}

export function centroid(q: Quad): Pt {
  return [(q[0][0] + q[1][0] + q[2][0] + q[3][0]) / 4, (q[0][1] + q[1][1] + q[2][1] + q[3][1]) / 4];
}

/** Moves one corner (index 0-3), or the whole shape (index 'all'), by dx, dy. Keeps everything on screen. */
export function moveBy(q: Quad, index: number | 'all', dx: number, dy: number): Quad {
  if (index === 'all') {
    // Limit the move so no corner leaves the screen.
    const xs = q.map((p) => p[0]), ys = q.map((p) => p[1]);
    const mx = Math.min(Math.max(dx, -Math.min(...xs)), 1 - Math.max(...xs));
    const my = Math.min(Math.max(dy, -Math.min(...ys)), 1 - Math.max(...ys));
    return q.map(([x, y]) => [x + mx, y + my]) as Quad;
  }
  return q.map((p, i) => (i === index ? [clamp(p[0] + dx), clamp(p[1] + dy)] : p)) as Quad;
}

/** Grows (factor > 1) or shrinks (factor < 1) the shape around its centre. */
export function scaleBy(q: Quad, factor: number): Quad {
  const [cx, cy] = centroid(q);
  const next = q.map(([x, y]) => [cx + (x - cx) * factor, cy + (y - cy) * factor]) as Quad;
  return next.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1) ? next : q;
}

/** Rotates the shape around its centre. Works in screen proportions so it does not squash. */
export function rotateBy(q: Quad, degrees: number): Quad {
  const [cx, cy] = centroid(q);
  const a = (degrees * Math.PI) / 180, cos = Math.cos(a), sin = Math.sin(a);
  const next = q.map(([x, y]) => {
    const px = (x - cx) * ASPECT, py = y - cy;
    return [cx + (px * cos - py * sin) / ASPECT, cy + (px * sin + py * cos)];
  }) as Quad;
  return next.every(([x, y]) => x >= 0 && x <= 1 && y >= 0 && y <= 1) ? next : q;
}

/** Moves the shape so its centre is the screen centre (as far as it fits). */
export function centerQuad(q: Quad): Quad {
  const [cx, cy] = centroid(q);
  return moveBy(q, 'all', 0.5 - cx, 0.5 - cy);
}

/** A point close to another surface's corner or the screen edge jumps onto it (for lining surfaces up). */
export function snapPoint(p: Pt, targets: Pt[], tol: number): Pt {
  let best: Pt | null = null, bd = tol;
  for (const t of targets) {
    const d = Math.hypot((p[0] - t[0]) * ASPECT, p[1] - t[1]);
    if (d < bd) { bd = d; best = t; }
  }
  if (best) return [best[0], best[1]];
  const x = p[0] < tol / ASPECT ? 0 : p[0] > 1 - tol / ASPECT ? 1 : p[0];
  const y = p[1] < tol ? 0 : p[1] > 1 - tol ? 1 : p[1];
  return [x, y];
}

/** The message the TV understands for a scene. */
export function sceneMessage(sc: Scene) {
  // An image that has not finished uploading cannot be shown on the TV yet.
  const surfaces = sc.surfaces.map((s) => ({ ...s, content: s.content === 'image' && !s.image_url ? 'blank' : s.content }));
  return { type: 'scene', surfaces, selected: sc.selected, blackout: sc.blackout, guides: sc.guides };
}

const HISTORY = 40; // undo steps kept (each is a few kilobytes)

// True until the first connection after the app starts. Closing and opening the app starts a fresh
// projection (one default surface), and the TV is reset to match. A reconnect while the app stays open
// (for example a short Wi-Fi drop) keeps the work. Saved scenes are still there under Load scene.
let freshStart = true;

/**
 * Holds the projection scene and sends it to the TV (through the backend) whenever it changes.
 * Sends at most every 33 ms, always with the newest state.
 * While a finger drags, the editor calls sendLive() instead of changing the scene,
 * so the TV follows the finger without re-drawing the whole phone screen on every move.
 */
export function useProjectionScene(send: (msg: object) => boolean, connected: boolean) {
  const [scene, setScene] = useState<Scene>(DEFAULT_SCENE);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const past = useRef<Scene[]>([]);
  const future = useRef<Scene[]>([]);
  const [, setHistTick] = useState(0);
  // Pictures picked on the phone, shown in the preview while (or instead of) uploading. By surface id.
  const [previews, setPreviews] = useState<Record<string, string>>({});
  const latest = useRef<object | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fromBackend = useRef(''); // the last scene the backend sent us, so we do not echo it back
  // After connecting, the PC sends the scene it has (saved where you left it). Until that arrives,
  // the phone sends nothing, so its own old or default copy can never overwrite the TV.
  const synced = useRef(false);
  const [syncTick, setSyncTick] = useState(0);
  useEffect(() => {
    if (!connected) { synced.current = false; return; }
    // Safety net: if the PC sends no scene within 1.5 s (an older backend), carry on as before.
    const t = setTimeout(() => { if (!synced.current) { synced.current = true; freshStart = false; setSyncTick((n) => n + 1); } }, 1500);
    return () => clearTimeout(t);
  }, [connected]);

  const push = (msg: object) => {
    latest.current = msg;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (latest.current) send(latest.current);
    }, 33);
  };

  useEffect(() => {
    if (!connected || !synced.current) return;
    const msg = sceneMessage(scene);
    if (JSON.stringify(msg) === fromBackend.current) return;
    push(msg);
  }, [scene, connected, syncTick]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** A change that Undo can take back. */
  const commit = (next: Scene) => {
    past.current = [...past.current.slice(-(HISTORY - 1)), sceneRef.current];
    future.current = [];
    sceneRef.current = next;
    setScene(next);
    setHistTick((n) => n + 1);
  };
  const edit = (fn: (s: Scene) => Scene) => commit(fn(sceneRef.current));
  const selectedOf = (s: Scene) => s.surfaces.find((x) => x.id === s.selected) ?? s.surfaces[0];
  const editSurface = (id: string, part: Partial<Surface> | ((s: Surface) => Partial<Surface>)) =>
    edit((sc) => ({ ...sc, surfaces: sc.surfaces.map((x) => (x.id === id ? { ...x, ...(typeof part === 'function' ? part(x) : part) } : x)) }));
  const editSelected = (part: Partial<Surface> | ((s: Surface) => Partial<Surface>)) => editSurface(selectedOf(sceneRef.current).id, part);
  /** Choosing a surface is not an undo step. */
  const select = (id: string) => {
    if (sceneRef.current.selected === id) return;
    const next = { ...sceneRef.current, selected: id };
    sceneRef.current = next;
    setScene(next);
  };

  const undo = () => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push(sceneRef.current);
    sceneRef.current = prev; setScene(prev); setHistTick((n) => n + 1);
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push(sceneRef.current);
    sceneRef.current = next; setScene(next); setHistTick((n) => n + 1);
  };

  /** Sends a surface change to the TV during a drag without storing it. Commit it when the finger lifts. */
  const sendLive = (id: string, part: Partial<Surface>) => {
    if (!connected || !synced.current) return;
    const sc = sceneRef.current;
    push(sceneMessage({ ...sc, surfaces: sc.surfaces.map((x) => (x.id === id ? { ...x, ...part } : x)) }));
  };

  // ---------- Surfaces ----------
  const nextName = (sc: Scene) => {
    let n = sc.surfaces.length + 1;
    while (sc.surfaces.some((x) => x.name === `Surface ${n}`)) n++;
    return `Surface ${n}`;
  };
  const addSurface = () => edit((sc) => {
    if (sc.surfaces.length >= MAX_SURFACES) return sc;
    const k = sc.surfaces.length % 5, o = 0.05 * k;  // a little offset so new surfaces do not hide each other
    const s = makeSurface(newId(), nextName(sc), [[0.3 + o, 0.3 + o], [0.6 + o, 0.3 + o], [0.6 + o, 0.65 + o], [0.3 + o, 0.65 + o]]);
    return { ...sc, surfaces: [...sc.surfaces, s], selected: s.id };
  });
  const duplicateSurface = () => edit((sc) => {
    if (sc.surfaces.length >= MAX_SURFACES) return sc;
    const cur = selectedOf(sc);
    const copy: Surface = JSON.parse(JSON.stringify(cur));
    copy.id = newId(); copy.name = nextName(sc); copy.locked = false;
    copy.corners = moveBy(copy.corners, 'all', 0.03, 0.03 * ASPECT);
    const i = sc.surfaces.indexOf(cur);
    return { ...sc, surfaces: [...sc.surfaces.slice(0, i + 1), copy, ...sc.surfaces.slice(i + 1)], selected: copy.id };
  });
  const deleteSurface = () => edit((sc) => {
    if (sc.surfaces.length <= 1) return sc;
    const i = sc.surfaces.findIndex((x) => x.id === sc.selected);
    const rest = sc.surfaces.filter((_, k) => k !== i);
    return { ...sc, surfaces: rest, selected: rest[Math.max(0, i - 1)].id };
  });
  /** Moves the selected surface one layer up (drawn on top) or down. */
  const moveLayer = (dir: 1 | -1) => edit((sc) => {
    const i = sc.surfaces.findIndex((x) => x.id === sc.selected), j = i + dir;
    if (j < 0 || j >= sc.surfaces.length) return sc;
    const list = [...sc.surfaces];
    [list[i], list[j]] = [list[j], list[i]];
    return { ...sc, surfaces: list };
  });
  const setBlackout = (on: boolean) => edit((sc) => ({ ...sc, blackout: on }));
  const setGuides = (on: boolean) => edit((sc) => ({ ...sc, guides: on }));
  /** Back to how a new surface starts: corners, warp points, shape, edges, flips, brightness. Its picture stays. */
  const resetSurface = () => editSelected((x) => {
    const fresh = makeSurface(x.id, x.name);
    return { ...fresh, content: x.content, color: x.color, image_url: x.image_url, fit: x.fit, grid: x.grid };
  });
  /** Everything back to one fresh surface (Undo can bring it back). */
  const resetScene = () => edit((sc) => ({ surfaces: [makeSurface('s1', 'Surface 1')], selected: 's1', blackout: false, guides: sc.guides }));
  const resetAll = () => { past.current = []; future.current = []; setPreviews({}); commit(DEFAULT_SCENE); past.current = []; };
  const loadScene = (sc: Scene) => commit(sc);
  const setPreview = (id: string, uri: string | null) =>
    setPreviews((p) => { const n = { ...p }; if (uri) n[id] = uri; else delete n[id]; return n; });

  /** Applies a scene from the backend (after connecting, a pinch-drag gesture, or a loaded saved scene). */
  const applyRemote = (m: any) => {
    const cur = sceneRef.current;
    let next: Scene;
    if (Array.isArray(m.surfaces) && m.surfaces.length) {
      const surfaces = m.surfaces.slice(0, MAX_SURFACES).map(cleanSurface);
      next = { surfaces, selected: surfaces.some((x: Surface) => x.id === m.selected) ? m.selected : surfaces[0].id, blackout: m.blackout === true, guides: m.guides === true };
    } else {
      // An older backend: one shape at the top level, applied to the selected surface.
      const sel = selectedOf(cur);
      const one = cleanSurface({ ...sel, ...Object.fromEntries(['corners', 'content', 'fit', 'grid', 'image_url'].filter((k) => k in m).map((k) => [k, m[k]])) }, 0);
      next = { ...cur, surfaces: cur.surfaces.map((x) => (x.id === sel.id ? one : x)) };
    }
    // A picture still uploading from this phone shows as blank on the TV; keep it as an image here.
    next = { ...next, surfaces: next.surfaces.map((x) => {
      const mine = cur.surfaces.find((y) => y.id === x.id);
      return mine && mine.content === 'image' && !mine.image_url && x.content === 'blank' ? { ...x, content: 'image' } : x;
    }) };
    fromBackend.current = JSON.stringify(sceneMessage(next));
    if (!synced.current && freshStart) {  // the app was just opened: start clean and reset the TV too
      freshStart = false;
      synced.current = true;
      // The phone's own scene wins: the clean default, or whatever was changed before connecting.
      setSyncTick((n) => n + 1); // sends it to the TV
    } else if (!synced.current) {  // reconnected while the app stayed open: carry on where the TV is
      synced.current = true;
      past.current = []; future.current = [];
      sceneRef.current = next; setScene(next); setHistTick((n) => n + 1);
    } else if (JSON.stringify(sceneMessage(cur)) !== fromBackend.current) {
      commit(next);
    }
  };

  const selected = selectedOf(scene);
  return {
    scene, selected, previews, setPreview,
    edit, editSurface, editSelected, select, sendLive,
    addSurface, duplicateSurface, deleteSurface, moveLayer, setBlackout, setGuides, loadScene, resetSurface, resetScene,
    undo, redo, canUndo: past.current.length > 0, canRedo: future.current.length > 0,
    resetAll, applyRemote,
  };
}
export type ProjectionApi = ReturnType<typeof useProjectionScene>;
