import os
import hashlib
import sys
from pathlib import Path
import tempfile
import unittest
import threading
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.models import ClaimedJob, JobCancelled, PublicationJob
from southfarm_publisher.runner import PublicationRunner, _config
from southfarm_publisher.platforms import InstagramPublisher, TikTokPublisher, YouTubeShortPublisher


class FakeApi:
    def __init__(self, job): self.job = job; self.calls = []; self.cancel = False
    def claim(self, device_id): self.calls.append(("claim", device_id)); return ClaimedJob(self.job, "claim-token")
    def heartbeat(self, job_id, token): self.calls.append(("heartbeat", job_id)); return {"cancel_requested": self.cancel}
    def checkpoint(self, job_id, token, step, progress, final_action=False, evidence=None): self.calls.append(("checkpoint", step, progress, final_action))
    def finish(self, job_id, token, status, **kwargs): self.calls.append(("finish", status))
    def download_media(self, media_id, token, target, metadata):
        with open(target, "wb") as handle: handle.write(b"video")
        return target
    worker_id = "worker-a"
    def availability(self, device_id): self.calls.append(("availability", device_id)); return {"device": {"device_id": "android-secure-id"}, "online": True, "available": False, "reasons": ["device_busy_publication"], "publication_lock": {"publication_job_id": 7, "worker_id": "worker-a"}}


class FakeRegistry:
    def __init__(self): self.lookups = []
    def open(self, device_id): self.lookups.append(device_id); return FakeDevice()

class FakeDevice:
    def __init__(self): self.calls = []
    def push(self, local, remote): self.calls.append(("push", local, remote))
    def scan_media(self, remote): self.calls.append(("scan", remote))
    def remove(self, remote): self.calls.append(("remove", remote))

class ScriptDevice(FakeDevice):
    def __init__(self, package, dumps): super().__init__(); self.package, self.dumps, self.typed = package, list(dumps), []
    def foreground_package(self): return self.package
    def dump_ui(self): return self.dumps.pop(0) if self.dumps else []
    def tap_bounds(self, bounds, delay_seconds=0): self.calls.append(("tap", bounds))
    def text(self, value): self.typed.append(value)
    def command(self, *args, **kwargs): return ""

def ui(**values):
    values.setdefault("bounds", "[10,20][110,80]"); values.setdefault("clickable", "true"); values.setdefault("enabled", "true")
    return values

def platform_dumps(platform):
    account = "expected.account"; remote = "publication-7-3.mp4"
    if platform == "instagram": return [
        [ui(text=account), ui(**{"content-desc": "Create New"})], [ui(**{"content-desc": "Create new reel"})], [ui(**{"content-desc": "Video thumbnail created today 0:25"})], [ui(**{"resource-id": "com.instagram.android:id/clips_right_action_button"})], [ui(text="Continue"), ui(text="Downloads privacy")], [ui(text="Write a caption and add hashtags...")], [ui(**{"class": "android.widget.EditText", "text": ""})], [ui(**{"class": "android.widget.EditText", "text": "safe"})], [ui(**{"class": "android.widget.EditText", "text": "safe test"})], [ui(text="Next")], [ui(text="About Reels"), ui(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button", "bounds": "[600,1400][700,1500]"})], [ui(text="About Reels"), ui(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button", "bounds": "[600,1400][700,1500]"})], [ui(text="expected.account"), ui(**{"content-desc": "safe test reel"})]]
    if platform == "tiktok": return [
        [ui(text=account), ui(text="Create")], [ui(text="Upload")], [ui(**{"resource-id": "com.zhiliaoapp.musically:id/ica", "content-desc": remote})], [ui(text="Next (1)")], [ui(text="Next")], [ui(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00"})], [ui(**{"class": "android.widget.EditText", "text": ""})], [ui(**{"class": "android.widget.EditText", "text": "safe"})], [ui(**{"class": "android.widget.EditText", "text": "safe test"})], [ui(text="Add description..."), ui(text="Public"), ui(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6"})], [ui(text="Add description..."), ui(text="Public"), ui(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6"})], [ui(text=account), ui(**{"content-desc": "safe test 0"})]]
    return [
        [ui(text=account), ui(text="Create")], [ui(text="Short", **{"resource-id": "com.google.android.youtube:id/creation_mode_button"})], [ui(**{"resource-id": "com.google.android.youtube:id/reel_camera_gallery_button_delegate"})], [ui(**{"resource-id": "com.google.android.youtube:id/thumb_image_view", "content-desc": remote})], [ui(text="Next", **{"resource-id": "com.google.android.youtube:id/multi_select_next_button"})], [ui(text="Done", **{"resource-id": "com.google.android.youtube:id/creation_next_button"})], [ui(text="Next", **{"resource-id": "com.google.android.youtube:id/shorts_post_bottom_button"})], [ui(text="Caption your Short", **{"class": "android.widget.EditText"})], [ui(**{"class": "android.widget.EditText", "text": ""})], [ui(**{"class": "android.widget.EditText", "text": "safe"})], [ui(**{"class": "android.widget.EditText", "text": "safe test"})], [ui(text="Caption your Short"), ui(text="Public"), ui(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button"})], [ui(text="Caption your Short"), ui(text="Public"), ui(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button"})], [ui(text="You")], [ui(**{"content-desc": "View channel"})], [ui(**{"content-desc": "safe test, No views - play Short"})]]

class ScriptRegistry:
    def __init__(self, device): self.device = device
    def open(self, device_id): return self.device


class Adapter:
    def __init__(self, fail_after_final=False): self.fail_after_final = fail_after_final; self.cleaned = False
    def prepare(self, job, device): pass
    def publish(self, job, device, checkpoint):
        checkpoint("publishing", 90, final_action=True)
        if self.fail_after_final: raise RuntimeError("unknown outcome")
    def verify(self, job, device): return "post-id"
    def cleanup(self, job, device): self.cleaned = True

class FlowAdapter(Adapter):
    def __init__(self, platform): super().__init__(); self.platform = platform
    def prepare(self, job, device): pass
    def publish(self, job, device, checkpoint):
        checkpoint("selecting_media", 25); checkpoint("editing", 45); checkpoint("captioning", 65); checkpoint("ready_to_publish", 80); checkpoint("publishing", 90, final_action=True)
    def verify(self, job, device): return f"{self.platform}-verified-post"

class ResponseLossApi(FakeApi):
    def checkpoint(self, job_id, token, step, progress, final_action=False, evidence=None):
        super().checkpoint(job_id, token, step, progress, final_action, evidence)
        if final_action: raise OSError("lost response")


class RunnerTests(unittest.TestCase):
    def job(self): return PublicationJob(id=7, device_id=5, media_id=3, platform="youtube", caption="safe test", media={"size_bytes": 5, "sha256": hashlib.sha256(b"video").hexdigest(), "mime_type": "video/mp4", "file_extension": "mp4", "duration_seconds": 25, "width": 1080, "height": 1920, "video_codec": "hevc", "audio_codec": "aac"})
    def test_post_final_exception_finishes_review_required_and_cleans_up(self):
        api = FakeApi(self.job()); adapter = Adapter(fail_after_final=True); registry = FakeRegistry()
        with tempfile.TemporaryDirectory() as directory:
            runner = PublicationRunner(api, registry, {"youtube": adapter}, temp_dir=directory, heartbeat_interval=999)
            runner.run_once(5)
            self.assertEqual(registry.lookups, ["android-secure-id"])
            self.assertEqual([entry[1] for entry in api.calls if entry[0] == "checkpoint"], ["preparing", "transferring", "publishing"])
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
        api.availability = lambda device_id: {"available": False, "online": False, "device": {"device_id": "android-secure-id"}}
        runner = PublicationRunner(api, FakeRegistry(), {"youtube": Adapter()}, heartbeat_interval=999)
        runner.run_once(5)
        self.assertIn(("finish", "failed"), api.calls)

    def test_lost_final_checkpoint_response_becomes_review_required(self):
        api = ResponseLossApi(self.job()); runner = PublicationRunner(api, FakeRegistry(), {"youtube": Adapter()}, heartbeat_interval=999)
        runner.run_once(5)
        self.assertIn(("finish", "review_required"), api.calls)

    def test_adapter_must_checkpoint_final_action_before_completion(self):
        class NoFinal(Adapter):
            def publish(self, job, device, checkpoint): checkpoint("editing", 40)
        api = FakeApi(self.job()); runner = PublicationRunner(api, FakeRegistry(), {"youtube": NoFinal()}, heartbeat_interval=999)
        runner.run_once(5)
        self.assertIn(("finish", "failed"), api.calls)

    def test_missing_platform_adapter_finishes_claim_once_without_heartbeat_leak(self):
        api = FakeApi(self.job()); runner = PublicationRunner(api, FakeRegistry(), {"instagram": Adapter()}, heartbeat_interval=999)
        runner.run_once(5)
        self.assertEqual([call for call in api.calls if call == ("finish", "failed")], [("finish", "failed")])
        self.assertEqual([call for call in api.calls if call[0] == "heartbeat"], [])

    def test_empty_adapter_registry_fails_before_any_claim(self):
        with self.assertRaises(Exception): PublicationRunner(FakeApi(self.job()), FakeRegistry(), {})

    def test_terminal_finish_failure_propagates_after_heartbeat_shutdown(self):
        class BrokenFinish(FakeApi):
            def finish(self, *args, **kwargs): raise RuntimeError("finish unavailable")
        runner = PublicationRunner(BrokenFinish(self.job()), FakeRegistry(), {"instagram": Adapter()}, heartbeat_interval=999)
        with self.assertRaisesRegex(RuntimeError, "finish unavailable"): runner.run_once(5)

    def test_terminal_finish_transport_failures_are_not_retried_or_reclassified(self):
        class RaisingFinishApi(FakeApi):
            def __init__(self, job, failure, lose_final_checkpoint=False):
                super().__init__(job); self.failure = failure; self.lose_final_checkpoint = lose_final_checkpoint; self.finish_attempts = 0; self.heartbeat_after_finish = False; self.finished = False
            def heartbeat(self, job_id, token):
                if self.finished: self.heartbeat_after_finish = True
                return super().heartbeat(job_id, token)
            def checkpoint(self, job_id, token, step, progress, final_action=False, evidence=None):
                super().checkpoint(job_id, token, step, progress, final_action, evidence)
                if self.lose_final_checkpoint and final_action: raise OSError("final checkpoint response lost")
            def finish(self, job_id, token, status, **kwargs):
                self.finish_attempts += 1; self.calls.append(("finish", status)); self.finished = True
                raise self.failure
        cases = [
            (ConnectionError("finish not sent"), False, "completed"),
            (OSError("finish response lost"), True, "review_required"),
        ]
        for failure, lose_final_checkpoint, expected_status in cases:
            with self.subTest(failure=failure):
                adapter = Adapter(); api = RaisingFinishApi(self.job(), failure, lose_final_checkpoint)
                runner = PublicationRunner(api, FakeRegistry(), {"youtube": adapter}, heartbeat_interval=999)
                with self.assertRaisesRegex(type(failure), str(failure)):
                    runner.run_once(5)
                self.assertEqual(api.finish_attempts, 1)
                self.assertEqual([call for call in api.calls if call[0] == "finish"], [("finish", expected_status)])
                self.assertFalse(api.heartbeat_after_finish)
                self.assertFalse(any(thread.name == "southfarm-publisher-heartbeat-7" and thread.is_alive() for thread in threading.enumerate()))
                self.assertTrue(adapter.cleaned)

    def test_terminal_finish_waits_for_inflight_heartbeat(self):
        entered, release, complete, finished = threading.Event(), threading.Event(), threading.Event(), threading.Event()
        class BlockingApi(FakeApi):
            def __init__(self, job): super().__init__(job); self.heartbeats = 0
            def heartbeat(self, job_id, token):
                self.heartbeats += 1
                if self.heartbeats == 2:
                    entered.set(); release.wait(2)
                return {"cancel_requested": False}
            def finish(self, *args, **kwargs):
                finished.set(); return super().finish(*args, **kwargs)
        class WaitAdapter(Adapter):
            def prepare(self, job, device): entered.wait(2); raise RuntimeError("pre-final failure")
        api = BlockingApi(self.job()); runner = PublicationRunner(api, FakeRegistry(), {"youtube": WaitAdapter()}, heartbeat_interval=1)
        thread = threading.Thread(target=lambda: (runner.run_once(5), complete.set()))
        thread.start(); self.assertTrue(entered.wait(2)); self.assertFalse(finished.wait(1.25), "finish raced the in-flight heartbeat")
        release.set(); thread.join(3)
        self.assertTrue(complete.is_set()); self.assertIn(("finish", "failed"), api.calls); self.assertFalse(thread.is_alive())

    def test_run_forever_uses_bounded_idle_backoff(self):
        runner = PublicationRunner(FakeApi(self.job()), FakeRegistry(), {"youtube": Adapter()})
        runner.run_once = lambda device_id: False
        stop = type("Stop", (), {"calls": 0, "is_set": lambda self: self.calls > 0})()
        waits = []
        def sleep(seconds): waits.append(seconds); stop.calls += 1
        runner.run_forever(5, stop=stop, sleep=sleep, random_value=lambda: 0.5)
        self.assertEqual(waits, [16.0])

    def test_runner_completes_each_social_platform_with_full_adapter_contract(self):
        for platform in ("instagram", "tiktok", "youtube"):
            with self.subTest(platform=platform):
                claimed = self.job()
                claimed = PublicationJob(id=claimed.id, device_id=claimed.device_id, media_id=claimed.media_id, platform=platform, caption=claimed.caption, media=claimed.media)
                api = FakeApi(claimed); adapter = FlowAdapter(platform)
                PublicationRunner(api, FakeRegistry(), {platform: adapter}, heartbeat_interval=999).run_once(5)
                self.assertIn(("finish", "completed"), api.calls)
                self.assertEqual([call[1] for call in api.calls if call[0] == "checkpoint"], ["preparing", "transferring", "selecting_media", "editing", "captioning", "ready_to_publish", "publishing", "verifying"])

    def test_runner_completes_with_each_real_platform_adapter(self):
        table = {"instagram": (InstagramPublisher, "com.instagram.android"), "tiktok": (TikTokPublisher, "com.zhiliaoapp.musically"), "youtube": (YouTubeShortPublisher, "com.google.android.youtube")}
        for platform, (cls, package) in table.items():
            with self.subTest(platform=platform):
                base = self.job(); media = {**base.media, **({"duration_seconds": 25} if platform == "instagram" else {})}; claimed = PublicationJob(base.id, base.device_id, base.media_id, platform, base.caption, media)
                api = FakeApi(claimed); device = ScriptDevice(package, platform_dumps(platform))
                PublicationRunner(api, ScriptRegistry(device), {platform: cls(expected_account="expected.account")}, heartbeat_interval=999).run_once(5)
                self.assertIn(("finish", "completed"), api.calls)
                self.assertEqual([call[1] for call in api.calls if call[0] == "checkpoint"], ["preparing", "transferring", "selecting_media", "editing", "captioning", "ready_to_publish", "publishing", "verifying"])

    def test_runner_final_checkpoint_response_loss_never_allows_another_final_tap(self):
        class OneFinalTap(FlowAdapter):
            def __init__(self): super().__init__("youtube"); self.final_taps = 0
            def publish(self, job, device, checkpoint):
                checkpoint("selecting_media", 25); checkpoint("editing", 45); checkpoint("captioning", 65); checkpoint("ready_to_publish", 80); checkpoint("publishing", 90, final_action=True); self.final_taps += 1
        api = ResponseLossApi(self.job()); adapter = OneFinalTap()
        PublicationRunner(api, FakeRegistry(), {"youtube": adapter}, heartbeat_interval=999).run_once(5)
        self.assertEqual(adapter.final_taps, 0, "the response loss raised before irreversible tap")
        self.assertIn(("finish", "review_required"), api.calls)

    def test_runner_real_instagram_checkpoint_response_loss_never_taps_share(self):
        base = self.job(); claimed = PublicationJob(base.id, base.device_id, base.media_id, "instagram", base.caption, {**base.media, "duration_seconds": 25})
        api = ResponseLossApi(claimed); device = ScriptDevice("com.instagram.android", platform_dumps("instagram"))
        PublicationRunner(api, ScriptRegistry(device), {"instagram": InstagramPublisher(expected_account="expected.account")}, heartbeat_interval=999).run_once(5)
        self.assertIn(("finish", "review_required"), api.calls)
        self.assertFalse(any(call == ("tap", (600, 1400, 700, 1500)) for call in device.calls))

    def test_config_rejects_missing_or_invalid_adb_without_secret_echo(self):
        with self.assertRaises(Exception) as raised:
            _config({"SOUTHFARM_API_URL": "https://api.test", "SOUTHFARM_PUBLISHER_WORKER_TOKEN": "very-secret", "SOUTHFARM_PUBLISHER_WORKER_ID": "worker", "SOUTHFARM_PUBLISHER_DEVICE_ID": "5", "SOUTHFARM_ADB": "C:/not-present/adb.exe"})
        self.assertNotIn("very-secret", str(raised.exception))
