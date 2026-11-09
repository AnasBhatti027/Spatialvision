"""Turns hand points into actions on the TV.

Where the hand points come from (the "source"):
- "phone" (default): the SpatialVision app runs MediaPipe on the PHONE's own camera and sends the
  21 hand points over the WebSocket (message type "hand"). The laptop webcam is never opened.
- "webcam": only when the app asks for it explicitly; the backend reads the PC webcam itself.
Both sources feed the same GestureEngine, so pointer smoothing and corner editing are identical.

What the hand does:
- The knuckles move a steady pointer dot on the TV (see vision/interaction.py).
- Pinch on a corner moves that corner, pinch on the middle of a side resizes the shape,
  pinch inside the shape moves all of it. Releasing the pinch drops it there.
- Swipe right / left switches the content (test pattern, image, blank).
Every gesture is also sent to the phones, together with the measured frame rate.
"""
import asyncio
import math
import statistics
import threading
import time
from collections import Counter, deque, namedtuple

from vision.hands import INDEX_TIP, GestureTracker, classify
from vision.interaction import PHONE_UPDATE_S, BoundaryEditor, PinchLock, PointerTracker, target_name

CONTENT_ORDER = ["pattern", "image", "blank"]
PHONE_GAP_S = 0.35        # no hand message from the phone for this long: treat as "no hand" (short Wi-Fi pauses are normal)
CLOCK_WINDOW_S = 5.0      # phone-to-PC clock offset: the quickest delivery seen in this window
PHONE_SILENT_S = 3.0      # ...for this long: tell the phone user the camera stopped sending
Point = namedtuple("Point", "x y")


def next_content(current: str, has_image: bool, step: int) -> str:
    options = [c for c in CONTENT_ORDER if c != "image" or has_image]
    i = options.index(current) if current in options else 0
    return options[(i + step) % len(options)]


def held_report(engine) -> dict:
    """Share of frames in the last second where the pointer was held still (hand unclear), and the
    main reason. Resets the counts. Shown in the app so problem areas can be measured, not guessed."""
    if engine is None:
        return {"held_pct": None, "held_why": None}
    total = sum(engine.frames.values())
    held = engine.frames["holding"]
    why = engine.reasons.most_common(1)[0][0] if engine.reasons else None
    engine.frames.clear()
    engine.reasons.clear()
    return {"held_pct": round(100 * held / total) if total else None, "held_why": why}


def phone_points(msg: dict):
    """Checks a "hand" message from the phone and returns (points, width, height).
    points is None when there is no (valid) hand. The phone may ask to mirror (front camera,
    so moving right moves right) and to turn the picture (rot = 0, 90, 180 or 270 degrees)."""
    try:
        w, h = int(msg.get("w") or 0), int(msg.get("h") or 0)
    except (TypeError, ValueError):
        w = h = 0
    if w <= 0 or h <= 0:
        w, h = 1280, 720
    flat = msg.get("pts")
    if not isinstance(flat, list) or len(flat) != 42:
        return None, w, h
    try:
        xy = [(float(flat[2 * i]), float(flat[2 * i + 1])) for i in range(21)]
    except (TypeError, ValueError):
        return None, w, h
    if not all(math.isfinite(c) for p in xy for c in p):
        return None, w, h
    if max(abs(c) for p in xy for c in p) > 3:  # pixels instead of 0-1 fractions: convert
        xy = [(x / w, y / h) for x, y in xy]
    rot = int(msg.get("rot") or 0) % 360
    if rot == 90:
        xy, (w, h) = [(1 - y, x) for x, y in xy], (h, w)
    elif rot == 180:
        xy = [(1 - x, 1 - y) for x, y in xy]
    elif rot == 270:
        xy, (w, h) = [(y, 1 - x) for x, y in xy], (h, w)
    if msg.get("mirror"):
        xy = [(1 - x, y) for x, y in xy]
    return xy, w, h


class GestureEngine:
    """One frame of hand points in -> pointer, gestures and shape edits out. Used by both sources."""

    def __init__(self, service):
        self.service = service
        self.tracker = GestureTracker()
        self.pointer_tracker = PointerTracker()
        self.editor = BoundaryEditor()
        self.lock = PinchLock()
        self.frames = Counter()   # frames per state since the last status report (tracking / holding / lost)
        self.reasons = Counter()  # ...and why the pointer was held
        self.pinching = False           # pinch state with hysteresis (see classify)
        self.last_phone_update = 0.0
        self.start = time.perf_counter()

    def process(self, pts, frame_w: int, frame_h: int, at: float):
        """pts: 21 (x, y) picture fractions, already mirrored for a natural feel, or None.
        at: perf_counter time the picture was taken (webcam) or arrived (phone)."""
        svc, hub = self.service, self.service.hub
        raw = "none"
        if pts is not None:
            raw = classify([Point(x, y) for x, y in pts], was_pinching=self.pinching)
        pointer, state = self.pointer_tracker.update(pts, frame_w, frame_h, at,
                                                     freeze_area=self.pinching or self.editor.drag is not None)
        self.frames[state] += 1
        if state == "holding":
            self.reasons[self.pointer_tracker.reason or "?"] += 1
        # The pinch only counts while the hand is clearly seen; otherwise it is "unknown",
        # so a short tracking gap never drops or grabs a corner by accident.
        if state == "tracking":
            self.pinching = raw == "pinch"
            pinch = self.pinching
        else:
            pinch = None

        pointer = self.lock.update(pointer, pinch, at)  # keep the pointer where the pinch started

        event = self.tracker.update(raw, pts[INDEX_TIP][0] if pts else None, at)
        gesture = self.tracker.stable

        # Editing the shape: hover, grab, drag, release.
        corners, released = self.editor.update(pointer, pinch, hub.scene["corners"], at)
        if corners is not None:
            # The TV follows every frame. When the phone is the camera, it gets the new shape only
            # once, when the corner is dropped: redrawing its screen during the drag would slow down
            # the hand points it is sending (that was the lag while pinching). Otherwise a few updates.
            if svc.source == "phone":
                to_phone = released
            else:
                to_phone = released or at - self.last_phone_update >= PHONE_UPDATE_S
            if to_phone:
                self.last_phone_update = at
            svc._change_scene(phones=to_phone, corners=corners)

        svc._send_pointer({"type": "pointer", "visible": pointer is not None, "held": state == "holding",
                           "t": at, "x": pointer[0] if pointer else 0, "y": pointer[1] if pointer else 0,
                           "gesture": "pinch" if self.pinching else gesture,
                           "hover": target_name(self.editor.hover), "drag": target_name(self.editor.drag)})

        if event:
            message = {"type": "gesture", "name": event, "t": round(at - self.start, 2)}
            svc._call(hub.to_phones(message))
            svc._call(hub.to_tv(message))
            if event in ("swipe_right", "swipe_left"):
                scene = hub.scene
                svc._change_scene(content=next_content(scene["content"], bool(scene.get("image_url")),
                                                       1 if event == "swipe_right" else -1))


class GestureService:
    def __init__(self, hub):
        self.hub = hub
        self.loop: asyncio.AbstractEventLoop | None = None
        self.thread: threading.Thread | None = None
        self.stop_flag = threading.Event()
        self.status = {"type": "vision_status", "running": False, "source": None, "fps": None, "detect_ms": None,
                       "latency_ms": None, "error": None}
        self.source: str | None = None      # "phone" or "webcam" while running
        self.engine: GestureEngine | None = None
        self.phone_task: asyncio.Task | None = None
        self.phone_last_at = 0.0             # when the last hand message from the phone arrived
        self.phone_count = 0                 # messages since the last status report
        self.clock = deque()                 # (arrival time, arrival - phone time) for the clock offset
        self.last_frame_at = 0.0             # phone frame time (in PC clock) of the last message
        self.last_phone_t = None             # phone's own time of the last message (seconds)
        self.gap_phone = 0.0                 # longest pause between frames on the phone (this second)
        self.gap_net = 0.0                   # longest pause between arrivals at the PC (this second)
        self.phone_detect_ms: float | None = None
        # Delay from reading a camera frame to the TV page drawing the pointer and answering (milliseconds).
        self.latencies: deque[float] = deque(maxlen=60)
        # Pointer messages: only the newest one is ever waiting to be sent, so a slow TV connection
        # cannot build up a queue of old positions (that would look like lag).
        self._pointer_lock = threading.Lock()
        self._pointer_msg: dict | None = None
        self._pointer_busy = False

    def record_ack(self, t: float):
        """The TV page echoes back the time a frame was read, after it has drawn the pointer."""
        self.latencies.append((time.perf_counter() - t) * 1000)

    @property
    def running(self) -> bool:
        if self.source == "phone":
            return self.phone_task is not None and not self.phone_task.done()
        return self.thread is not None and self.thread.is_alive()

    def start(self, loop: asyncio.AbstractEventLoop, source: str = "phone"):
        """Starts gesture control. source "phone" (default) waits for hand points from the app;
        "webcam" opens the PC camera. There is no automatic fallback from one to the other."""
        if self.running:
            if self.source == source:
                self._publish_status()
                return
            self.stop()
            self.phone_task = None  # an old phone task must not switch the new source off when it ends
            if self.thread is not None:
                self.thread.join(timeout=2.0)
        self.loop = loop
        self.source = source
        self.engine = GestureEngine(self)
        self.latencies.clear()
        if source == "webcam":
            self.stop_flag.clear()
            self.thread = threading.Thread(target=self._run, name="gestures", daemon=True)
            self.thread.start()
        else:
            self.phone_last_at = time.perf_counter()
            self.phone_count = 0
            self.clock.clear()
            self.last_frame_at, self.last_phone_t = 0.0, None
            self.gap_phone = self.gap_net = 0.0
            self.phone_detect_ms = None
            self.phone_task = loop.create_task(self._phone_watchdog())
            self._publish_status(running=True, source="phone", error=None, fps=None, detect_ms=None, latency_ms=None)

    def stop(self):
        self.stop_flag.set()
        if self.phone_task is not None and not self.phone_task.done():
            self.phone_task.cancel()

    # ---------- phone camera source ----------
    def on_phone_hand(self, msg: dict):
        """A "hand" message from the app: the hand points the phone's camera saw in one frame.

        Wi-Fi often delivers messages in small bursts. Timing them by arrival would make a burst look
        like a sudden fast movement (and a pause like a stop), so the phone stamps each frame with its
        own clock ("t", milliseconds) and the backend converts that to PC time. The offset between the
        clocks is taken from the quickest delivery seen recently."""
        if self.source != "phone" or not self.running or self.engine is None:
            return
        arrival = time.perf_counter()
        self.gap_net = max(self.gap_net, arrival - self.phone_last_at) if self.phone_count else self.gap_net
        self.phone_last_at = arrival
        self.phone_count += 1
        if isinstance(msg.get("detect_ms"), (int, float)):
            self.phone_detect_ms = round(float(msg["detect_ms"]), 1)

        at = arrival
        t = msg.get("t")
        if isinstance(t, (int, float)) and math.isfinite(t):
            phone_t = float(t) / 1000.0
            if self.last_phone_t is not None:
                if phone_t < self.last_phone_t - 1.0:  # phone clock jumped back (app restarted): start again
                    self.clock.clear()
                else:
                    self.gap_phone = max(self.gap_phone, phone_t - self.last_phone_t)
            self.last_phone_t = phone_t
            self.clock.append((arrival, arrival - phone_t))
            while self.clock and arrival - self.clock[0][0] > CLOCK_WINDOW_S:
                self.clock.popleft()
            offset = min(d for _, d in self.clock)
            at = min(arrival, phone_t + offset)
            at = max(at, self.last_frame_at + 1e-4)  # keep time moving forward
        self.last_frame_at = at

        pts, w, h = phone_points(msg)
        self.engine.process(pts, w, h, at)

    def phone_gone(self):
        """The phone that was sending hand points disconnected."""
        if self.source == "phone":
            self.stop()

    async def _phone_watchdog(self):
        """Keeps the pointer honest when the phone stops sending (camera paused, Wi-Fi hiccup),
        and reports the real message rate once per second."""
        win_start = time.perf_counter()
        warned = False
        try:
            while True:
                await asyncio.sleep(0.05)
                now = time.perf_counter()
                silent = now - self.phone_last_at
                if silent > PHONE_GAP_S and self.engine is not None:
                    self.last_frame_at = max(self.last_frame_at, now)
                    self.engine.process(None, 1280, 720, now)  # counts as "no hand": pointer holds, then hides
                if silent > PHONE_SILENT_S and not warned:
                    warned = True
                    self._publish_status(error="No hand data from the phone camera. Is the camera open in the app?")
                elif silent <= PHONE_SILENT_S and warned:
                    warned = False
                    self._publish_status(error=None)
                if now - win_start >= 1.0:
                    latency = round(statistics.median(self.latencies), 1) if self.latencies else None
                    self._publish_status(fps=round(self.phone_count / (now - win_start), 1),
                                         detect_ms=self.phone_detect_ms, latency_ms=latency,
                                         gap_phone_ms=round(self.gap_phone * 1000) if self.last_phone_t is not None else None,
                                         gap_net_ms=round(self.gap_net * 1000) if self.phone_count else None,
                                         **held_report(self.engine))
                    win_start, self.phone_count = now, 0
                    self.gap_phone = self.gap_net = 0.0
        except asyncio.CancelledError:
            pass
        finally:
            if asyncio.current_task() is self.phone_task:  # still the active source
                self._send_pointer({"type": "pointer", "visible": False, "x": 0, "y": 0, "gesture": "none"})
                self.source = None
                self._publish_status(running=False, source=None, fps=None, detect_ms=None, latency_ms=None)

    # ---------- talking to the async hub from this thread ----------
    def _call(self, coro):
        if self.loop:
            asyncio.run_coroutine_threadsafe(coro, self.loop)

    def _publish_status(self, **changes):
        self.status.update(changes)
        self._call(self.hub.to_phones(dict(self.status)))

    def _send_pointer(self, message: dict):
        with self._pointer_lock:
            self._pointer_msg = message
            if self._pointer_busy:
                return
            self._pointer_busy = True
        self._call(self._pointer_pump())

    async def _pointer_pump(self):
        while True:
            with self._pointer_lock:
                message, self._pointer_msg = self._pointer_msg, None
                if message is None:
                    self._pointer_busy = False
                    return
            await self.hub.to_tv(message)

    def _change_scene(self, phones: bool = True, **changes):
        self._call(self.hub.update_scene(changes, phones=phones))

    # ---------- PC webcam source (only when asked for explicitly) ----------
    def _run(self):
        import cv2  # only needed for the webcam source
        import mediapipe as mp
        from vision.camera import DEFAULT_EXPOSURE, LatestFrameReader, open_camera, set_exposure
        from vision.hands import create_landmarker

        cap = open_camera(0)
        if cap is None:
            self._publish_status(running=False, source=None, error="Could not open the PC webcam. Close other apps using it.")
            self.source = None
            return
        try:
            landmarker = create_landmarker()
        except SystemExit as e:  # model file missing
            cap.release()
            self._publish_status(running=False, source=None, error=str(e))
            self.source = None
            return
        set_exposure(cap, DEFAULT_EXPOSURE)
        reader = LatestFrameReader(cap)  # always process the newest picture, never a queued old one
        self._publish_status(running=True, source="webcam", error=None, fps=None, detect_ms=None, latency_ms=None)

        engine = self.engine
        start = time.perf_counter()
        win_start, win_frames, win_ms = start, 0, 0.0
        last_ts = -1
        try:
            while not self.stop_flag.is_set():
                ok, frame, read_at = reader.read()  # read_at: when the picture arrived from the camera
                if not ok:
                    self._publish_status(error="The camera stopped giving pictures.")
                    break
                frame = cv2.flip(frame, 1)
                frame_h, frame_w = frame.shape[:2]
                ts = max(last_ts + 1, int((read_at - start) * 1000))  # MediaPipe needs rising timestamps
                last_ts = ts
                t0 = time.perf_counter()
                result = landmarker.detect_for_video(
                    mp.Image(image_format=mp.ImageFormat.SRGB, data=cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)), ts)
                win_ms += (time.perf_counter() - t0) * 1000
                win_frames += 1
                pts = [(p.x, p.y) for p in result.hand_landmarks[0]] if result.hand_landmarks else None
                engine.process(pts, frame_w, frame_h, read_at)

                if read_at - win_start >= 1.0:  # report the real speed once per second
                    latency = round(statistics.median(self.latencies), 1) if self.latencies else None
                    self._publish_status(fps=round(win_frames / (read_at - win_start), 1),
                                         detect_ms=round(win_ms / win_frames, 1), latency_ms=latency,
                                         **held_report(engine))
                    win_start, win_frames, win_ms = read_at, 0, 0.0
        finally:
            reader.release()
            landmarker.close()
            self._send_pointer({"type": "pointer", "visible": False, "x": 0, "y": 0, "gesture": "none"})
            self.source = None
            self._publish_status(running=False, source=None, fps=None, detect_ms=None, latency_ms=None)
