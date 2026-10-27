# SpatialVision

Interactive projection mapping that keeps visuals aligned when an object moves, and lets people control the content with hand gestures instead of a keyboard or controller.

Final Year Project, SZABIST Islamabad, Fall 2026.
Team: M Anas Bhatti, Zahra Tul Hussan Syed, Syed Ali Tarikh.

## How it works

```
Phone app  <--Wi-Fi-->  Python backend on the PC  <--Wi-Fi or HDMI-->  TV display
(controls)              (webcam, OpenCV, MediaPipe)                    (shows the visuals)
```

- **Phone app**: the remote control (presets, calibration, live preview).
- **Backend**: runs the webcam, computer vision and hand tracking, and connects the phone and the display.
- **Display**: an LED TV for now. A projector will be added later as a second display.

The TV connects first and gets a 4-digit pairing code. The phone must send that code to connect.

## Project status

| Part | Status |
|---|---|
| Backend server, TV and phone pairing | Working |
| Login and sign-up (SQLite, hashed passwords) | Working |
| Phone app interface | Designed; most features still simulated |
| Webcam capture, hand tracking | Not started |
| TV display page | Not started |
| Calibration (ArUco, homography) | Not started |

## Folder layout

```
backend/      FastAPI server, vision code, tests, requirements.txt
mobile-app/   Expo + React Native + TypeScript app
tv-display/   TV client (not built yet)
docs/         proposal and notes
```

## Setup (Windows, once per PC)

You need Git, Python 3.11 and Node.js (LTS).

```
git clone https://github.com/AnasBhatti027/Spatialvision.git
cd Spatialvision\backend
py -3.11 -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
cd ..\mobile-app
npm install
```

If activating the venv says scripts are disabled, run
`Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` once and try again.

## Running

**Backend** (from `backend`, with `(venv)` active):

```
uvicorn main:app --host 0.0.0.0 --port 8000 --reload
```

Check http://localhost:8000/health. The test page for every endpoint is http://localhost:8000/docs.

**Pairing test** (second terminal, venv active, server running):

```
python test_pairing.py
```

**Phone app** (from `mobile-app`):

```
npx expo start
```

Scan the QR code with Expo Go. The phone and PC must be on the same Wi-Fi. In the app, enter your PC's IPv4 address (from `ipconfig`) with port 8000.

## Rules

- One branch per person: `feature/<what-you-are-building>`, then a pull request into `main`.
- Never commit `venv`, `node_modules`, `.env` or `*.db` files (the `.gitignore` already blocks them).
- Only real measured numbers go in the app and the report.
