"""Checks the pointer and shape editing with made-up hand data (no camera needed).

Run from the backend folder with the venv active:
    python test_interaction.py

The noise levels below are assumptions for the simulation. Real numbers come from
    python -m vision.pointer_check
"""
import math
import random
import statistics

from vision.interaction import (BoundaryEditor, OneEuroFilter2D, PointerTracker, palm_in_picture,
                                screen_dist)

FPS, DT = 30, 1 / 30
W, H = 1280, 720
random.seed(1)
failures = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(name)


def hand(cx, cy, pinch=False, noise=0.0):
    """21 points of an upright right hand whose knuckles (points 5 and 9) are centred on (cx, cy)."""
    s = 0.18  # palm length as a fraction of the picture height
    p = {0: (cx + 0.01, cy + s), 1: (cx - 0.05, cy + 0.15), 2: (cx - 0.08, cy + 0.10), 3: (cx - 0.10, cy + 0.04),
         4: (cx - 0.04, cy - 0.11) if pinch else (cx - 0.11, cy - 0.02),
         5: (cx - 0.02, cy), 6: (cx - 0.03, cy - 0.06), 7: (cx - 0.035, cy - 0.09), 8: (cx - 0.04, cy - 0.12),
         9: (cx + 0.02, cy), 10: (cx + 0.02, cy - 0.07), 11: (cx + 0.02, cy - 0.11), 12: (cx + 0.02, cy - 0.14),
         13: (cx + 0.05, cy + 0.01), 14: (cx + 0.055, cy - 0.06), 15: (cx + 0.06, cy - 0.09), 16: (cx + 0.06, cy - 0.12),
         17: (cx + 0.08, cy + 0.03), 18: (cx + 0.085, cy - 0.02), 19: (cx + 0.09, cy - 0.05), 20: (cx + 0.09, cy - 0.08)}
    return [(p[i][0] + random.gauss(0, noise), p[i][1] + random.gauss(0, noise)) for i in range(21)]


def spread(points):
    return statistics.pstdev([p[0] for p in points]) + statistics.pstdev([p[1] for p in points])


def warm_up(pt, cx, cy, frames=60, t0=0.0):
    """Holds a hand still so the tracker learns its size. Returns the time after it."""
    for i in range(frames):
        pt.update(hand(cx, cy, noise=0.002), W, H, t0 + i * DT)
    return t0 + frames * DT


# 1. All four TV corners can be reached while the whole palm is still in the picture.
pt = PointerTracker()
warm_up(pt, 0.5, 0.45)
l, r, t, b = pt.area.bounds()
reached = []
for name, (cx, cy), want in [("top-left", (l, t), (0, 0)), ("top-right", (r, t), (1, 0)),
                             ("bottom-right", (r, b), (1, 1)), ("bottom-left", (l, b), (0, 1))]:
    pts = hand(cx, cy)
    tv = pt.area.to_screen(cx, cy)
    reached.append(palm_in_picture(pts) and screen_dist(tv, want) < 0.01)
check("all 4 TV corners reachable with the palm in view", all(reached),
      f"camera area x {l:.2f}-{r:.2f}, y {t:.2f}-{b:.2f}")

# 1b. Bottom corners with the wrist below the picture (seen in the 9 Nov camera test): still followed.
pt1b = PointerTracker(); pt1b.area = pt.area
low = hand(r, 0.86)  # knuckles low in the picture, wrist (0.86 + 0.18) below it
states = [pt1b.update(hand(r, 0.86, noise=0.002), W, H, i * DT, freeze_area=True)[1] for i in range(30)]
check("wrist below the picture still tracks", low[0][1] > 1 and states[-1] == "tracking" and states.count("tracking") == 30)

# 2. Holding still at each corner and the centre: same steadiness everywhere.
spreads = {}
ix, iy = 0.05 * (r - l), 0.05 * (b - t)  # 5% inside each corner, so clamping cannot hide shaking
for name, (cx, cy) in {"centre": ((l + r) / 2, (t + b) / 2), "top-left": (l + ix, t + iy), "top-right": (r - ix, t + iy),
                       "bottom-right": (r - ix, b - iy), "bottom-left": (l + ix, b - iy)}.items():
    pt2 = PointerTracker(); pt2.area = pt.area
    out = [pt2.update(hand(cx, cy, noise=0.002), W, H, i * DT, freeze_area=True)[0] for i in range(400)]
    spreads[name] = spread([p for p in out[20:] if p])
worst = max(spreads.values())
check("corners as steady as the centre", worst < spreads["centre"] * 1.3 + 1e-4,
      ", ".join(f"{k} {v:.4f}" for k, v in spreads.items()))

# 3. The "earthquake": near an edge, 35% of frames are bad (palm cut off, or a wild guess elsewhere).
pt3 = PointerTracker(); pt3.area = pt.area
out = []
for i in range(150):
    if random.random() < 0.35:
        if random.random() < 0.5:
            pts = hand(r + 0.2, t)  # palm pushed out of the picture
        else:
            pts = hand(random.uniform(0.2, 0.8), random.uniform(0.2, 0.7))  # a wild, wrong hand position
    else:
        pts = hand(r - 0.01, t + 0.01, noise=0.002)
    out.append(pt3.update(pts, W, H, i * DT, freeze_area=True)[0])
steps = [screen_dist(out[i], out[i - 1]) for i in range(20, 150) if out[i] and out[i - 1]]
check("bad frames near an edge cause no shaking", max(steps) < 0.05 and statistics.mean(steps) < 0.005 and all(out[20:]),
      f"largest step {max(steps):.4f}, average {statistics.mean(steps):.4f} TV widths, pointer always visible")

# 3b. A real fast hand move (3 TV widths per second) is followed, not mistaken for a glitch.
pt3b = PointerTracker(); pt3b.area = pt.area
t_end = 0.0
for i in range(30):
    pt3b.update(hand(0.3, 0.45, noise=0.001), W, H, i * DT, freeze_area=True)
cx, behind = 0.3, []
for i in range(30, 45):
    cx += 3.0 * (r - l) * DT  # 3 TV widths per second, in picture units
    if cx > r: break
    p, s = pt3b.update(hand(cx, 0.45, noise=0.001), W, H, i * DT, freeze_area=True)
    behind.append(pt3b.area.to_screen(cx - 0.0, 0.45)[0] - p[0] if p else 9)
check("fast real move is followed", max(behind) < 0.15, f"furthest behind {max(behind):.3f} TV widths")

# 4. Losing the hand: pointer stays (dimmed) for a moment, then goes; it never sticks for long.
pt4 = PointerTracker()
t_end = warm_up(pt4, 0.5, 0.45, 30)
states = [pt4.update(None, W, H, t_end + k * DT)[1] for k in range(40)]  # 1.3 s without a hand
check("short loss holds the pointer", states[:20] == ["holding"] * 20)
check("long loss hides it", states[-1] == "lost" and pt4.pointer is None)

# 5. Broken numbers (NaN) never move or hide the pointer at once.
pt5 = PointerTracker()
t_end = warm_up(pt5, 0.5, 0.45, 30)
bad = hand(0.5, 0.45); bad[5] = (math.nan, 0.4)
p, s = pt5.update(bad, W, H, t_end)
check("NaN frame is ignored", s == "holding" and p is not None)

# 6. Pinching does not move the pointer (it follows the knuckles, not the fingertip).
pt6 = PointerTracker()
t_end = warm_up(pt6, 0.5, 0.45, 30)
a = pt6.update(hand(0.5, 0.45), W, H, t_end, freeze_area=True)[0]
b2 = pt6.update(hand(0.5, 0.45, pinch=True), W, H, t_end + DT, freeze_area=True)[0]
check("pinching does not move the pointer", screen_dist(a, b2) < 0.001, f"moved {screen_dist(a, b2):.4f}")

# 7. Responsiveness: delay behind the hand at slow, medium and fast speed (filter only).
lags = {}
for v in (0.15, 0.5, 1.5):
    f, lag = OneEuroFilter2D(), []
    for i in range(90):
        tt = i * DT; x = 0.1 + v * max(0, tt - 0.5)
        q = f((x + random.gauss(0, 0.002), 0.5), tt)
        if tt > 0.9 and x < 0.95:
            lag.append((x - q[0]) / v * 1000)
    lags[v] = statistics.mean(lag)
check("pointer keeps up with the hand", max(lags.values()) < 50,
      ", ".join(f"{v} widths/s: {ms:.0f} ms" for v, ms in lags.items()))


# ---------- shape editing
def run(editor, quad, frames):
    released = False
    for i, (p, pinch) in enumerate(frames):
        new, rel = editor.update(p, pinch, quad, i * DT)
        if new is not None:
            quad = new
        released = released or rel
    return quad, released


Q = [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]

# 8. Each of the 4 corners: hover, pinch, drag 0.05 inwards, release -> only that corner moves.
ok_all, detail = True, []
for i, (cx, cy) in enumerate(Q):
    e = BoundaryEditor()
    e.update((cx, cy), False, Q, 0)
    hovered = e.hover == ("corner", i)
    sx, sy = (1 if cx < 0.5 else -1), (1 if cy < 0.5 else -1)
    frames = [((cx, cy), True)] * 3 + [((cx + sx * 0.005 * k, cy + sy * 0.005 * k), True) for k in range(1, 11)]
    frames += [((cx + sx * 0.05, cy + sy * 0.05), False)] * 3
    q, rel = run(e, Q, frames)
    moved = abs(q[i][0] - (cx + sx * 0.05)) < 0.006 and abs(q[i][1] - (cy + sy * 0.05)) < 0.006
    others = all(q[j] == Q[j] for j in range(4) if j != i)
    ok_all &= hovered and moved and others and rel
    detail.append(f"corner {i + 1}: {'ok' if hovered and moved and others and rel else 'FAILED'}")
check("all 4 corners can be grabbed, dragged and released", ok_all, ", ".join(detail))

# 9. A grabbed corner stays grabbed, even when dragged right past another corner's handle.
e = BoundaryEditor()
q, _ = run(e, Q, [((0.1, 0.1), True)] * 3 + [((0.1 + 0.02 * k, 0.1), True) for k in range(1, 40)])
check("grabbed corner stays locked", e.drag == ("corner", 0) and q[1] == Q[1], f"corner 1 at {q[0]}")

# 10. Hand unclear for a few frames while dragging (pinch unknown) does not drop the corner.
e = BoundaryEditor()
q, rel = run(e, Q, [((0.1, 0.1), True)] * 3 + [((0.15, 0.15), True)] * 2 + [((0.15, 0.15), None)] * 6
             + [((0.18, 0.18), True)] * 2)
check("short tracking gap keeps the corner grabbed", not rel and e.drag == ("corner", 0) and abs(q[0][0] - 0.18) < 1e-9)

# 11. Release drops the corner where it was before the fingers opened (no jump).
e = BoundaryEditor()
q, rel = run(e, Q, [((0.1, 0.1), True)] * 3 + [((0.2, 0.2), True)] * 3 + [((0.23, 0.17), False)] * 3)
check("release does not jump", rel and abs(q[0][0] - 0.2) < 1e-9 and abs(q[0][1] - 0.2) < 1e-9, f"{q[0]}")

# 12. Pinching empty space does nothing; pinch inside moves all; side handle resizes; no folding.
e = BoundaryEditor()
q, rel = run(e, Q, [((0.02, 0.5), True)] * 10)
check("pinch outside the shape changes nothing", q == Q and not rel)
e = BoundaryEditor()
q, _ = run(e, Q, [((0.5, 0.5), True)] * 3 + [((0.55, 0.45), True)] * 3 + [((0.55, 0.45), False)] * 3)
check("pinch inside moves the whole shape", abs(q[0][0] - 0.15) < 1e-9 and abs(q[2][1] - 0.85) < 1e-9)
e = BoundaryEditor()
q, _ = run(e, Q, [((0.9, 0.5), True)] * 3 + [((0.7, 0.5), True)] * 3 + [((0.7, 0.5), False)] * 3)
check("side handle resizes the shape", abs(q[1][0] - 0.7) < 1e-6 and abs(q[0][0] - 0.3) < 1e-6)
e = BoundaryEditor()
q, _ = run(e, Q, [((0.1, 0.1), True)] * 3 + [((0.95, 0.95), True)] * 3 + [((0.95, 0.95), False)] * 3)
check("shape never folds over", q == Q)

print()
print("All checks passed" if not failures else f"{len(failures)} check(s) failed: {failures}")
