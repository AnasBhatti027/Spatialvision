"""Turns raw hand points into a steady pointer on the TV, and lets a pinch edit the projection shape.

No camera or MediaPipe code here, so every part can be tested with made-up numbers
(see test_interaction.py in the backend folder).

Root causes of the pointer problems (found 9 Nov 2026) and what this file does about them
1. The pointer followed the index FINGERTIP. MediaPipe's fingertip points are its noisiest, they move
   whenever the fingers bend or pinch, and near the top of the picture the fingertip leaves the image first.
   -> The pointer now follows the KNUCKLES of the index and middle finger (points 5 and 9). They are far
      steadier, do not move when you pinch, and sit in the middle of the hand.
2. Reaching a TV corner needed the hand at the very edge of the camera picture. There MediaPipe only sees
   part of the hand and guesses the rest, so the points jump (the "earthquake"), or it loses the hand
   (the pointer disappears).
   -> The camera area that maps onto the TV is now worked out from the size of YOUR hand in the picture,
      so the palm and fingers stay fully in view even at the TV corners.
   -> Frames where the palm is cut off by the picture edge are not trusted: the pointer holds still instead.
3. The glitch filter gave up after 3 bad frames and snapped to the raw (unsmoothed) value. With frequent bad
   frames near the edge that snapping repeated: shaking. -> A far jump is only accepted when several frames
   agree with each other.
4. Losing the hand for more than 0.25 s removed the pointer. -> It now holds (dimmed) for up to 0.8 s,
   then disappears, so it never sticks for long in a wrong place.
5. Smoothing settings were tuned for the noisy fingertip, so the pointer lagged. The steadier knuckles need
   much less smoothing; speed-based smoothing (One Euro filter) keeps slow moves steady and fast moves quick.
"""
import math
from collections import deque

ASPECT = 16 / 9  # TV width / height, so distances are measured the same way across and down

# MediaPipe hand point numbers used here
WRIST, INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP = 0, 5, 9, 13, 17
KNUCKLES = (INDEX_MCP, MIDDLE_MCP, RING_MCP, PINKY_MCP)  # must be in the picture for the pointer to be trusted

# How far the hand reaches from the pointer point (between the two knuckles), in palm lengths
# (palm length = wrist to middle knuckle). Used to keep the whole hand in the picture at the TV edges.
REACH_UP = 0.85      # fingertips above the knuckles (needed to see a pinch)
REACH_DOWN = 1.05    # wrist below the knuckles
SIDE_MIN = 0.25      # side margins are at least this many palm lengths
SIDE_SAFETY = 1.25   # ...and 25% more than the knuckles were measured to reach (hands turn a little)
EDGE_GAP = 0.03      # extra space to the picture edge (fraction of the picture)
MIN_ACTIVE = 0.30    # the active area is never smaller than this part of the picture (hand very close)
PALM_AVERAGE_S = 2.0 # hand size is averaged slowly, so the mapping does not wobble
COMFORT_W = 4.5      # moving the hand this many palm lengths sideways crosses the whole TV...
COMFORT_H = 3.0      # ...and this many up and down (the same at any distance from the camera)
IN_PICTURE = 0.005   # a point closer than this to the picture edge counts as cut off

HOLD_S = 0.8             # hand lost or not trusted: keep the pointer (dimmed) this long, then hide it
MAX_SPEED = 4.0          # TV widths per second (well above real hand speed); a faster jump between two frames is suspicious...
MIN_JUMP = 0.06          # (never treat a move smaller than this as suspicious, even at high frame rates)
JUMP_CONFIRM_FRAMES = 3  # ...and only accepted when this many frames in a row form a smooth path

CORNER_RADIUS = 0.06     # how close (TV widths) the pointer must be to grab a corner
EDGE_RADIUS = 0.035      # ...or anywhere along a side (moves just that side)
HOVER_KEEP = 1.4         # once hovering, stay hovering until this many radii away (no flicker)
PINCH_START_FRAMES = 2   # pinch must be seen this many frames before it grabs
PINCH_END_FRAMES = 3     # open fingers must be seen this many frames before it lets go
PHONE_UPDATE_S = 0.1     # while dragging, update the phone at most 10 times a second

GAIN_SLOW = 0.75         # pointer acceleration: slow hand movement moves the pointer at 75% (a little more precise)...
GAIN_FAST = 1.1          # ...fast movement at 110% (quick across the screen)
SPEED_SLOW = 0.12        # hand speed (TV widths per second) at or below which the slow gain applies
SPEED_FAST = 1.0         # ...and at or above which the fast gain applies
CATCH_UP = 7.0           # while the hand moves, this fraction per TV width moved pulls the pointer back in line
EDGE_SNAP_S = 0.12       # hand at the edge of the TV area: the pointer goes all the way there within about this time

STILL_SPEED = 0.06       # still lock: hand slower than this (TV widths per second)...
STILL_TIME_S = 0.10      # ...for this long locks the pointer exactly in place...
UNLOCK_DIST = 0.010      # ...until the hand has clearly moved this far (TV widths, about 1% of the screen)
UNLOCK_GLIDE_S_STILL = 0.08  # after unlocking, the pointer joins the hand over about this time (no jump)
DRAG_START = 0.03        # while pinching a corner, side or the inside: the projection stays put until the hand moves this far
GUARD_RATIO = 0.6        # thumb-index gap (in palm lengths) below this: the fingers are closing for a pinch
GUARD_MAX_S = 0.5        # the dot waits this long for the pinch to be recognised; otherwise it carries on
RELEASE_SETTLE_S = 0.25  # after a pinch the dot stays put this long while the fingers finish opening
OFFSET_CLOSE = 0.5       # after a pinch, the gap to the hand closes by this share of each hand step
DRAG_STOP_S = 0.25       # ...and locks again once the hand has moved less than DRAG_STOP_DIST in this time
DRAG_STOP_DIST = 0.012

LOCK_SETTLE_S = 0.15     # pinch: hand movement in this first moment (fingers closing) never moves a grabbed corner
UNLOCK_GLIDE_S = 0.25    # after letting go, the pointer glides back onto the hand over about this time


def clamp01(v: float) -> float:
    return min(1.0, max(0.0, v))


def screen_dist(a, b) -> float:
    """Distance between two TV points in TV widths (vertical distances scaled to match)."""
    return math.hypot(a[0] - b[0], (a[1] - b[1]) / ASPECT)


class OneEuroFilter2D:
    """The One Euro filter (Casiez et al., CHI 2012) for a 2D point.
    Strong smoothing when the hand is still (no jitter), little smoothing when it moves fast (little delay).
    Both axes share one speed, so diagonal moves do not wobble."""

    def __init__(self, min_cutoff: float = 1.6, beta: float = 10.0, d_cutoff: float = 2.0):
        self.min_cutoff, self.beta, self.d_cutoff = min_cutoff, beta, d_cutoff
        self.reset()

    def reset(self):
        self.p = None
        self.v = (0.0, 0.0)
        self.t = 0.0

    @staticmethod
    def _alpha(cutoff: float, dt: float) -> float:
        tau = 1.0 / (2 * math.pi * cutoff)
        return 1.0 / (1.0 + tau / dt)

    def __call__(self, p, t: float):
        if self.p is None:
            self.p, self.t = p, t
            return p
        dt = max(t - self.t, 1e-3)
        self.t = t
        a_d = self._alpha(self.d_cutoff, dt)
        self.v = tuple(a_d * ((n - o) / dt) + (1 - a_d) * vo for n, o, vo in zip(p, self.p, self.v))
        speed = math.hypot(self.v[0], self.v[1] / ASPECT)
        a = self._alpha(self.min_cutoff + self.beta * speed, dt)
        self.p = tuple(a * n + (1 - a) * o for n, o in zip(p, self.p))
        return self.p


class ActiveArea:
    """The part of the camera picture that maps onto the whole TV, sized from the hand in the picture.

    Up and down use the palm length (fingers above the knuckles, wrist below). Left and right use how
    far YOUR knuckles really reach from the pointer point on each side, measured from the hand. The
    pointer point (between the index and middle knuckles) sits on the thumb side of the palm, so the
    little-finger knuckle reaches much further on the other side. Equal margins (as before) let that
    knuckle leave the picture first at the corners on the little-finger side, which made the pointer
    hold and catch up there (corner 2 with a right hand and the mirrored front camera)."""

    def __init__(self):
        self.palm_x = None  # palm length as a fraction of the picture width
        self.palm_y = None  # ...and of the picture height
        self.reach_left = None   # how far the knuckles reach left of the pointer point (picture fraction)
        self.reach_right = None  # ...and right of it

    def learn(self, pts, frame_w: int, frame_h: int, dt: float):
        (wx, wy), (mx, my) = pts[WRIST], pts[MIDDLE_MCP]
        palm_px = math.hypot((mx - wx) * frame_w, (my - wy) * frame_h)
        px, py = palm_px / frame_w, palm_px / frame_h
        ax = (pts[INDEX_MCP][0] + pts[MIDDLE_MCP][0]) / 2
        rl = max(0.0, ax - min(pts[i][0] for i in KNUCKLES))
        rr = max(0.0, max(pts[i][0] for i in KNUCKLES) - ax)
        if self.palm_x is None:
            self.palm_x, self.palm_y, self.reach_left, self.reach_right = px, py, rl, rr
        else:
            k = 1 - math.exp(-dt / PALM_AVERAGE_S)
            self.palm_x += k * (px - self.palm_x)
            self.palm_y += k * (py - self.palm_y)
            self.reach_left += k * (rl - self.reach_left)
            self.reach_right += k * (rr - self.reach_right)

    def bounds(self):
        """(left, right, top, bottom) of the active area, as picture fractions.

        The area is a comfortable box measured in palm lengths (COMFORT_W x COMFORT_H), centred in
        the picture, so the hand movement that crosses the TV is the same whether you stand close
        to the camera or far from it. Measured 9 Nov: sized only from the picture, the area was 83%
        of the picture when sitting far from the phone (the hand had to travel very far), and 64%
        when close (it felt too fast). It never goes beyond the edges where the knuckles stay in view."""
        l, r, t, b = self._limits()
        px, py = self.palm_x or 0.12, self.palm_y or 0.2
        want_w, want_h = COMFORT_W * px, COMFORT_H * py
        if want_w < r - l:
            cx = min(max(0.5, l + want_w / 2), r - want_w / 2)
            l, r = cx - want_w / 2, cx + want_w / 2
        if want_h < b - t:
            cy = min(max(0.5, t + want_h / 2), b - want_h / 2)
            t, b = cy - want_h / 2, cy + want_h / 2
        return l, r, t, b

    def _limits(self):
        """The largest area where the knuckles (and fingertips for a pinch) stay in the picture."""
        px, py = self.palm_x or 0.12, self.palm_y or 0.2
        side_min = SIDE_MIN * px  # never less than this, so a hand turning a little still fits
        left = max(self.reach_left or 0.0, side_min) * SIDE_SAFETY + EDGE_GAP
        right = max(self.reach_right or 0.0, side_min) * SIDE_SAFETY + EDGE_GAP
        if left + right > 1 - MIN_ACTIVE:  # hand very close to the camera: share what is left
            f = (1 - MIN_ACTIVE) / (left + right)
            left, right = left * f, right * f
        top, bottom = REACH_UP * py + EDGE_GAP, REACH_DOWN * py + EDGE_GAP
        if top + bottom > 1 - MIN_ACTIVE:
            f = (1 - MIN_ACTIVE) / (top + bottom)
            top, bottom = top * f, bottom * f
        return left, 1 - right, top, 1 - bottom

    def to_screen(self, x: float, y: float):
        """Camera picture fractions -> TV fractions. Not clamped, so the filter sees the true movement."""
        l, r, t, b = self.bounds()
        return (x - l) / (r - l), (y - t) / (b - t)


def anchor_point(pts):
    """The pointer point: halfway between the index and middle knuckles."""
    return ((pts[INDEX_MCP][0] + pts[MIDDLE_MCP][0]) / 2, (pts[INDEX_MCP][1] + pts[MIDDLE_MCP][1]) / 2)


def in_picture(p) -> bool:
    return IN_PICTURE < p[0] < 1 - IN_PICTURE and IN_PICTURE < p[1] < 1 - IN_PICTURE


def palm_in_picture(pts) -> bool:
    """False when a knuckle is cut off by the picture edge (MediaPipe is only guessing the hand then).
    The wrist may leave the picture: the pointer follows the knuckles, and near the bottom of the
    picture (or when the hand tilts to pinch) the wrist is the first thing to go."""
    return all(in_picture(pts[i]) for i in KNUCKLES)


class PointerTracker:
    """Raw hand points in, steady TV pointer out.

    update() returns (pointer, state): pointer is (x, y) in TV fractions or None, state is
    'tracking' (following the hand), 'holding' (hand lost or not trusted, pointer kept still) or 'lost'."""

    def __init__(self):
        self.filter = OneEuroFilter2D()
        self.area = ActiveArea()
        self.pointer = None
        self.last_good = -math.inf
        self.last_t = None
        self.jumps = []           # recent far-away targets waiting to be confirmed
        self.last_target = None   # last accepted raw position (before smoothing)
        self.reason = ""          # why the last frame was not followed (for vision.pointer_check)
        self.state = "lost"

    def update(self, pts, frame_w: int, frame_h: int, now: float, freeze_area: bool = False):
        """pts: the 21 hand points as (x, y) picture fractions, or None when there is no hand.
        freeze_area: True while pinching or dragging, so the mapping cannot shift under the hand."""
        dt = 0.0 if self.last_t is None else max(0.0, now - self.last_t)
        self.last_t = now

        if pts is None or len(pts) != 21:
            self.reason = "no hand"
            return self._hold(now)
        if not all(math.isfinite(c) for p in pts for c in p):
            self.reason = "bad numbers"
            return self._hold(now)
        if not palm_in_picture(pts):
            self.reason = "knuckles cut off"
            return self._hold(now)
        self.reason = ""

        if not freeze_area and in_picture(pts[WRIST]):  # hand size needs the wrist
            self.area.learn(pts, frame_w, frame_h, dt)
        target = self.area.to_screen(*anchor_point(pts))

        if self.state == "lost" or self.last_target is None:
            # Starting again after the pointer was hidden: go straight to the hand.
            # (After a short hold the glitch check below still applies.)
            self.filter.reset()
            self.jumps.clear()
        else:
            limit = max(MIN_JUMP, MAX_SPEED * max(dt, 1 / 60))
            if screen_dist(target, self.last_target) > limit:
                # Faster than a hand moves: usually a tracking glitch. A real fast move continues
                # smoothly in the next frame; glitches jump about. Hold still until it is clear.
                j = self.jumps
                if len(j) == 1:
                    smooth = screen_dist(target, j[0]) <= limit
                elif len(j) >= 2:  # keeps going in the same direction at a similar speed
                    predicted = (2 * j[-1][0] - j[-2][0], 2 * j[-1][1] - j[-2][1])
                    smooth = screen_dist(target, predicted) <= limit / 2
                else:
                    smooth = False
                self.jumps = j + [target] if smooth else [target]
                if len(self.jumps) < JUMP_CONFIRM_FRAMES:
                    self.reason = "glitch ignored"
                    self.last_good = now
                    return self.pointer, "holding"  # this frame (and any pinch in it) is not trusted
                self.filter.reset()
        self.jumps.clear()
        self.last_target = target

        fx, fy = self.filter(target, now)
        self.pointer = (clamp01(fx), clamp01(fy))
        self.last_good = now
        self.state = "tracking"
        return self.pointer, self.state

    def _hold(self, now: float):
        self.jumps.clear()  # a fast-move path must come from frames right after each other
        if self.pointer is not None and now - self.last_good <= HOLD_S:
            self.state = "holding"
            return self.pointer, self.state
        self.pointer = None
        self.filter.reset()
        self.jumps.clear()
        self.last_target = None
        self.state = "lost"
        return None, self.state


class PointerAcceleration:
    """Like a computer mouse: slow hand movement moves the pointer less (precise placing), fast
    movement moves it fully (quick across the screen).

    Without this, the camera area that maps onto the whole TV is small, so a small slow hand
    movement became a big pointer jump ("slipping"). Because a slower pointer would drift away from
    where the hand is, the pointer is pulled back in line while the hand moves, in proportion to the
    movement: when the hand is still nothing moves, so the pointer never creeps on its own."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.hand = None     # previous hand position (TV fractions, before acceleration)
        self.out = None      # pointer shown
        self.last_t = None

    def update(self, pointer, at: float):
        if pointer is None:
            self.reset()
            return None
        if self.out is None:
            self.hand, self.out, self.last_t = pointer, pointer, at
            return pointer
        dt = max(at - self.last_t, 1e-3)
        self.last_t = at
        dx, dy = pointer[0] - self.hand[0], pointer[1] - self.hand[1]
        self.hand = pointer
        moved = math.hypot(dx, dy / ASPECT)               # TV widths this frame
        speed = moved / dt
        k = min(1.0, max(0.0, (speed - SPEED_SLOW) / (SPEED_FAST - SPEED_SLOW)))
        k = k * k * (3 - 2 * k)                           # smooth change between the two gains
        gain = GAIN_SLOW + (GAIN_FAST - GAIN_SLOW) * k
        x, y = self.out[0] + dx * gain, self.out[1] + dy * gain
        pull = min(1.0, CATCH_UP * moved)                 # back in line, only while moving
        x += (pointer[0] - x) * pull
        y += (pointer[1] - y) * pull
        # The hand has reached an edge of the TV area: follow it all the way, so corners are always reachable.
        snap = 1 - math.exp(-dt / EDGE_SNAP_S)
        if pointer[0] <= 0.002 or pointer[0] >= 0.998:
            x += (pointer[0] - x) * snap
        if pointer[1] <= 0.002 or pointer[1] >= 0.998:
            y += (pointer[1] - y) * snap
        self.out = (clamp01(x), clamp01(y))
        return self.out


class StillLock:
    """When the hand is (nearly) still, the pointer does not move at all.

    A held hand is never perfectly still: it trembles, and the camera adds noise. Smoothing alone
    leaves a slow drift, so the pointer "does not stop". Here, once the hand has been slower than
    STILL_SPEED for STILL_TIME_S, the pointer locks exactly in place, and only unlocks when the hand
    has clearly moved UNLOCK_DIST away. It then joins the hand smoothly, without a jump."""

    def __init__(self):
        self.reset()

    def reset(self):
        self.prev = None
        self.last_t = None
        self.slow_since = None
        self.locked = None        # locked position, or None
        self.offset = (0.0, 0.0)

    def update(self, pointer, at: float):
        if pointer is None:
            self.reset()
            return None
        dt = 0.0 if self.last_t is None else max(1e-3, at - self.last_t)
        speed = screen_dist(pointer, self.prev) / dt if self.prev is not None and dt > 0 else 0.0
        self.prev, self.last_t = pointer, at
        if self.locked is not None:
            if screen_dist(pointer, self.locked) <= UNLOCK_DIST:
                return self.locked
            # Clearly moving again: start from the locked spot and join the hand.
            self.offset = (self.locked[0] - pointer[0], self.locked[1] - pointer[1])
            self.locked, self.slow_since = None, None
        if speed < STILL_SPEED:
            if self.slow_since is None:
                self.slow_since = at
        else:
            self.slow_since = None
        k = math.exp(-dt / UNLOCK_GLIDE_S_STILL) if dt > 0 else 1.0
        self.offset = (self.offset[0] * k, self.offset[1] * k)
        out = (clamp01(pointer[0] + self.offset[0]), clamp01(pointer[1] + self.offset[1]))
        # Lock only once the pointer has caught up with the hand, so it never freezes beside it.
        caught_up = math.hypot(self.offset[0], self.offset[1] / ASPECT) < 0.002
        if self.slow_since is not None and at - self.slow_since >= STILL_TIME_S and caught_up:
            self.locked, self.offset = out, (0.0, 0.0)
        return out


class PinchLock:
    """Pinch = the dot is captured and stays exactly where it is. If a corner, side or the inside was
    under it, the dot rides on that as it is dragged (dot and projection move together), and both hold
    still whenever the hand pauses.

    What the logs of 10 Nov (17:03) showed: the dot moved 2-10% of the screen WHILE THE FINGERS WERE
    CLOSING, before the pinch was recognised (closing the index finger shifts the hand in the picture,
    and recognising the pinch took up to 0.3 s). The lock then captured that moved position. So:

    1. Fingers start closing (thumb-index gap drops below GUARD_RATIO): the dot is frozen at once, where
       it was with the fingers open. If no pinch follows within GUARD_MAX_S, it simply carries on.
    2. Pinch recognised: locked at that frozen spot for the whole pinch. New frames, noise, hand movement
       and unclear frames cannot change it. If a corner, side or the inside was under the dot, clear hand
       movement moves that (drag_point) and the dot goes with it; wobble and slow drift move nothing.
    3. Pinch ends: the dot stays put while the fingers finish opening (RELEASE_SETTLE_S), then carries on
       from where it is. It never slides or jumps by itself; the gap to the hand closes only as the hand
       moves."""

    def __init__(self):
        self.locked = False
        self.lock_point = None           # the captured dot position: shown unchanged for the whole pinch
        self.lock_t = 0.0
        self.drag_point = None           # separate position that moves what was grabbed (None = no pinch)
        self.base = None                 # hand position the drag is measured from
        self.drag_from = None            # drag_point at that moment
        self.moving = False              # the hand is clearly moving (else the projection holds still)
        self.track = deque()             # (time, hand) while grabbing, to notice when the hand stops
        self.rebase = False              # the drag was paused for unclear frames: restart from the current hand
        self.grabbed = False
        self.guard_point = None          # fingers closing: the dot waits here for the pinch
        self.guard_t = 0.0
        self.closing = False             # thumb and index are near each other
        self.was_open = False            # ...and were clearly apart on the frame before
        self.hold_point = None           # pinch just ended: the dot stays here while the fingers open
        self.hold_until = 0.0
        self.offset = (0.0, 0.0)         # gap between the dot and the hand after a pinch
        self.shown = None
        self.last_hand = None

    @property
    def frozen(self) -> bool:
        """The dot is being kept exactly where it is (closing, pinching, or just released)."""
        return self.locked or self.guard_point is not None or self.hold_point is not None

    def update(self, pointer, pinch, at: float, dragging: bool = False, moving_ok: bool = True, ratio=None):
        """pointer: the live (filtered) pointer from the hand, or None when the hand is gone.
        pinch: True / False, or None when the hand is unclear this frame (the state is kept).
        dragging: a corner, side or the inside is grabbed. moving_ok: the pinch is clearly seen this frame
        (only then does the grabbed handle move; otherwise it and the dot hold still together). ratio: thumb-tip to index-tip distance in palm
        lengths, or None when unknown. Returns the dot position to show."""
        if pointer is None:              # hand gone for longer than the hold time
            self.__init__()
            return None
        if pinch is None:
            pinch = self.locked
        if ratio is not None:
            self.closing = ratio < GUARD_RATIO

        if pinch and not self.locked:    # pinch recognised: capture the dot exactly as it is shown now
            self.locked, self.lock_t = True, at          # (while the fingers were closing it was already frozen)
            self.lock_point = self.shown or pointer
            self.drag_point = self.lock_point
            self.base, self.moving, self.grabbed = None, False, False
            self.guard_point = self.hold_point = None
        if self.locked and pinch:
            if dragging:
                self.grabbed = True
                if moving_ok:
                    self._drag(pointer, at)
                else:
                    self.rebase = True   # paused: when the pinch is clear again, continue from here (no jump)
            # Nothing grabbed: exactly the captured spot. Grabbed: on the projection (moves only on purpose).
            self.shown, self.last_hand = (self.drag_point if self.grabbed else self.lock_point), pointer
            return self.shown
        if self.locked:                  # pinch ended: the dot stays where it is (on the dropped corner)
            self.locked, self.drag_point = False, None
            self.hold_point, self.hold_until = self.shown, at + RELEASE_SETTLE_S
        if self.hold_point is not None:
            if at < self.hold_until:     # fingers still opening (that shifts the hand too): stay put
                self.shown, self.last_hand = self.hold_point, pointer
                return self.shown
            self._carry_on(self.hold_point, pointer)
            self.hold_point = None
        if self.guard_point is None:
            if self.closing and self.was_open and self.shown is not None:
                self.guard_point, self.guard_t = self.shown, at     # fingers start closing: freeze here
        elif not self.closing or at - self.guard_t > GUARD_MAX_S:    # no pinch came: carry on, no jump
            self._carry_on(self.guard_point, pointer)
            self.guard_point = None
        self.was_open = not self.closing
        if self.guard_point is not None:
            self.shown, self.last_hand = self.guard_point, pointer
            return self.shown

        # Following the hand. A gap left by a pinch closes only while the hand moves: each frame by up to
        # OFFSET_CLOSE of the hand's step, so the dot always moves the way the hand does and never by itself.
        if self.last_hand is not None and (self.offset[0] or self.offset[1]):
            step = math.hypot(pointer[0] - self.last_hand[0], (pointer[1] - self.last_hand[1]) / ASPECT)
            gap = math.hypot(self.offset[0], self.offset[1] / ASPECT)
            k = max(0.0, 1.0 - OFFSET_CLOSE * step / gap) if gap > 1e-9 else 0.0
            self.offset = (self.offset[0] * k, self.offset[1] * k)
            if math.hypot(*self.offset) < 1e-4:
                self.offset = (0.0, 0.0)
        self.last_hand = pointer
        self.shown = (clamp01(pointer[0] + self.offset[0]), clamp01(pointer[1] + self.offset[1]))
        # At a screen edge the gap gives way (like a mouse), so turning back moves the dot at once.
        if self.offset[0] or self.offset[1]:
            self.offset = (self.shown[0] - pointer[0], self.shown[1] - pointer[1])
        return self.shown

    def _carry_on(self, point, hand):
        """The dot continues from `point` although the hand is elsewhere."""
        self.offset = (point[0] - hand[0], point[1] - hand[1])
        self.last_hand = hand

    def _drag(self, hand, at: float):
        """Moves drag_point (what the editor uses to move the grabbed corner, side or shape) with the
        hand. The first DRAG_START of movement is ignored, so a held pinch does not shake the projection."""
        if at - self.lock_t < LOCK_SETTLE_S:   # fingers still settling: nothing moves
            return
        gap = lambda a, b: math.hypot(a[0] - b[0], (a[1] - b[1]) / ASPECT)
        if self.base is None:
            self.base, self.drag_from, self.moving = hand, self.drag_point, False
            self.track.clear()
        elif self.rebase:                # after a pause: carry on from where dot and handle are now
            self.base, self.drag_from, self.rebase = hand, self.drag_point, False
            self.track.clear()
        self.track.append((at, hand))
        while self.track and self.track[0][0] < at - 2 * DRAG_STOP_S:
            self.track.popleft()
        if not self.moving:
            if gap(hand, self.base) <= DRAG_START:
                return                                   # wobble or slow drift: nothing moves
            self.moving = True
        self.drag_point = (clamp01(self.drag_from[0] + hand[0] - self.base[0]),
                           clamp01(self.drag_from[1] + hand[1] - self.base[1]))
        older = [p for t, p in self.track if t <= at - DRAG_STOP_S]
        if older and gap(hand, older[-1]) < DRAG_STOP_DIST:   # the hand stopped: hold here
            self.moving, self.drag_from, self.base = False, self.drag_point, hand


# ---------------------------------------------------------------- editing the shape

def centroid(q):
    return (sum(p[0] for p in q) / 4, sum(p[1] for p in q) / 4)


def is_convex(q) -> bool:
    """True when the four corners make a proper (not folded or twisted) shape."""
    sign = 0
    for i in range(4):
        a, b, c = q[i], q[(i + 1) % 4], q[(i + 2) % 4]
        cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0])
        if abs(cross) < 1e-6:
            return False
        s = 1 if cross > 0 else -1
        if sign and s != sign:
            return False
        sign = s
    return True


def inside(q, p) -> bool:
    """Point-in-polygon test (ray casting)."""
    hit = False
    for i in range(4):
        (x1, y1), (x2, y2) = q[i], q[(i + 1) % 4]
        if (y1 > p[1]) != (y2 > p[1]) and p[0] < x1 + (p[1] - y1) * (x2 - x1) / (y2 - y1):
            hit = not hit
    return hit


def on_screen(q) -> bool:
    return all(0 <= x <= 1 and 0 <= y <= 1 for x, y in q)


def move_quad(corners, dx, dy):
    """Moves all four corners by dx, dy (0-1 units) without leaving the screen."""
    xs = [p[0] for p in corners]
    ys = [p[1] for p in corners]
    dx = min(max(dx, -min(xs)), 1 - max(xs))
    dy = min(max(dy, -min(ys)), 1 - max(ys))
    return [[x + dx, y + dy] for x, y in corners]


def target_name(target) -> str | None:
    """('corner', 2) -> 'corner:2', for the TV page."""
    if target is None:
        return None
    return target[0] if len(target) == 1 else f"{target[0]}:{target[1]}"


class BoundaryEditor:
    """Hover, grab, drag and release for the projection shape.

    Targets (checked in this order, so a corner or side is never mistaken for the whole shape):
    ('corner', i) moves only corner i; ('edge', i) moves only side i (0 top, 1 right, 2 bottom, 3 left,
    the side from corner i to corner i+1) straight towards or away from the opposite side, which stays
    where it is; ('body',) moves the whole shape. Pinching empty space does nothing.
    """

    def __init__(self):
        self.hover = None
        self.drag = None
        self.grab_pointer = None
        self.grab_quad = None
        self.history = deque(maxlen=PINCH_END_FRAMES + 2)
        self.pinch_frames = 0
        self.open_frames = 0

    # -- hit testing
    @staticmethod
    def _segment_dist(p, a, b) -> float:
        """Distance (TV widths) from point p to the side from a to b."""
        ax, ay, bx, by, px, py = a[0], a[1] / ASPECT, b[0], b[1] / ASPECT, p[0], p[1] / ASPECT
        dx, dy = bx - ax, by - ay
        L = dx * dx + dy * dy
        t = 0.0 if L < 1e-12 else max(0.0, min(1.0, ((px - ax) * dx + (py - ay) * dy) / L))
        return math.hypot(px - (ax + t * dx), py - (ay + t * dy))

    def _scores(self, q, p):
        """How close the pointer is to each corner and side, in units of its grab radius (< 1 = in reach)."""
        out = [(("corner", i), screen_dist(p, q[i]) / CORNER_RADIUS) for i in range(4)]
        out += [(("edge", i), self._segment_dist(p, q[i], q[(i + 1) % 4]) / EDGE_RADIUS) for i in range(4)]
        return out

    def _find_hover(self, q, p):
        scores = dict(self._scores(q, p))
        cur = self.hover

        def keep(kind):  # stay on the current handle a bit longer (no flicker), within one kind
            return cur is not None and cur[0] == kind and scores.get(cur, 9) < HOVER_KEEP

        # A corner in reach always wins, even over a side that is highlighted (approaching a corner
        # along a side used to keep the side selected, so the side was grabbed instead of the corner).
        if keep("corner"):
            return cur
        corners = [(sc, t) for t, sc in scores.items() if t[0] == "corner" and sc < 1]
        if corners:
            return min(corners)[1]
        if keep("edge"):
            return cur
        sides = [(sc, t) for t, sc in scores.items() if t[0] == "edge" and sc < 1]
        if sides:
            return min(sides)[1]
        return ("body",) if inside(q, p) else None

    # -- moving
    def _dragged(self, p):
        q0, (gx, gy) = self.grab_quad, self.grab_pointer
        dx, dy = p[0] - gx, p[1] - gy
        kind = self.drag[0]
        if kind == "body":
            return move_quad(q0, dx, dy)
        if kind == "corner":
            i = self.drag[1]
            q = [list(c) for c in q0]
            q[i] = [clamp01(q0[i][0] + dx), clamp01(q0[i][1] + dy)]
            return q if is_convex(q) else None
        # edge: move only this side, straight towards or away from the opposite side.
        i, j = self.drag[1], (self.drag[1] + 1) % 4
        a, b = q0[i], q0[j]
        ex, ey = b[0] - a[0], (b[1] - a[1]) / ASPECT          # side direction, TV-width units
        L = math.hypot(ex, ey)
        if L < 1e-6:
            return None
        nx, ny = -ey / L, ex / L                               # unit normal to the side
        s = dx * nx + (dy / ASPECT) * ny                       # hand movement across the side
        mx, my = s * nx, s * ny * ASPECT                       # back to TV fractions
        # Shorten the move if it would push either end of the side off the screen.
        f = 1.0
        for (px, py) in (a, b):
            for v, m in ((px, mx), (py, my)):
                if v + m > 1:
                    f = min(f, (1 - v) / m)
                elif v + m < 0:
                    f = min(f, -v / m)
        f = max(0.0, f)
        q = [list(c) for c in q0]
        q[i] = [a[0] + mx * f, a[1] + my * f]
        q[j] = [b[0] + mx * f, b[1] + my * f]
        return q if is_convex(q) else None

    def update(self, pointer, raw_pinch, corners, now: float):
        """One frame. pointer: (x, y) TV fractions or None. raw_pinch: True / False, or None when the hand
        is not clearly visible this frame (then nothing is grabbed or released).
        corners: the current shape. Returns (new_corners or None, released: bool)."""
        q = [list(c) for c in corners]
        if raw_pinch is not None:
            self.pinch_frames = self.pinch_frames + 1 if raw_pinch else 0
            self.open_frames = 0 if raw_pinch else self.open_frames + 1

        if self.drag is None:
            self.hover = None if pointer is None else self._find_hover(q, pointer)
            if pointer is not None and raw_pinch and self.pinch_frames == PINCH_START_FRAMES and self.hover is not None:
                self.drag, self.grab_pointer, self.grab_quad = self.hover, pointer, q
                self.history.clear()
                self.history.append(q)
            return None, False

        # Dragging
        if pointer is None:  # hand lost for longer than the hold time: let go where it is
            return self._release(use_history=False)
        if raw_pinch is None:  # hand briefly unclear: keep holding the handle, do not move it
            return None, False
        if not raw_pinch:
            # Fingers opening: hold still, and let go once it is certain.
            if self.open_frames >= PINCH_END_FRAMES:
                return self._release(use_history=True)
            return None, False
        new = self._dragged(pointer)
        if new is None:
            return None, False
        self.history.append(new)
        return new, False

    def _release(self, use_history: bool):
        # Opening the fingers moves them a little in the last frame or two before the release is
        # recognised, so drop the shape where it was just before that.
        final = self.history[-2] if use_history and len(self.history) >= 3 else self.history[-1]
        self.drag = None
        self.hover = None
        self.history.clear()
        return final, True
