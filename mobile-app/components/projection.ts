import { useEffect, useRef, useState } from 'react';

/** A point as fractions of the output screen: x and y go from 0 (left/top) to 1 (right/bottom). */
export type Pt = [number, number];
/** Four corners in order: 1 top-left, 2 top-right, 3 bottom-right, 4 bottom-left. */
export type Quad = [Pt, Pt, Pt, Pt];
export type Content = 'pattern' | 'image' | 'blank';
export type Fit = 'contain' | 'cover';

export type Scene = {
  corners: Quad;
  content: Content;
  fit: Fit;
  grid: boolean;
  imageUrl: string | null;  // where the TV loads the image from (after upload)
  localUri: string | null;  // the picked image on the phone, for the preview
};

export const ASPECT = 16 / 9; // the TV's shape
export const DEFAULT_QUAD: Quad = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]];
export const DEFAULT_SCENE: Scene = { corners: DEFAULT_QUAD, content: 'pattern', fit: 'contain', grid: false, imageUrl: null, localUri: null };

const clamp = (v: number) => Math.min(1, Math.max(0, v));

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

/**
 * Perspective map from the unit square to the quad (the same maths the TV warp uses).
 * (u, v) = (0,0) top-left, (1,0) top-right, (1,1) bottom-right, (0,1) bottom-left.
 * Returns null when the shape is folded over itself, because no flat picture fits it.
 */
export function squareToQuad(q: Quad): ((u: number, v: number) => Pt) | null {
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
  const a = x1 - x0 + g * x1, b = x3 - x0 + h * x3, c = x0;
  const d = y1 - y0 + g * y1, e = y3 - y0 + h * y3, f = y0;
  // A corner with w <= 0 means the shape is folded; refuse rather than draw garbage.
  if ([[0, 0], [1, 0], [1, 1], [0, 1]].some(([u, v]) => g * u + h * v + 1 <= 1e-6)) return null;
  return (u, v) => {
    const w = g * u + h * v + 1;
    return [(a * u + b * v + c) / w, (d * u + e * v + f) / w];
  };
}

/** The message the TV understands for a scene. */
function sceneMessage(sc: Scene) {
  // An image that has not finished uploading cannot be shown on the TV yet.
  const content = sc.content === 'image' && !sc.imageUrl ? 'blank' : sc.content;
  return { type: 'scene', corners: sc.corners, content, fit: sc.fit, grid: sc.grid, image_url: sc.imageUrl };
}

/**
 * Holds the projection scene and sends it to the TV (through the backend) whenever it changes.
 * Sends at most every 33 ms, always with the newest state.
 * While a finger drags a corner, the editor calls sendLive() instead of changing the scene,
 * so the TV follows the finger without re-drawing the whole phone screen on every move.
 */
export function useProjectionScene(send: (msg: object) => boolean, connected: boolean) {
  const [scene, setScene] = useState<Scene>(DEFAULT_SCENE);
  const sceneRef = useRef(scene);
  sceneRef.current = scene;
  const latest = useRef<object | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fromBackend = useRef(''); // the last scene the backend sent us, so we do not echo it back

  const push = (msg: object) => {
    latest.current = msg;
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (latest.current) send(latest.current);
    }, 33);
  };

  useEffect(() => {
    if (!connected) return;
    const msg = sceneMessage(scene);
    if (JSON.stringify(msg) === fromBackend.current) return;
    push(msg);
  }, [scene, connected]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  /** Sends corners to the TV during a drag without storing them. Call setCorners when the finger lifts. */
  const sendLive = (corners: Quad) => {
    if (connected) push(sceneMessage({ ...sceneRef.current, corners }));
  };

  const update = (part: Partial<Scene>) => setScene((s) => ({ ...s, ...part }));
  const setCorners = (corners: Quad) => update({ corners });
  const reset = () => update({ corners: DEFAULT_QUAD });
  const resetAll = () => setScene(DEFAULT_SCENE);

  /** Applies a scene changed on the backend (for example by a pinch-drag gesture). */
  const applyRemote = (m: { corners?: Quad; content?: Content; fit?: Fit; grid?: boolean; image_url?: string | null }) => {
    setScene((s) => {
      const imageUrl = m.image_url !== undefined ? m.image_url : s.imageUrl;
      const next: Scene = {
        corners: m.corners ?? s.corners, content: m.content ?? s.content, fit: m.fit ?? s.fit, grid: m.grid ?? s.grid,
        imageUrl, localUri: imageUrl === s.imageUrl ? s.localUri : null,
      };
      fromBackend.current = JSON.stringify(sceneMessage(next));
      return next;
    });
  };
  return { scene, update, setCorners, sendLive, reset, resetAll, applyRemote };
}
