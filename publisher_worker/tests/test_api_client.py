import hashlib
import sys
from pathlib import Path
import os
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.api_client import PublisherApiClient
from southfarm_publisher.models import PublisherError


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None): self.status = status; self.body = body; self.headers = headers or {}; self.offset = 0
    def read(self, size=-1):
        if size < 0: size = len(self.body) - self.offset
        part = self.body[self.offset:self.offset + size]; self.offset += len(part); return part
    def getcode(self): return self.status
    def close(self): pass


class ApiClientTests(unittest.TestCase):
    def test_download_streams_and_removes_partial_file_on_hash_mismatch(self):
        client = PublisherApiClient("https://api.example.test", "secret-token", "worker-a", opener=lambda request, timeout: FakeResponse(body=b"wrong"))
        with tempfile.TemporaryDirectory() as directory:
            target = os.path.join(directory, "clip.mp4")
            with self.assertRaises(PublisherError) as raised: client.download_media(9, "claim-1", target, {"size_bytes": 5, "sha256": hashlib.sha256(b"right").hexdigest()})
            self.assertEqual(raised.exception.code, "MEDIA_HASH_MISMATCH")
            self.assertFalse(os.path.exists(target))

    def test_authorization_secret_is_redacted_from_transport_errors(self):
        def fail(request, timeout): raise OSError("Bearer secret-token exploded")
        client = PublisherApiClient("https://api.example.test", "secret-token", "worker-a", opener=fail)
        with self.assertRaises(PublisherError) as raised: client.claim(5)
        self.assertNotIn("secret-token", str(raised.exception))
