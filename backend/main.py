import asyncio
import base64
import binascii
import json
import secrets
import time
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import presets
from auth import router as auth_router, user_from_token
from scene_model import apply_changes, normalize
from vision.gesture_service import GestureService

BASE = Path(__file__).parent
TV_DIR = BASE.parent / "tv-display"   # the TV web page
ASSETS_DIR = BASE / "assets"           # images uploaded from the phone (ignored by git)
ASSETS_DIR.mkdir(exist_ok=True)
SCENE_FILE = BASE / "scene.json"       # the last shape and content, kept across restarts (ignored by git)
SCENE_SAVE_S = 0.5                     # while something is being dragged, save at most twice a second
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

app = FastAPI(title="SpatialVision Backend")

# Lets the Expo web version (running in a browser) call this server.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(auth_router)


def load_scene() -> dict:
    """The scene saved last time, or the default one. Anything broken in the file is ignored.
    A scene.json from before surfaces existed becomes surface 1."""
    try:
        return normalize(json.loads(SCENE_FILE.read_text()))
    except (OSError, ValueError, AttributeError, TypeError):
        return normalize({})


def new_code() -> str:
    return f"{secrets.randbelow(10000):04d}"


class Hub:
    """Connects one TV display with the paired phone controllers."""

    def __init__(self):
        self.code = new_code()
        self.tv: WebSocket | None = None
        self.phones: set[WebSocket] = set()
        # The current scene (corners, content). Changed by the phone or by gestures.
        # A TV or phone that connects gets it straight away. It is saved to scene.json, so a restart
        # of the backend keeps the shape where it was left.
        self.scene: dict = load_scene()
        self._saved_at = 0.0
        self._save_pending = False

    def remember(self):
        """Saves the scene soon (at most every SCENE_SAVE_S while it keeps changing)."""
        if self._save_pending:
            return
        wait = SCENE_SAVE_S - (time.monotonic() - self._saved_at)
        if wait <= 0:
            self._save_now()
        else:
            self._save_pending = True
            asyncio.get_running_loop().call_later(wait, self._save_now)

    def _save_now(self):
        self._save_pending = False
        self._saved_at = time.monotonic()
        try:
            tmp = SCENE_FILE.with_suffix(".tmp")
            tmp.write_text(json.dumps(self.scene))
            tmp.replace(SCENE_FILE)  # replace in one step, so a crash never leaves half a file
        except OSError as e:
            print(f"Could not save the scene: {e}")

    async def to_phones(self, message: dict):
        for ws in list(self.phones):
            try:
                await ws.send_json(message)
            except Exception:
                self.phones.discard(ws)

    async def to_tv(self, message: dict):
        if self.tv:
            try:
                await self.tv.send_json(message)
            except Exception:
                self.tv = None

    async def phones_changed(self):
        await self.to_tv({"type": "phones", "count": len(self.phones)})

    async def update_scene(self, changes: dict, phones: bool = True):
        """Used by gestures: changes part of the scene and tells the TV (and the phones, unless phones=False)."""
        self.scene = apply_changes(self.scene, changes)
        self.remember()
        await self.to_tv(self.scene)
        if phones:
            await self.to_phones(self.scene)


hub = Hub()
gestures = GestureService(hub)
gesture_phone = {"ws": None}  # the phone whose camera is the gesture source


@app.on_event("shutdown")
def stop_gestures():
    gestures.stop()


@app.on_event("shutdown")
def save_scene_on_exit():
    """A save that was still waiting (during a drag) is written before the backend stops."""
    if hub._save_pending:
        hub._save_now()


@app.get("/health")
def health():
    return {"status": "ok", "tv_connected": hub.tv is not None, "phones": len(hub.phones)}


@app.websocket("/ws/tv")
async def tv_socket(ws: WebSocket):
    await ws.accept()
    hub.tv = ws
    hub.code = new_code()
    await ws.send_json({"type": "pair_code", "code": hub.code})
    await ws.send_json({"type": "phones", "count": len(hub.phones)})
    await ws.send_json(hub.scene)
    await hub.to_phones({"type": "tv_status", "connected": True})
    try:
        while True:
            data = await ws.receive_json()
            if data.get("type") == "pointer_ack":
                gestures.record_ack(float(data.get("t", 0)))
                continue
            await hub.to_phones(data)
    except WebSocketDisconnect:
        pass
    finally:
        if hub.tv is ws:
            hub.tv = None
            await hub.to_phones({"type": "tv_status", "connected": False})


@app.websocket("/ws/phone")
async def phone_socket(ws: WebSocket, code: str = ""):
    await ws.accept()
    if code != hub.code:
        await ws.send_json({"type": "error", "message": "Wrong pairing code"})
        await ws.close(code=4401)
        return
    hub.phones.add(ws)
    await ws.send_json({"type": "paired", "tv_connected": hub.tv is not None})
    await ws.send_json(hub.scene)  # the shape as it is now, so the phone starts from it instead of overwriting it
    await ws.send_json(gestures.status)
    await hub.phones_changed()
    try:
        while True:
            data = await ws.receive_json()
            kind = data.get("type")
            if kind == "hand":  # hand points from the phone's camera; never forwarded to the TV
                if ws is gesture_phone["ws"]:
                    gestures.on_phone_hand(data)
                continue
            if kind == "start_gestures":
                # Default: the phone's own camera. The PC webcam is only used when asked for by name.
                source = "webcam" if data.get("source") == "webcam" else "phone"
                gesture_phone["ws"] = ws if source == "phone" else None
                gestures.start(asyncio.get_running_loop(), source)
                continue
            if kind == "stop_gestures":
                gestures.stop()
                continue
            if kind == "scene":
                hub.scene = normalize(data, hub.scene)
                hub.remember()
                await hub.to_tv(hub.scene)
                continue
            if kind in ("list_presets", "save_preset", "load_preset", "delete_preset"):
                await handle_presets(ws, kind, data)
                continue
            await hub.to_tv(data)
    except WebSocketDisconnect:
        pass
    finally:
        hub.phones.discard(ws)
        if gesture_phone["ws"] is ws:  # the camera phone left: stop gestures, never switch to the webcam
            gesture_phone["ws"] = None
            gestures.phone_gone()
        await hub.phones_changed()


async def handle_presets(ws: WebSocket, kind: str, data: dict):
    """Saved scenes: the phone asks, the backend answers with the list (and loads one when asked)."""
    try:
        pid = int(data.get("id", -1))
    except (TypeError, ValueError):
        pid = -1
    if kind == "save_preset":
        presets.save_preset(str(data.get("name", "")), hub.scene)
    elif kind == "delete_preset":
        presets.delete_preset(pid)
    elif kind == "load_preset":
        scene = presets.load_preset(pid)
        if scene is None:
            await ws.send_json({"type": "presets_error", "message": "That saved scene no longer exists."})
        else:
            hub.scene = scene
            hub.remember()
            await hub.to_tv(hub.scene)
            await hub.to_phones(hub.scene)
    await ws.send_json({"type": "presets", "items": presets.list_presets()})


class UploadIn(BaseModel):
    data: str                    # the image file, base64-encoded
    mime: str = "image/jpeg"


@app.post("/assets")
def upload_asset(body: UploadIn, authorization: str = Header("")):
    """The phone uploads a gallery image here. Only logged-in users may upload."""
    user_from_token(authorization)
    ext = IMAGE_TYPES.get(body.mime)
    if ext is None:
        raise HTTPException(400, "Only JPEG, PNG or WebP images are supported.")
    try:
        raw = base64.b64decode(body.data, validate=True)
    except (binascii.Error, ValueError):
        raise HTTPException(400, "The image data could not be read.")
    if len(raw) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "The image is too large (15 MB maximum).")
    name = secrets.token_hex(8) + ext
    (ASSETS_DIR / name).write_bytes(raw)
    return {"url": f"/assets/{name}", "bytes": len(raw)}


# Static files: uploaded images and the TV page (open http://<PC-IP>:8000/tv on the TV).
app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")
app.mount("/tv", StaticFiles(directory=TV_DIR, html=True), name="tv")
