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

# 13. Pinch = capture and lock (the spec of 10 Nov). Checks the actual pointer coordinates.
from vision.interaction import DRAG_START, DRAG_STOP_S, GUARD_MAX_S, LOCK_SETTLE_S, RELEASE_SETTLE_S, StillLock
_r = __import__("random").Random(7)  # own random numbers, so the later checks get the same noise as before
lk = PinchLock()
track = [lk.update((0.3 + 0.01 * i, 0.5), False, i * DT) for i in range(20)]
check("tracking: the pointer follows the hand", abs(track[-1][0] - 0.49) < 1e-9, f"{track[-1]}")
t0 = 20 * DT
shown_before = track[-1]
first = lk.update((0.50 + 0.004, 0.5 + 0.003), True, t0)   # fingers touch; this frame the hand also wobbled
check("pinch captures the pointer exactly as it was shown (not an older or later spot)", first == shown_before, f"{shown_before} -> {first}")
check("pinch: the lock is on", lk.locked and lk.lock_point == shown_before)
# The whole pinch: noise, drift, a big hand movement, unclear frames. The pointer must not change at all.
pts = []
for k in range(1, 80):
    hand = (0.5 + 0.2 * k / 80 + _r.gauss(0, 0.004), 0.5 + _r.gauss(0, 0.004))
    pts.append(lk.update(hand, None if k % 9 == 0 else True, t0 + k * DT))
check("locked for the whole pinch: noise, drift, movement and unclear frames change nothing", all(p == shown_before for p in pts),
      f"{len(set(pts))} different position(s) over {len(pts)} frames")
check("the captured coordinates themselves never changed", lk.lock_point == shown_before)
# Release: unlock, glide back onto the hand (no jump), then follow normally.
hand = (0.72, 0.5)
rel = lk.update(hand, False, t0 + 80 * DT)
check("release unlocks", not lk.locked and lk.drag_point is None)
check("release: the pointer stays exactly where it was locked (no slide, no jump)", rel == shown_before, f"{shown_before} -> {rel}")
still_after = [lk.update(hand, False, t0 + (81 + k) * DT) for k in range(20)]
check("after release, a still hand: the pointer does not move by itself", all(p == shown_before for p in still_after))
moving = [lk.update((hand[0] - 0.01 * k, hand[1]), False, t0 + (101 + k) * DT) for k in range(1, 6)]
check("after release it carries on from there, moving the same way as the hand", all(b[0] < a[0] for a, b in zip([shown_before] + moving, moving)),
      f"{shown_before[0]:.3f} -> {moving[0][0]:.3f}")
far = [lk.update((0.3 + 0.004 * k, 0.5), False, t0 + (106 + k) * DT) for k in range(150)]
far = far + [lk.update((0.896 - 0.004 * k, 0.5), False, t0 + (256 + k) * DT) for k in range(100)]
check("...and rejoins the hand as it keeps moving", abs(far[-1][0] - (0.896 - 0.004 * 99)) < 0.01, f"pointer {far[-1][0]:.3f}, hand {0.896 - 0.004 * 99:.3f}")
# Repeated pinch / release cycles.
ok = True
for c in range(5):
    base_t = t0 + (130 + c * 40) * DT
    sh = lk.update((0.4 + 0.02 * c, 0.4), False, base_t)
    for k in range(10):
        sh = lk.update((0.4 + 0.02 * c, 0.4), False, base_t + (k + 1) * DT)
    cap = lk.update((0.4 + 0.02 * c + 0.01, 0.41), True, base_t + 11 * DT)
    held = [lk.update((0.4 + 0.02 * c + 0.05 * k / 10, 0.42), True, base_t + (12 + k) * DT) for k in range(10)]
    ok = ok and cap == sh and all(p == cap for p in held)
    lk.update((0.4 + 0.02 * c, 0.4), False, base_t + 23 * DT)
check("five pinch/release cycles: each captures and locks exactly", ok)

# Pinch on a corner (grabbed): the dot rides on the corner. Wobble and drift move nothing; deliberate
# movement moves dot and corner together; when the hand pauses, both hold still.
lk = PinchLock()
for i in range(10):
    lk.update((0.5, 0.5), False, i * DT, ratio=1.0)
t0 = 10 * DT
cap = lk.update((0.5, 0.5), True, t0, dragging=True, ratio=0.1)
settle = [lk.update((0.5 + 0.004 * k, 0.5), True, t0 + k * DT, dragging=True, ratio=0.1) for k in range(1, int(LOCK_SETTLE_S / DT))]
check("grab: fingers closing move nothing", lk.drag_point == cap and all(p == cap for p in settle))
t1 = t0 + int(LOCK_SETTLE_S / DT) * DT
drift = [lk.update((0.5 + 0.0015 * k, 0.5 + 0.001 * k), True, t1 + k * DT, dragging=True, ratio=0.1) for k in range(12)]
check("grab: slow drift while holding moves neither dot nor corner", lk.drag_point == cap and all(p == cap for p in drift), f"{drift[-1]}")
h0 = (0.5 + 0.0165, 0.5 + 0.011)
go = [lk.update((h0[0] + DRAG_START * 1.5 + 0.01 * k, h0[1]), True, t1 + (12 + k) * DT, dragging=True, ratio=0.1) for k in range(8)]
check("grab: moving the hand moves the corner, and the dot rides on it", go[-1] == lk.drag_point and lk.drag_point[0] > 0.56, f"{lk.drag_point}")
stop = [lk.update((h0[0] + DRAG_START * 1.5 + 0.07 + 0.004 * ((-1) ** k), h0[1]), True, t1 + (20 + k) * DT, dragging=True, ratio=0.1) for k in range(int(DRAG_STOP_S / DT) + 8)]
dp = lk.drag_point
more = [lk.update((h0[0] + DRAG_START * 1.5 + 0.07 + 0.004 * ((-1) ** k), h0[1] + 0.003), True, t1 + (40 + k) * DT, dragging=True, ratio=0.1) for k in range(6)]
check("grab: when the hand pauses, dot and corner hold still (wobble ignored)", lk.drag_point == dp and all(p == dp for p in more), f"{dp} -> {lk.drag_point}")
rel = [lk.update((dp[0] + 0.02 * k, dp[1]), False, t1 + (46 + k) * DT, ratio=1.3) for k in range(int(RELEASE_SETTLE_S / DT) + 1)]
check("grab: letting go, the dot stays on the dropped corner (no slide, no jump)", all(p == dp for p in rel), f"{rel[-1]}")

# 13a. The fault in the logs of 10 Nov 17:03: the dot moved 2-10% of the screen while the fingers were
#      closing, before the pinch was recognised. Now it is frozen from the moment they start closing.
lk = PinchLock()
for i in range(10):
    aim = lk.update((0.5, 0.47), False, i * DT, ratio=1.45)
t0 = 10 * DT
# The real sequence of pinch 2 in that log: gap 1.45 -> 0.32 -> 0.14 -> 0.07 while the hand shifted (0.05, -0.10).
closing = [lk.update(h, False, t0 + k * DT, ratio=r) for k, (h, r) in enumerate([((0.508, 0.436), 0.321), ((0.532, 0.396), 0.137), ((0.547, 0.374), 0.074)])]
check("fingers closing: the dot does not move at all (hand shifted 10% of the screen)", all(p == aim for p in closing), f"aimed at {aim}, shown {closing}")
got = lk.update((0.552, 0.365), True, t0 + 3 * DT, ratio=0.11)
check("pinch locks exactly where the dot was aimed before the fingers closed", got == aim and lk.lock_point == aim, f"{got}")
held = [lk.update((0.552 + 0.002 * k, 0.36), True, t0 + (4 + k) * DT, ratio=0.11) for k in range(30)]
check("...and stays there for the whole pinch", all(p == aim for p in held))
# Letting go: the fingers open and the hand shifts back. The dot must not move.
t1 = t0 + 34 * DT
opening = [lk.update(h, False, t1 + k * DT, ratio=r) for k, (h, r) in enumerate([((0.54, 0.40), 0.7), ((0.52, 0.44), 1.2), ((0.50, 0.47), 1.45)])]
rest = [lk.update((0.5, 0.47), False, t1 + (3 + k) * DT, ratio=1.45) for k in range(30)]
check("letting go: the dot stays exactly in place while the fingers open and after", all(p == aim for p in opening + rest),
      f"{len(set(opening + rest))} position(s)")
step = lk.update((0.51, 0.47), False, t1 + 34 * DT, ratio=1.45)
check("then it follows the hand again from that spot", abs(step[0] - 0.51) < 1e-6 and abs(step[1] - 0.47) < 1e-6, f"{step}")
# Fingers come together a little but no pinch follows (hand keeps moving): a short pause, then on, no jump.
lk = PinchLock()
for i in range(10):
    p0 = lk.update((0.3 + 0.005 * i, 0.5), False, i * DT, ratio=1.0)
dip = [lk.update((0.35 + 0.005 * k, 0.5), False, (10 + k) * DT, ratio=0.5) for k in range(3)]
back = lk.update((0.365, 0.5), False, 13 * DT, ratio=1.0)
on = lk.update((0.375, 0.5), False, 14 * DT, ratio=1.0)
check("fingers nearly together without a pinch: no jump, then it moves on with the hand", all(p == p0 for p in dip) and back == p0 and on[0] > p0[0], f"{p0} {back} {on}")
lk = PinchLock()
for i in range(10):
    p0 = lk.update((0.3, 0.5), False, i * DT, ratio=1.0)
n = int(GUARD_MAX_S / DT) + 12
slow = [lk.update((0.3 + 0.004 * k, 0.5), False, (10 + k) * DT, ratio=0.5) for k in range(n)]
check("hand held half closed while moving: the dot waits at most GUARD_MAX_S, then follows", slow[int(GUARD_MAX_S / DT) - 2] == p0 and slow[-1][0] > p0[0] + 0.02,
      f"after {n * DT:.2f} s the dot is at {slow[-1][0]:.3f}")
# After a drag, at a screen edge: the dot does not get stuck there.
lk = PinchLock()
for i in range(5):
    lk.update((0.9, 0.5), False, i * DT, ratio=1.0)
lk.update((0.9, 0.5), True, 5 * DT, ratio=0.1)
for k in range(10):
    lk.update((0.9 - 0.04 * k, 0.5), True, (6 + k) * DT, ratio=0.1)                     # pinch on nothing: hand moves 0.36 left, the dot stays at 0.9
for k in range(10):
    lk.update((0.54, 0.5), False, (16 + k) * DT, ratio=1.2)                             # let go, hand still
for k in range(1, 21):
    e = lk.update((0.54 + 0.02 * k, 0.5), False, (26 + k) * DT, ratio=1.2)              # hand comes back right: the dot reaches the edge
turn = lk.update((0.94 - 0.02, 0.5), False, 47 * DT, ratio=1.2)
check("at the screen edge the dot turns back at once with the hand (not stuck)", e[0] == 1.0 and turn[0] < 1.0, f"edge {e[0]}, after turning back {turn[0]:.3f}")

# 13c. The top-edge moment in the video of 10 Nov 17:58: mid-drag, two frames look like open fingers.
#      The editor holds the edge still on such frames, so the dot riding on it must hold still too,
#      and when the pinch is clear again both carry on together without a jump.
lk = PinchLock()
for i in range(8):
    lk.update((0.45, 0.15), False, i * DT, ratio=1.0)
t0 = 8 * DT
cap = lk.update((0.45, 0.15), True, t0, dragging=True, moving_ok=True, ratio=0.15)
for k in range(1, 6):
    lk.update((0.45, 0.15), True, t0 + k * DT, dragging=True, moving_ok=True, ratio=0.15)
for k in range(6, 14):
    dot = lk.update((0.45, 0.15 + 0.02 * (k - 5)), True, t0 + k * DT, dragging=True, moving_ok=True, ratio=0.15)
before_gap = dot
gap = [lk.update((0.45, 0.31 - 0.05 * j), True, t0 + (14 + j) * DT, dragging=True, moving_ok=False, ratio=0.7) for j in range(2)]
check("open-looking frames mid-drag: the dot holds still with the edge", all(p == before_gap for p in gap), f"{before_gap} -> {gap}")
resume = lk.update((0.45, 0.21), True, t0 + 16 * DT, dragging=True, moving_ok=True, ratio=0.15)
check("pinch clear again: no jump", resume == before_gap, f"{before_gap} -> {resume}")
on = lk.update((0.45, 0.17), True, t0 + 17 * DT, dragging=True, moving_ok=True, ratio=0.15)
check("...then dot and edge carry on together from there", abs(on[1] - (before_gap[1] - 0.04)) < 1e-9, f"{on}")
# Release: the fingers open (frames not clearly a pinch), the hand moves: the dot stays on the dropped edge.
rel = [lk.update((0.45 + 0.01 * j, 0.17 + 0.01 * j), True, t0 + (18 + j) * DT, dragging=True, moving_ok=False, ratio=0.8) for j in range(3)]
rel += [lk.update((0.48 + 0.01 * j, 0.20), False, t0 + (21 + j) * DT, ratio=0.9) for j in range(int(RELEASE_SETTLE_S / DT))]
check("letting go: the dot stays exactly on the dropped edge", all(p == on for p in rel), f"{on} -> {rel[-1]}")

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
