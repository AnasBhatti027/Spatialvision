"""Module 4: hand tracking and gesture recognition (MediaPipe Tasks).

Run from the backend folder with the venv active:
    python -m vision.hands

Shows the mirrored camera picture with the 21 hand points, the recognised gesture
and where the index finger points (as 0-1 screen coordinates). Press Q to stop.

Needs the model file vision/models/hand_landmarker.task (see README).
"""
import math
import time
from collections import Counter, deque
from pathlib import Path

import cv2
import mediapipe as mp
from mediapipe.tasks import python as mp_tasks
from mediapipe.tasks.python import vision as mp_vision

from vision.camera import DEFAULT_EXPOSURE, open_camera, set_exposure

MODEL = Path(__file__).parent / "models" / "hand_landmarker.task"

# MediaPipe hand point numbers
WRIST, THUMB_IP, THUMB_TIP = 0, 3, 4
INDEX_MCP, INDEX_PIP, INDEX_TIP = 5, 6, 8
MIDDLE_MCP, MIDDLE_PIP, MIDDLE_TIP = 9, 10, 12
RING_PIP, RING_TIP = 14, 16
PINKY_MCP, PINKY_PIP, PINKY_TIP = 17, 18, 20

# Lines between the 21 points, for drawing the hand skeleton.
CONNECTIONS = [(0, 1), (1, 2), (2, 3), (3, 4), (0, 5), (5, 6), (6, 7), (7, 8), (5, 9), (9, 10), (10, 11), (11, 12),
               (9, 13), (13, 14), (14, 15), (15, 16), (13, 17), (17, 18), (18, 19), (19, 20), (0, 17)]

PINCH_RATIO = 0.30      # thumb tip to index tip, relative to palm size
HOLD_FRAMES = 3         # a gesture must be seen this many frames in a row before it counts (3 at 30 fps = 100 ms)
SWIPE_WINDOW_S = 0.40   # a swipe must happen within this time
SWIPE_DISTANCE = 0.30   # ...and move this far across the picture (fraction of its width)
SWIPE_COOLDOWN_S = 0.8


def dist(a, b) -> float:
    return math.hypot(a.x - b.x, a.y - b.y)


def classify(lm) -> str:
    """Names the hand shape from the 21 points. Uses distances only, so it works at any hand angle."""
    palm = dist(lm[WRIST], lm[MIDDLE_MCP]) or 1e-6
    # Pinch: thumb and index tips touch while the index finger still reaches forward
    # (in a fist the thumb also rests near the index tip, but the index is curled back).
    index_forward = dist(lm[WRIST], lm[INDEX_TIP]) > dist(lm[WRIST], lm[INDEX_PIP])
    if index_forward and dist(lm[THUMB_TIP], lm[INDEX_TIP]) / palm < PINCH_RATIO:
        return "pinch"
    # A finger is extended when its tip is further from the wrist than its middle joint.
    fingers = [dist(lm[WRIST], lm[tip]) > dist(lm[WRIST], lm[pip]) * 1.15
               for tip, pip in ((INDEX_TIP, INDEX_PIP), (MIDDLE_TIP, MIDDLE_PIP), (RING_TIP, RING_PIP), (PINKY_TIP, PINKY_PIP))]
    thumb = dist(lm[THUMB_TIP], lm[PINKY_MCP]) > dist(lm[THUMB_IP], lm[PINKY_MCP]) * 1.1
    if all(fingers) and thumb:
        return "open_palm"
    if fingers[0] and not any(fingers[1:]):
        return "point"
    if not any(fingers):
        return "fist"
    return "other"


class GestureTracker:
    """Smooths gestures (no flicker) and detects left/right swipes from index-tip movement."""

    def __init__(self):
        self.recent = deque(maxlen=HOLD_FRAMES)
        self.stable = "none"
        self.trail = deque()          # (time, x) of the index tip
        self.last_swipe = -math.inf
        self.counts = Counter()       # how often each gesture started, for analytics

    def update(self, raw: str, tip_x: float | None, now: float) -> str | None:
        """Feeds one frame. Returns an event name when something new happens, else None.
        A swipe only counts with an open hand, so pointing or pinching never triggers one."""
        event = None
        self.recent.append(raw)
        if len(self.recent) == HOLD_FRAMES and len(set(self.recent)) == 1 and raw != self.stable:
            self.stable = raw
            if raw not in ("none", "other"):
                self.counts[raw] += 1
                event = raw

        if tip_x is None or raw != "open_palm":
            self.trail.clear()
        else:
            self.trail.append((now, tip_x))
            while self.trail and now - self.trail[0][0] > SWIPE_WINDOW_S:
                self.trail.popleft()
            dx = tip_x - self.trail[0][1]
            if abs(dx) > SWIPE_DISTANCE and now - self.last_swipe > SWIPE_COOLDOWN_S:
                event = "swipe_right" if dx > 0 else "swipe_left"
                self.counts[event] += 1
                self.last_swipe = now
                self.trail.clear()
        return event


def create_landmarker():
    if not MODEL.exists():
        raise SystemExit(f"Model file missing: {MODEL}\nDownload it first (see the instructions in the README).")
    options = mp_vision.HandLandmarkerOptions(
        base_options=mp_tasks.BaseOptions(model_asset_path=str(MODEL)),
        running_mode=mp_vision.RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.5,
        min_hand_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return mp_vision.HandLandmarker.create_from_options(options)


def draw_hand(frame, lm, color=(245, 217, 69)):
    h, w = frame.shape[:2]
    pts = [(int(p.x * w), int(p.y * h)) for p in lm]
    for a, b in CONNECTIONS:
        cv2.line(frame, pts[a], pts[b], (255, 255, 255), 2, cv2.LINE_AA)
    for i, p in enumerate(pts):
        cv2.circle(frame, p, 6 if i in (THUMB_TIP, INDEX_TIP) else 4, color, -1, cv2.LINE_AA)


def main():
    cap = open_camera(0)
    if cap is None:
        raise SystemExit("Could not open camera 0. Run: python -m vision.camera --list")
    set_exposure(cap, DEFAULT_EXPOSURE)
    landmarker = create_landmarker()
    tracker = GestureTracker()

    window = "SpatialVision hands - press Q to stop"
    start = time.perf_counter()
    frames, hand_frames, detect_ms_total = 0, 0, 0.0
    shown_fps, fps_frames, fps_start = 0.0, 0, start
    last_event, last_event_t = "", 0.0

    while True:
        ok, frame = cap.read()
        if not ok:
            print("The camera stopped giving pictures.")
            break
        frame = cv2.flip(frame, 1)  # mirror, so moving your right hand moves right on screen
        now = time.perf_counter()

        rgb = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
        t0 = time.perf_counter()
        result = landmarker.detect_for_video(mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb), int((now - start) * 1000))
        detect_ms_total += (time.perf_counter() - t0) * 1000
        frames += 1

        raw, tip = "none", None
        if result.hand_landmarks:
            lm = result.hand_landmarks[0]
            hand_frames += 1
            raw = classify(lm)
            tip = (min(1.0, max(0.0, lm[INDEX_TIP].x)), min(1.0, max(0.0, lm[INDEX_TIP].y)))
            draw_hand(frame, lm)
        event = tracker.update(raw, tip[0] if tip else None, now)
        if event:
            last_event, last_event_t = event, now
            print(f"{now - start:6.1f} s  {event}")

        fps_frames += 1
        if now - fps_start >= 1.0:
            shown_fps, fps_frames, fps_start = fps_frames / (now - fps_start), 0, now

        lines = [f"{shown_fps:.1f} fps   gesture: {tracker.stable}",
                 f"pointer: {tip[0]:.2f}, {tip[1]:.2f}" if tip else "pointer: no hand"]
        if now - last_event_t < 1.0:
            lines.append(f"EVENT: {last_event}")
        for i, text in enumerate(lines):
            cv2.putText(frame, text, (16, 36 + i * 34), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (245, 217, 69), 2, cv2.LINE_AA)
        cv2.imshow(window, frame)
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27) or cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
            break

    elapsed = time.perf_counter() - start
    cap.release()
    cv2.destroyAllWindows()
    landmarker.close()
    if frames:
        print(f"\nMeasured over {elapsed:.0f} s: {frames / elapsed:.1f} fps, "
              f"hand detection {detect_ms_total / frames:.1f} ms per frame, hand visible in {100 * hand_frames / frames:.0f}% of frames")
        print("Gestures counted:", dict(tracker.counts) or "none")


if __name__ == "__main__":
    main()
