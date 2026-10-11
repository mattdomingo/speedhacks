import unittest
from unittest.mock import patch
import capture


class UploadTests(unittest.TestCase):
    def test_remote_http_rejected_before_sending_secret(self):
        with patch("capture.urlopen") as send:
            with self.assertRaises(ValueError):
                capture.upload_frame("http://example.com", "secret", b"jpeg")
            send.assert_not_called()

    def test_oversized_frame_rejected(self):
        with patch("capture.urlopen") as send:
            with self.assertRaises(ValueError):
                capture.upload_frame("https://example.com", "secret", b"x" * 500_001)
            send.assert_not_called()


if __name__ == "__main__":
    unittest.main()
