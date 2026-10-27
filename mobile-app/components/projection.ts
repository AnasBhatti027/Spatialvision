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
 * Holds the projection scene and sends it to the TV (through the backend) whenever it changes.
 * Sends at most every 40 ms, always with the newest state, so dragging stays smooth.
 */
export function useProjectionScene(send: (msg: object) => boolean, connected: boolean) {
  const [scene, setScene] = useState<Scene>(DEFAULT_SCENE);
  const latest = useRef<object | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!connected) return;
    // An image that has not finished uploading cannot be shown on the TV yet.
    const content = scene.content === 'image' && !scene.imageUrl ? 'blank' : scene.content;
    latest.current = { type: 'scene', corners: scene.corners, content, fit: scene.fit, grid: scene.grid, image_url: scene.imageUrl };
    if (timer.current) return;
    timer.current = setTimeout(() => {
      timer.current = null;
      if (latest.current) send(latest.current);
    }, 40);
  }, [scene, connected]);

  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const update = (part: Partial<Scene>) => setScene((s) => ({ ...s, ...part }));
  const setCorners = (corners: Quad) => update({ corners });
  const reset = () => update({ corners: DEFAULT_QUAD });
  const resetAll = () => setScene(DEFAULT_SCENE);
  return { scene, update, setCorners, reset, resetAll };
}
