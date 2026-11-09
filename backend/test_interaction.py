"""Checks the pointer and shape editing with made-up hand data (no camera needed).

Run from the backend folder with the venv active:
    python test_interaction.py

The noise levels below are assumptions for the simulation. Real numbers come from
    python -m vision.pointer_check
"""
import math
import random
import statistics

from vision.interaction import (BoundaryEditor, OneEuroFilter2D, PinchLock, PointerAcceleration, PointerTracker, palm_in_picture,
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

# 1c. A lopsided hand (little-finger knuckle reaching far to one side, as with a right hand in the
#     mirrored phone camera): every TV corner is still reachable with all four knuckles in the picture.
def lopsided(cx, cy):
    pts = hand(cx, cy)
    pts[13] = (cx + 0.08, cy + 0.01)
    pts[17] = (cx + 0.13, cy + 0.03)  # much further out than the standard test hand
    return pts
ptl = PointerTracker()
for i in range(60):
    ptl.update(lopsided(0.5, 0.45), W, H, i * DT)
l2, r2, t2, b2 = ptl.area.bounds()
ok = all(palm_in_picture(lopsided(cx, cy)) for cx, cy in [(l2, t2), (r2, t2), (r2, b2), (l2, b2)])
check("lopsided hand: all 4 corners reachable with the knuckles in view", ok,
      f"camera area x {l2:.2f}-{r2:.2f} (more room on the little-finger side)")

# 1b. Bottom corners with the wrist below the picture (seen in the 9 Nov camera test): still followed.
pt1b = PointerTracker(); pt1b.area = pt.area
low = hand(r, 0.86)  # knuckles low in the picture, wrist (0.86 + 0.18) below it
states = [pt1b.update(hand(r, 0.86, noise=0.002), W, H, i * DT, freeze_area=True)[1] for i in range(30)]
check("wrist below the picture still tracks", low[0][1] > 1 and states[-1] == "tracking" and states.count("tracking") == 30)

# 1d. The hand movement that crosses the TV is the same at any distance from the camera (in palm lengths).
widths = []
for scale in (1.0, 0.6):  # 0.6 = sitting further away: the hand looks 40% smaller in the picture
    ptd = PointerTracker()
    for i in range(60):
        pts = [(0.5 + (x - 0.5) * scale, 0.45 + (y - 0.45) * scale) for x, y in hand(0.5, 0.45)]
        ptd.update(pts, W, H, i * DT)
    l3, r3, _, _ = ptd.area.bounds()
    widths.append((r3 - l3) / (ptd.area.palm_x))
check("same hand movement crosses the TV at any distance", abs(widths[0] - widths[1]) < 0.05, f"{widths[0]:.2f} vs {widths[1]:.2f} palm lengths")

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
            pts = hand(1.02, t)  # knuckles pushed past the picture edge
        else:
            pts = hand(random.uniform(0.2, 0.8), random.uniform(0.2, 0.7))  # a wild, wrong hand position
    else:
        pts = hand(r - 0.01, t + 0.01, noise=0.002)
    out.append(pt3.update(pts, W, H, i * DT, freeze_area=True)[0])
steps = [screen_dist(out[i], out[i - 1]) for i in range(20, 150) if out[i] and out[i - 1]]
# (35% bad frames is far harsher than real use: the 9 Nov logs had under 0.5% glitch frames. A random
#  wrong position that lands close to the real one cannot be told apart from movement, so the check is
#  that there is no repeated shaking and no big jump, not that every frame is perfect.)
check("bad frames near an edge cause no shaking", max(steps) < 0.12 and statistics.mean(steps) < 0.005 and all(out[20:]),
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
# 12b. Sides: grabbing a side anywhere along it moves ONLY that side; the opposite side stays put.
names = ["top", "right", "bottom", "left"]
grab = [(0.35, 0.1), (0.9, 0.62), (0.7, 0.9), (0.1, 0.3)]          # points on each side, not the middle
move = [(0.03, 0.08), (-0.15, 0.04), (-0.02, -0.1), (0.12, -0.05)]  # hand moves (with some sideways drift)
ok_all, detail = True, []
for i in range(4):
    e = BoundaryEditor()
    e.update(grab[i], False, Q, 0)
    hovered = e.hover == ("edge", i)
    g, (mx, my) = grab[i], move[i]
    q, rel = run(e, Q, [(g, True)] * 3 + [((g[0] + mx, g[1] + my), True)] * 3 + [((g[0] + mx, g[1] + my), False)] * 3)
    j = (i + 1) % 4
    moving = {i, j}
    fixed = all(q[k] == Q[k] for k in range(4) if k not in moving)
    if i in (0, 2):  # top / bottom: only up-down, by the hand's up-down movement
        good = all(abs(q[k][0] - Q[k][0]) < 1e-9 and abs(q[k][1] - (Q[k][1] + my)) < 1e-9 for k in moving)
    else:            # left / right: only sideways
        good = all(abs(q[k][1] - Q[k][1]) < 1e-9 and abs(q[k][0] - (Q[k][0] + mx)) < 1e-9 for k in moving)
    ok_all &= hovered and fixed and good and rel
    detail.append(f"{names[i]}: {'ok' if hovered and fixed and good and rel else 'FAILED'}")
check("each side moves alone, opposite side fixed, no scaling", ok_all, ", ".join(detail))

# 12c. Near a corner, the corner wins over the two sides that meet there.
e = BoundaryEditor()
e.update((0.12, 0.11), False, Q, 0)
check("corner wins where sides meet", e.hover == ("corner", 0), str(e.hover))

# 12d. A side cannot be pushed off the screen.
e = BoundaryEditor()
q, _ = run(e, Q, [((0.5, 0.1), True)] * 3 + [((0.5, -0.5), True)] * 3 + [((0.5, -0.5), False)] * 3)
check("side stops at the screen edge", abs(q[0][1]) < 1e-9 and abs(q[1][1]) < 1e-9 and q[2] == Q[2], f"top side at y={q[0][1]:.3f}")
e = BoundaryEditor()
q, _ = run(e, Q, [((0.1, 0.1), True)] * 3 + [((0.95, 0.95), True)] * 3 + [((0.95, 0.95), False)] * 3)
check("shape never folds over", q == Q)

# 13. Strict pinch lock.
#   a) The hand drifts while the fingers close: the pointer stays where it was before the pinch.
#   b) Pinch held, nothing grabbed: the pointer does not move at all, even when the hand does.
#   c) Pinch on a handle (dragging): tremor up to DRAG_DEADZONE is ignored, beyond that it follows.
from vision.interaction import DRAG_DEADZONE, StillLock
lk = PinchLock()
for i in range(10):
    lk.update((0.5, 0.5), False, i * DT)
t0 = 10 * DT
lk.update((0.51, 0.5), False, t0)            # fingers start closing, hand drifts
lk.update((0.52, 0.5), False, t0 + DT)
locked = [lk.update((0.52 + 0.002 * k, 0.5), True, t0 + (2 + k) * DT) for k in range(4)]
check("pinch locks the pointer where it was before the fingers closed", all(abs(p[0] - 0.5) < 1e-9 for p in locked), f"{[round(p[0], 3) for p in locked]}")
frozen = [lk.update((0.53 + 0.01 * k, 0.51), True, t0 + (6 + k) * DT) for k in range(20)]
check("pinch with nothing grabbed: pointer does not move at all", all(p == (0.5, 0.5) for p in frozen), f"hand moved 0.2, pointer {frozen[-1]}")
small = [lk.update((0.53 + 0.003 * k, 0.51), True, t0 + (26 + k) * DT, dragging=True) for k in range(3)]
check("dragging: small tremor is ignored", all(p == (0.5, 0.5) for p in small), f"{small[-1]}")
big = lk.update((0.53 + 0.05, 0.51), True, t0 + 30 * DT, dragging=True)
check("dragging: a real movement moves it (minus the tremor allowance)", abs(big[0] - (0.5 + 0.05 - DRAG_DEADZONE)) < 0.002, f"{big[0]:.3f}")
after = lk.update((0.58, 0.51), False, t0 + 31 * DT)
check("letting go glides back to the hand (no jump)", abs(after[0] - big[0]) < 0.01, f"{big[0]:.3f} -> {after[0]:.3f}")

# 13b. Still lock: a trembling but still hand gives a pointer that does not move at all,
#      a clear movement unlocks it without a jump.
sl = StillLock()
outs = [sl.update((0.4 + random.gauss(0, 0.0008), 0.5 + random.gauss(0, 0.0008)), i * DT) for i in range(60)]
check("still hand: pointer exactly still", len(set(outs[10:])) == 1, f"{len(set(outs[10:]))} different positions in 50 frames")
moving = [sl.update((0.4 + 0.004 * k, 0.5), (60 + k) * DT) for k in range(1, 20)]
steps = [screen_dist(a, b) for a, b in zip(moving, moving[1:])]
check("moving again unlocks smoothly", moving[-1][0] > 0.45 and max(steps) < 0.02, f"now {moving[-1][0]:.3f}, largest step {max(steps):.4f}")

# 14. Pointer acceleration: slow = precise, fast = quick, corners still reachable, no creep when still.
def accel_run(path):
    a, out = PointerAcceleration(), None
    for i, p in enumerate(path):
        out = a.update(p, i * DT)
    return out
def line(a, b, secs):
    n = int(secs * FPS)
    return [(a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n) for k in range(n + 1)]
small = accel_run(line((0.5, 0.5), (0.55, 0.5), 1.0))[0] - 0.5
fast = accel_run(line((0.2, 0.5), (0.8, 0.5), 0.25))[0] - 0.2
corner = accel_run(line((0.5, 0.5), (1.0, 0.0), 5.0) + [(1.0, 0.0)] * 15)
check("slow hand movement is a little more precise (pointer moves less)", 0.030 < small < 0.048, f"hand 0.050, pointer {small:.3f}")
check("fast hand movement keeps full speed", 0.55 < fast < 0.70, f"hand 0.600, pointer {fast:.3f}")
check("slow movement still reaches the corner", corner[0] > 0.99 and corner[1] < 0.01, f"{corner[0]:.3f}, {corner[1]:.3f}")

print()
print("All checks passed" if not failures else f"{len(failures)} check(s) failed: {failures}")
