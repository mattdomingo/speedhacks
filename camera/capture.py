"""Laptop webcam transport. Object detection belongs in Engineer 3's pipeline."""
import argparse
import base64
from datetime import datetime, timezone
import json
import os
import time
from urllib.error import HTTPError, URLError
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def upload_frame(backend_url, token, jpeg):
    parsed = urlparse(backend_url)
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")
    ):
        raise ValueError("Use HTTPS for remote camera uploads")
    if len(jpeg) > 500_000:
        raise ValueError("JPEG exceeds 500 KB; reduce capture resolution")
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "jpegBase64": base64.b64encode(jpeg).decode("ascii"),
    }
    request = Request(
        backend_url.rstrip("/") + "/camera/frame",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=10) as response:
        return json.load(response)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--once", action="store_true")
    args = parser.parse_args()
    if args.interval < 0.5:
        parser.error("--interval must be at least 0.5 seconds")
    token = os.environ.get("CAMERA_TOKEN", "")
    if len(token) < 32:
        parser.error("Set CAMERA_TOKEN to the backend's camera secret")
    backend_url = os.environ.get("BACKEND_URL", "http://127.0.0.1:3000")
    try:
        import cv2
    except ImportError:
        parser.error("Install camera/requirements.txt in a virtual environment first")
    capture = cv2.VideoCapture(args.device)
    try:
        if not capture.isOpened():
            raise RuntimeError("Cannot open webcam; check device and OS camera permission")
        while True:
            # Grab a fresh frame after sleeping; flush a few buffered camera frames.
            for _ in range(3):
                capture.grab()
            ok, frame = capture.read()
            if not ok:
                raise RuntimeError("Cannot read webcam")
            height, width = frame.shape[:2]
            if width > 960:
                frame = cv2.resize(frame, (960, round(height * 960 / width)))
            ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 70])
            if not ok:
                raise RuntimeError("Cannot encode JPEG")
            try:
                result = upload_frame(backend_url, token, encoded.tobytes())
                print(f"Frame uploaded at {result['timestamp']}; inference not configured", flush=True)
            except (HTTPError, URLError, TimeoutError, ValueError) as error:
                if args.once:
                    raise
                print(f"Upload failed ({type(error).__name__}); retrying next interval", flush=True)
            if args.once:
                break
            time.sleep(args.interval)
    finally:
        capture.release()


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
