"""Module 1: webcam capture.

Run from the backend folder with the venv active:
    python -m vision.camera --list          find which camera numbers work
    python -m vision.camera                 live preview of camera 0
    python -m vision.camera --index 1       live preview of camera 1
    python -m vision.camera --lock          also try to lock exposure and white balance
    python -m vision.camera --width 640 --height 480    try a smaller size
    python -m vision.camera --exposure -5   change the fixed exposure (-5 = 1/32 s brighter, -7 = 1/128 s darker)
    python -m vision.camera --auto-exposure let the camera choose exposure (often much slower indoors)
    python -m vision.camera --backend msmf  use Media Foundation instead of DirectShow (Windows)

Press Q or Esc in the preview window to stop.
"""
import argparse
import sys
import time

import cv2

WIDTH, HEIGHT, FPS = 1280, 720, 30
# Fixed exposure (DirectShow: -6 = 1/64 s). Measured on the team laptop camera on 27 Oct 2026:
# automatic exposure gave 9.4 fps indoors, fixed -6 gave 29.5 fps at 1280x720.
DEFAULT_EXPOSURE = -6.0


BACKENDS = {"dshow": cv2.CAP_DSHOW, "msmf": cv2.CAP_MSMF, "any": cv2.CAP_ANY}


def open_camera(index: int = 0, width: int = WIDTH, height: int = HEIGHT, fps: int = FPS, backend_name: str = "dshow"):
    """Opens a camera and asks for a size and frame rate. Returns None if it cannot be opened."""
    # On Windows the DirectShow backend usually opens much faster than the default one.
    backend = BACKENDS[backend_name] if sys.platform == "win32" else cv2.CAP_ANY
    cap = cv2.VideoCapture(index, backend)
    if not cap.isOpened():
        return None
    # MJPG lets most USB webcams deliver 720p at 30 fps (raw video is often limited to 5-10 fps).
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    cap.set(cv2.CAP_PROP_FRAME_WIDTH, width)
    cap.set(cv2.CAP_PROP_FRAME_HEIGHT, height)
    cap.set(cv2.CAP_PROP_FPS, fps)
    # Some drivers only accept the format after the size is set, so ask again.
    cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
    return cap


def fourcc_name(cap) -> str:
    """The video format the camera is really using, e.g. MJPG (compressed) or YUY2 (raw)."""
    code = int(cap.get(cv2.CAP_PROP_FOURCC))
    name = "".join(chr((code >> (8 * i)) & 0xFF) for i in range(4))
    return name if name.strip("\x00").isprintable() and code else "unknown"


def lock_exposure(cap) -> dict:
    """Tries to switch off automatic exposure and white balance, so projected light
    does not keep changing the image. Many cheap webcams ignore this; we report what happened."""
    exposure = cap.get(cv2.CAP_PROP_EXPOSURE)
    result = {
        # With DirectShow, 0.25 means manual exposure and 0.75 means automatic.
        "auto_exposure_off": cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25),
        "exposure_kept": cap.set(cv2.CAP_PROP_EXPOSURE, exposure),
        "auto_white_balance_off": cap.set(cv2.CAP_PROP_AUTO_WB, 0),
    }
    result["exposure_value"] = cap.get(cv2.CAP_PROP_EXPOSURE)
    return result


def list_cameras(max_index: int = 4):
    """Tries camera numbers 0 to max_index-1 and says which ones give a picture."""
    found = 0
    for i in range(max_index):
        cap = open_camera(i)
        if cap is None:
            print(f"Camera {i}: not found")
            continue
        ok, frame = cap.read()
        if ok:
            h, w = frame.shape[:2]
            print(f"Camera {i}: works, gives {w}x{h}")
            found += 1
        else:
            print(f"Camera {i}: opens but gives no picture")
        cap.release()
    if found == 0:
        print("\nNo working camera found. Check the USB cable, and close other apps using the camera (Teams, Zoom, Camera app).")


def set_exposure(cap, value: float) -> dict:
    """Switches to manual exposure with a fixed value. With DirectShow the value is a power of two
    in seconds: -5 is 1/32 s, -6 is 1/64 s. Shorter exposure allows more frames per second but a darker image."""
    return {
        "auto_exposure_off": cap.set(cv2.CAP_PROP_AUTO_EXPOSURE, 0.25),
        "exposure_set": cap.set(cv2.CAP_PROP_EXPOSURE, value),
        "exposure_now": cap.get(cv2.CAP_PROP_EXPOSURE),
    }


def preview(index: int, lock: bool, width: int = WIDTH, height: int = HEIGHT,
            exposure: float | None = None, backend_name: str = "dshow"):
    cap = open_camera(index, width, height, backend_name=backend_name)
    if cap is None:
        print(f"Could not open camera {index}. Run: python -m vision.camera --list")
        return

    w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    print(f"Asked for   : {width}x{height} at {FPS} fps, format MJPG")
    print(f"Camera says : {w}x{h} at {cap.get(cv2.CAP_PROP_FPS):.0f} fps, format {fourcc_name(cap)} (what the driver reports)")
    print(f"Backend     : {backend_name}")
    if lock:
        print("Lock result :", lock_exposure(cap))
    if exposure is not None:
        print("Exposure    :", set_exposure(cap, exposure))

    window = f"SpatialVision camera {index} - press Q to stop"
    frames, started, shown_fps = 0, time.perf_counter(), 0.0
    total_frames, total_start = 0, started
    size = (w, h)
    while True:
        ok, frame = cap.read()
        if not ok:
            print("The camera stopped giving pictures.")
            break
        frames += 1
        total_frames += 1
        now = time.perf_counter()
        if now - started >= 1.0:  # update the measured frame rate once per second
            shown_fps = frames / (now - started)
            frames, started = 0, now

        fh, fw = frame.shape[:2]
        size = (fw, fh)
        cv2.putText(frame, f"{fw}x{fh}  {shown_fps:.1f} fps (measured)", (16, 36),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.0, (245, 217, 69), 2, cv2.LINE_AA)
        cv2.imshow(window, frame)
        key = cv2.waitKey(1) & 0xFF
        if key in (ord("q"), 27) or cv2.getWindowProperty(window, cv2.WND_PROP_VISIBLE) < 1:
            break

    elapsed = time.perf_counter() - total_start
    if elapsed > 0 and total_frames:
        print(f"Measured    : {size[0]}x{size[1]}, average {total_frames / elapsed:.1f} fps over {elapsed:.0f} s ({total_frames} frames)")
    cap.release()
    cv2.destroyAllWindows()


def main():
    parser = argparse.ArgumentParser(description="SpatialVision webcam capture")
    parser.add_argument("--list", action="store_true", help="find which camera numbers work")
    parser.add_argument("--index", type=int, default=0, help="camera number (0 is usually the laptop camera)")
    parser.add_argument("--lock", action="store_true", help="try to lock exposure and white balance")
    parser.add_argument("--width", type=int, default=WIDTH, help="picture width to ask for")
    parser.add_argument("--height", type=int, default=HEIGHT, help="picture height to ask for")
    parser.add_argument("--exposure", type=float, default=DEFAULT_EXPOSURE, help="fixed exposure, default -6 (DirectShow)")
    parser.add_argument("--auto-exposure", action="store_true", help="let the camera choose exposure itself")
    parser.add_argument("--backend", choices=list(BACKENDS), default="dshow", help="Windows camera backend")
    args = parser.parse_args()
    if args.list:
        list_cameras()
    else:
        exposure = None if args.auto_exposure else args.exposure
        preview(args.index, args.lock, args.width, args.height, exposure, args.backend)


if __name__ == "__main__":
    main()
