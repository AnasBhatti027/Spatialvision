"""Checks the phone-camera gesture source with simulated phone messages (no phone or camera needed).

Run from the backend folder with the venv active:
    python test_phone_source.py

It pretends to be the app: it sends "hand" messages (21 points, 30 per second) the same way the
phone does, grabs corner 1 with a pinch, drags it, lets go, and pauses. It also checks that the
PC webcam is never opened in phone mode.
"""
import asyncio
import statistics
import time

import vision.camera
import vision.gesture_service as gs
import random

webcam_opened = []
vision.camera.open_camera = lambda *a, **k: webcam_opened.append(1)  # must never be called in phone mode

failures = []


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


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        failures.append(name)


class Hub:
    """Stands in for main.py's Hub: records what would go to the TV and the phones."""

    def __init__(self):
        self.scene = {"type": "scene", "corners": [[0.1, 0.1], [0.9, 0.1], [0.9, 0.9], [0.1, 0.9]]}
        self.tv, self.phones = [], []

    async def to_tv(self, m):
        self.tv.append(m)

    async def to_phones(self, m):
        self.phones.append(m)

    async def update_scene(self, changes, phones=True):
        self.scene = {**self.scene, **changes}
        self.tv.append(dict(self.scene))
        if phones:
            self.phones.append(dict(self.scene))


def message(pts, mirror=False, rot=0, t=None):
    flat = None if pts is None else [round(c, 4) for p in pts for c in p]
    m = {"type": "hand", "pts": flat, "w": 1280, "h": 720, "mirror": mirror, "rot": rot, "detect_ms": 18.0}
    if t is not None:
        m["t"] = t
    return m


async def main():
    hub = Hub()
    svc = gs.GestureService(hub)
    svc.start(asyncio.get_running_loop())  # what main.py does for {"type": "start_gestures"}
    await asyncio.sleep(0.05)
    check("phone mode starts", svc.running and svc.source == "phone")

    async def send(pts, frames=1, **kw):
        for _ in range(frames):
            svc.on_phone_hand(message(pts, **kw))
            await asyncio.sleep(1 / 30)

    # Learn the hand, then find where corner 1 (top-left, TV 0.1, 0.1) is in the camera picture.
    await send(hand(0.5, 0.45, noise=0.002), 45)
    area = svc.engine.pointer_tracker.area
    l, r, t, b = area.bounds()
    cx, cy = l + 0.1 * (r - l), t + 0.1 * (b - t)
    await send(hand(cx, cy), 20)
    pointers = [m for m in hub.tv if m.get("type") == "pointer"]
    check("pointer reaches the TV", pointers and pointers[-1]["visible"], f"last pointer {pointers[-1]['x']:.3f}, {pointers[-1]['y']:.3f}")
    check("corner 1 is highlighted", pointers[-1].get("hover") == "corner:0", str(pointers[-1].get("hover")))

    # Pinch, drag 0.1 of the TV to the right and down, let go.
    await send(hand(cx, cy, pinch=True), 4)
    for k in range(1, 21):
        await send(hand(cx + k * 0.005 * (r - l), cy + k * 0.005 * (b - t), pinch=True))
    await send(hand(cx + 0.1 * (r - l), cy + 0.1 * (b - t), pinch=True), 4)
    await send(hand(cx + 0.1 * (r - l), cy + 0.1 * (b - t)), 6)
    c1 = hub.scene["corners"][0]
    check("pinch-drag moves corner 1 and releases", abs(c1[0] - 0.2) < 0.02 and abs(c1[1] - 0.2) < 0.02 and svc.engine.editor.drag is None,
          f"corner 1 now {c1[0]:.3f}, {c1[1]:.3f}")
    check("other corners unchanged", hub.scene["corners"][1:] == [[0.9, 0.1], [0.9, 0.9], [0.1, 0.9]])
    scene_to_phone = [m for m in hub.phones if m.get("type") == "scene"]
    check("phone gets the shape once, at release (not during the drag)", len(scene_to_phone) == 1, f"{len(scene_to_phone)} update(s)")

    # Phone stops sending for 0.4 s: pointer is held (dimmed), not hidden.
    hub.tv.clear()
    await asyncio.sleep(0.4)
    held = [m for m in hub.tv if m.get("type") == "pointer"]
    check("short pause holds the pointer", held and all(m["visible"] for m in held) and held[-1].get("held"))
    # ...for 1 s more: pointer hides (never stuck forever).
    await asyncio.sleep(1.0)
    last = [m for m in hub.tv if m.get("type") == "pointer"][-1]
    check("long pause hides the pointer", not last["visible"])

    # Broken messages are ignored safely.
    for bad in ({"type": "hand", "pts": [1, 2, 3]}, {"type": "hand", "pts": ["x"] * 42}, {"type": "hand", "pts": [float("nan")] * 42},
                {"type": "hand"}):
        svc.on_phone_hand(bad)
    check("broken messages do not crash", svc.running)

    # Status reports the real message rate.
    await send(hand(0.5, 0.45, noise=0.002), 40)
    status = [m for m in hub.phones if m.get("type") == "vision_status" and m.get("fps")]
    check("measured rate reported", bool(status), f"{status[-1]['fps']} messages/s, phone detection {status[-1]['detect_ms']} ms" if status else "")

    # Wi-Fi bursts: the phone takes a frame every 33 ms while the hand moves steadily, but the
    # messages arrive 4 at a time every 133 ms. With the phone's time stamps the pointer still moves evenly.
    async def burst_run(stamped):
        svc.stop(); await asyncio.sleep(0.1)
        svc.start(asyncio.get_running_loop()); await asyncio.sleep(0.05)
        await send(hand(0.4, 0.45, noise=0.0), 45)  # learn the hand
        t_ms, x, xs = 100000.0, 0.4, []
        for burst in range(12):
            for k in range(4):
                x += 0.004
                t_ms += 1000 / 30
                svc.on_phone_hand(message(hand(x, 0.45), t=t_ms if stamped else None))
                xs.append(svc.engine.pointer_tracker.pointer[0])  # where the pointer is after each frame
            await asyncio.sleep(4 / 30)
        steps = [b - a for a, b in zip(xs[8:], xs[9:])]
        return statistics.pstdev(steps) / max(statistics.mean(steps), 1e-9)

    unstamped, stamped = await burst_run(False), await burst_run(True)
    check("Wi-Fi bursts: pointer moves evenly with phone time stamps", stamped < unstamped * 0.5,
          f"unevenness {unstamped:.2f} by arrival time, {stamped:.2f} with phone time")

    svc.stop()
    await asyncio.sleep(0.1)
    check("stop works", not svc.running)
    check("PC webcam never opened", not webcam_opened)

    # Mirroring and turning are applied before tracking.
    pts, w, h = gs.phone_points(message([(0.2, 0.3)] * 21, mirror=True))
    check("mirror flips left and right", abs(pts[0][0] - 0.8) < 1e-9 and abs(pts[0][1] - 0.3) < 1e-9)
    pts, w, h = gs.phone_points(message([(0.2, 0.3)] * 21, rot=90))
    check("turn 90 degrees", abs(pts[0][0] - 0.7) < 1e-9 and abs(pts[0][1] - 0.2) < 1e-9 and (w, h) == (720, 1280))


asyncio.run(main())
print()
print("All checks passed" if not failures else f"{len(failures)} check(s) failed: {failures}")
