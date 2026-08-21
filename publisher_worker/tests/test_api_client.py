import hashlib
import copy
import sys
from pathlib import Path
import os
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.api_client import PublisherApiClient
from southfarm_publisher.models import PublisherError, PublicationJob


class FakeResponse:
    def __init__(self, status=200, body=b"", headers=None): self.status = status; self.body = body; self.headers = headers or {}; self.offset = 0
    def read(self, size=-1):
        if size < 0: size = len(self.body) - self.offset
        part = self.body[self.offset:self.offset + size]; self.offset += len(part); return part
    def getcode(self): return self.status
    def close(self): pass


class ApiClientTests(unittest.TestCase):
    def test_claim_fixture_requires_safe_media_contract_before_adb(self):
        fixture = {
            "claimed": True, "claim_token": "claim-1",
            "job": {"id": 7, "device_id": 5, "media_id": 3, "platform": "youtube", "caption": "safe test", "status": "claimed",
                    "media": {"id": 3, "size_bytes": 5, "sha256": hashlib.sha256(b"video").hexdigest(), "mime_type": "video/mp4", "file_extension": "mp4", "duration_seconds": 25, "width": 1080, "height": 1920, "video_codec": "hevc", "audio_codec": "aac"},
                    "account": {"id": 9, "username": "worker-test-channel", "display_name": "worker-test-channel", "platform": "youtube"},
                    "device": {"id": 5, "device_id": "worker-test-android"}},
        }
        client = PublisherApiClient("https://api.example.test", "secret-token", "worker-a", opener=lambda request, timeout: FakeResponse(body=__import__('json').dumps(fixture).encode()))
        claim = client.claim(5)
        self.assertEqual(claim.job.media_id, claim.job.media["id"])
        self.assertEqual(claim.job.media["mime_type"], "video/mp4")
        self.assertEqual(claim.job.account["username"], "worker-test-channel")
        self.assertEqual(claim.job.device["device_id"], "worker-test-android")
        for media in ({}, {"id": 3}, {**fixture["job"]["media"], "id": 4}, {**fixture["job"]["media"], "sha256": "UPPER"}, {**fixture["job"]["media"], "mime_type": "text/plain"}, {**fixture["job"]["media"], "file_extension": "mov"}):
            with self.subTest(media=media):
                with self.assertRaises(PublisherError) as raised: PublicationJob.from_json({**fixture["job"], "media": media})
                self.assertEqual(raised.exception.code, "JOB_INVALID")
        for mutation in (
            lambda job: job.update(id="7"),
            lambda job: job.update(device_id=True),
            lambda job: job.update(media_id="3"),
            lambda job: job.update(platform=["youtube"]),
            lambda job: job.update(caption=123),
            lambda job: job.update(status="queued"),
            lambda job: job.update(media=[("id", 3)]),
            lambda job: job.update(media="3"),
            lambda job: job["media"].update(size_bytes="5"),
            lambda job: job.pop("account"),
            lambda job: job["account"].update(username=""),
            lambda job: job["account"].update(platform="tiktok"),
            lambda job: job["device"].update(device_id=""),
        ):
            with self.subTest(mutation=mutation):
                invalid = copy.deepcopy(fixture["job"]); mutation(invalid)
                with self.assertRaises(PublisherError) as raised: PublicationJob.from_json(invalid)
                self.assertEqual(raised.exception.code, "JOB_INVALID")

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

    def test_download_closes_response_when_disk_write_fails(self):
        response = FakeResponse(body=b"video")
        response.close = lambda: setattr(response, "closed", True)
        client = PublisherApiClient("https://api.example.test", "secret-token", "worker-a", opener=lambda request, timeout: response)
        with tempfile.TemporaryDirectory() as directory:
            target = os.path.join(directory, "clip.mp4")
            import unittest.mock
            with unittest.mock.patch("pathlib.Path.open", side_effect=OSError("disk full")):
                with self.assertRaises(OSError): client.download_media(9, "claim-1", target, {"size_bytes": 5, "sha256": "0" * 64})
        self.assertTrue(response.closed)
