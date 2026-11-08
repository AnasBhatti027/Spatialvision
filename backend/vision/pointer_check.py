"""Measures how steady the hand pointer really is in each part of the screen (centre, edges, corners).

Run from the backend folder with the venv active, with gesture control STOPPED on the phone
(only one program can use the camera):
    python -m vision.pointer_check

The window shows the camera picture with:
  - the cyan box: the camera area that maps onto the whole TV (sized from your hand),
  - the dot on your knuckles: what the pointer follows,
  - the small TV picture top-right: where the pointer is, coloured by state
    (cyan = tracking, orange = holding because the hand is unclear, none = lost).
Move your hand slowly through the centre, all four edges and all four corners, holding still
for a few seconds in each, and PINCH for a second in each corner. Press Q to stop.
Two tables of measured numbers per screen area are printed.
"""
import statistics
import time
from collections import defaultdict

import cv2
import mediapipe as mp

from vision.camera import DEFAULT_EXPOSURE, LatestFrameReader, open_camera, set_exposure
from vision.hands import classify, create_landmarker
from vision.interaction import PointerTracker, anchor_point, screen_dist

TV_PX = 1920  # pointer steps are reported in pixels of a 1920-wide TV, easier to picture than fractions
AREAS = [["top-left", "top", "top-right"], ["left", "centre", "right"], ["bottom-left", "bottom", "bottom-right"]]


def area_name(p):
    col = 0 if p[0] < 0.2 else 2 if p[0] > 0.8 else 1
    row = 0 if p[1] < 0.2 else 2 if p[1] > 0.8 else 1
    return AREAS[row][col]


def main(show: bool = True, max_frames: int | None = None, cap=None, landmarker=None):
    cap = cap or open_camera(0)
    if cap is None:
        raise SystemExit("Could not open the camera. Stop gesture control on the phone first, and close other camera apps.")
    set_exposure(cap, DEFAULT_EXPOSURE)
    reader = LatestFrameReader(cap)
    landmarker = landmarker or create_landmarker()
    tracker = PointerTracker()

    # per screen area: frames, how many were tracking / holding, and pointer steps while the hand is still
    stats = defaultdict(lambda: {"frames": 0, "tracking": 0, "holding": 0, "still_steps": [], "pinch": 0,
                                 "reasons": defaultdict(int)})
    lost_frames, frames, detect_ms = 0, 0, []
    start = time.perf_counter()
    last_ts, prev = -1, None
    window = "SpatialVision pointer check - press Q to stop"
    try:
        while max_frames is None or frames < max_frames:
            ok, frame, at = reader.read()
            if not ok:
                print("The camera stopped giving pictures.")
                break
            frame = cv2.flip(frame, 1)
            h, w = frame.shape[:2]
            ts = max(last_ts + 1, int((at - start) * 1000))
            last_ts = ts
            t0 = time.perf_counter()
            result = landmarker.detect_for_video(
                mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), ts)
            detect_ms.append((time.perf_counter() - t0) * 1000)
            frames += 1

            pts = [(p.x, p.y) for p in result.hand_landmarks[0]] if result.hand_landmarks else None
            last_pointer = tracker.pointer
            pointer, state = tracker.update(pts, w, h, at)
            pinched = bool(result.hand_landmarks) and classify(result.hand_landmarks[0]) == "pinch"
            if pointer is None:
                lost_frames += 1
                if last_pointer is not None:  # where it disappeared, and why
                    stats[area_name(last_pointer)]["reasons"]["disappeared (" + (tracker.reason or "?") + ")"] += 1
            else:
                s = stats[area_name(pointer)]
                s["frames"] += 1
                s[state] += 1
                s["pinch"] += pinched
                if state == "holding":
                    s["reasons"][tracker.reason or "?"] += 1
                # "Still": the hand moved less than 2% of the TV width in the last frame.
                if prev is not None and state == "tracking":
                    step = screen_dist(pointer, prev)
                    if step < 0.02:
                        s["still_steps"].append(step * TV_PX)
            prev = pointer if state == "tracking" else None

            if show:
                l, r, t, b = tracker.area.bounds()
                cv2.rectangle(frame, (int(l * w), int(t * h)), (int(r * w), int(b * h)), (245, 217, 69), 2)
                if pts:
                    ax, ay = anchor_point(pts)
                    cv2.circle(frame, (int(ax * w), int(ay * h)), 8, (255, 255, 255), -1)
                tw, th = 320, 180  # small TV picture
                cv2.rectangle(frame, (w - tw - 16, 16), (w - 16, 16 + th), (80, 80, 80), -1)
                if pointer:
                    colour = (245, 217, 69) if state == "tracking" else (0, 165, 255)
                    cv2.circle(frame, (int(w - tw - 16 + pointer[0] * tw), int(16 + pointer[1] * th)), 8, colour, -1)
                fps = frames / max(at - start, 1e-6)
                cv2.putText(frame, f"{fps:.1f} fps  detect {statistics.mean(detect_ms[-30:]):.0f} ms  {state}",
                            (16, 36), cv2.FONT_HERSHEY_SIMPLEX, 0.9, (245, 217, 69), 2, cv2.LINE_AA)
                cv2.imshow(window, frame)
                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27) or cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
                    break
    finally:
        elapsed = time.perf_counter() - start
        dropped = reader.dropped
        reader.release()
        landmarker.close()
        if show:
            cv2.destroyAllWindows()

    if not frames:
        return stats
    print(f"\nMeasured over {elapsed:.0f} s: {frames / elapsed:.1f} fps processed, hand detection "
          f"{statistics.mean(detect_ms):.1f} ms per frame, {dropped} old camera pictures skipped (not queued), "
          f"no hand {100 * lost_frames / frames:.0f}% of frames")
    print(f"\n{'screen area':14}{'frames':>8}{'tracking':>10}{'holding':>9}{'shake when still':>19}")
    for row in AREAS:
        for name in row:
            s = stats.get(name)
            if not s or not s["frames"]:
                print(f"{name:14}{'not visited':>8}")
                continue
            shake = f"{statistics.median(s['still_steps']):.1f} px" if len(s["still_steps"]) >= 10 else "too few"
            print(f"{name:14}{s['frames']:8}{100 * s['tracking'] / s['frames']:9.0f}%{100 * s['holding'] / s['frames']:8.0f}%{shake:>19}")
    print("\nshake when still = median pointer movement per frame while the hand is (nearly) still,"
          f" in pixels of a {TV_PX}-wide TV.")
    print(f"\n{'screen area':14}{'pinch seen':>11}   why the pointer held still or disappeared")
    for row in AREAS:
        for name in row:
            s = stats.get(name)
            if not s:
                continue
            pinch = f"{100 * s['pinch'] / s['frames']:.0f}%" if s["frames"] else "-"
            why = ", ".join(f"{k} x{v}" for k, v in sorted(s["reasons"].items(), key=lambda kv: -kv[1])) or "-"
            print(f"{name:14}{pinch:>11}   {why}")
    return stats


if __name__ == "__main__":
    main()
