import unittest
import json
from queue import Queue
from threading import Event
from unittest.mock import Mock, patch
import capture


class UploadTests(unittest.TestCase):
    def test_capture_timestamp_survives_waiting_in_upload_queue(self):
        response = Mock()
        response.read.return_value = b'{"inference":"analyzed"}'
        with patch("capture.urlopen") as send:
            send.return_value.__enter__.return_value = response
            result = capture.upload_frame("http://127.0.0.1:3000", "secret", b"jpeg", "2026-10-11T12:00:00Z")
            self.assertEqual(result["inference"], "analyzed")
            request = send.call_args.args[0]
            self.assertEqual(json.loads(request.data)["timestamp"], "2026-10-11T12:00:00Z")
            self.assertEqual(send.call_args.kwargs["timeout"], 35)

    def test_remote_http_rejected_before_sending_secret(self):
        with patch("capture.urlopen") as send:
            with self.assertRaises(ValueError):
                capture.upload_frame("http://example.com", "secret", b"jpeg")
            send.assert_not_called()

    def test_pending_queue_keeps_only_newest_capture(self):
        pending = Queue(maxsize=1)
        capture.offer_latest(pending, ("old", b"old"))
        capture.offer_latest(pending, ("new", b"new"))
        self.assertEqual(pending.qsize(), 1)
        self.assertEqual(pending.get_nowait(), ("new", b"new"))

    def test_connection_reset_does_not_stop_future_uploads(self):
        pending, stopped = Queue(), Event()
        pending.put(("first", b"first"))
        pending.put(("second", b"second"))

        def send(_url, _token, item):
            if item[0] == "first":
                raise ConnectionResetError()
            stopped.set()

        with patch("capture.send_frame", side_effect=send) as uploader, patch("builtins.print"):
            capture.upload_loop("http://localhost", "secret", pending, stopped)
        self.assertEqual(uploader.call_count, 2)

    def test_jpeg_quality_reduces_to_meet_existing_upload_limit(self):
        cv2 = Mock()
        frame = Mock(shape=(720, 1280, 3))
        large, small = Mock(), Mock()
        large.tobytes.return_value = b"x" * 500_001
        small.tobytes.return_value = b"jpeg"
        cv2.imencode.side_effect = [(True, large), (True, small)]
        self.assertEqual(capture.encode_jpeg(cv2, frame), b"jpeg")
        self.assertEqual(cv2.imencode.call_count, 2)
        cv2.resize.assert_not_called()

    def test_encoding_failures_do_not_upload_oversized_or_invalid_images(self):
        cv2 = Mock()
        frame = Mock(shape=(720, 1280, 3))
        cv2.imencode.return_value = (False, None)
        with self.assertRaises(RuntimeError):
            capture.encode_jpeg(cv2, frame)
        encoded = Mock()
        encoded.tobytes.return_value = b"x" * 500_001
        cv2.imencode.return_value = (True, encoded)
        with self.assertRaises(ValueError):
            capture.encode_jpeg(cv2, frame)

    def test_oversized_frame_rejected(self):
        with patch("capture.urlopen") as send:
            with self.assertRaises(ValueError):
                capture.upload_frame("https://example.com", "secret", b"x" * 500_001)
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
