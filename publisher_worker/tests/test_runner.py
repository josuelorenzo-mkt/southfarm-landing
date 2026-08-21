import os
import hashlib
import sys
from pathlib import Path
import tempfile
import unittest
import threading
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.models import ClaimedJob, JobCancelled, PublicationJob, PublicationStatus, PublisherError
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
    def ensure_accessibility_healthy(self): self.calls.append(("health_check",))
    def ensure_network_up(self): self.calls.append(("network_check",))
    def push(self, local, remote): self.calls.append(("push", local, remote))
    def scan_media(self, remote): self.calls.append(("scan", remote))
    def remove(self, remote): self.calls.append(("remove", remote))

class ScriptDevice(FakeDevice):
    def __init__(self, package, dumps, explicit=None): super().__init__(); self.package, self.dumps, self.typed, self._last, self._after = package, list(dumps), [], None, True; self.explicit = list(explicit or [])
    def foreground_package(self): return self.package
    def dump_ui(self):
        if self._after or self._last is None:
            self._last = self.dumps.pop(0) if self.dumps else []
            self._after = False
        return self._last
    def dump_ui_explicit(self, source):
        return self.explicit.pop(0) if self.explicit else []
    def tap_bounds(self, bounds, delay_seconds=0): self.calls.append(("tap", bounds)); self._after = True
    def swipe(self, x1, y1, x2, y2, duration_ms=300): self.calls.append(("swipe", (x1, y1, x2, y2, duration_ms))); self._after = True
    def swipe_bezier(self, x1, y1, x2, y2, duration_ms=400): self.calls.append(("swipe_bezier", (x1, y1, x2, y2, duration_ms))); self._after = True
    def text(self, value): self.typed.append(value); self._after = True
    def command(self, *args, **kwargs):
        if "keyevent" in args: self._after = True
        return ""

def ui(**values):
    values.setdefault("bounds", "[10,20][110,80]"); values.setdefault("clickable", "true"); values.setdefault("enabled", "true")
    return values

def instagram_publish_dumps(account):
    """Scripted Instagram revisions from launch through the Share tap."""
    return [
        [ui(**{"content-desc": "Profile", "resource-id": "com.instagram.android:id/profile_tab"})],
        [ui(text=account, **{"resource-id": "com.instagram.android:id/action_bar_title"}), ui(**{"content-desc": "Create New"}), ui(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "8posts"}), ui(**{"content-desc": "Reel by Expected at row 1, column 1", "resource-id": "com.instagram.android:id/image_button", "bounds": "[0,834][238,1151]"})],
        [ui(**{"content-desc": "Create new reel"})],
        [ui(text="New reel", **{"resource-id": "com.instagram.android:id/gallery_title_text"}), ui(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail created today", "bounds": "[0,100][200,300]"}), ui(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,260][200,300]"}), ui(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail created yesterday", "bounds": "[0,300][200,500]"}), ui(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,460][200,500]"})],
        [ui(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Selected Video thumbnail created today", "bounds": "[0,100][200,300]"}), ui(text="Next", **{"resource-id": "com.instagram.android:id/next_button_textview"})],
        [ui(**{"resource-id": "com.instagram.android:id/clips_right_action_button", "content-desc": "Next"})],
        [ui(text="Write a caption and add hashtags…", **{"resource-id": "com.instagram.android:id/caption_input_text_view", "content-desc": "Write a caption"}), ui(**{"resource-id": "com.instagram.android:id/save_draft_button", "content-desc": "Save draft"}), ui(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share", "bounds": "[600,1400][700,1500]"})],
        [ui(text="Write a caption and add hashtags…", **{"resource-id": "com.instagram.android:id/caption_input_text_view", "content-desc": "Write a caption"}), ui(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share", "bounds": "[600,1400][700,1500]"})],
        [ui(text="safe test", **{"resource-id": "com.instagram.android:id/caption_input_text_view"}), ui(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share", "bounds": "[600,1400][700,1500]"})],
        [ui(text="safe test", **{"resource-id": "com.instagram.android:id/caption_input_text_view"}), ui(**{"resource-id": "com.instagram.android:id/save_draft_button", "content-desc": "Save draft"}), ui(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share", "bounds": "[600,1400][700,1500]"})],
    ]

def instagram_completed_tail(account):
    """Post-Share revisions for the agile verify sequence that completes.

    Pop order: Profile tab and Home tab lookups of the re-sync cycle, the
    tabbed profile with the 9posts delta, the pre-identity recomposition
    cycle (Home lookup, tabbed profile), the identity grid dump, then the
    opened viewer carrying the caption.
    """
    tab = {"resource-id": "com.instagram.android:id/profile_tab", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"}
    home = {"resource-id": "com.instagram.android:id/feed_tab", "content-desc": "Home", "bounds": "[0,1456][144,1544]"}
    profile9 = [ui(text=account, **{"resource-id": "com.instagram.android:id/action_bar_title"}), ui(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "9posts"}), ui(**{"content-desc": "Reel by Expected at row 1, column 1", "resource-id": "com.instagram.android:id/image_button", "bounds": "[0,834][238,1151]"}), ui(**tab), ui(**home)]
    return [
        [ui(**tab)],
        [ui(**home)],
        profile9,           # re-sync last Profile lookup
        profile9,           # post-refresh composite check: 9posts delta
        [ui(**home)],       # identity resync: Home lookup
        profile9,           # identity resync: last Profile lookup
        profile9,           # identity grid dump before the tile tap
        [ui(**{"resource-id": "com.instagram.android:id/clips_media_component", "content-desc": f"Reel by {account}. Double tap to play or pause."}), ui(text="safe test")],
    ]

def instagram_unverified_tail(account):
    """Post-Share revisions for the agile verify sequence that never verifies."""
    tab = {"resource-id": "com.instagram.android:id/profile_tab", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"}
    home = {"resource-id": "com.instagram.android:id/feed_tab", "content-desc": "Home", "bounds": "[0,1456][144,1544]"}
    profile8 = [ui(text=account, **{"resource-id": "com.instagram.android:id/action_bar_title"}), ui(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "8posts"}), ui(**{"content-desc": "Reel by Expected at row 1, column 1", "resource-id": "com.instagram.android:id/image_button", "bounds": "[0,834][238,1151]"}), ui(**tab), ui(**home)]
    return [[ui(**tab)], [ui(**home)], profile8, profile8, profile8, profile8]

def youtube_tabs():
    """YouTube bottom bar (recon 2026-08-17): Buttons WITHOUT resource-id,
    semantic content-desc only."""
    return [
        ui(**{"content-desc": "Home", "bounds": "[0,1448][144,1544]"}),
        ui(**{"content-desc": "Create", "bounds": "[288,1448][432,1544]"}),
        ui(**{"content-desc": "You", "bounds": "[576,1448][720,1544]"}),
    ]

def youtube_you(account):
    handle = f"@{account}"
    return [ui(text=handle, **{"content-desc": handle}), ui(**{"content-desc": "View channel", "bounds": "[32,368][352,432]"}), *youtube_tabs()]

def youtube_channel(tiles):
    """Channel profile grid: the special 'Drafts' tile precedes the Shorts."""
    return [ui(**{"content-desc": "Drafts"})] + [ui(**{"content-desc": desc}) for desc in tiles]

def youtube_publish_prefix(remote):
    """Scripted YouTube revisions from launch through the upload confirmation."""
    return [
        youtube_tabs(),
        youtube_you("expected.account"),
        youtube_channel(["older Short, 12 views - play Short"]),
        youtube_tabs(),
        [ui(**{"resource-id": "com.google.android.youtube:id/reel_camera_gallery_button_delegate", "content-desc": "Import video from photo library"})],
        [ui(**{"resource-id": "com.google.android.youtube:id/thumb_image_view", "content-desc": remote, "clickable": "false", "bounds": "[0,100][200,300]"})],
        [ui(**{"resource-id": "com.google.android.youtube:id/thumb_image_view", "content-desc": remote, "clickable": "false", "bounds": "[0,100][200,300]"}), ui(**{"resource-id": "com.google.android.youtube:id/selected_state", "text": "1"}), ui(text="Next", **{"resource-id": "com.google.android.youtube:id/multi_select_next_button"})],
        [ui(text="Done", **{"resource-id": "com.google.android.youtube:id/creation_next_button"})],
        [ui(text="Next", **{"resource-id": "com.google.android.youtube:id/shorts_post_bottom_button"})],
        [ui(text="Uploaded to Your Channel"), ui(**{"content-desc": "safe test, No views - play Short"}), *youtube_tabs()],
    ]

def youtube_explicit():
    return [
        [ui(**{"class": "android.widget.EditText", "text": "", "content-desc": "Caption your Short"})],
        [ui(**{"class": "android.widget.EditText", "text": "safe test"})],
        [ui(**{"class": "android.widget.EditText", "text": "safe test"}), ui(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button", "bounds": "[20,1400][700,1520]"})],
    ]

def youtube_completed_tail(account):
    """Agile verify revisions: Home/You tab lookups, View channel, the grid
    with the caption-prefix + "No views" delta, then the opened player
    carrying the caption (the fake repeats the current revision between taps,
    so the player lands on the first post-tap read)."""
    new_tile = "safe test, No views - play Short"
    return [
        youtube_tabs(),
        youtube_you(account),
        youtube_channel([new_tile, "older Short, 12 views - play Short"]),
        [ui(text="safe test")],
    ]

def youtube_unverified_tail(account):
    """Agile verify revisions that never show the delta: three checks."""
    return [
        youtube_tabs(),
        youtube_you(account),
        youtube_channel(["older Short, 12 views - play Short"]),
        youtube_channel(["older Short, 12 views - play Short"]),
        youtube_channel(["older Short, 12 views - play Short"]),
    ]

def platform_dumps(platform):
    """Scripted (service, explicit) UI revisions modelling each real adapter's verified flow."""
    account = "expected.account"; remote = "publication-7-3.mp4"
    if platform == "instagram": return instagram_publish_dumps(account) + instagram_completed_tail(account), []
    if platform == "tiktok":
        profile_tab = {"resource-id": "com.zhiliaoapp.musically:id/o76", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"}
        home_tab = {"content-desc": "Home", "bounds": "[0,1456][144,1544]"}
        def profile_delta():
            return [
                ui(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
                ui(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
                ui(**{"content-desc": "new cover", "bounds": "[0,834][238,1151]"}),
                ui(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
                ui(**{"content-desc": "older cover", "bounds": "[248,834][486,1151]"}),
                ui(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[328,1100][408,1150]"}),
                ui(**profile_tab), ui(**home_tab),
            ]
        # The "Video posted!" toast overlays the profile screen, so its dump
        # carries the bottom bar: the agile verify's first tab lookup reads it
        # (the fake serves the current revision until a tap advances it).
        posted_with_tabs = [
            ui(text="Video posted!", **{"resource-id": "com.zhiliaoapp.musically:id/zxp", "bounds": "[200,180][520,240]"}),
            ui(**profile_tab), ui(**home_tab),
        ]
        # Agile verify tail: Profile/Home tab lookups of the re-sync cycle,
        # the tabbed profile with the ["0", "12"] play-count delta, the
        # pre-identity recomposition cycle, the identity grid dump, then the
        # opened viewer carrying the caption.
        return [
            [ui(text="Profile")],
            [ui(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}), ui(**{"resource-id": "com.zhiliaoapp.musically:id/o70", "content-desc": "Create"}), ui(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}), ui(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"})],
            [ui(**{"resource-id": "com.zhiliaoapp.musically:id/upload_hot_area", "bounds": "[10,1700][220,1900]"})],
            [ui(**{"content-desc": "Videos", "bounds": "[10,280][200,360]"})],
            [ui(**{"content-desc": "Videos", "bounds": "[10,280][200,360]"}), ui(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"}), ui(text="00:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,520][220,560]"})],
            [ui(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/x4j", "bounds": "[520,2100][700,2200]"})],
            [ui(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[520,2100][700,2200]"})],
            [ui(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"})],
            [ui(text="", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "true", "bounds": "[10,1300][700,1380]"})],
            [ui(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "true", "bounds": "[10,1300][700,1380]"})],
            [ui(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"}), ui(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6", "bounds": "[520,2100][700,2200]"})],
            posted_with_tabs,
            [ui(**home_tab)],
            profile_delta(),
            profile_delta(),
            [ui(**home_tab)],
            profile_delta(),
            profile_delta(),
            [ui(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/desc", "clickable": "false", "bounds": "[10,300][710,380]"})],
        ], []
    # YouTube hybrid: service dumps for the You-tab identity, the channel
    # grid baseline, Home/picker/trim/editor/post-share, and uiautomator-only
    # dumps for the Google-protected Add details screen.
    return youtube_publish_prefix(remote) + youtube_completed_tail(account), youtube_explicit()

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
    def test_publication_job_keeps_an_immutable_account_username_snapshot(self):
        account = {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "youtube"}
        claimed = PublicationJob(7, 5, 3, "youtube", "safe test", self.job().media, account)

        account["username"] = "different.account"

        self.assertEqual(claimed.account["username"], "expected.account")
        with self.assertRaises(TypeError):
            claimed.account["username"] = "another.account"

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

    def test_unavailable_selected_account_finishes_once_without_media_transfer_or_final_checkpoint(self):
        class AccountUnavailable(Adapter):
            def prepare(self, job, device):
                raise PublisherError("ACCOUNT_UNAVAILABLE", "The selected scanned account is unavailable on this device")

        class LockedApi(FakeApi):
            def __init__(self, job):
                super().__init__(job); self.downloads = 0; self.finished = False; self.heartbeat_after_finish = False
            def heartbeat(self, job_id, token):
                if self.finished: self.heartbeat_after_finish = True
                return super().heartbeat(job_id, token)
            def download_media(self, *args, **kwargs):
                self.downloads += 1
                return super().download_media(*args, **kwargs)
            def finish(self, job_id, token, status, **kwargs):
                self.finished = True
                self.calls.append(("finish", status, kwargs.get("error_code")))

        api, registry = LockedApi(self.job()), FakeRegistry()
        PublicationRunner(api, registry, {"youtube": AccountUnavailable()}, heartbeat_interval=999).run_once(5)

        self.assertEqual(api.downloads, 0)
        self.assertEqual(registry.lookups, ["android-secure-id"])
        self.assertEqual([call[1] for call in api.calls if call[0] == "checkpoint"], ["preparing"])
        self.assertEqual([call for call in api.calls if call[0] == "finish"], [("finish", "failed", "ACCOUNT_UNAVAILABLE")])
        self.assertFalse(api.heartbeat_after_finish)
        self.assertFalse(any(thread.name == "southfarm-publisher-heartbeat-7" and thread.is_alive() for thread in threading.enumerate()))

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
                base = self.job(); media = {**base.media, **({"duration_seconds": 25} if platform == "instagram" else {})}; claimed = PublicationJob(base.id, base.device_id, base.media_id, platform, base.caption, media, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": platform})
                api = FakeApi(claimed); device = ScriptDevice(package, *platform_dumps(platform))
                # pause is faked so the agile verify waits (20s/3s/3s + 20s/10s retries + 1s pre-identity resync) do not sleep the suite.
                PublicationRunner(api, ScriptRegistry(device), {platform: cls(expected_account="expected.account", pause=lambda _: None)}, heartbeat_interval=999).run_once(5)
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
        base = self.job(); claimed = PublicationJob(base.id, base.device_id, base.media_id, "instagram", base.caption, {**base.media, "duration_seconds": 25}, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "instagram"})
        api = ResponseLossApi(claimed); device = ScriptDevice("com.instagram.android", *platform_dumps("instagram"))
        PublicationRunner(api, ScriptRegistry(device), {"instagram": InstagramPublisher(expected_account="expected.account", pause=lambda _: None)}, heartbeat_interval=999).run_once(5)
        self.assertIn(("finish", "review_required"), api.calls)
        self.assertFalse(any(call == ("tap", (600, 1400, 700, 1500)) for call in device.calls))

    def test_dead_accessibility_service_aborts_job_without_any_app_action(self):
        # The pre-flight health check runs before any checkpoint, media
        # transfer or app interaction: a service that stays dead even after
        # its one repair aborts the job with ACCESSIBILITY_SERVICE_DOWN.
        class DeadServiceDevice(FakeDevice):
            def ensure_accessibility_healthy(self):
                self.calls.append(("health_check",))
                raise PublisherError("ACCESSIBILITY_SERVICE_DOWN", "accessibility service stayed dead", retryable=True)
        class RecordingAdapter(Adapter):
            def __init__(self): super().__init__(); self.steps = []
            def prepare(self, job, device): self.steps.append("prepare")
            def publish(self, job, device, checkpoint): self.steps.append("publish")
            def verify(self, job, device): self.steps.append("verify")
        class FinishApi(FakeApi):
            def __init__(self, job): super().__init__(job); self.downloads = 0
            def download_media(self, *args, **kwargs): self.downloads += 1; return super().download_media(*args, **kwargs)
            def finish(self, job_id, token, status, **kwargs): self.calls.append(("finish", status, kwargs.get("error_code")))
        class DeadRegistry(FakeRegistry):
            def open(self, device_id): self.lookups.append(device_id); return DeadServiceDevice()
        api = FinishApi(self.job()); adapter = RecordingAdapter()
        PublicationRunner(api, DeadRegistry(), {"youtube": adapter}, heartbeat_interval=999).run_once(5)
        self.assertEqual([call for call in api.calls if call[0] == "finish"], [("finish", "failed", "ACCESSIBILITY_SERVICE_DOWN")])
        self.assertEqual(adapter.steps, [], "no adapter step runs when the accessibility service is down")
        self.assertEqual([call for call in api.calls if call[0] == "checkpoint"], [])
        self.assertEqual(api.downloads, 0)

    def test_accessibility_health_check_runs_before_adapter_prepare(self):
        # Live service (or a repair that succeeded): the check runs once,
        # before any app interaction, and the flow proceeds normally.
        device = FakeDevice(); order = []
        class RecordingAdapter(Adapter):
            def prepare(self, job, device): order.append(list(device.calls))
        registry = FakeRegistry(); registry.open = lambda device_id: device
        PublicationRunner(FakeApi(self.job()), registry, {"youtube": RecordingAdapter()}, heartbeat_interval=999).run_once(5)
        self.assertEqual(order, [[("health_check",), ("network_check",)]], "the health check then the network check are the only device calls before prepare")

    def test_device_offline_aborts_job_before_any_checkpoint_media_or_app(self):
        # The connectivity gate runs right after the accessibility
        # pre-flight: a device without working internet aborts with
        # DEVICE_OFFLINE (retryable) before any checkpoint, media
        # download/push or app interaction.
        class OfflineDevice(FakeDevice):
            def ensure_network_up(self):
                self.calls.append(("network_check",))
                raise PublisherError("DEVICE_OFFLINE", "The device has no working network connectivity", retryable=True)
        class RecordingAdapter(Adapter):
            def __init__(self): super().__init__(); self.steps = []
            def prepare(self, job, device): self.steps.append("prepare")
            def publish(self, job, device, checkpoint): self.steps.append("publish")
            def verify(self, job, device): self.steps.append("verify")
        class FinishApi(FakeApi):
            def __init__(self, job): super().__init__(job); self.downloads = 0
            def download_media(self, *args, **kwargs): self.downloads += 1; return super().download_media(*args, **kwargs)
            def finish(self, job_id, token, status, **kwargs): self.calls.append(("finish", status, kwargs.get("error_code")))
        device = OfflineDevice()
        class OfflineRegistry(FakeRegistry):
            def open(self, device_id): self.lookups.append(device_id); return device
        api = FinishApi(self.job()); adapter = RecordingAdapter()
        PublicationRunner(api, OfflineRegistry(), {"youtube": adapter}, heartbeat_interval=999).run_once(5)
        self.assertEqual([call for call in api.calls if call[0] == "finish"], [("finish", "failed", "DEVICE_OFFLINE")])
        self.assertEqual(adapter.steps, [], "no adapter step runs when the device is offline")
        self.assertEqual([call for call in api.calls if call[0] == "checkpoint"], [])
        self.assertEqual(api.downloads, 0)
        self.assertEqual(device.calls, [("health_check",), ("network_check",)], "only the two pre-flight checks ran; no media push was attempted")

    def test_network_check_runs_after_health_before_media_push(self):
        # Live connectivity (ping answered): the two pre-flight gates run
        # in order and the media push only happens after both passed.
        device = FakeDevice()
        class FixedRegistry(FakeRegistry):
            def open(self, device_id): self.lookups.append(device_id); return device
        PublicationRunner(FakeApi(self.job()), FixedRegistry(), {"youtube": Adapter()}, heartbeat_interval=999).run_once(5)
        kinds = [call[0] for call in device.calls]
        self.assertLess(kinds.index("health_check"), kinds.index("network_check"), "the health check precedes the network check")
        self.assertLess(kinds.index("network_check"), kinds.index("push"), "the media push happens only after both pre-flight gates")

    def test_unverified_adapter_result_finishes_review_required_with_verification_pending(self):
        # The worker-local `unverified` result (verify() -> None) is finished
        # through the closest backend-supported terminal state: NOT failed,
        # NOT completed, no error raised -- review_required with the
        # VERIFICATION_PENDING code and the adapter evidence in `result`.
        evidence = {"platform": "instagram", "stage": "verification_pending", "post_counts": [8], "last_dump": []}
        class UnverifiedAdapter(Adapter):
            verification_evidence = evidence
            def verify(self, job, device): return None
        class FinishApi(FakeApi):
            def finish(self, job_id, token, status, **kwargs): self.calls.append(("finish", status, kwargs))
        api = FinishApi(self.job()); adapter = UnverifiedAdapter()
        PublicationRunner(api, FakeRegistry(), {"youtube": adapter}, heartbeat_interval=999).run_once(5)
        finished = [call for call in api.calls if call[0] == "finish"]
        self.assertEqual(len(finished), 1)
        self.assertEqual(finished[0][1], "review_required")
        self.assertEqual(finished[0][2]["error_code"], "VERIFICATION_PENDING")
        self.assertIn("verification pending", finished[0][2]["error_message"])
        self.assertEqual(finished[0][2]["result"], evidence)
        self.assertNotIn("completed", [call[1] for call in api.calls if call[0] == "finish"])
        self.assertNotIn("failed", [call[1] for call in api.calls if call[0] == "finish"])
        self.assertTrue(adapter.cleaned)

    def test_unverified_status_sentinel_finishes_review_required_with_verification_pending(self):
        # The TikTok adapter returns models.PublicationStatus.UNVERIFIED
        # itself (instead of None): the runner must map the sentinel to the
        # same terminal outcome -- review_required + VERIFICATION_PENDING,
        # never completed and never failed.
        evidence = {"platform": "tiktok", "stage": "verification_pending", "play_counts": ["12"], "last_dump": []}
        class UnverifiedStatusAdapter(Adapter):
            verification_evidence = evidence
            def verify(self, job, device): return PublicationStatus.UNVERIFIED
        class FinishApi(FakeApi):
            def finish(self, job_id, token, status, **kwargs): self.calls.append(("finish", status, kwargs))
        api = FinishApi(self.job()); adapter = UnverifiedStatusAdapter()
        PublicationRunner(api, FakeRegistry(), {"youtube": adapter}, heartbeat_interval=999).run_once(5)
        finished = [call for call in api.calls if call[0] == "finish"]
        self.assertEqual(len(finished), 1)
        self.assertEqual(finished[0][1], "review_required")
        self.assertEqual(finished[0][2]["error_code"], "VERIFICATION_PENDING")
        self.assertEqual(finished[0][2]["result"], evidence)
        self.assertNotIn("completed", [call[1] for call in api.calls if call[0] == "finish"])
        self.assertNotIn("failed", [call[1] for call in api.calls if call[0] == "finish"])

    def test_runner_real_instagram_unverified_verification_finishes_review_required_with_evidence(self):
        base = self.job(); claimed = PublicationJob(base.id, base.device_id, base.media_id, "instagram", base.caption, {**base.media, "duration_seconds": 25}, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "instagram"})
        class FinishApi(FakeApi):
            def finish(self, job_id, token, status, **kwargs): self.calls.append(("finish", status, kwargs))
        api = FinishApi(claimed)
        device = ScriptDevice("com.instagram.android", instagram_publish_dumps("expected.account") + instagram_unverified_tail("expected.account"))
        with self.assertLogs("southfarm_publisher.platforms.instagram", level="WARNING") as logs:
            PublicationRunner(api, ScriptRegistry(device), {"instagram": InstagramPublisher(expected_account="expected.account", pause=lambda _: None)}, heartbeat_interval=999).run_once(5)
        self.assertTrue(any("verification pending" in line for line in logs.output), "a clear verification-pending log is emitted")
        finished = [call for call in api.calls if call[0] == "finish"]
        self.assertEqual(finished[0][1], "review_required")
        self.assertEqual(finished[0][2]["error_code"], "VERIFICATION_PENDING")
        self.assertIn("verification pending", finished[0][2]["error_message"])
        result = finished[0][2]["result"]
        self.assertEqual((result["platform"], result["stage"]), ("instagram", "verification_pending"))
        self.assertEqual(result["post_counts"], [8])
        self.assertTrue(any(node.get("content-desc") == "8posts" for node in result["last_dump"]), "the last dump travels with the finished job")
        self.assertEqual([call[1] for call in api.calls if call[0] == "checkpoint"][-1], "verifying")

    def test_runner_real_youtube_unverified_verification_finishes_review_required_with_evidence(self):
        # The YouTube adapter returns models.PublicationStatus.UNVERIFIED
        # after three checks without a grid delta: the runner maps it to the
        # same terminal outcome as Instagram/TikTok -- review_required +
        # VERIFICATION_PENDING, never completed and never failed.
        base = self.job(); claimed = PublicationJob(base.id, base.device_id, base.media_id, "youtube", base.caption, base.media, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "youtube"})
        class FinishApi(FakeApi):
            def finish(self, job_id, token, status, **kwargs): self.calls.append(("finish", status, kwargs))
        api = FinishApi(claimed)
        device = ScriptDevice("com.google.android.youtube", youtube_publish_prefix("publication-7-3.mp4") + youtube_unverified_tail("expected.account"), youtube_explicit())
        with self.assertLogs("southfarm_publisher.platforms.youtube", level="WARNING") as logs:
            PublicationRunner(api, ScriptRegistry(device), {"youtube": YouTubeShortPublisher(expected_account="expected.account", pause=lambda _: None)}, heartbeat_interval=999).run_once(5)
        self.assertTrue(any("verification pending" in line for line in logs.output), "a clear verification-pending log is emitted")
        finished = [call for call in api.calls if call[0] == "finish"]
        self.assertEqual(finished[0][1], "review_required")
        self.assertEqual(finished[0][2]["error_code"], "VERIFICATION_PENDING")
        self.assertIn("verification pending", finished[0][2]["error_message"])
        result = finished[0][2]["result"]
        self.assertEqual((result["platform"], result["stage"]), ("youtube", "verification_pending"))
        self.assertEqual(result["baseline_tiles"], ["older Short, 12 views - play Short"])
        self.assertEqual([call[1] for call in api.calls if call[0] == "checkpoint"][-1], "verifying")

    def test_config_rejects_missing_or_invalid_adb_without_secret_echo(self):
        with self.assertRaises(Exception) as raised:
            _config({"SOUTHFARM_API_URL": "https://api.test", "SOUTHFARM_PUBLISHER_WORKER_TOKEN": "very-secret", "SOUTHFARM_PUBLISHER_WORKER_ID": "worker", "SOUTHFARM_PUBLISHER_DEVICE_ID": "5", "SOUTHFARM_ADB": "C:/not-present/adb.exe", "SOUTHFARM_ADB_SERIAL": "serial", "SOUTHFARM_EXPECTED_ANDROID_ID": "android-id"})
        self.assertNotIn("very-secret", str(raised.exception))

    def test_config_binds_registry_to_exact_serial_and_android_identity(self):
        env = {"SOUTHFARM_API_URL": "https://api.test", "SOUTHFARM_PUBLISHER_WORKER_TOKEN": "secret", "SOUTHFARM_PUBLISHER_WORKER_ID": "worker", "SOUTHFARM_PUBLISHER_DEVICE_ID": "5", "SOUTHFARM_ADB": "C:/adb.exe", "SOUTHFARM_ADB_SERIAL": "usb-exact", "SOUTHFARM_EXPECTED_ANDROID_ID": "0123456789abcdef", "SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS": "protected"}
        with patch("southfarm_publisher.runner.os.path.isfile", return_value=True), patch("southfarm_publisher.runner.os.access", return_value=True):
            _api, registry, device_id, _forbidden = _config(env)
        self.assertEqual(device_id, 5)
        self.assertEqual(registry.expected_serial, "usb-exact")
        self.assertEqual(registry.expected_android_id, "0123456789abcdef")
        self.assertEqual(registry.ui_source, "auto")

    def test_config_reads_and_validates_ui_source(self):
        base = {"SOUTHFARM_API_URL": "https://api.test", "SOUTHFARM_PUBLISHER_WORKER_TOKEN": "secret", "SOUTHFARM_PUBLISHER_WORKER_ID": "worker", "SOUTHFARM_PUBLISHER_DEVICE_ID": "5", "SOUTHFARM_ADB": "C:/adb.exe", "SOUTHFARM_ADB_SERIAL": "usb-exact", "SOUTHFARM_EXPECTED_ANDROID_ID": "0123456789abcdef", "SOUTHFARM_FORBIDDEN_INSTAGRAM_ACCOUNTS": "protected"}
        with patch("southfarm_publisher.runner.os.path.isfile", return_value=True), patch("southfarm_publisher.runner.os.access", return_value=True):
            _api, registry, _device_id, _forbidden = _config({**base, "SOUTHFARM_UI_SOURCE": " uiautomator "})
            self.assertEqual(registry.ui_source, "uiautomator")
            with self.assertRaises(PublisherError) as raised: _config({**base, "SOUTHFARM_UI_SOURCE": "screenreader"})
        self.assertEqual(raised.exception.code, "CONFIG_INVALID")
