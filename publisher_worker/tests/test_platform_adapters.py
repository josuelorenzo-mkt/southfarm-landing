import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.models import PublicationJob, PublisherError
from southfarm_publisher.platforms.instagram import InstagramPublisher
from southfarm_publisher.platforms.tiktok import TikTokPublisher
from southfarm_publisher.platforms.youtube import YouTubeShortPublisher


class Device:
    def __init__(self, package, dumps):
        self.package, self.dumps, self.taps, self.typed = package, list(dumps), [], []
    def foreground_package(self): return self.package
    def dump_ui(self): return self.dumps.pop(0) if self.dumps else []
    def tap_bounds(self, bounds, delay_seconds=0): self.taps.append(bounds)
    def text(self, value): self.typed.append(value)
    def command(self, *args, **kwargs): return ""


def job(platform="tiktok", caption="safe publishing test"):
    return PublicationJob(7, 5, 3, platform, caption, {"id": 3, "size_bytes": 1, "sha256": "a" * 64, "mime_type": "video/mp4", "file_extension": "mp4"})


def node(**values):
    values.setdefault("bounds", "[10,20][110,80]")
    values.setdefault("clickable", "true")
    values.setdefault("enabled", "true")
    return values

def resumed_for_final(cls):
    publisher = cls(expected_account="expected.account")
    publisher._prepared = True
    return publisher


class PlatformAdapterTests(unittest.TestCase):
    def test_sanitized_fixture_is_parsed_into_exact_nodes(self):
        fixtures = {
            "instagram_about_reels.xml": "com.instagram.android:id/clips_nux_sheet_share_button",
            "instagram_next_share_collision.xml": "com.instagram.android:id/clips_right_action_button",
            "instagram_wrong_account.xml": "santiago.account",
            "tiktok_create_collision.xml": "Create a Story",
            "tiktok_details_keyboard_open.xml": "com.zhiliaoapp.musically:id/h00",
            "tiktok_verify_item.xml": "safe publishing test 0 views",
            "youtube_disabled_upload.xml": "com.google.android.youtube:id/upload_bottom_button",
            "youtube_duplicate_gallery.xml": "publication-7-3.mp4",
            "youtube_short_collision.xml": "Shorts",
            "youtube_verify_item.xml": "safe publishing test, No views - play Short",
        }
        for name, expected in fixtures.items():
            with self.subTest(name=name):
                nodes = [dict(item.attrib) for item in ET.parse(Path(__file__).with_name("fixtures") / name).iter("node")]
                self.assertIn(expected, " ".join(" ".join(node.values()) for node in nodes))

    def test_wrong_package_is_rejected_before_any_tap(self):
        device = Device("com.example.other", [[node(text="About Reels"), node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(InstagramPublisher).publish(job("instagram"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "WRONG_PACKAGE")
        self.assertEqual(device.taps, [])

    def test_account_label_mismatch_blocks_tiktok_create(self):
        device = Device("com.zhiliaoapp.musically", [[node(**{"content-desc": "Create"}), node(text="different.account")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_MISMATCH")
        self.assertEqual(device.taps, [])
    def test_tiktok_refuses_create_a_story_collision(self):
        device = Device("com.zhiliaoapp.musically", [[node(**{"content-desc": "Create a Story"}), node(text="expected.account")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "CREATE_CONTROL")
        self.assertEqual(device.taps, [])

    def test_youtube_refuses_shorts_collision(self):
        device = Device("com.google.android.youtube", [[node(text="Shorts", **{"resource-id": "com.google.android.youtube:id/creation_mode_button"}), node(text="expected.account")]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").prepare(job("youtube"), device)
        self.assertEqual(raised.exception.code, "SHORT_SELECTOR")
        self.assertEqual(device.taps, [])

    def test_instagram_mid_flow_is_refused_before_share_tap(self):
        final = [node(text="About Reels"), node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]
        device = Device("com.instagram.android", [final, final])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(InstagramPublisher).publish(job("instagram"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertEqual(device.taps, [])

    def test_final_checkpoint_error_cannot_resume_mid_flow(self):
        details = [node(text="About Reels"), node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]
        device = Device("com.instagram.android", [details, details])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(InstagramPublisher).publish(job("instagram"), device, lambda *a, **k: (_ for _ in ()).throw(OSError("checkpoint unavailable")))
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertEqual(device.taps, [])

    def test_final_button_without_about_reels_context_is_not_tapped(self):
        button = [node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]
        device = Device("com.instagram.android", [button, button])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(InstagramPublisher).publish(job("instagram"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertEqual(device.taps, [])

    def test_disabled_youtube_upload_is_not_tapped(self):
        final_bounds = "[20,1400][700,1520]"
        details = [node(text="Caption your Short"), node(text="Public"), node(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button", "enabled": "false", "bounds": final_bounds})]
        device = Device("com.google.android.youtube", [details, details, details, details, details, details, details])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(YouTubeShortPublisher).publish(job("youtube"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertNotIn((20, 1400, 700, 1520), device.taps)

    def test_youtube_rejects_duplicate_remote_media(self):
        duplicate = [node(**{"content-desc": "publication-7-3.mp4", "resource-id": "com.google.android.youtube:id/thumb_image_view"}), node(**{"content-desc": "publication-7-3.mp4", "resource-id": "com.google.android.youtube:id/thumb_image_view"})]
        device = Device("com.google.android.youtube", [
            [node(**{"resource-id": "com.google.android.youtube:id/reel_camera_gallery_button_delegate"})], duplicate
        ])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(YouTubeShortPublisher).publish(job("youtube"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MEDIA_AMBIGUOUS")

    def test_verify_requires_exact_caption_identity(self):
        device = Device("com.google.android.youtube", [[node(text="You")], [node(**{"content-desc": "View channel"})], [node(**{"content-desc": "other caption - play Short"})]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").verify(job("youtube"), device)
        self.assertEqual(raised.exception.code, "VERIFICATION_MISSING")

    def test_verify_rejects_identity_already_present_in_profile_baseline(self):
        identity = "safe publishing test, No views - play Short"
        publisher = YouTubeShortPublisher(expected_account="expected.account")
        publisher._baseline = {identity}
        device = Device("com.google.android.youtube", [[node(text="You")], [node(**{"content-desc": "View channel"})], [node(**{"content-desc": identity})]])
        with self.assertRaises(PublisherError) as raised:
            publisher.verify(job("youtube"), device)
        self.assertEqual(raised.exception.code, "VERIFICATION_NO_DELTA")

    def test_cleanup_requires_verified_identity_and_restores_baseline(self):
        expected, baseline = "safe publishing test - play Short", {"older post - play Short"}
        device = Device("com.google.android.youtube", [
            [node(**{"content-desc": expected}), node(**{"content-desc": "older post - play Short"})],
            [node(**{"content-desc": "More actions"})],
            [node(text="Delete")],
            [node(text="Delete")],
            [node(**{"content-desc": "older post - play Short"})],
        ])
        YouTubeShortPublisher(expected_account="expected.account").cleanup_test_post(expected, baseline, device)
        self.assertEqual(len(device.taps), 4)

    def test_instagram_cleanup_uses_reel_menu_and_exact_baseline(self):
        expected, baseline = "safe reel", {"older reel"}
        device = Device("com.instagram.android", [
            [node(**{"content-desc": expected}), node(**{"content-desc": "older reel"})], [node(**{"content-desc": "More options"})], [node(text="Delete")], [node(text="Delete")], [node(**{"content-desc": "older reel"})]
        ])
        InstagramPublisher(expected_account="expected.account").cleanup_test_post(expected, baseline, device)
        self.assertEqual(len(device.taps), 4)

    def test_tiktok_cleanup_uses_video_menu_and_exact_baseline(self):
        expected, baseline = "safe video", {"older video"}
        device = Device("com.zhiliaoapp.musically", [
            [node(**{"content-desc": expected}), node(**{"content-desc": "older video"})], [node(**{"content-desc": "More actions"})], [node(text="Delete")], [node(text="Delete")], [node(**{"content-desc": "older video"})]
        ])
        TikTokPublisher(expected_account="expected.account").cleanup_test_post(expected, baseline, device)
        self.assertEqual(len(device.taps), 4)

    def test_caption_contract_blocks_eleven_words_before_youtube_ui(self):
        too_many = job("youtube", "one two three four five six seven eight nine ten eleven")
        device = Device("com.google.android.youtube", [[]])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(YouTubeShortPublisher).publish(too_many, device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "CAPTION_INVALID")
        self.assertEqual(device.taps, [])

    def test_wait_for_times_out_after_fresh_package_checked_dumps(self):
        ticks = iter([0.0, 0.0, 0.5, 1.1])
        device = Device("com.instagram.android", [[], [], []])
        publisher = InstagramPublisher(expected_account="expected.account", timeout=1, poll=.1, pause=lambda _: None)
        with self.assertRaises(PublisherError) as raised:
            publisher.wait_for(device, error="MISSING", text="never", clock=lambda: next(ticks))
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")

    def test_forbidden_account_blocks_before_create(self):
        device = Device("com.zhiliaoapp.musically", [[node(text="expected.account"), node(text="Create")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account", forbidden_accounts={"expected.account"}).prepare(job(), device)
        self.assertEqual(raised.exception.code, "FORBIDDEN_ACCOUNT")
        self.assertEqual(device.taps, [])

    def test_caption_requires_each_observable_exact_prefix(self):
        device = Device("com.google.android.youtube", [[node(**{"class": "android.widget.EditText", "text": "wrong"})]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account")._caption(device, "safe", youtube=True)
        self.assertEqual(raised.exception.code, "CAPTION_DIVERGED")
        self.assertEqual(device.typed, ["safe"])

    def test_instagram_full_profile_to_share_flow_has_monotonic_checkpoints(self):
        clip = job("instagram", "safe test")
        remote = "publication-7-3.mp4"
        profile = [node(text="expected.account"), node(**{"content-desc": "Create New"}), node(**{"content-desc": "older reel"})]
        create = [node(**{"content-desc": "Create new reel"})]
        gallery = [node(**{"content-desc": remote})]
        editor = [node(**{"resource-id": "com.instagram.android:id/clips_right_action_button"})]
        privacy = [node(text="Continue"), node(text="Downloads privacy")]
        caption = [node(text="Write a caption and add hashtags...")]
        field_one = [node(**{"class": "android.widget.EditText", "text": "safe"})]
        field_two = [node(**{"class": "android.widget.EditText", "text": "safe test"})]
        details = [node(text="Next")]
        final = [node(text="About Reels"), node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]
        device = Device("com.instagram.android", [profile, create, gallery, editor, privacy, caption, field_one, field_two, details, final, final])
        events = []
        publisher = InstagramPublisher(expected_account="expected.account")
        publisher.prepare(clip, device)
        publisher.publish(clip, device, lambda step, progress, **kwargs: events.append((step, progress, kwargs, len(device.taps))))
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertTrue(events[-1][2]["final_action"])
        self.assertEqual(events[-1][3], len(device.taps) - 1)

    def test_tiktok_full_profile_to_post_flow_has_monotonic_checkpoints(self):
        clip = job("tiktok", "safe test")
        profile = [node(text="expected.account"), node(text="Create"), node(**{"content-desc": "older tile"})]
        upload = [node(text="Upload")]
        gallery = [node(**{"resource-id": "com.zhiliaoapp.musically:id/ica"})]
        next_one = [node(text="Next (1)")]
        editor = [node(text="Next")]
        field = [node(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00"})]
        field_one = [node(**{"class": "android.widget.EditText", "text": "safe"})]
        field_two = [node(**{"class": "android.widget.EditText", "text": "safe test"})]
        details = [node(text="Add description..."), node(text="Public"), node(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6"})]
        device = Device("com.zhiliaoapp.musically", [profile, upload, gallery, next_one, editor, field, field_one, field_two, details, details])
        events = []
        publisher = TikTokPublisher(expected_account="expected.account")
        publisher.prepare(clip, device)
        publisher.publish(clip, device, lambda step, progress, **kwargs: events.append((step, kwargs, len(device.taps))))
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertEqual(events[-1][2], len(device.taps) - 1)

    def test_youtube_full_profile_to_upload_flow_has_monotonic_checkpoints(self):
        clip = job("youtube", "safe test")
        remote = "publication-7-3.mp4"
        profile = [node(text="expected.account"), node(text="Short", **{"resource-id": "com.google.android.youtube:id/creation_mode_button"}), node(**{"content-desc": "old channel card - play Short"})]
        import_button = [node(**{"resource-id": "com.google.android.youtube:id/reel_camera_gallery_button_delegate"})]
        gallery = [node(**{"resource-id": "com.google.android.youtube:id/thumb_image_view", "content-desc": remote})]
        next_one = [node(text="Next", **{"resource-id": "com.google.android.youtube:id/multi_select_next_button"})]
        done = [node(text="Done", **{"resource-id": "com.google.android.youtube:id/creation_next_button"})]
        editor = [node(text="Next", **{"resource-id": "com.google.android.youtube:id/shorts_post_bottom_button"})]
        field = [node(text="Caption your Short", **{"class": "android.widget.EditText"})]
        field_one = [node(**{"class": "android.widget.EditText", "text": "safe"})]
        field_two = [node(**{"class": "android.widget.EditText", "text": "safe test"})]
        details = [node(text="Caption your Short"), node(text="Public"), node(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button"})]
        device = Device("com.google.android.youtube", [profile, import_button, gallery, next_one, done, editor, field, field_one, field_two, details, details])
        events = []
        publisher = YouTubeShortPublisher(expected_account="expected.account")
        publisher.prepare(clip, device)
        publisher.publish(clip, device, lambda step, progress, **kwargs: events.append((step, kwargs, len(device.taps))))
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertEqual(events[-1][2], len(device.taps) - 1)

    def test_runner_main_registers_exact_platform_ids(self):
        from southfarm_publisher.runner import platform_adapters
        self.assertEqual(set(platform_adapters()), {"instagram", "tiktok", "youtube"})

    def test_runner_factory_binds_claim_account_instead_of_singleton(self):
        from southfarm_publisher.runner import platform_adapters
        # Directly-created synthetic job has no safe snapshot: the factory must reject it.
        with self.assertRaises(PublisherError) as raised:
            platform_adapters()["youtube"](job("youtube"))
        self.assertEqual(raised.exception.code, "ACCOUNT_SNAPSHOT_INVALID")


if __name__ == "__main__":
    unittest.main()
