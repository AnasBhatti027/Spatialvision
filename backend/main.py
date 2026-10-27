import base64
import binascii
import secrets
from pathlib import Path

from fastapi import FastAPI, Header, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from auth import router as auth_router, user_from_token

BASE = Path(__file__).parent
TV_DIR = BASE.parent / "tv-display"   # the TV web page
ASSETS_DIR = BASE / "assets"           # images uploaded from the phone (ignored by git)
ASSETS_DIR.mkdir(exist_ok=True)
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
IMAGE_TYPES = {"image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp"}

app = FastAPI(title="SpatialVision Backend")

# Lets the Expo web version (running in a browser) call this server.
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])
app.include_router(auth_router)


def new_code() -> str:
    return f"{secrets.randbelow(10000):04d}"


class Hub:
    """Connects one TV display with the paired phone controllers."""

    def __init__(self):
        self.code = new_code()
        self.tv: WebSocket | None = None
        self.phones: set[WebSocket] = set()
        # The last scene the phone sent (corners, content). A TV that reconnects gets it straight away.
        self.scene: dict | None = None

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


hub = Hub()


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
    if hub.scene:
        await ws.send_json(hub.scene)
    await hub.to_phones({"type": "tv_status", "connected": True})
    try:
        while True:
            data = await ws.receive_json()
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
    await hub.phones_changed()
    try:
        while True:
            data = await ws.receive_json()
            if data.get("type") == "scene":
                hub.scene = data
            await hub.to_tv(data)
    except WebSocketDisconnect:
        pass
    finally:
        hub.phones.discard(ws)
        await hub.phones_changed()


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
