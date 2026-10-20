import asyncio
import json

import websockets

URL = "ws://localhost:8000"


async def recv(ws):
    return json.loads(await asyncio.wait_for(ws.recv(), timeout=5))


async def main():
    # 1. The TV connects and receives a pairing code
    async with websockets.connect(f"{URL}/ws/tv") as tv:
        msg = await recv(tv)
        print("TV got       :", msg)
        code = msg["code"]

        # 2. A phone with the WRONG code is rejected
        async with websockets.connect(f"{URL}/ws/phone?code=abcd") as bad:
            print("Wrong code   :", await recv(bad))

        # 3. A phone with the RIGHT code is paired
        async with websockets.connect(f"{URL}/ws/phone?code={code}") as phone:
            print("Phone got    :", await recv(phone))

            # 4. Phone -> TV
            await phone.send(json.dumps({"type": "start_calibration"}))
            print("TV received  :", await recv(tv))

            # 5. TV -> Phone
            await tv.send(json.dumps({"type": "calibration_done", "error_px": 0.8}))
            print("Phone received:", await recv(phone))

    print("\nAll checks passed.")


asyncio.run(main())