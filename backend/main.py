import secrets

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from auth import router as auth_router

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
    try:
        while True:
            data = await ws.receive_json()
            await hub.to_tv(data)
    except WebSocketDisconnect:
        pass
    finally:
        hub.phones.discard(ws)