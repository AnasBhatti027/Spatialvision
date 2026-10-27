"""Runs hand tracking in the background inside the backend, and turns gestures into actions.

- The index fingertip becomes a pointer dot on the TV.
- Pinch and move drags the whole projected shape.
- Swipe right / left switches the content (test pattern, image, blank).
Every gesture is also sent to the phones, together with the measured frame rate.
"""
import asyncio
import math
import threading
import time

import cv2
import mediapipe as mp

from vision.camera import DEFAULT_EXPOSURE, open_camera, set_exposure
from vision.hands import INDEX_TIP, GestureTracker, classify, create_landmarker

CONTENT_ORDER = ["pattern", "image", "blank"]
SMOOTHING = 0.5  # 0 = no smoothing, closer to 1 = smoother but slower pointer


def move_quad(corners, dx, dy):
    """Moves all four corners by dx, dy (0-1 units) without leaving the screen."""
    xs = [p[0] for p in corners]
    ys = [p[1] for p in corners]
    dx = min(max(dx, -min(xs)), 1 - max(xs))
    dy = min(max(dy, -min(ys)), 1 - max(ys))
    return [[x + dx, y + dy] for x, y in corners]


def next_content(current: str, has_image: bool, step: int) -> str:
    options = [c for c in CONTENT_ORDER if c != "image" or has_image]
    i = options.index(current) if current in options else 0
    return options[(i + step) % len(options)]


class GestureService:
    def __init__(self, hub):
        self.hub = hub
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.stop_flag = threading.Event()
        self.status = {"type": "vision_status", "running": False, "fps": None, "detect_ms": None, "error": None}

    @property
    def running(self) -> bool:
        return self.thread is not None and self.thread.is_alive()

    def start(self, loop: asyncio.AbstractEventLoop):
        if self.running:
            self._publish_status()
            return
        self.loop = loop
        self.stop_flag.clear()
        self.thread = threading.Thread(target=self._run, name="gestures", daemon=True)
        self.thread.start()

    def stop(self):
        self.stop_flag.set()

    # ---------- talking to the async hub from this thread ----------
    def _call(self, coro):
        if self.loop:
            asyncio.run_coroutine_threadsafe(coro, self.loop)

    def _publish_status(self, **changes):
        self.status.update(changes)
        self._call(self.hub.to_phones(dict(self.status)))

    def _change_scene(self, **changes):
        self._call(self.hub.update_scene(changes))

    # ---------- the camera loop ----------
    def _run(self):
        cap = open_camera(0)
        if cap is None:
            self._publish_status(running=False, error="Could not open the camera. Close other apps using it (or the hands test window).")
            return
        try:
            landmarker = create_landmarker()
        except SystemExit as e:  # model file missing
            cap.release()
            self._publish_status(running=False, error=str(e))
            return
        set_exposure(cap, DEFAULT_EXPOSURE)
        self._publish_status(running=True, error=None, fps=None, detect_ms=None)

        tracker = GestureTracker()
        start = time.perf_counter()
        pointer = None                 # smoothed (x, y) of the index tip
        drag_from = None               # (pointer, corners) when a pinch started
        win_start, win_frames, win_ms = start, 0, 0.0
        try:
            while not self.stop_flag.is_set():
                ok, frame = cap.read()
                if not ok:
                    self._publish_status(error="The camera stopped giving pictures.")
                    break
                frame = cv2.flip(frame, 1)
                now = time.perf_counter()
                t0 = time.perf_counter()
                result = landmarker.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)),
                    int((now - start) * 1000))
                win_ms += (time.perf_counter() - t0) * 1000
                win_frames += 1

                raw, tip = "none", None
                if result.hand_landmarks:
                    lm = result.hand_landmarks[0]
                    raw = classify(lm)
                    tip = (min(1.0, max(0.0, lm[INDEX_TIP].x)), min(1.0, max(0.0, lm[INDEX_TIP].y)))
                    pointer = tip if pointer is None else (
                        pointer[0] * SMOOTHING + tip[0] * (1 - SMOOTHING),
                        pointer[1] * SMOOTHING + tip[1] * (1 - SMOOTHING))
                else:
                    pointer = None

                event = tracker.update(raw, tip[0] if tip else None, now)
                gesture = tracker.stable
                self._call(self.hub.to_tv({"type": "pointer", "visible": pointer is not None,
                                           "x": pointer[0] if pointer else 0, "y": pointer[1] if pointer else 0,
                                           "gesture": gesture}))

                # Pinch and move: drag the whole shape. Starts once the pinch is steady,
                # and stops the moment the fingers open (raw), so the shape does not drift afterwards.
                if raw == "pinch" and (gesture == "pinch" or drag_from is not None) and pointer is not None:
                    if drag_from is None:
                        drag_from = (pointer, self.hub.scene["corners"])
                    else:
                        (px, py), corners = drag_from
                        self._change_scene(corners=move_quad(corners, pointer[0] - px, pointer[1] - py))
                else:
                    drag_from = None

                if event:
                    message = {"type": "gesture", "name": event, "t": round(now - start, 2)}
                    self._call(self.hub.to_phones(message))
                    self._call(self.hub.to_tv(message))
                    if event in ("swipe_right", "swipe_left"):
                        scene = self.hub.scene
                        self._change_scene(content=next_content(scene["content"], bool(scene.get("image_url")),
                                                                1 if event == "swipe_right" else -1))

                if now - win_start >= 1.0:  # report the real speed once per second
                    self._publish_status(fps=round(win_frames / (now - win_start), 1), detect_ms=round(win_ms / win_frames, 1))
                    win_start, win_frames, win_ms = now, 0, 0.0
        finally:
            cap.release()
            landmarker.close()
            self._call(self.hub.to_tv({"type": "pointer", "visible": False, "x": 0, "y": 0, "gesture": "none"}))
            self._publish_status(running=False, fps=None, detect_ms=None)
