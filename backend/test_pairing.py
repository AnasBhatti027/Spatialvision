import asyncio
import json

import websockets

URL = "ws://localhost:8000"


async def recv(ws, want=None):
    """Waits for the next message (of type `want`, if given) and skips any others."""
    while True:
        msg = json.loads(await asyncio.wait_for(ws.recv(), timeout=5))
        if want is None or msg.get("type") == want:
            return msg


async def main():
    # 1. The TV connects and receives a pairing code
    async with websockets.connect(f"{URL}/ws/tv") as tv:
        msg = await recv(tv, "pair_code")
        print("TV got        :", msg)
        code = msg["code"]

        # 2. A phone with the WRONG code is rejected
        async with websockets.connect(f"{URL}/ws/phone?code=abcd") as bad:
            print("Wrong code    :", await recv(bad))

        # 3. A phone with the RIGHT code is paired, and the TV is told
        async with websockets.connect(f"{URL}/ws/phone?code={code}") as phone:
            print("Phone got     :", await recv(phone, "paired"))
            print("TV got        :", await recv(tv, "phones"))

            # 4. Phone -> TV: a scene with four corners
            scene = {"type": "scene", "corners": [[0, 0], [1, 0], [1, 1], [0, 1]], "content": "pattern"}
            await phone.send(json.dumps(scene))
            print("TV received   :", await recv(tv, "scene"))

            # 5. TV -> Phone
            await tv.send(json.dumps({"type": "calibration_done", "error_px": 0.8}))
            print("Phone received:", await recv(phone, "calibration_done"))

    print("\nAll checks passed.")


asyncio.run(main())
