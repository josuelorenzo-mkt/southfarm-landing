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
    def __init__(self, package, dumps, *, advance_on_poll=False):
        self.package, self.dumps, self.taps, self.typed, self.swipes = package, list(dumps), [], [], []
        self._last_dump, self._after_tap, self._stale_reads, self.advance_on_poll = None, True, 0, advance_on_poll
    def foreground_package(self): return self.package
    def dump_ui(self):
        if self._after_tap or self._last_dump is None:
            if not self.dumps:
                raise PublisherError("UI_TIMEOUT", "fake device has no next UI revision")
            self._last_dump = self.dumps.pop(0)
            self._after_tap = False
            self._stale_reads = 0
        elif self.advance_on_poll and self.dumps:
            self._last_dump = self.dumps.pop(0)
        else:
            self._stale_reads += 1
            if self._stale_reads > 3:
                raise PublisherError("UI_TIMEOUT", "fake device UI did not advance")
        return self._last_dump
    def tap_bounds(self, bounds, delay_seconds=0): self.taps.append(bounds); self._after_tap = True; self._stale_reads = 0
    def text(self, value): self.typed.append(value); self._after_tap = True; self._stale_reads = 0
    def swipe(self, *args): self.swipes.append(args); self._after_tap = True; self._stale_reads = 0
    def command(self, *args, **kwargs):
        if "keyevent" in args: self._after_tap = True
        return ""


def job(platform="tiktok", caption="safe publishing test"):
    return PublicationJob(7, 5, 3, platform, caption, {"id": 3, "size_bytes": 1, "sha256": "a" * 64, "mime_type": "video/mp4", "file_extension": "mp4", "duration_seconds": 25, "width": 1080, "height": 1920, "video_codec": "hevc", "audio_codec": "aac"}, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": platform})


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
    def test_tiktok_duplicate_switcher_control_is_account_unavailable_without_media_or_typing(self):
        device = Device("com.zhiliaoapp.musically", [
            [node(text="Profile")],
            [node(text="wrong", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"}), node(text="wrong", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"})],
        ])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1)
        self.assertEqual(device.typed, [])

    def test_tiktok_duplicate_selected_switcher_item_is_account_unavailable_without_media_or_typing(self):
        device = Device("com.zhiliaoapp.musically", [
            [node(text="Profile")],
            [node(text="wrong", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"})],
            [node(text="expected.account"), node(text="expected.account")],
        ])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 2)
        self.assertEqual(device.typed, [])

    def test_youtube_duplicate_switcher_control_is_account_unavailable_without_media_or_typing(self):
        device = Device("com.google.android.youtube", [
            [node(text="You")],
            [node(**{"content-desc": "Account"}), node(**{"content-desc": "Account"})],
        ])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").prepare(job("youtube"), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1)
        self.assertEqual(device.typed, [])

    def test_youtube_duplicate_selected_switcher_item_is_account_unavailable_without_media_or_typing(self):
        device = Device("com.google.android.youtube", [
            [node(text="You")],
            [node(**{"content-desc": "Account"})],
            [node(text="expected.account"), node(text="expected.account")],
        ])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").prepare(job("youtube"), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 2)
        self.assertEqual(device.typed, [])

    def test_tiktok_missing_selected_switcher_item_is_account_unavailable_without_typing(self):
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [node(text="wrong", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"})], [node(text="backup")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(device.typed, [])

    def test_youtube_missing_selected_switcher_item_is_account_unavailable_without_typing(self):
        device = Device("com.google.android.youtube", [[node(text="You")], [node(**{"content-desc": "Account"})], [node(text="backup")]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").prepare(job("youtube"), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(device.typed, [])

    def test_duplicate_active_account_controls_are_account_unavailable_on_all_platforms(self):
        cases = {
            "instagram": (InstagramPublisher, "com.instagram.android", [[node(text="Profile")], [node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})]]),
            "tiktok": (TikTokPublisher, "com.zhiliaoapp.musically", [[node(text="Profile")], [node(text="expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"}), node(text="expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"})]]),
            "youtube": (YouTubeShortPublisher, "com.google.android.youtube", [[node(text="expected.account", **{"resource-id": "com.google.android.youtube:id/account_name"}), node(text="expected.account", **{"resource-id": "com.google.android.youtube:id/account_name"})]]),
        }
        for platform, (publisher_type, package, dumps) in cases.items():
            with self.subTest(platform=platform):
                device = Device(package, dumps)
                with self.assertRaises(PublisherError) as raised:
                    publisher_type(expected_account="expected.account").prepare(job(platform), device)
                self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
                self.assertEqual(device.typed, [])

    def test_instagram_rejects_incidental_username_without_active_profile_control(self):
        device = Device("com.instagram.android", [[node(text="Profile")], [node(text="expected.account"), node(**{"content-desc": "Create New"})]])

        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").prepare(job("instagram"), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1)
        self.assertEqual(device.typed, [])

    def test_tiktok_rejects_incidental_username_without_active_profile_control(self):
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [node(text="expected.account"), node(text="Create")]])

        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1)
        self.assertEqual(device.typed, [])

    def test_youtube_rejects_incidental_username_without_active_channel_control(self):
        device = Device("com.google.android.youtube", [[node(text="expected.account"), node(text="Create")]])

        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").prepare(job("youtube"), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(device.taps, [])
        self.assertEqual(device.typed, [])

    def test_duplicate_account_switch_controls_are_account_unavailable(self):
        device = Device("com.instagram.android", [
            [node(text="Profile")],
            [node(text="wrong.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"resource-id": "com.instagram.android:id/action_bar_username_container"}), node(**{"resource-id": "com.instagram.android:id/action_bar_username_container"})],
        ])

        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").prepare(job("instagram"), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1)

    def test_instagram_prepare_switches_from_wrong_profile_to_exact_selected_account(self):
        device = Device("com.instagram.android", [
            [node(text="Profile")],
            [node(text="wrong.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"resource-id": "com.instagram.android:id/action_bar_username_container"})],
            [node(text="expected.account", **{"resource-id": "account_item"})],
            [node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"content-desc": "Create New"})],
            [node(**{"content-desc": "Create new reel"})],
            [node(**{"content-desc": "Video thumbnail created today"})],
            [node(text="Profile")],
            [node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})],
        ])

        InstagramPublisher(expected_account="expected.account").prepare(job("instagram"), device)

        self.assertEqual(len(device.taps), 6)

    def test_tiktok_prepare_switches_from_wrong_profile_to_exact_selected_account(self):
        device = Device("com.zhiliaoapp.musically", [
            [node(text="Profile")],
            [node(text="wrong.account", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"})],
            [node(text="expected.account")],
            [node(text="expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"}), node(**{"content-desc": "Create"})],
            [node(text="Upload")],
            [node(**{"resource-id": "com.zhiliaoapp.musically:id/ica"})],
            [node(text="Profile")],
            [node(text="expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"})],
        ])

        TikTokPublisher(expected_account="expected.account").prepare(job(), device)

        self.assertEqual(len(device.taps), 6)

    def test_youtube_prepare_switches_channel_before_opening_short_selector(self):
        device = Device("com.google.android.youtube", [
            [node(text="You")],
            [node(text="wrong.account"), node(**{"content-desc": "Account"})],
            [node(text="expected.account", **{"resource-id": "account_item"})],
            [node(text="expected.account", **{"resource-id": "com.google.android.youtube:id/account_name"}), node(text="Create")],
            [node(text="Short", **{"resource-id": "com.google.android.youtube:id/creation_mode_button"})],
            [node(**{"resource-id": "com.google.android.youtube:id/reel_camera_gallery_button_delegate"})],
        ])

        YouTubeShortPublisher(expected_account="expected.account").prepare(job("youtube"), device)

        self.assertEqual(len(device.taps), 5)

    def test_missing_selected_account_never_reaches_media_selection(self):
        device = Device("com.instagram.android", [
            [node(text="Profile")],
            [node(text="wrong.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"resource-id": "com.instagram.android:id/action_bar_username_container"})],
            [node(text="expected.account.backup"), node(**{"content-desc": "Create New"})],
        ])

        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").prepare(job("instagram"), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 2)

    def test_forbidden_santilorennzo_is_blocked_before_account_switch(self):
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")]])

        claimed = job()
        claimed = PublicationJob(claimed.id, claimed.device_id, claimed.media_id, claimed.platform, claimed.caption, claimed.media, {"id": 9, "username": "santilorennzo", "display_name": "Santiago", "platform": "tiktok"})
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="santilorennzo", forbidden_accounts={"santilorennzo"}).prepare(claimed, device)

        self.assertEqual(raised.exception.code, "FORBIDDEN_ACCOUNT")
        self.assertEqual(device.taps, [])

    def test_select_account_accepts_scanned_account_when_current_profile_differs(self):
        claimed = job()
        claimed = PublicationJob(claimed.id, claimed.device_id, claimed.media_id, claimed.platform, claimed.caption, claimed.media, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "tiktok"})
        device = Device("com.zhiliaoapp.musically", [[node(text="different.account"), node(text="expected.account")]])

        TikTokPublisher(expected_account="expected.account").select_account(claimed, device)

        self.assertEqual(device.taps, [], "account availability must not enter credentials or make an irreversible UI action")
        self.assertEqual(claimed.account["username"], "expected.account")

    def test_select_account_requires_an_exact_switcher_username_match(self):
        claimed = job()
        claimed = PublicationJob(claimed.id, claimed.device_id, claimed.media_id, claimed.platform, claimed.caption, claimed.media, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "tiktok"})
        device = Device("com.zhiliaoapp.musically", [[node(text="expected.account.backup"), node(text="expected.account")]])

        TikTokPublisher(expected_account="expected.account").select_account(claimed, device)

        self.assertEqual(device.taps, [])

    def test_select_account_reports_scanned_account_absent_from_switcher(self):
        claimed = job()
        claimed = PublicationJob(claimed.id, claimed.device_id, claimed.media_id, claimed.platform, claimed.caption, claimed.media, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "tiktok"})
        device = Device("com.zhiliaoapp.musically", [[node(text="different.account"), node(text="expected.account.backup")]])

        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").select_account(claimed, device)

        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(device.taps, [])

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
        self.assertEqual(device.taps, [], "a wrong foreground package is rejected before every tap")

    def test_account_label_mismatch_blocks_tiktok_create(self):
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [node(**{"content-desc": "Create"}), node(text="different.account")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1, "Only the required Profile navigation may occur before account rejection")
    def test_tiktok_refuses_create_a_story_collision(self):
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [node(**{"content-desc": "Create a Story"}), node(text="expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"})]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "CREATE_CONTROL")
        self.assertEqual(len(device.taps), 1, "Only the required Profile navigation may occur before Create collision rejection")

    def test_youtube_refuses_shorts_collision(self):
        device = Device("com.google.android.youtube", [[node(text="Create"), node(text="expected.account", **{"resource-id": "com.google.android.youtube:id/account_name"})], [node(text="Shorts", **{"resource-id": "com.google.android.youtube:id/creation_mode_button"})]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").prepare(job("youtube"), device)
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertEqual(len(device.taps), 1, "Create may open the mode sheet; Shorts is never tapped")

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
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")

    def test_verify_rejects_identity_already_present_in_profile_baseline(self):
        identity = "safe publishing test, No views - play Short"
        publisher = YouTubeShortPublisher(expected_account="expected.account")
        publisher._baseline = {identity}
        device = Device("com.google.android.youtube", [[node(text="You")], [node(**{"content-desc": "View channel"})], [node(**{"content-desc": identity})]])
        with self.assertRaises(PublisherError) as raised:
            publisher.verify(job("youtube"), device)
        self.assertEqual(raised.exception.code, "VERIFICATION_NO_DELTA")

    def test_cleanup_requires_verified_identity_and_restores_baseline(self):
        expected, baseline = "safe publishing test - play Short", ["expected.account", "older post - play Short"]
        device = Device("com.google.android.youtube", [
            [node(text="expected.account"), node(**{"content-desc": expected, "bounds": "[0,100][600,200]"}), node(**{"content-desc": "More actions", "bounds": "[610,100][700,200]"}), node(**{"content-desc": "older post - play Short"})],
            [node(**{"resource-id": "com.google.android.youtube:id/delete"})],
            [node(text="Confirm deletion")],
            [node(**{"resource-id": "com.google.android.youtube:id/delete", "bounds": "[20,1200][700,1300]"}), node(text="Confirm delete")],
            [node(text="expected.account"), node(**{"content-desc": "older post - play Short"})],
        ])
        YouTubeShortPublisher(expected_account="expected.account", pause=lambda _: setattr(device, "_after_tap", True)).cleanup_test_post(expected, baseline, device)
        self.assertEqual(len(device.taps), 3)

    def test_instagram_cleanup_uses_reel_menu_and_exact_baseline(self):
        expected, baseline = "safe reel", ["expected.account", "older reel"]
        device = Device("com.instagram.android", [
            [node(text="expected.account"), node(**{"content-desc": expected}), node(**{"content-desc": "older reel"})], [node(**{"resource-id": "com.instagram.android:id/reel_more_options"})], [node(**{"resource-id": "com.instagram.android:id/delete"})], [node(text="Confirm deletion")], [node(**{"resource-id": "com.instagram.android:id/delete", "bounds": "[20,1200][700,1300]"}), node(text="Confirm delete")], [node(text="expected.account"), node(**{"content-desc": "older reel"})]
        ])
        InstagramPublisher(expected_account="expected.account", pause=lambda _: setattr(device, "_after_tap", True)).cleanup_test_post(expected, baseline, device)
        self.assertEqual(len(device.taps), 4)

    def test_tiktok_cleanup_uses_video_menu_and_exact_baseline(self):
        expected, baseline = "safe video", ["expected.account", "older video"]
        device = Device("com.zhiliaoapp.musically", [
            [node(text="expected.account"), node(**{"content-desc": expected}), node(**{"content-desc": "older video"})], [node(**{"resource-id": "com.zhiliaoapp.musically:id/vbn"})], [node(**{"resource-id": "com.zhiliaoapp.musically:id/fq5"})], [node(text="Confirm deletion")], [node(**{"resource-id": "com.zhiliaoapp.musically:id/fq5", "bounds": "[20,1200][700,1300]"}), node(text="Confirm delete")], [node(text="expected.account"), node(**{"content-desc": "older video"})]
        ])
        TikTokPublisher(expected_account="expected.account", pause=lambda _: setattr(device, "_after_tap", True)).cleanup_test_post(expected, baseline, device)
        self.assertEqual(len(device.taps), 3)
        self.assertEqual(len(device.swipes), 1)

    def test_tiktok_cleanup_rejects_fq5_already_visible_before_and_after_swipe(self):
        expected, baseline = "safe video", ["expected.account", "older video"]
        stale = [node(**{"resource-id": "com.zhiliaoapp.musically:id/fq5"}), node(text="Saved")]
        device = Device("com.zhiliaoapp.musically", [
            [node(text="expected.account"), node(**{"content-desc": expected}), node(**{"content-desc": "older video"})],
            [node(**{"resource-id": "com.zhiliaoapp.musically:id/vbn"}), node(**{"resource-id": "com.zhiliaoapp.musically:id/fq5"})],
            stale,
        ])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).cleanup_test_post(expected, baseline, device)
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertEqual(len(device.taps), 1, "Only the verified video target is opened; stale fq5 is never tapped")

    def test_cleanup_baseline_rejects_duplicate_missing_or_reordered_identities(self):
        baseline = ["expected.account", "same reel", "same reel"]
        expected = "new reel"
        publisher = InstagramPublisher(expected_account="expected.account")
        for visible in (
            ["expected.account", expected, "same reel"],
            ["expected.account", "same reel", expected, "same reel"],
        ):
            with self.subTest(visible=visible):
                device = Device("com.instagram.android", [[node(text=value) for value in visible]])
                with self.assertRaises(PublisherError) as raised:
                    publisher.cleanup_test_post(expected, baseline, device)
                self.assertEqual(raised.exception.code, "CLEANUP_IDENTITY_MISMATCH")
                self.assertEqual(device.taps, [])

    def test_cleanup_collision_or_extra_identity_never_taps_delete_target(self):
        expected, baseline = "safe reel", ["expected.account", "older reel"]
        device = Device("com.instagram.android", [[node(text="expected.account"), node(**{"content-desc": expected}), node(**{"content-desc": "older reel"}), node(**{"content-desc": "unrelated reel"})]])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").cleanup_test_post(expected, baseline, device)
        self.assertEqual(raised.exception.code, "CLEANUP_IDENTITY_MISMATCH")
        self.assertEqual(device.taps, [])

    def test_youtube_cleanup_more_actions_from_other_card_never_deletes(self):
        expected, baseline = "safe publishing test - play Short", ["expected.account", "older post - play Short"]
        device = Device("com.google.android.youtube", [[node(text="expected.account"), node(**{"content-desc": expected, "bounds": "[0,100][600,200]"}), node(**{"content-desc": "More actions", "bounds": "[610,300][700,400]"}), node(**{"content-desc": "older post - play Short"})]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").cleanup_test_post(expected, baseline, device)
        self.assertEqual(raised.exception.code, "CLEANUP_MENU_COLLISION")
        self.assertEqual(device.taps, [])

    def test_instagram_cleanup_wrong_menu_id_never_reaches_delete(self):
        expected, baseline = "safe reel", ["expected.account", "older reel"]
        device = Device("com.instagram.android", [[node(text="expected.account"), node(**{"content-desc": expected}), node(**{"content-desc": "older reel"})], [node(**{"content-desc": "More options"})]])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).cleanup_test_post(expected, baseline, device)
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertEqual(len(device.taps), 1)

    def test_cleanup_missing_confirmation_never_taps_delete_action(self):
        expected, baseline = "safe video", ["expected.account", "older video"]
        device = Device("com.zhiliaoapp.musically", [[node(text="expected.account"), node(**{"content-desc": expected}), node(**{"content-desc": "older video"})], [node(**{"content-desc": "More actions"})], [node(text="Delete")], []])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).cleanup_test_post(expected, baseline, device)
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertEqual(len(device.taps), 1, "the exact menu id is absent, so no delete action is tapped")

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
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [node(text="expected.account"), node(text="Create")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account", forbidden_accounts={"expected.account"}).prepare(job(), device)
        self.assertEqual(raised.exception.code, "FORBIDDEN_ACCOUNT")
        self.assertEqual(len(device.taps), 0, "Forbidden accounts are rejected before any UI action")

    def test_instagram_factory_normalizes_forbidden_account_only_for_instagram(self):
        from southfarm_publisher.runner import platform_adapters
        claimed = job("instagram"); claimed = PublicationJob(claimed.id, claimed.device_id, claimed.media_id, claimed.platform, claimed.caption, claimed.media, {"id": 9, "username": "@Expected.Account", "display_name": "Expected", "platform": "instagram"}, {"id": 5, "device_id": "android"})
        instagram = platform_adapters(forbidden_instagram_accounts={"expected.account"})["instagram"](claimed)
        device = Device("com.instagram.android", [[node(text="Profile")], [node(text="@Expected.Account"), node(**{"content-desc": "Create New"})]])
        with self.assertRaises(PublisherError) as raised: instagram.prepare(claimed, device)
        self.assertEqual(raised.exception.code, "FORBIDDEN_ACCOUNT")
        youtube = platform_adapters(forbidden_instagram_accounts={"expected.account"})["youtube"](PublicationJob(claimed.id, claimed.device_id, claimed.media_id, "youtube", claimed.caption, claimed.media, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "youtube"}, {"id": 5, "device_id": "android"}))
        self.assertEqual(youtube.forbidden_accounts, set())

    def test_caption_requires_each_observable_exact_prefix(self):
        device = Device("com.google.android.youtube", [[node(**{"class": "android.widget.EditText", "text": "wrong"})]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account")._caption(device, "safe", youtube=True)
        self.assertEqual(raised.exception.code, "CAPTION_DIVERGED")
        self.assertEqual(device.typed, ["safe"])

    def test_gallery_baseline_uses_stable_identity_when_old_tiles_shift_bounds(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        old = node(**{"content-desc": "Video thumbnail created yesterday", "resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "bounds": "[0,100][200,300]"})
        publisher._capture_gallery_baseline([old], publisher._is_video_tile)
        shifted_old = node(**{"content-desc": "Video thumbnail created yesterday", "resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "bounds": "[0,300][200,500]"})
        new = node(**{"content-desc": "Video thumbnail created today", "resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "bounds": "[0,100][200,300]"})
        self.assertEqual(publisher._new_gallery_tile([new, shifted_old], publisher._is_video_tile), new)

    def test_instagram_prepare_rejects_username_incidental_outside_profile(self):
        device = Device("com.instagram.android", [[node(text="expected.account"), node(**{"content-desc": "Create New"})]])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).prepare(job("instagram"), device)
        self.assertEqual(raised.exception.code, "PROFILE_TAB")
        self.assertEqual(device.taps, [])

    def test_tiktok_prepare_rejects_username_incidental_outside_profile(self):
        device = Device("com.zhiliaoapp.musically", [[node(text="expected.account"), node(text="Create")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).prepare(job(), device)
        self.assertEqual(raised.exception.code, "PROFILE_TAB")
        self.assertEqual(device.taps, [])

    def test_tap_and_wait_rejects_target_already_present_before_tap(self):
        screen = [node(text="Create"), node(text="Upload")]
        device = Device("com.zhiliaoapp.musically", [screen, screen, screen])
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05)
        with self.assertRaises(PublisherError) as raised:
            publisher.tap_and_wait(device, screen[0], error="UPLOAD_SELECTOR", text="Upload")
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertEqual(len(device.taps), 1)

    def test_tap_and_wait_rejects_preexisting_target_when_only_toast_changes(self):
        before = [node(text="Create"), node(text="Upload")]
        after_toast = [node(text="Create"), node(text="Upload"), node(text="Network available")]
        device = Device("com.zhiliaoapp.musically", [before, after_toast])
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None)
        with self.assertRaises(PublisherError) as raised:
            publisher.tap_and_wait(device, before[0], error="UPLOAD_SELECTOR", text="Upload")
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")

    def test_tap_and_wait_rejects_stale_target_with_bounds_enabled_drift_and_toast(self):
        before = [node(text="Create"), node(text="Upload", bounds="[0,100][200,200]")]
        drift = [node(text="Create"), node(text="Upload", bounds="[0,120][220,220]", enabled="true"), node(text="Saved")]
        device = Device("com.zhiliaoapp.musically", [before, drift])
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None)
        with self.assertRaises(PublisherError) as raised:
            publisher.tap_and_wait(device, before[0], error="UPLOAD_SELECTOR", text="Upload")
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertEqual(len(device.taps), 1)

    def test_tap_and_wait_accepts_same_logical_target_only_after_absence(self):
        before = [node(text="Create"), node(text="Delete", **{"resource-id": "delete"})]
        absent = [node(text="Confirm deletion")]
        reappeared = [node(text="Delete", **{"resource-id": "delete", "bounds": "[20,1200][700,1300]"})]
        device = Device("com.instagram.android", [before, absent, reappeared], advance_on_poll=True)
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.2, poll=.05, pause=lambda _: None)
        selected = publisher.tap_and_wait(device, before[0], error="DELETE_CONFIRMATION", text="Delete", resource_id="delete")
        self.assertEqual(selected["resource-id"], "delete")

    def test_gallery_baseline_preserves_duplicate_multiplicity_and_order(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        old = node(**{"resource-id": "com.zhiliaoapp.musically:id/ica", "content-desc": "same cover"})
        publisher._capture_gallery_baseline([old, old], publisher._is_video_tile)
        new = node(**{"resource-id": "com.zhiliaoapp.musically:id/ica", "content-desc": "new cover"})
        self.assertEqual(publisher._new_gallery_tile([new, old, old], publisher._is_video_tile), new)
        with self.assertRaises(PublisherError) as missing:
            publisher._new_gallery_tile([new, old], publisher._is_video_tile)
        self.assertEqual(missing.exception.code, "MEDIA_BASELINE_MISSING")
        with self.assertRaises(PublisherError) as reordered:
            publisher._new_gallery_tile([old, new, old], publisher._is_video_tile)
        self.assertEqual(reordered.exception.code, "MEDIA_BASELINE_ORDER_CHANGED")

    def test_tiktok_profile_delta_preserves_duplicate_baseline_order_below_new_first(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        old = node(**{"resource-id": "com.zhiliaoapp.musically:id/ev2", "content-desc": "same cover", "bounds": "[0,100][200,300]"})
        publisher._capture_profile_tiles([old, old])
        new = node(**{"resource-id": "com.zhiliaoapp.musically:id/ev2", "content-desc": "new cover", "bounds": "[0,100][200,300]"})
        zero = node(**{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "text": "0", "bounds": "[0,280][80,300]"})
        shifted_old_a = {**old, "bounds": "[0,300][200,500]"}
        shifted_old_b = {**old, "bounds": "[0,500][200,700]"}
        self.assertEqual(publisher._verified_new_profile_tile([new, zero, shifted_old_a, shifted_old_b]), new)
        with self.assertRaises(PublisherError) as removed:
            publisher._verified_new_profile_tile([new, zero, shifted_old_a])
        self.assertEqual(removed.exception.code, "VERIFICATION_NO_DELTA")

    def test_instagram_profile_delta_rejects_duplicate_removal_or_reorder(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        old = node(**{"content-desc": "old reel"})
        publisher._profile_tiles = [publisher._tile_signature(old), publisher._tile_signature(old)]
        new = node(**{"content-desc": "new reel"})
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        profile = node(text="Profile")
        valid = Device("com.instagram.android", [[profile], [account, new, old, old]])
        self.assertEqual(publisher.verify(job("instagram"), valid), "new reel")
        for tiles in ([new, old], [new, old, node(**{"content-desc": "different reel"})], [old, new, old]):
            with self.subTest(tiles=[item.get("content-desc") for item in tiles]):
                device = Device("com.instagram.android", [[profile], [account, *tiles]])
                with self.assertRaises(PublisherError) as raised:
                    publisher.verify(job("instagram"), device)
                self.assertEqual(raised.exception.code, "VERIFICATION_NO_DELTA")

    def test_instagram_duration_is_read_from_associated_label_not_thumbnail_description(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        thumbnail = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Video thumbnail created today", "bounds": "[0,100][200,300]"})
        label = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,260][200,300]"})
        self.assertEqual(publisher._instagram_video_tiles([thumbnail, label], 25), [thumbnail])

    def test_instagram_duration_rejects_duplicate_or_mismatched_labels(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        thumbnail = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Video thumbnail", "bounds": "[0,100][200,300]"})
        mismatch = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:24", "bounds": "[120,260][200,300]"})
        duplicate = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[125,260][200,300]"})
        self.assertEqual(publisher._instagram_video_tiles([thumbnail, mismatch], 25), [])
        self.assertEqual(publisher._instagram_video_tiles([thumbnail, duplicate, duplicate], 25), [])

    def test_instagram_duration_accepts_minutes_format_from_label(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        thumbnail = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Video thumbnail", "bounds": "[0,100][200,300]"})
        label = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "1:05", "bounds": "[120,260][200,300]"})
        self.assertEqual(publisher._instagram_video_tiles([thumbnail, label], 65), [thumbnail])

    def test_tiktok_verification_uses_ev2_cover_and_exact_tv_play_count_zero(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        old = node(**{"resource-id": "com.zhiliaoapp.musically:id/ev2", "content-desc": "old cover", "bounds": "[0,100][200,300]"})
        old_count = node(**{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "text": "12", "bounds": "[0,280][80,300]"})
        publisher._capture_profile_tiles([old, old_count])
        new = node(**{"resource-id": "com.zhiliaoapp.musically:id/ev2", "content-desc": "new cover", "bounds": "[0,100][200,300]"})
        new_count = node(**{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "text": "0", "bounds": "[0,280][80,300]"})
        shifted_old = node(**{"resource-id": "com.zhiliaoapp.musically:id/ev2", "content-desc": "old cover", "bounds": "[0,300][200,500]"})
        shifted_count = node(**{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "text": "12", "bounds": "[0,480][80,500]"})
        self.assertEqual(publisher._verified_new_profile_tile([new, new_count, shifted_old, shifted_count]), new)

    def test_tiktok_verification_rejects_zero_in_unrelated_content_description(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        publisher._capture_profile_tiles([])
        cover = node(**{"resource-id": "com.zhiliaoapp.musically:id/ev2", "content-desc": "new cover 0 comments", "bounds": "[0,100][200,300]"})
        wrong_count = node(**{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "text": "1", "bounds": "[0,280][80,300]"})
        with self.assertRaises(PublisherError) as raised:
            publisher._verified_new_profile_tile([cover, wrong_count])
        self.assertEqual(raised.exception.code, "VERIFICATION_VIEW_COUNT")

    def test_instagram_full_profile_to_share_flow_has_monotonic_checkpoints(self):
        base = job("instagram", "safe test"); clip = PublicationJob(base.id, base.device_id, base.media_id, base.platform, base.caption, {**base.media, "duration_seconds": 25}, base.account)
        remote = "publication-7-3.mp4"
        home = [node(text="Profile")]
        profile = [node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"content-desc": "Create New"}), node(**{"content-desc": "older reel"})]
        create = [node(**{"content-desc": "Create new reel"})]
        gallery = [node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Video thumbnail created today", "bounds": "[0,100][200,300]"}), node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,260][200,300]"}), node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Video thumbnail created yesterday", "bounds": "[0,300][200,500]"}), node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,460][200,500]"})]
        editor = [node(**{"resource-id": "com.instagram.android:id/clips_right_action_button"})]
        privacy = [node(text="Continue"), node(text="Downloads privacy")]
        caption = [node(text="Write a caption and add hashtags...")]
        field_empty = [node(**{"class": "android.widget.EditText", "text": ""})]
        field_one = [node(**{"class": "android.widget.EditText", "text": "safe"})]
        field_two = [node(**{"class": "android.widget.EditText", "text": "safe test"}), node(text="Next")]
        final = [node(text="About Reels"), node(text="Share", **{"resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"})]
        # Prepare records the old gallery before transfer, returns to Profile, then publish
        # reopens it and sees the one newly scanned tile.
        old_gallery = [node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Video thumbnail created yesterday", "bounds": "[0,100][200,300]"}), node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,260][200,300]"})]
        device = Device("com.instagram.android", [home, profile, create, old_gallery, home, profile, create, gallery, editor, privacy, caption, field_empty, field_one, field_two, final, final])
        events = []
        publisher = InstagramPublisher(expected_account="expected.account")
        publisher.prepare(clip, device)
        publisher.publish(clip, device, lambda step, progress, **kwargs: events.append((step, progress, kwargs, len(device.taps))))
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertTrue(events[-1][2]["final_action"])
        self.assertEqual(events[-1][3], len(device.taps) - 1)

    def test_tiktok_full_profile_to_post_flow_has_monotonic_checkpoints(self):
        clip = job("tiktok", "safe test")
        home = [node(text="Profile")]
        profile = [node(text="expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/profile_account"}), node(text="Create"), node(**{"resource-id": "com.zhiliaoapp.musically:id/ev2", "content-desc": "older tile"})]
        upload = [node(text="Upload")]
        gallery = [node(**{"resource-id": "com.zhiliaoapp.musically:id/ica", "content-desc": "publication-7-3.mp4", "bounds": "[0,100][200,300]"}), node(**{"resource-id": "com.zhiliaoapp.musically:id/ica", "content-desc": "old-tile", "bounds": "[0,300][200,500]"})]
        next_one = [node(text="Next (1)")]
        editor = [node(text="Next")]
        field = [node(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00"})]
        field_empty = [node(**{"class": "android.widget.EditText", "text": ""})]
        field_one = [node(**{"class": "android.widget.EditText", "text": "safe"})]
        field_two = [node(**{"class": "android.widget.EditText", "text": "safe test"}), node(text="Add description..."), node(text="Public"), node(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6"})]
        details = [node(text="Add description..."), node(text="Public"), node(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6"})]
        old_gallery = [node(**{"resource-id": "com.zhiliaoapp.musically:id/ica", "content-desc": "old-tile"})]
        device = Device("com.zhiliaoapp.musically", [home, profile, upload, old_gallery, home, profile, upload, gallery, next_one, editor, field, field_empty, field_one, field_two, details, details])
        events = []
        publisher = TikTokPublisher(expected_account="expected.account")
        publisher.prepare(clip, device)
        publisher.publish(clip, device, lambda step, progress, **kwargs: events.append((step, kwargs, len(device.taps))))
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertEqual(events[-1][2], len(device.taps) - 1)

    def test_youtube_full_profile_to_upload_flow_has_monotonic_checkpoints(self):
        clip = job("youtube", "safe test")
        remote = "publication-7-3.mp4"
        profile = [node(text="expected.account", **{"resource-id": "com.google.android.youtube:id/account_name"}), node(text="Create"), node(**{"content-desc": "old channel card - play Short"})]
        short = [node(text="Short", **{"resource-id": "com.google.android.youtube:id/creation_mode_button"})]
        import_button = [node(**{"resource-id": "com.google.android.youtube:id/reel_camera_gallery_button_delegate"})]
        gallery = [node(**{"resource-id": "com.google.android.youtube:id/thumb_image_view", "content-desc": remote})]
        next_one = [node(text="Next", **{"resource-id": "com.google.android.youtube:id/multi_select_next_button"})]
        done = [node(text="Done", **{"resource-id": "com.google.android.youtube:id/creation_next_button"})]
        editor = [node(text="Next", **{"resource-id": "com.google.android.youtube:id/shorts_post_bottom_button"})]
        field = [node(text="Caption your Short", **{"class": "android.widget.EditText"})]
        field_empty = [node(**{"class": "android.widget.EditText", "text": ""})]
        field_one = [node(**{"class": "android.widget.EditText", "text": "safe"})]
        field_two = [node(**{"class": "android.widget.EditText", "text": "safe test"}), node(text="Caption your Short"), node(text="Public"), node(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button"})]
        details = [node(text="Caption your Short"), node(text="Public"), node(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button"})]
        device = Device("com.google.android.youtube", [profile, short, import_button, gallery, next_one, done, editor, field, field_empty, field_one, field_two, details, details])
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
            base = job("youtube")
            platform_adapters()["youtube"](PublicationJob(base.id, base.device_id, base.media_id, base.platform, base.caption, base.media))
        self.assertEqual(raised.exception.code, "ACCOUNT_SNAPSHOT_INVALID")


if __name__ == "__main__":
    unittest.main()
