"""Capture a fixed tabletop for the object-memory backend. Press q to close preview."""
import argparse
import base64
from datetime import datetime, timezone
import json
import os
from queue import Empty, Queue
from threading import Event, Thread
import time
from urllib.parse import urlparse
from urllib.request import Request, urlopen


def upload_frame(backend_url, token, jpeg, timestamp=None):
    parsed = urlparse(backend_url)
    if parsed.scheme != "https" and not (
        parsed.scheme == "http" and parsed.hostname in ("localhost", "127.0.0.1")
    ):
        raise ValueError("Use HTTPS for remote camera uploads")
    if len(jpeg) > 500_000:
        raise ValueError("JPEG exceeds 500 KB; reduce capture resolution")
    payload = {
        "timestamp": timestamp or datetime.now(timezone.utc).isoformat(),
        "jpegBase64": base64.b64encode(jpeg).decode("ascii"),
    }
    request = Request(
        backend_url.rstrip("/") + "/camera/frame",
        data=json.dumps(payload).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    with urlopen(request, timeout=35) as response:
        return json.load(response)


def encode_jpeg(cv2, frame):
    height, width = frame.shape[:2]
    if max(height, width) > 1280:
        scale = 1280 / max(height, width)
        frame = cv2.resize(frame, (round(width * scale), round(height * scale)))
    for quality in (85, 70, 55, 40, 25):
        ok, encoded = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, quality])
        if not ok:
            raise RuntimeError("Cannot encode JPEG")
        jpeg = encoded.tobytes()
        if len(jpeg) <= 500_000:
            return jpeg
    raise ValueError("JPEG exceeds 500 KB even at reduced quality; reduce camera resolution")


def offer_latest(pending, item):
    try:
        pending.get_nowait()
    except Empty:
        pass
    pending.put_nowait(item)


def send_frame(backend_url, token, item):
    timestamp, jpeg = item
    result = upload_frame(backend_url, token, jpeg, timestamp)
    print(f"Frame {result.get('status', 'received')} at {timestamp}; "
          f"inference={result.get('inference', 'unknown')}; "
          f"confirmed={result.get('confirmed', 0)}", flush=True)


def upload_loop(backend_url, token, pending, stopped):
    while not stopped.is_set():
        try:
            item = pending.get(timeout=0.25)
        except Empty:
            continue
        try:
            send_frame(backend_url, token, item)
        except (OSError, ValueError) as error:
            print(f"Upload failed ({type(error).__name__}); waiting for next fresh frame", flush=True)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--device", type=int, default=0)
    parser.add_argument("--interval", type=float, default=5)
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--preview", action="store_true", help="Show the camera locally; press q to stop")
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
    pending, stopped = Queue(maxsize=1), Event()
    uploader = None
    try:
        if not capture.isOpened():
            raise RuntimeError("Cannot open webcam; check device and OS camera permission")
        capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1280)
        capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 720)
        print(f"Camera active: {int(capture.get(cv2.CAP_PROP_FRAME_WIDTH))}x"
              f"{int(capture.get(cv2.CAP_PROP_FRAME_HEIGHT))}; selected snapshots upload every {args.interval}s", flush=True)
        if not args.once:
            uploader = Thread(target=upload_loop, args=(backend_url, token, pending, stopped), daemon=True)
            uploader.start()
        next_capture = 0
        while True:
            # Grab a fresh frame after sleeping; flush a few buffered camera frames.
            for _ in range(3):
                capture.grab()
            ok, frame = capture.read()
            captured_at = datetime.now(timezone.utc).isoformat()
            if not ok:
                raise RuntimeError("Cannot read webcam")
            if args.preview:
                cv2.imshow("Object memory camera - q to stop", frame)
                if cv2.waitKey(30) & 0xff == ord('q'):
                    break
            if time.monotonic() >= next_capture:
                item = (captured_at, encode_jpeg(cv2, frame))
                if args.once:
                    send_frame(backend_url, token, item)
                else:
                    # Keep capture fresh while a serverless request completes its inference.
                    offer_latest(pending, item)
                next_capture = time.monotonic() + args.interval
            if args.once:
                break
            if not args.preview:
                time.sleep(max(0, next_capture - time.monotonic()))
    finally:
        capture.release()
        stopped.set()
        if args.preview:
            cv2.destroyAllWindows()
        if uploader:
            uploader.join(timeout=36)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        pass
