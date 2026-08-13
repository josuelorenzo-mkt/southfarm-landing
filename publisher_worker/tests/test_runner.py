import os
import sys
from pathlib import Path
import tempfile
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.models import ClaimedJob, JobCancelled, PublicationJob
from southfarm_publisher.runner import PublicationRunner


class FakeApi:
    def __init__(self, job): self.job = job; self.calls = []; self.cancel = False
    def claim(self, device_id): self.calls.append(("claim", device_id)); return ClaimedJob(self.job, "claim-token")
    def heartbeat(self, job_id, token): self.calls.append(("heartbeat", job_id)); return {"cancel_requested": self.cancel}
    def checkpoint(self, job_id, token, step, progress, final_action=False, evidence=None): self.calls.append(("checkpoint", step, progress, final_action))
    def finish(self, job_id, token, status, **kwargs): self.calls.append(("finish", status))
    def download_media(self, media_id, token, target, metadata):
        with open(target, "wb") as handle: handle.write(b"video")
        return target
    def availability(self, device_id): self.calls.append(("availability", device_id)); return {"device": {"device_id": "android-secure-id"}, "available": True}


class FakeRegistry:
    def __init__(self): self.lookups = []
    def open(self, device_id): self.lookups.append(device_id); return FakeDevice()

class FakeDevice:
    def __init__(self): self.calls = []
    def push(self, local, remote): self.calls.append(("push", local, remote))
    def scan_media(self, remote): self.calls.append(("scan", remote))
    def remove(self, remote): self.calls.append(("remove", remote))


class Adapter:
    def __init__(self, fail_after_final=False): self.fail_after_final = fail_after_final; self.cleaned = False
    def prepare(self, job, device): pass
    def publish(self, job, device, checkpoint):
        checkpoint("preparing", 10)
        checkpoint("publishing", 90, final_action=True)
        if self.fail_after_final: raise RuntimeError("unknown outcome")
    def verify(self, job, device): return "post-id"
    def cleanup(self, job, device): self.cleaned = True


class RunnerTests(unittest.TestCase):
    def job(self): return PublicationJob(id=7, device_id=5, media_id=3, platform="youtube", caption="safe test", media={"size_bytes": 5, "sha256": "x"})
    def test_post_final_exception_finishes_review_required_and_cleans_up(self):
        api = FakeApi(self.job()); adapter = Adapter(fail_after_final=True); registry = FakeRegistry()
        with tempfile.TemporaryDirectory() as directory:
            runner = PublicationRunner(api, registry, {"youtube": adapter}, temp_dir=directory, heartbeat_interval=999)
            runner.run_once(5)
            self.assertEqual(registry.lookups, ["android-secure-id"])
            self.assertEqual([entry[1] for entry in api.calls if entry[0] == "checkpoint"], ["transferring", "preparing", "publishing"])
            self.assertIn(("finish", "review_required"), api.calls)
            self.assertTrue(adapter.cleaned)
            self.assertEqual(os.listdir(directory), [])
    def test_heartbeat_cancellation_raises_and_finishes_cancelled(self):
        api = FakeApi(self.job()); api.cancel = True; adapter = Adapter()
        runner = PublicationRunner(api, FakeRegistry(), {"youtube": adapter}, heartbeat_interval=999)
        with self.assertRaises(JobCancelled): runner._heartbeat_once(7, "claim-token")
        self.assertEqual(runner.backoff_seconds(lambda: 0.0), 2.0)
        self.assertEqual(runner.backoff_seconds(lambda: 1.0), 30.0)

    def test_pre_final_cancellation_finishes_cancelled_and_cleans_adapter(self):
        api = FakeApi(self.job()); api.cancel = True; adapter = Adapter()
        runner = PublicationRunner(api, FakeRegistry(), {"youtube": adapter}, heartbeat_interval=999)
        runner.run_once(5)
        self.assertIn(("finish", "cancelled"), api.calls)
        self.assertTrue(adapter.cleaned)

    def test_unavailable_device_is_finished_as_pre_final_failure(self):
        api = FakeApi(self.job())
        api.availability = lambda device_id: {"available": False, "device": {"device_id": "android-secure-id"}}
        runner = PublicationRunner(api, FakeRegistry(), {"youtube": Adapter()}, heartbeat_interval=999)
        runner.run_once(5)
        self.assertIn(("finish", "failed"), api.calls)
