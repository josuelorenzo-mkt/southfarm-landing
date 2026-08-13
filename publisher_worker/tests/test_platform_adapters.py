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


class PlatformAdapterTests(unittest.TestCase):
    def test_sanitized_fixture_is_parsed_into_exact_nodes(self):
        fixture = Path(__file__).with_name("fixtures") / "instagram_about_reels.xml"
        nodes = [dict(item.attrib) for item in ET.parse(fixture).iter("node")]
        self.assertEqual(nodes[1]["resource-id"], "com.instagram.android:id/clips_nux_sheet_share_button")

    def test_wrong_package_is_rejected_before_any_tap(self):
        device = Device("com.example.other", [[node(text="About Reels"), node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher().publish(job("instagram"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "WRONG_PACKAGE")
        self.assertEqual(device.taps, [])

    def test_account_label_mismatch_blocks_tiktok_create(self):
        device = Device("com.zhiliaoapp.musically", [[node(**{"content-desc": "Create"}), node(text="different.account")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_MISMATCH")
        self.assertEqual(device.taps, [])
    def test_tiktok_refuses_create_a_story_collision(self):
        device = Device("com.zhiliaoapp.musically", [[node(**{"content-desc": "Create a Story"})]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher().prepare(job(), device)
        self.assertEqual(raised.exception.code, "CREATE_CONTROL")
        self.assertEqual(device.taps, [])

    def test_youtube_refuses_shorts_collision(self):
        device = Device("com.google.android.youtube", [[node(text="Shorts", **{"resource-id": "com.google.android.youtube:id/creation_mode_button"})]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher().prepare(job("youtube"), device)
        self.assertEqual(raised.exception.code, "SHORT_SELECTOR")
        self.assertEqual(device.taps, [])

    def test_instagram_final_checkpoint_happens_before_share_tap(self):
        final = [node(text="About Reels"), node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]
        device = Device("com.instagram.android", [final, final])
        events = []
        def checkpoint(*args, **kwargs): events.append((args, kwargs, len(device.taps)))
        InstagramPublisher().publish(job("instagram"), device, checkpoint)
        self.assertEqual(events[0][0][0], "publishing")
        self.assertTrue(events[0][1]["final_action"])
        self.assertEqual(events[0][2], 0)
        self.assertEqual(len(device.taps), 1)

    def test_final_checkpoint_error_prevents_final_tap(self):
        details = [node(text="About Reels"), node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]
        device = Device("com.instagram.android", [details, details])
        with self.assertRaises(OSError):
            InstagramPublisher().publish(job("instagram"), device, lambda *a, **k: (_ for _ in ()).throw(OSError("checkpoint unavailable")))
        self.assertEqual(device.taps, [])

    def test_final_button_without_about_reels_context_is_not_tapped(self):
        button = [node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]
        device = Device("com.instagram.android", [button, button])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher().publish(job("instagram"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "FINAL_CONTEXT_MISSING")
        self.assertEqual(device.taps, [])

    def test_disabled_youtube_upload_is_not_tapped(self):
        final_bounds = "[20,1400][700,1520]"
        details = [node(text="Caption your Short"), node(text="Public"), node(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button", "enabled": "false", "bounds": final_bounds})]
        device = Device("com.google.android.youtube", [details, details, details, details, details, details, details])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher().publish(job("youtube"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "CONTROL_DISABLED")
        self.assertNotIn((20, 1400, 700, 1520), device.taps)

    def test_youtube_rejects_duplicate_remote_media(self):
        duplicate = [node(**{"content-desc": "publication-7-3.mp4", "resource-id": "com.google.android.youtube:id/thumb_image_view"}), node(**{"content-desc": "publication-7-3.mp4", "resource-id": "com.google.android.youtube:id/thumb_image_view"})]
        device = Device("com.google.android.youtube", [
            [node(**{"resource-id": "com.google.android.youtube:id/reel_camera_gallery_button_delegate"})], duplicate
        ])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher().publish(job("youtube"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MEDIA_AMBIGUOUS")

    def test_verify_requires_exact_caption_identity(self):
        device = Device("com.google.android.youtube", [[node(**{"content-desc": "other caption - play Short"})]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher().verify(job("youtube"), device)
        self.assertEqual(raised.exception.code, "VERIFICATION_MISSING")

    def test_cleanup_requires_verified_identity_and_restores_baseline(self):
        expected, baseline = "safe publishing test - play Short", {"older post - play Short"}
        device = Device("com.google.android.youtube", [
            [node(**{"content-desc": expected}), node(**{"content-desc": "older post - play Short"})],
            [node(text="Delete")],
            [node(**{"content-desc": "older post - play Short"})],
        ])
        YouTubeShortPublisher().cleanup_test_post(expected, baseline, device)
        self.assertEqual(len(device.taps), 2)

    def test_caption_contract_blocks_eleven_words_before_youtube_ui(self):
        too_many = job("youtube", "one two three four five six seven eight nine ten eleven")
        device = Device("com.google.android.youtube", [[]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher().publish(too_many, device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "CAPTION_INVALID")
        self.assertEqual(device.taps, [])

    def test_runner_main_registers_exact_platform_ids(self):
        from southfarm_publisher.runner import platform_adapters
        self.assertEqual(set(platform_adapters()), {"instagram", "tiktok", "youtube"})


if __name__ == "__main__":
    unittest.main()
