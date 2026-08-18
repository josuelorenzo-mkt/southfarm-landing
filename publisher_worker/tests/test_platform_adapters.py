import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.models import PublicationJob, PublicationStatus, PublisherError
from southfarm_publisher.platforms.instagram import InstagramPublisher
from southfarm_publisher.platforms.tiktok import TikTokPublisher
from southfarm_publisher.platforms.youtube import YouTubeShortPublisher


class Device:
    def __init__(self, package, dumps, *, advance_on_poll=False):
        self.package, self.dumps, self.taps, self.typed, self.swipes, self.commands = package, list(dumps), [], [], [], []
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
                # A timeout does not kill the device: callers that catch
                # UI_TIMEOUT (for example the media-candidate loop, which now
                # re-dumps before the next tap) must be able to read again.
                self._stale_reads = 0
                raise PublisherError("UI_TIMEOUT", "fake device UI did not advance")
        return self._last_dump
    def tap_bounds(self, bounds, delay_seconds=0): self.taps.append(bounds); self._after_tap = True; self._stale_reads = 0
    def text(self, value): self.typed.append(value); self._after_tap = True; self._stale_reads = 0
    def swipe(self, *args): self.swipes.append(args); self._after_tap = True; self._stale_reads = 0
    def command(self, *args, **kwargs):
        self.commands.append(args)
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


def posting_overlay(percent):
    """Live 2026-08-17 upload overlay: su6 "Posting..." + su5 "N%"."""
    return [
        node(text="Posting...", clickable="false", **{"resource-id": "com.zhiliaoapp.musically:id/su6", "bounds": "[216,1373][696,1411]"}),
        node(text=percent, clickable="false", **{"resource-id": "com.zhiliaoapp.musically:id/su5", "bounds": "[136,1373][216,1411]"}),
    ]


class ClockedTikTokPublisher(TikTokPublisher):
    """TikTokPublisher whose post-Post confirmation wait runs on a fake clock."""

    def __init__(self, ticks, **kwargs):
        super().__init__(**kwargs)
        self._confirmation_ticks = iter(ticks)

    def _wait_post_confirmation(self, device):
        return TikTokPublisher._wait_post_confirmation(self, device, clock=lambda: next(self._confirmation_ticks))


class PlatformAdapterTests(unittest.TestCase):
    def test_passive_account_identity_labels_are_accepted_but_switchers_remain_actionable(self):
        labels = (
            (InstagramPublisher, "com.instagram.android:id/action_bar_title"),
            (TikTokPublisher, "com.zhiliaoapp.musically:id/se1"),
            (YouTubeShortPublisher, "com.google.android.youtube:id/account_name"),
        )
        switcher = node(**{"resource-id": "com.instagram.android:id/action_bar_username_container"})

        for publisher_type, label_id in labels:
            with self.subTest(label_id=label_id):
                label = node(text="expected.account", clickable="false", **{"resource-id": label_id})
                publisher = publisher_type(expected_account="expected.account")
                self.assertEqual(publisher.account_control([label, switcher], resource_id=label_id, error="active account"), label)

        self.assertEqual(InstagramPublisher(expected_account="expected.account")._one([switcher], error="Instagram account switcher", resource_id="com.instagram.android:id/action_bar_username_container"), switcher)
        disabled_switcher = node(clickable="false", **{"resource-id": "com.instagram.android:id/action_bar_username_container"})
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account")._one([disabled_switcher], error="Instagram account switcher", resource_id="com.instagram.android:id/action_bar_username_container")
        self.assertEqual(raised.exception.code, "CONTROL_DISABLED")

    def test_selected_account_prefers_one_clickable_account_option_over_its_nested_text(self):
        option = node(**{"content-desc": "expected.account", "bounds": "[32,679][688,807]"})
        label = node(text="expected.account", clickable="false", bounds="[168,722][384,763]")

        for platform, publisher_type in (("instagram", InstagramPublisher), ("tiktok", TikTokPublisher), ("youtube", YouTubeShortPublisher)):
            with self.subTest(platform=platform):
                selected = publisher_type(expected_account="expected.account").require_account_available(job(platform), [option, label])
                self.assertEqual(selected, option)

    def test_selected_account_rejects_duplicate_clickable_account_options(self):
        first = node(**{"content-desc": "expected.account", "bounds": "[32,679][688,807]"})
        second = node(**{"content-desc": "expected.account", "bounds": "[32,808][688,936]"})
        label = node(text="expected.account", clickable="false", bounds="[168,722][384,763]")

        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").require_account_available(job("instagram"), [first, label, second])

        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")

    def test_tiktok_duplicate_identity_control_is_account_unavailable_without_media_or_typing(self):
        device = Device("com.zhiliaoapp.musically", [
            [node(text="Profile")],
            [node(text="@wrong", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}), node(text="@wrong", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})],
        ])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1)
        self.assertEqual(device.typed, [])

    def test_tiktok_wrong_active_profile_is_account_mismatch_without_switching(self):
        device = Device("com.zhiliaoapp.musically", [
            [node(text="Profile")],
            [node(text="@wrong.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})],
        ])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_MISMATCH")
        self.assertEqual(len(device.taps), 1, "Only the required Profile navigation may occur before account rejection")
        self.assertEqual(device.typed, [])

    def test_instagram_duplicate_selected_switcher_item_is_account_mismatch_without_switching(self):
        device = Device("com.instagram.android", [
            [node(**{"content-desc": "Profile"})],
            [node(text="wrong.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"resource-id": "com.instagram.android:id/action_bar_username_container"})],
            [node(text="expected.account"), node(text="expected.account")],
        ])

        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").prepare(job("instagram"), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_MISMATCH")
        self.assertEqual(len(device.taps), 1)
        self.assertEqual(device.typed, [])

    def test_tiktok_missing_selected_switcher_item_is_account_unavailable_without_typing(self):
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [node(**{"resource-id": "com.zhiliaoapp.musically:id/sh3", "content-desc": "Wrong Display"}), node(text="expected.account")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1)
        self.assertEqual(device.typed, [])

    def test_duplicate_active_account_controls_are_account_unavailable_on_all_platforms(self):
        cases = {
            "instagram": (InstagramPublisher, "com.instagram.android", [[node(**{"content-desc": "Profile"})], [node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title", "bounds": "[10,20][110,80]"}), node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title", "bounds": "[10,90][110,150]"})]]),
            "tiktok": (TikTokPublisher, "com.zhiliaoapp.musically", [[node(text="Profile")], [node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}), node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})]]),
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
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [node(**{"resource-id": "com.zhiliaoapp.musically:id/sh3", "content-desc": "Display"}), node(text="expected.account"), node(text="Create")]])

        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1)
        self.assertEqual(device.typed, [])

    def test_instagram_duplicate_switch_controls_are_untouched_on_account_mismatch(self):
        device = Device("com.instagram.android", [
            [node(**{"content-desc": "Profile"})],
            [node(text="wrong.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"resource-id": "com.instagram.android:id/action_bar_username_container"}), node(**{"resource-id": "com.instagram.android:id/action_bar_username_container", "bounds": "[10,90][110,150]"})],
        ])

        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").prepare(job("instagram"), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_MISMATCH")
        self.assertEqual(len(device.taps), 1)

    def test_instagram_prepare_captures_post_count_baseline_without_gallery_visit(self):
        profile = [node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"content-desc": "Create New"}), node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "8posts"}), node(**{"content-desc": "Reel by Expected at row 1, column 1"})]
        device = Device("com.instagram.android", [[node(**{"content-desc": "Profile"})], profile])

        publisher = InstagramPublisher(expected_account="expected.account")
        publisher.prepare(job("instagram"), device)

        self.assertEqual(publisher._baseline_posts, 8)
        self.assertEqual(publisher._baseline_tiles, frozenset({"Reel by Expected at row 1, column 1"}))
        self.assertEqual(len(device.taps), 1, "prepare navigates to the profile and never opens the gallery")

    def test_tiktok_prepare_captures_play_count_baseline_without_picker_visit(self):
        profile = [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/sh3", "content-desc": "Expected"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/o70", "content-desc": "Create"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/o76", "content-desc": "Profile"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
            node(**{"content-desc": "older cover", "bounds": "[0,834][238,1151]"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
        ]
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], profile])

        publisher = TikTokPublisher(expected_account="expected.account")
        publisher.prepare(job(), device)

        self.assertEqual(publisher._baseline_play_counts, ["12"])
        self.assertEqual(len(device.taps), 1, "prepare navigates to the profile and never opens the picker")

    def test_tiktok_prepare_recaptures_late_rendering_play_counts_with_redump(self):
        # Live 2026-08-17: the profile grid renders its tiles before the
        # tv_play_count counters.  prepare re-dumps (with a 2s pause per
        # attempt) and captures the row once the counters render.
        waits = []
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})
        count = node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"})
        without_counts = [identity, grid]
        with_counts = [identity, grid, count]
        device = Device("com.zhiliaoapp.musically", [
            [node(text="Profile")],   # initial dump: only the profile tab
            [node(text="Profile")],   # immediately-before dump of the tab tap
            without_counts,           # post-tap profile: grid rendered, no counters
            with_counts,              # first retry re-dump: counters rendered
        ], advance_on_poll=True)

        publisher = TikTokPublisher(expected_account="expected.account", pause=waits.append)
        publisher.prepare(job(), device)

        self.assertEqual(publisher._baseline_play_counts, ["12"])
        self.assertEqual(waits, [2.0], "exactly one 2s retry pause before the re-dump that rendered the counts")

    def test_tiktok_prepare_empty_profile_without_tiles_needs_no_retry_or_warning(self):
        # A genuinely post-less profile has no grid: the empty baseline is
        # valid immediately, without retries and without the weak-signal
        # warning.
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [identity]])

        publisher = TikTokPublisher(expected_account="expected.account")
        with self.assertNoLogs("southfarm_publisher.platforms.tiktok", level="WARNING"):
            publisher.prepare(job(), device)

        self.assertEqual(publisher._baseline_play_counts, [])
        self.assertEqual(len(device.taps), 1, "only the required Profile navigation occurs")

    def test_tiktok_prepare_warns_and_continues_when_grid_counts_never_render(self):
        # Tiles exist but the counters never render across the retries: the
        # empty baseline is accepted with a clear warning and prepare
        # completes -- the identity gate stays the only verification signal.
        waits = []
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})
        without_counts = [identity, grid]
        device = Device("com.zhiliaoapp.musically", [
            [node(text="Profile")],
            [node(text="Profile")],
            without_counts,
            without_counts,
            without_counts,
            without_counts,
        ], advance_on_poll=True)

        publisher = TikTokPublisher(expected_account="expected.account", pause=waits.append)
        with self.assertLogs("southfarm_publisher.platforms.tiktok", level="WARNING") as logs:
            publisher.prepare(job(), device)

        self.assertEqual(publisher._baseline_play_counts, [])
        self.assertEqual(waits, [2.0, 2.0, 2.0], "exactly three retry pauses before accepting the empty row")
        self.assertTrue(any("play-count baseline empty; identity gate is the only verification signal" in line for line in logs.output))
        self.assertTrue(publisher._prepared, "prepare completes; the identity-gated verify stays valid")

    def test_tap_and_wait_taps_clickable_ancestor_when_leaf_is_not_clickable(self):
        # Live editor build: the "Next" TextView (pjg) reports clickable=false
        # and its LinearLayout parent (pje) carries the tap.
        leaf = node(text="Next", clickable="false", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[493,1456][566,1496]"})
        parent = node(**{"resource-id": "com.zhiliaoapp.musically:id/pje", "clickable": "true", "bounds": "[364,1432][696,1520]"})
        caption_screen = [node(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "bounds": "[10,1300][700,1380]"})]
        device = Device("com.zhiliaoapp.musically", [[parent, leaf], caption_screen])

        publisher = TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None)
        selected = publisher.tap_and_wait(device, leaf, error="CAPTION_FIELD", resource_id="com.zhiliaoapp.musically:id/h00")

        self.assertEqual(selected["resource-id"], "com.zhiliaoapp.musically:id/h00")
        self.assertEqual(device.taps, [(364, 1432, 696, 1520)], "the tap dispatches the clickable ancestor bounds, never the leaf")

    def test_clickable_target_returns_the_leaf_itself_when_already_clickable(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        leaf = node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[500,2050][700,2150]"})
        container = node(**{"resource-id": "com.zhiliaoapp.musically:id/pje", "clickable": "true", "bounds": "[364,1432][696,1520]"})
        self.assertIs(publisher._clickable_target(leaf, [container, leaf]), leaf)
        self.assertIs(publisher._one([container, leaf], error="EDITOR_NEXT", resource_id="com.zhiliaoapp.musically:id/pjg", text="Next"), leaf)

    def test_control_disabled_when_leaf_has_no_clickable_ancestor(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        leaf = node(text="Next", clickable="false", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[493,1456][566,1496]"})
        containers = [
            node(**{"class": "android.widget.LinearLayout", "clickable": "false", "bounds": "[427,1426][592,1516]"}),
            node(**{"class": "android.view.ViewGroup", "clickable": "false", "bounds": "[0,1422][720,1520]"}),
        ]
        with self.assertRaises(PublisherError) as raised:
            publisher._one([*containers, leaf], error="EDITOR_NEXT", resource_id="com.zhiliaoapp.musically:id/pjg", text="Next")
        self.assertEqual(raised.exception.code, "CONTROL_DISABLED")

    def test_control_disabled_when_clickable_target_is_disabled_even_with_ancestors(self):
        # Fail-closed in both directions: a clickable-but-disabled leaf is
        # never rescued through a container, and a disabled clickable
        # ancestor is never tapped instead of the leaf.
        publisher = TikTokPublisher(expected_account="expected.account")
        disabled_leaf = node(text="Next", clickable="true", enabled="false", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[493,1456][566,1496]"})
        parent = node(**{"resource-id": "com.zhiliaoapp.musically:id/pje", "clickable": "true", "bounds": "[364,1432][696,1520]"})
        with self.assertRaises(PublisherError) as raised:
            publisher._one([parent, disabled_leaf], error="EDITOR_NEXT", resource_id="com.zhiliaoapp.musically:id/pjg", text="Next")
        self.assertEqual(raised.exception.code, "CONTROL_DISABLED")

        disabled_parent = node(**{"resource-id": "com.zhiliaoapp.musically:id/pje", "clickable": "true", "enabled": "false", "bounds": "[364,1432][696,1520]"})
        plain_leaf = node(text="Next", clickable="false", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[493,1456][566,1496]"})
        with self.assertRaises(PublisherError) as raised:
            publisher._one([disabled_parent, plain_leaf], error="EDITOR_NEXT", resource_id="com.zhiliaoapp.musically:id/pjg", text="Next")
        self.assertEqual(raised.exception.code, "CONTROL_DISABLED")

    def test_fresh_tap_target_discards_when_resolved_ancestor_is_outside_viewport(self):
        # The re-localized leaf is fine, but its clickable ancestor serves
        # out-of-viewport spans: the fresh-tap path discards the target and
        # no tap is ever dispatched.
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        leaf = node(text="0:25", clickable="false", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,520][220,560]"})
        publisher._last_nodes = [leaf]
        off_parent = node(**{"class": "android.widget.FrameLayout", "clickable": "true", "bounds": "[140,500][240,2000]"})
        device = Device("com.zhiliaoapp.musically", [[off_parent, leaf]] * 4, advance_on_poll=True)

        self.assertIsNone(publisher._fresh_tap_target(device, leaf))
        self.assertEqual(device.taps, [], "no tap is ever dispatched when the clickable ancestor is off-viewport")

    def test_fresh_tap_target_re_resolves_ancestor_bounds_from_each_fresh_dump(self):
        # The ancestor may shift bounds between dumps: the leaf is
        # re-localized and the ancestor re-resolved on EVERY fresh dump, so
        # the accepted target carries the newest geometry.
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        leaf = node(text="Next", clickable="false", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[493,1456][566,1496]"})
        publisher._last_nodes = [leaf]
        stale_parent = node(**{"resource-id": "com.zhiliaoapp.musically:id/pje", "clickable": "true", "bounds": "[140,500][240,2000]"})
        fresh_parent = node(**{"resource-id": "com.zhiliaoapp.musically:id/pje", "clickable": "true", "bounds": "[364,1432][696,1520]"})
        device = Device("com.zhiliaoapp.musically", [[stale_parent, leaf], [fresh_parent, leaf]], advance_on_poll=True)

        target = publisher._fresh_tap_target(device, leaf)

        self.assertEqual(target["bounds"], "[364,1432][696,1520]", "the fresh dump re-resolves the ancestor with its new bounds")

    def test_tiktok_editor_next_taps_clickable_ancestor_after_selection(self):
        # Full live 2026-08-17 aborted scenario: the picker Next (x4j)
        # accepts the selection tap, the editor arrives with a non-clickable
        # "Next" leaf (pjg) whose LinearLayout parent (pje) is the clickable
        # target; the guarded taps must dispatch the parent's bounds.
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        stale_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"})
        stale_label = node(text="0:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,520][220,560]"})
        publisher._last_nodes = [stale_tile, stale_label]
        selected_screen = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/x4j", "bounds": "[368,1424][696,1512]"})]
        editor_leaf = node(text="Next", clickable="false", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[493,1456][566,1496]"})
        editor_parent = node(**{"resource-id": "com.zhiliaoapp.musically:id/pje", "clickable": "true", "bounds": "[364,1432][696,1520]"})
        caption_screen = [node(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"})]
        device = Device("com.zhiliaoapp.musically", [[stale_tile, stale_label], selected_screen, [editor_parent, editor_leaf], caption_screen])

        selected = publisher._select_media(device, 25)

        self.assertEqual(selected["resource-id"], "com.zhiliaoapp.musically:id/pjg")
        self.assertEqual(device.taps[0], (140, 520, 220, 560), "the candidate tap dispatches the fresh label bounds")
        publisher.tap_and_wait(device, selected, error="CAPTION_FIELD", predicate=publisher._caption_field)
        self.assertEqual(device.taps[1], (368, 1424, 696, 1512), "the picker Next tap dispatches its own clickable bounds")
        self.assertEqual(device.taps[2], (364, 1432, 696, 1520), "the editor Next tap dispatches the clickable ancestor bounds")

    def test_missing_selected_account_never_reaches_media_selection(self):
        device = Device("com.instagram.android", [
            [node(**{"content-desc": "Profile"})],
            [node(text="wrong.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}), node(**{"resource-id": "com.instagram.android:id/action_bar_username_container"})],
            [node(text="expected.account.backup"), node(**{"content-desc": "Create New"})],
        ])

        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").prepare(job("instagram"), device)

        self.assertEqual(raised.exception.code, "ACCOUNT_MISMATCH")
        self.assertEqual(len(device.taps), 1)

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
            "tiktok_create_collision.xml": "camera_label",
            "tiktok_details_keyboard_open.xml": "com.zhiliaoapp.musically:id/h00",
            "tiktok_verify_item.xml": "safe publishing test 0 views",
            "youtube_disabled_upload.xml": "com.google.android.youtube:id/upload_bottom_button",
            "youtube_duplicate_gallery.xml": "publication-7-3.mp4",
            "youtube_short_collision.xml": "Shorts",
            "youtube_verify_item.xml": "safe publishing test, No views - play Short",
            "youtube_channel_profile.xml": "23 views - play Short",
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
        device = Device("com.zhiliaoapp.musically", [[node(text="Profile")], [node(**{"resource-id": "com.zhiliaoapp.musically:id/sh3", "content-desc": "Display"}), node(**{"resource-id": "com.zhiliaoapp.musically:id/o70", "content-desc": "Create"}), node(text="different.account")]])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_UNAVAILABLE")
        self.assertEqual(len(device.taps), 1, "Only the required Profile navigation may occur before account rejection")
    def test_tiktok_mid_flow_is_refused_before_post_tap(self):
        flow = [node(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00"}), node(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6", "bounds": "[20,1400][700,1520]"})]
        device = Device("com.zhiliaoapp.musically", [flow, flow])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(TikTokPublisher).publish(job(), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertEqual(device.taps, [])

    def test_instagram_mid_flow_is_refused_before_share_tap(self):
        final = [node(text="safe test", **{"resource-id": "com.instagram.android:id/caption_input_text_view"}), node(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share"})]
        device = Device("com.instagram.android", [final, final])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(InstagramPublisher).publish(job("instagram"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertEqual(device.taps, [])

    def test_final_checkpoint_error_cannot_resume_mid_flow(self):
        details = [node(text="safe test", **{"resource-id": "com.instagram.android:id/caption_input_text_view"}), node(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share"})]
        device = Device("com.instagram.android", [details, details])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(InstagramPublisher).publish(job("instagram"), device, lambda *a, **k: (_ for _ in ()).throw(OSError("checkpoint unavailable")))
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertEqual(device.taps, [])

    def test_final_share_without_caption_context_is_not_tapped(self):
        share = node(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share", "bounds": "[600,1400][700,1500]"})
        device = Device("com.instagram.android", [[share], [share]])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(InstagramPublisher)._final(device, lambda *args, **kwargs: None, button={"resource_id": "com.instagram.android:id/share_button"}, context={"resource_id": "com.instagram.android:id/caption_input_text_view"}, evidence={"platform": "instagram"})
        self.assertEqual(raised.exception.code, "FINAL_CONTEXT_MISSING")
        self.assertEqual(device.taps, [])

    def test_disabled_youtube_upload_is_not_tapped(self):
        final_bounds = "[20,1400][700,1520]"
        details = [node(text="Caption your Short"), node(text="Public"), node(text="Upload Short", **{"resource-id": "com.google.android.youtube:id/upload_bottom_button", "enabled": "false", "bounds": final_bounds})]
        device = Device("com.google.android.youtube", [details, details, details, details, details, details, details])
        with self.assertRaises(PublisherError) as raised:
            resumed_for_final(YouTubeShortPublisher).publish(job("youtube"), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertNotIn((20, 1400, 700, 1520), device.taps)

    # Obsolete YouTube tests were removed: the old flow (Short mode button,
    # You-tab navigation, service-dump caption field, old delete dialog) is
    # replaced by the verified hybrid adapter and its full suite in
    # tests/test_youtube_adapter.py (duplicate remote media migrated there).

    def test_youtube_bottom_tab_selects_app_tab_over_systemui_navbar_home(self):
        # The YouTube bottom bar (Home/Shorts/Create/Subscriptions/You) has NO
        # resource-id and the SystemUI 3-button navbar exposes a content-desc
        # "Home" button: package scoping makes foreign-package nodes
        # invisible to the semantic tab match (recon 2026-08-17).
        publisher = YouTubeShortPublisher(expected_account="expected.account")
        systemui_home = node(**{"resource-id": "com.android.systemui:id/home", "package": "com.android.systemui", "content-desc": "Home", "bounds": "[280,1544][440,1640]"})
        app_home = node(**{"package": "com.google.android.youtube", "content-desc": "Home", "bounds": "[0,1448][144,1544]"})
        self.assertEqual(publisher._bottom_tab([systemui_home, app_home], label="Home"), app_home)
        self.assertIsNone(publisher._bottom_tab([systemui_home], label="Home"))

    def test_youtube_tap_tab_fails_closed_when_only_systemui_navbar_home_present(self):
        # Without the app's own Home tab the SystemUI navbar button must not
        # stand in: _tap_tab reports absence and fails closed with TAB_BAR.
        publisher = YouTubeShortPublisher(expected_account="expected.account")
        systemui_home = node(**{"resource-id": "com.android.systemui:id/home", "package": "com.android.systemui", "content-desc": "Home", "bounds": "[280,1544][440,1640]"})
        device = Device("com.google.android.youtube", [[systemui_home]])
        with self.assertRaises(PublisherError) as raised:
            publisher._tap_tab(device, label="Home")
        self.assertEqual(raised.exception.code, "TAB_BAR")
        self.assertEqual(device.taps, [], "the SystemUI Home button is never tapped")

    def test_instagram_cleanup_deletes_test_post_and_restores_post_count(self):
        expected = "safe publishing test"
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        tile = node(**{"content-desc": "Reel by Expected at row 1, column 1"})
        device = Device("com.instagram.android", [
            [account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "9posts"}), tile],
            [node(**{"resource-id": "com.instagram.android:id/clips_media_component", "content-desc": "Reel by expected.account. Double tap to play or pause."}), node(text=expected), node(**{"resource-id": "com.instagram.android:id/media_option_button", "content-desc": "More actions for this post"})],
            [node(text="Delete", **{"resource-id": "com.instagram.android:id/control_option_text"})],
            [node(text="Delete Post?", **{"resource-id": "com.instagram.android:id/igds_alert_dialog_headline"}), node(text="Delete", **{"resource-id": "com.instagram.android:id/igds_alert_dialog_primary_button"})],
            [account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "8posts"})],
        ])
        InstagramPublisher(expected_account="expected.account", pause=lambda _: setattr(device, "_after_tap", True)).cleanup_test_post(expected, ["8posts"], device)
        self.assertEqual(len(device.taps), 4)

    def test_instagram_cleanup_scrolls_sheet_when_delete_is_below_the_fold(self):
        expected = "safe publishing test"
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        tile = node(**{"content-desc": "Reel by Expected at row 1, column 1"})
        sheet = [node(text="Edit", **{"resource-id": "com.instagram.android:id/control_option_text"}), node(text="Archive", **{"resource-id": "com.instagram.android:id/control_option_text", "bounds": "[10,90][110,150]"})]
        device = Device("com.instagram.android", [
            [account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "9posts"}), tile],
            [node(**{"resource-id": "com.instagram.android:id/clips_media_component", "content-desc": "Reel by expected.account. Double tap to play or pause."}), node(text=expected), node(**{"resource-id": "com.instagram.android:id/media_option_button", "content-desc": "More actions for this post"})],
            sheet,
            [node(text="Delete", **{"resource-id": "com.instagram.android:id/control_option_text"})],
            [node(text="Delete Post?", **{"resource-id": "com.instagram.android:id/igds_alert_dialog_headline"}), node(text="Delete", **{"resource-id": "com.instagram.android:id/igds_alert_dialog_primary_button"})],
            [account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "8posts"})],
        ])
        InstagramPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).cleanup_test_post(expected, ["8posts"], device)
        self.assertEqual(len(device.swipes), 1)
        self.assertEqual(len(device.taps), 4)

    def test_instagram_cleanup_fails_closed_when_opened_reel_is_not_the_test_post(self):
        expected = "safe publishing test"
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        tile = node(**{"content-desc": "Reel by Expected at row 1, column 1"})
        wrong_reel = [node(**{"resource-id": "com.instagram.android:id/clips_media_component", "content-desc": "Reel by expected.account. Double tap to play or pause."}), node(text="unrelated reel"), node(**{"resource-id": "com.instagram.android:id/media_option_button", "content-desc": "More actions for this post"})]
        device = Device("com.instagram.android", [[account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "9posts"}), tile], wrong_reel, wrong_reel, wrong_reel, wrong_reel])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).cleanup_test_post(expected, ["8posts"], device)
        self.assertEqual(raised.exception.code, "REEL_MISMATCH")
        self.assertEqual(len(device.taps), 1, "only the grid tile is opened; the reel menu is never touched")

    def test_instagram_cleanup_requires_exactly_one_post_above_baseline(self):
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        device = Device("com.instagram.android", [[account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "8posts"})]])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").cleanup_test_post("safe publishing test", ["8posts"], device)
        self.assertEqual(raised.exception.code, "CLEANUP_IDENTITY_MISMATCH")
        self.assertEqual(device.taps, [])

    def test_instagram_cleanup_rejects_malformed_baselines_without_any_tap(self):
        device = Device("com.instagram.android", [[]])
        for baseline in ([], ["8posts", "9posts"], ["8 posts"], ["eight"], ["expected.account", "old reel"]):
            with self.subTest(baseline=baseline):
                with self.assertRaises(PublisherError) as raised:
                    InstagramPublisher(expected_account="expected.account").cleanup_test_post("safe publishing test", baseline, device)
                self.assertEqual(raised.exception.code, "CLEANUP_BASELINE_INVALID")
                self.assertEqual(device.taps, [])

    def test_instagram_cleanup_without_menu_control_never_reaches_delete(self):
        expected = "safe publishing test"
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        tile = node(**{"content-desc": "Reel by Expected at row 1, column 1"})
        reel = [node(**{"resource-id": "com.instagram.android:id/clips_media_component", "content-desc": "Reel by expected.account. Double tap to play or pause."}), node(text=expected)]
        device = Device("com.instagram.android", [[account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "9posts"}), tile], reel])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account").cleanup_test_post(expected, ["8posts"], device)
        self.assertEqual(raised.exception.code, "REEL_MENU")
        self.assertEqual(len(device.taps), 1)

    def tiktok_cleanup_profile(self):
        return [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
            node(**{"content-desc": "new cover", "bounds": "[0,834][238,1151]"}),
            node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
            node(**{"content-desc": "older cover", "bounds": "[248,834][486,1151]"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[328,1100][408,1150]"}),
        ]

    def tiktok_opened_post(self, caption="safe video"):
        share_visible = node(**{"resource-id": "com.zhiliaoapp.musically:id/fzi", "content-desc": "Share video", "bounds": "[10,1400][200,1500]"})
        share_preloaded = node(**{"resource-id": "com.zhiliaoapp.musically:id/fzi", "content-desc": "Share video", "bounds": "[730,1400][930,1500]"})
        return [node(text=caption, **{"resource-id": "com.zhiliaoapp.musically:id/desc"}), share_visible, share_preloaded]

    def test_tiktok_cleanup_deletes_test_post_and_restores_play_count_baseline(self):
        sheet = [node(**{"resource-id": "com.zhiliaoapp.musically:id/vbn", "content-desc": "Delete", "bounds": "[20,1420][160,1500]"})]
        confirm_dialog = [node(text="Delete", **{"resource-id": "com.zhiliaoapp.musically:id/fq5", "bounds": "[100,900][300,980]"})]
        restored = [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
            node(**{"content-desc": "older cover", "bounds": "[0,834][238,1151]"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
        ]
        device = Device("com.zhiliaoapp.musically", [self.tiktok_cleanup_profile(), self.tiktok_opened_post(), sheet, confirm_dialog, restored])

        TikTokPublisher(expected_account="expected.account").cleanup_test_post("safe video", ["12"], device)

        self.assertEqual(len(device.taps), 4)
        self.assertEqual(device.swipes, [])
        self.assertEqual(device.taps[1], (10, 1400, 200, 1500), "the on-screen Share button is tapped, never the preloaded off-screen copy")

    def test_tiktok_cleanup_scrolls_share_sheet_when_delete_is_off_screen(self):
        sheet_hidden = [node(**{"resource-id": "com.zhiliaoapp.musically:id/vbn", "content-desc": "Delete", "bounds": "[730,1420][870,1500]"})]
        sheet_visible = [node(**{"resource-id": "com.zhiliaoapp.musically:id/vbn", "content-desc": "Delete", "bounds": "[20,1420][160,1500]"})]
        confirm_dialog = [node(text="Delete", **{"resource-id": "com.zhiliaoapp.musically:id/fq5", "bounds": "[100,900][300,980]"})]
        restored = [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
        ]
        device = Device("com.zhiliaoapp.musically", [self.tiktok_cleanup_profile(), self.tiktok_opened_post(), sheet_hidden, sheet_visible, confirm_dialog, restored])

        TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).cleanup_test_post("safe video", ["12"], device)

        self.assertEqual(device.swipes, [(600, 1430, 100, 1430, 300)], "the scrolleable action row is swiped to reveal Delete")
        self.assertEqual(len(device.taps), 4)

    def test_tiktok_cleanup_fails_closed_when_opened_post_is_not_the_test_post(self):
        wrong_post = self.tiktok_opened_post(caption="different video")
        device = Device("com.zhiliaoapp.musically", [self.tiktok_cleanup_profile(), wrong_post, wrong_post, wrong_post, wrong_post])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).cleanup_test_post("safe video", ["12"], device)
        self.assertEqual(raised.exception.code, "REEL_MISMATCH")
        self.assertEqual(len(device.taps), 1, "only the grid tile is opened; the share sheet is never touched")
        self.assertEqual(device.swipes, [])

    def test_tiktok_cleanup_requires_exactly_one_zero_tile_above_baseline(self):
        stale = [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
        ]
        device = Device("com.zhiliaoapp.musically", [stale])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account").cleanup_test_post("safe video", ["12"], device)
        self.assertEqual(raised.exception.code, "CLEANUP_IDENTITY_MISMATCH")
        self.assertEqual(device.taps, [])

    def test_tiktok_cleanup_rejects_malformed_baselines_without_any_tap(self):
        device = Device("com.zhiliaoapp.musically", [[]])
        for baseline in ([], ["12", ""], ["12", 12], "12"):
            with self.subTest(baseline=baseline):
                with self.assertRaises(PublisherError) as raised:
                    TikTokPublisher(expected_account="expected.account").cleanup_test_post("safe video", baseline, device)
                self.assertEqual(raised.exception.code, "CLEANUP_BASELINE_INVALID")
                self.assertEqual(device.taps, [])

    def test_youtube_cleanup_more_actions_from_other_card_never_deletes(self):
        expected, baseline = "safe publishing test - play Short", ["expected.account", "older post - play Short"]
        device = Device("com.google.android.youtube", [[node(text="expected.account"), node(**{"content-desc": expected, "bounds": "[0,100][600,200]"}), node(**{"content-desc": "More actions", "bounds": "[610,300][700,400]"}), node(**{"content-desc": "older post - play Short"})]])
        with self.assertRaises(PublisherError) as raised:
            YouTubeShortPublisher(expected_account="expected.account").cleanup_test_post(expected, baseline, device)
        self.assertEqual(raised.exception.code, "CLEANUP_MENU_COLLISION")
        self.assertEqual(device.taps, [])

    def test_cleanup_missing_confirmation_never_taps_delete_action(self):
        sheet = [node(**{"resource-id": "com.zhiliaoapp.musically:id/vbn", "content-desc": "Delete", "bounds": "[20,1420][160,1500]"})]
        device = Device("com.zhiliaoapp.musically", [self.tiktok_cleanup_profile(), self.tiktok_opened_post(), sheet, []])
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).cleanup_test_post("safe video", ["12"], device)
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertEqual(len(device.taps), 3, "the confirmation control never appears, so no delete is confirmed")

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
        old = node(**{"content-desc": "Unselected Video thumbnail created yesterday", "resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "bounds": "[0,100][200,300]"})
        publisher._capture_gallery_baseline([old], publisher._is_video_tile)
        shifted_old = node(**{"content-desc": "Unselected Video thumbnail created yesterday", "resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "bounds": "[0,300][200,500]"})
        new = node(**{"content-desc": "Unselected Video thumbnail created today", "resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "bounds": "[0,100][200,300]"})
        self.assertEqual(publisher._new_gallery_tile([new, shifted_old], publisher._is_video_tile), new)

    def test_instagram_prepare_rejects_username_incidental_outside_profile(self):
        device = Device("com.instagram.android", [[node(text="expected.account"), node(**{"content-desc": "Create New"})]])
        with self.assertRaises(PublisherError) as raised:
            InstagramPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None).prepare(job("instagram"), device)
        self.assertEqual(raised.exception.code, "PROFILE_TAB")
        self.assertEqual(device.taps, [])

    def test_instagram_navigate_profile_reuses_the_exact_active_profile_without_tapping(self):
        active_profile = [
            node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}),
            node(**{"resource-id": "com.instagram.android:id/profile_header_container"}),
            node(**{"content-desc": "Profile"}),
        ]
        device = Device("com.instagram.android", [active_profile])

        nodes = InstagramPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None)._navigate_profile(device)

        self.assertEqual(nodes, active_profile)
        self.assertEqual(device.taps, [])

    def test_instagram_navigate_profile_reuses_a_verified_wrong_active_profile_without_tapping(self):
        active_profile = [
            node(text="wrong.account", **{"resource-id": "com.instagram.android:id/action_bar_title"}),
            node(**{"resource-id": "com.instagram.android:id/profile_header_container"}),
            node(**{"content-desc": "Profile"}),
        ]
        device = Device("com.instagram.android", [active_profile])

        nodes = InstagramPublisher(expected_account="expected.account", timeout=.1, poll=.05, pause=lambda _: None)._navigate_profile(device)

        self.assertEqual(nodes, active_profile)
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
        def is_picker_tile(node): return node.get("resource-id") == "com.zhiliaoapp.musically:id/ofk"
        old = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "content-desc": "same cover"})
        publisher._capture_gallery_baseline([old, old], is_picker_tile)
        new = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "content-desc": "new cover"})
        self.assertEqual(publisher._new_gallery_tile([new, old, old], is_picker_tile), new)
        with self.assertRaises(PublisherError) as missing:
            publisher._new_gallery_tile([new, old], is_picker_tile)
        self.assertEqual(missing.exception.code, "MEDIA_BASELINE_MISSING")
        with self.assertRaises(PublisherError) as reordered:
            publisher._new_gallery_tile([old, new, old], is_picker_tile)
        self.assertEqual(reordered.exception.code, "MEDIA_BASELINE_ORDER_CHANGED")

    def tiktok_profile_grid(self, *new_tile):
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})
        old_cover = node(**{"content-desc": "older cover", "bounds": "[0,834][238,1151]"})
        old_count = node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"})
        items = [identity, grid, old_cover, old_count]
        if new_tile:
            items = [identity, grid, *new_tile, old_cover, old_count]
        return items

    def test_tiktok_verification_detects_prepended_zero_tile_delta(self):
        # Delta is the prepend, not exact row equality: the first visible
        # count is the new "0" tile and the baseline did not lead with "0".
        publisher = TikTokPublisher(expected_account="expected.account")
        publisher._baseline_play_counts = ["12"]
        new_cover = node(**{"content-desc": "new cover", "bounds": "[0,834][238,1151]"})
        old_cover = node(**{"content-desc": "older cover", "bounds": "[248,834][486,1151]"})
        old_count = node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[328,1100][408,1150]"})
        new_count = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"})
        nodes = [node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}), node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}), new_cover, new_count, old_cover, old_count]
        self.assertEqual(publisher._profile_delta(nodes, ["12"]), new_count)
        self.assertIsNone(publisher._profile_delta(nodes, ["0", "12"]), "a baseline that already led with a zero tile is ambiguous, not the publication delta")
        self.assertIsNone(publisher._profile_delta(self.tiktok_profile_grid(), ["12"]), "without a '0' at the front of the row there is no delta")
        self.assertIsNone(publisher._profile_delta([node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})], ["12"]), "the grid control itself is required")

    def test_tiktok_new_tile_taps_its_clickable_ancestor_not_the_off_screen_preload(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        on_screen_tile = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"})
        preloaded_tile = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[730,1100][810,1150]"})
        row = node(**{"resource-id": "com.zhiliaoapp.musically:id/cover", "clickable": "true", "bounds": "[0,834][238,1151]"})
        whole_grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09", "clickable": "false", "bounds": "[0,700][720,2100]"})
        anchor = publisher._tile_anchor([whole_grid, row, on_screen_tile, preloaded_tile], on_screen_tile)
        self.assertEqual(anchor, row)
        self.assertEqual(publisher._tile_anchor([whole_grid, on_screen_tile], on_screen_tile), on_screen_tile, "a non clickable-only hierarchy falls back to the leaf itself")

    def test_instagram_verify_returns_caption_identity_after_post_count_delta(self):
        # Agile sequence first check: the re-sync tab cycle lands the 9posts
        # delta, the pre-identity recomposition cycle runs before the guarded
        # tile tap, and the identity tap confirms the caption, completing.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({"Reel by Expected at row 1, column 1"})
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        tab_profile = node(**{"resource-id": "com.instagram.android:id/profile_tab", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"})
        tab_home = node(**{"resource-id": "com.instagram.android:id/feed_tab", "content-desc": "Home", "bounds": "[0,1456][144,1544]"})
        profile9 = [account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "9posts"}), node(**{"content-desc": "Reel by Expected at row 1, column 1"}), tab_profile, tab_home]
        reel = [node(text="safe publishing test")]
        device = Device("com.instagram.android", [[tab_profile], [tab_home], profile9, profile9, [tab_home], profile9, profile9, reel])

        self.assertEqual(publisher.verify(job("instagram"), device), "safe publishing test")
        self.assertEqual(len(device.taps), 7, "the Profile->Home->Profile verify cycle, the pre-identity recomposition cycle and the identity tile tap")

    def test_instagram_verify_returns_unverified_with_evidence_when_delta_never_appears(self):
        # A profile that never shows the new reel after three checks is NOT an
        # error: verify returns None (the worker-local `unverified` result)
        # with the last dump attached as evidence, and no tile is ever opened.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset()
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        tab_profile = node(**{"resource-id": "com.instagram.android:id/profile_tab", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"})
        tab_home = node(**{"resource-id": "com.instagram.android:id/feed_tab", "content-desc": "Home", "bounds": "[0,1456][144,1544]"})
        stale = [account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "8posts"}), tab_profile, tab_home]
        device = Device("com.instagram.android", [[tab_profile], [tab_home], stale, stale, stale, stale])

        result = publisher.verify(job("instagram"), device)

        self.assertIsNone(result)
        self.assertEqual(publisher.verification_evidence["stage"], "verification_pending")
        self.assertEqual(publisher.verification_evidence["post_counts"], [8])
        self.assertEqual(len(device.taps), 3, "only the re-sync tab cycle is tapped; no tile is ever opened")

    def test_instagram_verify_ends_unverified_when_opened_reel_is_never_ours(self):
        # Delta by count lands on every check but the opened viewer never
        # carries our caption: every check recomposes the grid with the 1s
        # pre-identity cycle and then makes two fresh-dump identity attempts;
        # after all three checks the result is the worker-local unverified
        # state (None + evidence), never a failure and never republished.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({"Reel by Expected at row 1, column 1"})
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        tab_profile = node(**{"resource-id": "com.instagram.android:id/profile_tab", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"})
        tab_home = node(**{"resource-id": "com.instagram.android:id/feed_tab", "content-desc": "Home", "bounds": "[0,1456][144,1544]"})
        def profile9(): return [account, node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "9posts"}), node(**{"content-desc": "Reel by Expected at row 1, column 1"}), tab_profile, tab_home]
        wrong_reel = [node(text="different reel")]
        dumps = [[tab_profile], [tab_home], profile9()]
        for _ in range(3):
            dumps += [profile9(), [tab_home], profile9(), profile9(), wrong_reel, profile9(), wrong_reel]
        device = Device("com.instagram.android", dumps)

        result = publisher.verify(job("instagram"), device)

        self.assertIsNone(result)
        self.assertEqual(publisher.verification_evidence["stage"], "verification_pending")
        self.assertEqual(len(device.taps), 18, "the re-sync cycle plus the pre-identity recomposition cycle and two guarded tile taps per check across three checks")

    def test_instagram_duration_is_read_from_associated_label_not_thumbnail_description(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        thumbnail = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail created today", "bounds": "[0,100][200,300]"})
        label = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,260][200,300]"})
        self.assertEqual(publisher._instagram_video_tiles([thumbnail, label], 25), [thumbnail])

    def test_instagram_duration_rejects_duplicate_or_mismatched_labels(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        thumbnail = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail", "bounds": "[0,100][200,300]"})
        mismatch = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:24", "bounds": "[120,260][200,300]"})
        duplicate = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[125,260][200,300]"})
        self.assertEqual(publisher._instagram_video_tiles([thumbnail, mismatch], 25), [])
        self.assertEqual(publisher._instagram_video_tiles([thumbnail, duplicate, duplicate], 25), [])

    def test_instagram_duration_accepts_minutes_format_from_label(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        thumbnail = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail", "bounds": "[0,100][200,300]"})
        label = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "1:05", "bounds": "[120,260][200,300]"})
        self.assertEqual(publisher._instagram_video_tiles([thumbnail, label], 65), [thumbnail])

    def test_instagram_duplicate_duration_candidates_keep_gallery_document_order(self):
        publisher = InstagramPublisher(expected_account="expected.account")
        first = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail created on August 16, 2026 1:35 PM", "bounds": "[0,100][200,300]"})
        second = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail created on August 16, 2026 1:28 PM", "bounds": "[0,300][200,500]"})
        first_label = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:26", "bounds": "[120,260][200,300]"})
        second_label = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:26", "bounds": "[120,460][200,500]"})
        self.assertEqual(publisher._instagram_video_tiles([first, first_label, second, second_label], 26), [first, second])

    def test_instagram_collapses_identical_multiwindow_dump_copies(self):
        title = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        publisher = InstagramPublisher(expected_account="expected.account")
        nodes = publisher._nodes(Device("com.instagram.android", [[title, dict(title), dict(title)]]))
        self.assertEqual(nodes, [title])
        self.assertEqual(publisher.account_control(nodes, resource_id="com.instagram.android:id/action_bar_title", error="active account"), title)

    def test_tiktok_verification_accepts_live_grid_zero_tile_over_baseline(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        publisher._baseline_play_counts = ["12"]
        new_count = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"})
        nodes = self.tiktok_profile_grid(new_count)
        self.assertEqual([item.get("text") for item in publisher._visible_play_counts(nodes)], ["0", "12"])
        self.assertEqual(publisher._profile_delta(nodes, ["12"]), new_count)

    def test_tiktok_delta_detects_prepend_with_draft_tile_and_short_viewport_row(self):
        # live4 exact regression (2026-08-17): a DRAFT tile occupies the
        # first grid slot without a visible count of its own, the new "0"
        # tile is prepended beside it, and the oldest baseline count (578)
        # falls behind the bottom bar: the visible row is
        # ["0", "80", "209", "152", "86"] against the baseline
        # ["80", "209", "152", "86", "578"].  The exact ["0"] + baseline
        # row never materializes on screen -- the prepend signal must fire.
        publisher = TikTokPublisher(expected_account="expected.account")
        baseline = ["80", "209", "152", "86", "578"]
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})
        draft_cover = node(**{"content-desc": "draft cover", "bounds": "[8,834][238,1151]"})
        new_cover = node(**{"content-desc": "new cover", "bounds": "[248,834][479,1151]"})
        new_count = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[248,986][479,1018]"})
        counts = [
            node(text="80", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[489,986][720,1018]"}),
            node(text="209", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[8,1307][238,1339]"}),
            node(text="152", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[248,1307][479,1339]"}),
            node(text="86", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[489,1307][720,1339]"}),
        ]
        nodes = [identity, grid, draft_cover, new_cover, new_count, *counts]
        self.assertEqual(publisher._profile_delta(nodes, baseline), new_count)

    def test_tiktok_delta_rejects_zero_led_baseline_as_ambiguous(self):
        # Fail-closed on ambiguity: a "0" at the front of the visible row is
        # NOT a delta when the baseline itself led with "0" (the previous
        # post still shows zero plays) -- the prepend is indistinguishable
        # from the old tile, so the check keeps polling.
        publisher = TikTokPublisher(expected_account="expected.account")
        baseline = ["0", "80", "209", "152", "86", "578"]
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})
        zero = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[248,986][479,1018]"})
        nodes = [identity, grid, zero, node(text="80", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[489,986][720,1018]"})]
        self.assertIsNone(publisher._profile_delta(nodes, baseline))

    def test_tiktok_delta_survives_organic_drift_of_old_counts(self):
        # Old counts drift live (209 -> 210 on 2026-08-17): the prepend
        # signal never compares anything behind the front tile.
        publisher = TikTokPublisher(expected_account="expected.account")
        baseline = ["80", "209", "152", "86", "578"]
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})
        new_count = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[248,986][479,1018]"})
        drifted = [
            node(text="80", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[489,986][720,1018]"}),
            node(text="210", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[8,1307][238,1339]"}),
            node(text="152", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[248,1307][479,1339]"}),
        ]
        self.assertEqual(publisher._profile_delta([identity, grid, new_count, *drifted], baseline), new_count)

    def test_tiktok_delta_detects_prepend_when_viewport_cuts_the_row_short(self):
        # A shorter rendered row (counts behind the bottom bar) is tolerated:
        # the prepend fires as long as the front tile is the new "0".
        publisher = TikTokPublisher(expected_account="expected.account")
        baseline = ["80", "209", "152", "86", "578"]
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})
        new_count = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[248,986][479,1018]"})
        visible = [
            node(text="80", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[489,986][720,1018]"}),
            node(text="209", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[8,1307][238,1339]"}),
        ]
        self.assertEqual(publisher._profile_delta([identity, grid, new_count, *visible], baseline), new_count)

    def test_tiktok_delta_requires_at_least_one_visible_count(self):
        # A grid without any visible count proves nothing: no delta, the
        # verify cycle keeps polling exactly as before.
        publisher = TikTokPublisher(expected_account="expected.account")
        identity = node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"})
        grid = node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})
        self.assertIsNone(publisher._profile_delta([identity, grid], ["80", "209"]))

    def test_tiktok_verification_ignores_off_screen_play_count_preload(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        on_screen = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"})
        preloaded = node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[730,1100][810,1150]"})
        self.assertEqual(publisher._visible_play_counts([on_screen, preloaded]), [on_screen])

    def tiktok_verify_profile(self, *, with_delta=True, cover_bounds=(0, 834, 238, 1151)):
        """Profile revision with the ordered play-count row (baseline or
        zero-tile delta) and the semantic bottom bar."""
        nodes = [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
        ]
        if with_delta:
            nodes.append(node(**{"content-desc": "new cover", "bounds": f"[{cover_bounds[0]},{cover_bounds[1]}][{cover_bounds[2]},{cover_bounds[3]}]"}))
            nodes.append(node(text="0", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}))
        nodes += [
            node(**{"content-desc": "older cover", "bounds": "[248,834][486,1151]"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[328,1100][408,1150]"}),
        ]
        return nodes

    def tiktok_tabs(self):
        return [
            node(**{"resource-id": "com.zhiliaoapp.musically:id/o76", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"}),
            node(**{"content-desc": "Home", "bounds": "[0,1456][144,1544]"}),
        ]

    def test_tiktok_home_tab_selects_app_tab_over_systemui_navbar_home(self):
        # 3-button navigation regression (live 2026-08-17): the SystemUI
        # navbar exposes a content-desc "Home" button that used to collide
        # with the app's own Home tab (o74) and abort the verify tab cycle
        # with SELECTOR_COLLISION.  Package scoping makes foreign-package
        # nodes invisible to the selector.
        publisher = TikTokPublisher(expected_account="expected.account")
        systemui_home = node(**{"resource-id": "com.android.systemui:id/home", "package": "com.android.systemui", "content-desc": "Home", "bounds": "[280,1544][440,1640]"})
        tiktok_home = node(**{"resource-id": "com.zhiliaoapp.musically:id/o74", "package": "com.zhiliaoapp.musically", "content-desc": "Home", "bounds": "[0,1446][144,1544]"})
        self.assertEqual(publisher._home_tab([systemui_home, tiktok_home]), tiktok_home)

    def test_tiktok_home_tab_fails_closed_when_only_systemui_navbar_home_present(self):
        # Without the app's own Home tab the SystemUI navbar button must not
        # stand in: the selector reports absence and _tap_tab fails closed
        # with TAB_BAR, exactly like before the collision existed.
        publisher = TikTokPublisher(expected_account="expected.account")
        systemui_home = node(**{"resource-id": "com.android.systemui:id/home", "package": "com.android.systemui", "content-desc": "Home", "bounds": "[280,1544][440,1640]"})
        self.assertIsNone(publisher._home_tab([systemui_home]))
        device = Device("com.zhiliaoapp.musically", [[systemui_home]])
        with self.assertRaises(PublisherError) as raised:
            publisher._tap_tab(device, label="Home")
        self.assertEqual(raised.exception.code, "TAB_BAR")
        self.assertEqual(device.taps, [], "the SystemUI Home button is never tapped")

    def test_tiktok_profile_tab_ignores_foreign_package_profile_labels(self):
        # The desc/text fallback of the Profile selector is package-scoped
        # too: a launcher icon labelled "Profile" cannot collide with the
        # app's own Profile tab.
        publisher = TikTokPublisher(expected_account="expected.account")
        launcher_profile = node(**{"resource-id": "com.google.android.apps.nexuslauncher:id/icon", "package": "com.google.android.apps.nexuslauncher", "content-desc": "Profile", "bounds": "[10,20][110,80]"})
        app_tab = node(**{"resource-id": "com.zhiliaoapp.musically:id/o76", "package": "com.zhiliaoapp.musically", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"})
        self.assertEqual(publisher._profile_tab([launcher_profile, app_tab]), app_tab)

    def test_instagram_profile_tab_selects_app_tab_over_systemui_and_launcher_nodes(self):
        # Same package-scoping rule on Instagram: the semantic Profile match
        # must ignore the SystemUI navbar Home button and a launcher icon
        # labelled "Profile", while the resource-id-based bottom-bar matcher
        # keeps resolving the app's own tabs.
        publisher = InstagramPublisher(expected_account="expected.account")
        systemui_home = node(**{"resource-id": "com.android.systemui:id/home", "package": "com.android.systemui", "content-desc": "Home", "bounds": "[280,1544][440,1640]"})
        launcher_profile = node(**{"resource-id": "com.google.android.apps.nexuslauncher:id/icon", "package": "com.google.android.apps.nexuslauncher", "content-desc": "Profile", "bounds": "[10,20][110,80]"})
        ig_home = node(**{"resource-id": "com.instagram.android:id/feed_tab", "package": "com.instagram.android", "content-desc": "Home", "bounds": "[0,1456][144,1544]"})
        ig_profile = node(**{"resource-id": "com.instagram.android:id/profile_tab", "package": "com.instagram.android", "content-desc": "Profile", "bounds": "[576,1456][720,1544]"})
        dump = [systemui_home, launcher_profile, ig_home, ig_profile]
        self.assertEqual(publisher._profile_tab(dump), ig_profile)
        self.assertEqual(publisher._bottom_tab(dump, resource_id="com.instagram.android:id/profile_tab", label="Profile"), ig_profile)
        self.assertEqual(publisher._bottom_tab(dump, resource_id="com.instagram.android:id/feed_tab", label="Home"), ig_home)

    def test_instagram_bottom_tab_fails_closed_when_only_systemui_navbar_present(self):
        # With only the SystemUI navbar on screen the Instagram tab
        # selectors report absence and _bottom_tab fails closed with
        # TAB_BAR; the navbar button is never matched or tapped.
        publisher = InstagramPublisher(expected_account="expected.account")
        systemui_home = node(**{"resource-id": "com.android.systemui:id/home", "package": "com.android.systemui", "content-desc": "Home", "bounds": "[280,1544][440,1640]"})
        self.assertIsNone(publisher._profile_tab([systemui_home]))
        with self.assertRaises(PublisherError) as raised:
            publisher._bottom_tab([systemui_home], resource_id="com.instagram.android:id/feed_tab", label="Home")
        self.assertEqual(raised.exception.code, "TAB_BAR")

    def tiktok_verify_opened(self, caption="safe publishing test"):
        return [node(text=caption, **{"resource-id": "com.zhiliaoapp.musically:id/desc", "clickable": "false", "bounds": "[10,300][710,380]"})]

    def test_tiktok_verify_completes_on_first_check_delta_with_exact_timing(self):
        # Agile sequence, first check: 20s fixed wait -> Profile->3s->Home->
        # 3s->Profile re-sync cycle -> fixed-coordinate refresh -> composite
        # check.  The ["0", "12"] play-count delta then triggers the
        # pre-identity grid recomposition (Profile->1s->Home->1s->Profile->
        # refresh) before the guarded tile tap; the tile anchor is re-located
        # on a fresh dump and the opened post must carry the caption.  The
        # injected fake clock records exactly 20.0/3.0/3.0/1.0/1.0.
        waits = []
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=waits.append)
        publisher._baseline_play_counts = ["12"]
        profile_tab, home_tab = self.tiktok_tabs()
        dumps = [
            [profile_tab],
            [home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            [home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            self.tiktok_verify_opened(),
        ]
        device = Device("com.zhiliaoapp.musically", dumps)

        self.assertEqual(publisher.verify(job(), device), "safe publishing test")

        self.assertEqual(device.taps, [(576, 1456, 720, 1544), (0, 1456, 144, 1544), (576, 1456, 720, 1544), (576, 1456, 720, 1544), (0, 1456, 144, 1544), (576, 1456, 720, 1544), (0, 834, 238, 1151)], "the verify cycle and the pre-identity recomposition cycle precede the tile tap")
        self.assertEqual(device.swipes, [(360, 350, 360, 1000, 400)] * 2)
        self.assertEqual(waits, [20.0, 3.0, 3.0, 1.0, 1.0], "exactly 20s propagation wait, 3s cycle settles and 1s pre-identity resync settles; no 20s/10s retries")

    def test_tiktok_verify_completes_on_third_check_after_20s_and_10s_retries_with_exact_timing(self):
        # The new tile only lands by the third check: 20s initial wait, the
        # re-sync cycle, then exactly the non-uniform 20s/10s retries
        # (refresh + check each) and completion on the third check's delta,
        # which first recomposes the grid with the 1s pre-identity cycle.
        # The fake clock records the exact 20/3/3/20/10/1/1 sequence.
        waits = []
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=waits.append)
        publisher._baseline_play_counts = ["12"]
        profile_tab, home_tab = self.tiktok_tabs()
        dumps = [
            [profile_tab],
            [home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            [home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            self.tiktok_verify_opened(),
        ]
        device = Device("com.zhiliaoapp.musically", dumps)

        self.assertEqual(publisher.verify(job(), device), "safe publishing test")

        self.assertEqual(device.swipes, [(360, 350, 360, 1000, 400)] * 4, "the re-sync cycle, both retry refreshes and the pre-identity refresh")
        self.assertEqual(waits, [20.0, 3.0, 3.0, 20.0, 10.0, 1.0, 1.0])

    def test_tiktok_verify_returns_unverified_with_evidence_when_delta_never_appears(self):
        # Fail-closed without failure: a grid that never shows the zero tile
        # after three checks is NOT an error -- verify returns the worker-local
        # UNVERIFIED status (never None-as-error, never republished), attaches
        # the last dump as evidence and logs "verification pending".  The stale
        # grid is never opened.
        waits = []
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=waits.append)
        publisher._baseline_play_counts = ["12"]
        profile_tab, home_tab = self.tiktok_tabs()
        dumps = [
            [profile_tab],
            [home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
        ]
        device = Device("com.zhiliaoapp.musically", dumps)

        with self.assertLogs("southfarm_publisher.platforms.tiktok", level="WARNING") as logs:
            result = publisher.verify(job(), device)

        self.assertEqual(result, PublicationStatus.UNVERIFIED)
        self.assertTrue(any("verification pending" in line for line in logs.output), "a clear verification-pending log is emitted")
        evidence = publisher.verification_evidence
        self.assertEqual((evidence["platform"], evidence["stage"]), ("tiktok", "verification_pending"))
        self.assertEqual(evidence["play_counts"], ["12"])
        self.assertTrue(any(item.get("text") == "12" for item in evidence["last_dump"]), "the last dump travels with the job")
        self.assertEqual(len(device.taps), 3, "only the re-sync tab cycle is tapped; no tile is ever opened")
        self.assertEqual(device.swipes, [(360, 350, 360, 1000, 400)] * 3)
        self.assertEqual(waits, [20.0, 3.0, 3.0, 20.0, 10.0])

    def test_tiktok_verify_ends_unverified_when_opened_post_is_never_ours(self):
        # Delta lands on every check but the opened viewer never carries our
        # caption: every check recomposes the grid with the 1s pre-identity
        # cycle and then makes two fresh-dump identity attempts; after all
        # three checks the result is the worker-local unverified state
        # (UNVERIFIED + evidence), never a failure and never republished.
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        publisher._baseline_play_counts = ["12"]
        profile_tab, home_tab = self.tiktok_tabs()
        wrong = [node(text="different video", **{"resource-id": "com.zhiliaoapp.musically:id/desc", "clickable": "false", "bounds": "[10,300][710,380]"})]
        dumps = [[profile_tab], [home_tab], self.tiktok_verify_profile() + [profile_tab, home_tab]]
        for _ in range(3):
            dumps += [self.tiktok_verify_profile() + [profile_tab, home_tab], [home_tab], self.tiktok_verify_profile() + [profile_tab, home_tab], self.tiktok_verify_profile() + [profile_tab, home_tab], wrong, self.tiktok_verify_profile() + [profile_tab, home_tab], wrong]
        device = Device("com.zhiliaoapp.musically", dumps)

        result = publisher.verify(job(), device)

        self.assertEqual(result, PublicationStatus.UNVERIFIED)
        self.assertEqual(publisher.verification_evidence["stage"], "verification_pending")
        self.assertEqual(len(device.taps), 18, "the re-sync cycle plus the pre-identity recomposition cycle and two guarded tile taps per check across three checks")
        self.assertEqual(sum(1 for args in device.commands if "keyevent" in args), 6, "each failed attempt closes its viewer")

    def test_tiktok_verify_treats_preexisting_baseline_identity_as_no_delta(self):
        # The opened post carries the caption but its identity already exists
        # in the pre-publication baseline snapshot: that is treated as
        # no-delta (the polling continues), NEVER as an immediate error --
        # the checks keep running and the job ends unverified.
        waits = []
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=waits.append)
        publisher._baseline_play_counts = ["12"]
        publisher._baseline = {"safe publishing test"}
        profile_tab, home_tab = self.tiktok_tabs()
        dumps = [
            [profile_tab],
            [home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            [home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            self.tiktok_verify_profile() + [profile_tab, home_tab],
            self.tiktok_verify_opened(),
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
            self.tiktok_verify_profile(with_delta=False) + [profile_tab, home_tab],
        ]
        device = Device("com.zhiliaoapp.musically", dumps)

        result = publisher.verify(job(), device)

        self.assertEqual(result, PublicationStatus.UNVERIFIED, "a baseline-preexisting identity is no-delta, not a failure")
        self.assertEqual(len(device.taps), 7, "the identity tap happened; the baseline guard kept the cycle polling")
        self.assertEqual(device.swipes, [(360, 350, 360, 1000, 400)] * 4)
        self.assertEqual(waits, [20.0, 3.0, 3.0, 1.0, 1.0, 20.0, 10.0])

    def test_tiktok_verify_taps_tile_from_fresh_dump_after_stale_grid_bounds(self):
        # Stale grid geometry regression: the delta dump serves the tile cover
        # with out-of-viewport spans; the identity tap must re-dump and
        # dispatch ONLY the fresh in-viewport geometry, never the stale one.
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)
        publisher._baseline_play_counts = ["12"]
        profile_tab, home_tab = self.tiktok_tabs()
        stale_grid = self.tiktok_verify_profile(cover_bounds=(0, 500, 238, 2000)) + [profile_tab, home_tab]
        fresh_grid = self.tiktok_verify_profile(cover_bounds=(0, 834, 238, 1151)) + [profile_tab, home_tab]
        dumps = [
            [profile_tab],
            [home_tab],
            [profile_tab],
            stale_grid,
            [profile_tab],
            [home_tab],
            [profile_tab],
            stale_grid,
            fresh_grid,
            self.tiktok_verify_opened(),
        ]
        device = Device("com.zhiliaoapp.musically", dumps, advance_on_poll=True)

        self.assertEqual(publisher.verify(job(), device), "safe publishing test")

        self.assertEqual(device.taps[-1], (0, 834, 238, 1151), "the tile tap dispatches the fresh re-dump bounds")
        self.assertNotIn((0, 500, 238, 2000), device.taps, "the stale out-of-viewport geometry is never tapped")

    def test_tiktok_select_media_taps_only_fresh_redump_bounds_after_stale_arrival_geometry(self):
        # Stale picker bounds regression (same failure mode as the Instagram
        # live4 gallery tile): the arrival dump serves the duration label
        # ~1.4k px below its real position; the candidate tap must re-dump,
        # re-locate by identity and dispatch ONLY the fresh in-viewport
        # geometry; selection then proceeds to the editor.
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        stale_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,1760][220,1990]"})
        stale_label = node(text="0:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,1920][220,1990]"})
        publisher._last_nodes = [stale_tile, stale_label]
        fresh_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"})
        fresh_label = node(text="0:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,520][220,560]"})
        selected_screen = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/x4j", "bounds": "[500,2000][700,2100]"})]
        editor = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[500,2050][700,2150]"})]
        device = Device("com.zhiliaoapp.musically", [[fresh_tile, fresh_label], selected_screen, editor])

        selected = publisher._select_media(device, 25)

        self.assertEqual(selected["resource-id"], "com.zhiliaoapp.musically:id/pjg")
        self.assertEqual(device.taps[0], (140, 520, 220, 560), "the tap dispatches the fresh re-dump bounds, never the stale arrival geometry")
        self.assertNotIn((140, 1920, 220, 1990), device.taps, "the stale arrival geometry is never tapped")

    def test_tiktok_select_media_discards_candidates_persisting_outside_the_viewport(self):
        # Fail-closed stale-bounds rule: a candidate whose fresh re-dumps keep
        # serving off-viewport bounds is discarded after two re-dumps; with no
        # candidate left the selection aborts MEDIA_UNSELECTABLE and NOTHING
        # is ever tapped.
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        stale_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,1760][220,1990]"})
        stale_label = node(text="0:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,1920][220,1990]"})
        publisher._last_nodes = [stale_tile, stale_label]
        device = Device("com.zhiliaoapp.musically", [[stale_tile, stale_label]] * 4, advance_on_poll=True)

        with self.assertRaises(PublisherError) as raised:
            publisher._select_media(device, 25)

        self.assertEqual(raised.exception.code, "MEDIA_UNSELECTABLE")
        self.assertEqual(device.taps, [], "no tap is ever dispatched from out-of-viewport geometry")

    def test_tiktok_select_media_moves_to_next_candidate_when_fresh_dump_finally_lands_the_tile(self):
        # Candidate 1 persists outside the viewport across both re-dumps and
        # is discarded; candidate 2 re-localizes with valid bounds on its
        # first re-dump and carries the selection with the fresh geometry.
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        first_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,1760][220,1990]"})
        first_label = node(text="0:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,1920][220,1990]"})
        second_stale_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[480,1500][700,1800]"})
        second_stale_label = node(text="00:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[500,1740][700,1800]"})
        publisher._last_nodes = [first_tile, first_label, second_stale_tile, second_stale_label]
        second_fresh_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[480,420][700,740]"})
        second_fresh_label = node(text="00:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[500,680][700,740]"})
        selected_screen = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/x4j", "bounds": "[500,2000][700,2100]"})]
        editor = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[500,2050][700,2150]"})]
        # Re-dumps 1-2: candidate 1 still off the viewport (discarded);
        # re-dump 3: candidate 2 has corrected geometry and is tapped.
        dumps = [
            [first_tile, first_label, second_stale_tile, second_stale_label],
            [first_tile, first_label, second_stale_tile, second_stale_label],
            [first_tile, first_label, second_fresh_tile, second_fresh_label],
            selected_screen, selected_screen, selected_screen, editor,
        ]
        device = Device("com.zhiliaoapp.musically", dumps, advance_on_poll=True)

        selected = publisher._select_media(device, 25)

        self.assertEqual(selected["resource-id"], "com.zhiliaoapp.musically:id/pjg")
        self.assertEqual(device.taps[0], (500, 680, 700, 740), "candidate 2 is tapped with its fresh re-dump bounds")
        self.assertNotIn((140, 1920, 220, 1990), device.taps, "the discarded candidate is never tapped")

    def test_tiktok_duration_formats_cover_both_live_picker_label_styles(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        self.assertEqual(publisher._duration_formats(26), {"0:26", "00:26"})
        self.assertEqual(publisher._duration_formats(65), {"1:05"})

    def test_tiktok_candidates_associate_exactly_one_thumbnail_per_duration_label(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,100][220,320]"})
        label = node(text="0:26", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,280][220,320]"})
        other_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[240,100][460,320]"})
        self.assertEqual(publisher._video_candidates([tile, label, other_tile], 26), [label])
        self.assertEqual(publisher._video_candidates([tile, node(text="00:26", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,280][220,320]"}), other_tile], 26)[0].get("text"), "00:26")
        self.assertEqual(publisher._video_candidates([tile, node(text="0:20", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,280][220,320]"}), other_tile], 26), [], "wrong durations are never candidates")

    def instagram_publish_dumps(self, *, dead_candidates=0, typed_caption="safe test", diverged=False):
        account = node(text="expected.account", **{"resource-id": "com.instagram.android:id/action_bar_title"})
        profile = [account, node(**{"content-desc": "Create New"}), node(**{"resource-id": "com.instagram.android:id/profile_header_post_count_front_familiar", "content-desc": "8posts"}), node(**{"content-desc": "Reel by Expected at row 1, column 1"})]
        blank = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail created on August 16, 2026 1:37 PM", "bounds": "[0,100][200,300]"})
        usable = node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Unselected Video thumbnail created on August 16, 2026 1:35 PM", "bounds": "[0,300][200,500]"})
        gallery = [node(text="New reel", **{"resource-id": "com.instagram.android:id/gallery_title_text"}), blank, node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,260][200,300]"}), usable, node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,460][200,500]"})]
        unchanged_gallery = [node(text="New reel", **{"resource-id": "com.instagram.android:id/gallery_title_text"}), blank, node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,260][200,300]"}), usable, node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_label", "text": "0:25", "bounds": "[120,460][200,500]"})]
        selected = [node(**{"resource-id": "com.instagram.android:id/gallery_grid_item_thumbnail", "content-desc": "Selected Video thumbnail created on August 16, 2026 1:35 PM", "bounds": "[0,300][200,500]"}), node(text="Next", **{"resource-id": "com.instagram.android:id/next_button_textview"})]
        editor = [node(**{"resource-id": "com.instagram.android:id/clips_right_action_button", "content-desc": "Next"})]
        caption = [node(text="Write a caption and add hashtags…", **{"resource-id": "com.instagram.android:id/caption_input_text_view", "content-desc": "Write a caption"}), node(**{"resource-id": "com.instagram.android:id/save_draft_button", "content-desc": "Save draft"}), node(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share", "bounds": "[600,1400][700,1500]"})]
        typed = [node(text=typed_caption if not diverged else "wrong words", **{"resource-id": "com.instagram.android:id/caption_input_text_view", "content-desc": "Write a caption"})]
        share_ready = [node(text=typed_caption, **{"resource-id": "com.instagram.android:id/caption_input_text_view"}), node(**{"resource-id": "com.instagram.android:id/save_draft_button", "content-desc": "Save draft"}), node(**{"resource-id": "com.instagram.android:id/share_button", "content-desc": "Share", "bounds": "[600,1400][700,1500]"})]
        dumps = [[node(**{"content-desc": "Profile"})], profile, [node(**{"content-desc": "Create new reel"})], gallery]
        dumps.extend([unchanged_gallery] * dead_candidates)
        if dead_candidates < 2:
            dumps.extend([selected, editor, caption, caption, typed, share_ready, [[]]])
        return dumps

    def test_instagram_full_profile_to_share_flow_has_monotonic_checkpoints(self):
        clip = job("instagram", "safe test")
        # Two same-duration candidates: the newest one has a blank frame and
        # never registers the tap, so the second candidate must carry the flow.
        device = Device("com.instagram.android", self.instagram_publish_dumps(dead_candidates=1))
        events = []
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.15, poll=.05, pause=lambda _: None)
        publisher.prepare(clip, device)
        publisher.publish(clip, device, lambda step, progress, **kwargs: events.append((step, progress, kwargs, len(device.taps))))
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertTrue(events[-1][2]["final_action"])
        self.assertEqual(events[-1][3], len(device.taps) - 1)
        self.assertEqual(device.typed, ["safe test"], "the caption is typed in a single pass")
        self.assertIn(("shell", "input", "keyevent", "4"), device.commands, "the IME is closed with back before Share")
        self.assertEqual(device.taps[-1], (600, 1400, 700, 1500))

    def test_instagram_publish_fails_closed_when_no_candidate_accepts_the_tap(self):
        clip = job("instagram", "safe test")
        device = Device("com.instagram.android", self.instagram_publish_dumps(dead_candidates=2))
        events = []
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.15, poll=.05, pause=lambda _: None)
        publisher.prepare(clip, device)
        with self.assertRaises(PublisherError) as raised:
            publisher.publish(clip, device, lambda step, progress, **kwargs: events.append(step))
        self.assertEqual(raised.exception.code, "MEDIA_UNSELECTABLE")
        self.assertEqual(events, ["selecting_media"])
        self.assertEqual(device.typed, [])

    def test_instagram_diverged_caption_never_reaches_share(self):
        clip = job("instagram", "safe test")
        device = Device("com.instagram.android", self.instagram_publish_dumps(diverged=True))
        publisher = InstagramPublisher(expected_account="expected.account")
        publisher.prepare(clip, device)
        with self.assertRaises(PublisherError) as raised:
            publisher.publish(clip, device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "CAPTION_DIVERGED")
        self.assertEqual(device.typed, ["safe test"])
        self.assertNotIn((600, 1400, 700, 1500), device.taps)

    def tiktok_publish_dumps(self, *, dead_candidates=0):
        profile = [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/o70", "content-desc": "Create"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
        ]
        camera = [node(**{"resource-id": "com.zhiliaoapp.musically:id/upload_hot_area", "bounds": "[10,1700][220,1900]"})]
        picker_landing = [node(**{"content-desc": "Videos", "bounds": "[10,280][200,360]"})]
        dead_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"})
        dead_label = node(text="0:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,520][220,560]"})
        live_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[240,340][460,560]"})
        live_label = node(text="00:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[380,520][460,560]"})
        picker = [node(**{"content-desc": "Videos", "bounds": "[10,280][200,360]"}), dead_tile, dead_label, live_tile, live_label]
        selected = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/x4j", "bounds": "[500,2000][700,2100]"})]
        editor = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[500,2050][700,2150]"})]
        caption_idle = [node(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"})]
        caption_focused = [node(text="", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "true", "bounds": "[10,1300][700,1380]"})]
        caption_typed = [node(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "true", "bounds": "[10,1300][700,1380]"})]
        post_ready = [node(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"}), node(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6", "bounds": "[520,2150][700,2250]"})]
        posted = [node(text="Video posted!", **{"resource-id": "com.zhiliaoapp.musically:id/zxp", "bounds": "[200,180][520,240]"})]
        # Each screen is served exactly once: the guarded helpers re-read the
        # current screen (stale) as the immediately-before dump of a tap, so
        # only the post-tap read consumes the next revision.
        dumps = [[node(text="Profile")], profile, camera, picker_landing, picker]
        dumps.extend([picker] * dead_candidates)
        if dead_candidates < 2:
            dumps.extend([selected, editor, caption_idle, caption_focused, caption_typed, post_ready, posted])
        return dumps

    def tiktok_publish_dumps_prefiltered(self):
        """Live 2026-08-17 picker arrival: the dump right after the upload
        hot-area tap already carries the Videos filter selected
        (selected="true" / clickable="false") with the thumbnail grid
        rendered -- the chip tap is a no-op on this build."""
        profile = [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/o70", "content-desc": "Create"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
        ]
        camera = [node(**{"resource-id": "com.zhiliaoapp.musically:id/upload_hot_area", "bounds": "[10,1700][220,1900]"})]
        chip = node(**{"content-desc": "Videos", "clickable": "false", "selected": "true", "bounds": "[10,280][200,360]"})
        live_tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"})
        live_label = node(text="0:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,520][220,560]"})
        picker = [chip, live_tile, live_label]
        selected = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/x4j", "bounds": "[500,2000][700,2100]"})]
        editor = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[500,2050][700,2150]"})]
        caption_idle = [node(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"})]
        caption_focused = [node(text="", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "true", "bounds": "[10,1300][700,1380]"})]
        caption_typed = [node(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "true", "bounds": "[10,1300][700,1380]"})]
        post_ready = [node(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"}), node(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6", "bounds": "[520,2150][700,2250]"})]
        posted = [node(text="Video posted!", **{"resource-id": "com.zhiliaoapp.musically:id/zxp", "bounds": "[200,180][520,240]"})]
        return [[node(text="Profile")], profile, camera, picker, selected, editor, caption_idle, caption_focused, caption_typed, post_ready, posted]

    def test_tiktok_enter_videos_grid_skips_chip_when_picker_lands_prefiltered(self):
        # The live 2026-08-17 picker arrives already on the Videos filter:
        # the chip is selected (and therefore not clickable) and the grid is
        # rendered, so the chip tap must be skipped -- it is a no-op that
        # _wait_for_fresh can never satisfy (deterministic VIDEOS_MEDIA).
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.15, poll=.01, pause=lambda _: None)
        chip = node(**{"content-desc": "Videos", "clickable": "false", "selected": "true", "bounds": "[10,280][200,360]"})
        tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"})
        publisher._last_nodes = [chip, tile]
        device = Device("com.zhiliaoapp.musically", [])
        publisher._enter_videos_grid(device, chip)
        self.assertEqual(device.taps, [], "an already-selected Videos chip is never tapped")

    def test_tiktok_enter_videos_grid_skips_chip_when_grid_already_rendered(self):
        # Grid presence alone proves the picker is on the Videos screen: no
        # chip tap even when the chip attributes report unselected.
        publisher = TikTokPublisher(expected_account="expected.account")
        chip = node(**{"content-desc": "Videos", "clickable": "true", "bounds": "[10,280][200,360]"})
        tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"})
        publisher._last_nodes = [chip, tile]
        device = Device("com.zhiliaoapp.musically", [])
        publisher._enter_videos_grid(device, chip)
        self.assertEqual(device.taps, [], "a rendered video grid makes the chip tap unnecessary")

    def test_tiktok_enter_videos_grid_taps_clickable_unselected_chip(self):
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.15, poll=.01, pause=lambda _: None)
        chip = node(**{"content-desc": "Videos", "clickable": "true", "selected": "false", "bounds": "[10,280][200,360]"})
        tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"})
        publisher._last_nodes = [chip]
        device = Device("com.zhiliaoapp.musically", [[chip], [chip, tile]])
        publisher._enter_videos_grid(device, chip)
        self.assertEqual(device.taps, [(10, 280, 200, 360)], "the clickable unselected chip gets the guarded tap")

    def test_tiktok_enter_videos_grid_clickable_chip_without_grid_times_out_videos_media(self):
        # Fail-closed intact: a clickable chip whose tap never produces the
        # grid still aborts with the same VIDEOS_MEDIA timeout as before.
        class StickyDevice(Device):
            def dump_ui(self):
                if self._after_tap or self._last_dump is None:
                    self._last_dump = self.dumps[0]
                    self._after_tap = False
                    self._stale_reads = 0
                return self._last_dump
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.15, poll=.01, pause=lambda _: None)
        chip = node(**{"content-desc": "Videos", "clickable": "true", "bounds": "[10,280][200,360]"})
        publisher._last_nodes = [chip]
        device = StickyDevice("com.zhiliaoapp.musically", [[chip]])
        with self.assertRaises(PublisherError) as raised:
            publisher._enter_videos_grid(device, chip)
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertIn("VIDEOS_MEDIA", str(raised.exception))
        self.assertEqual(device.taps, [(10, 280, 200, 360)], "the clickable chip was tapped before the timeout")

    def test_tiktok_enter_videos_grid_unclickable_unselected_chip_without_grid_fails_closed(self):
        publisher = TikTokPublisher(expected_account="expected.account")
        chip = node(**{"content-desc": "Videos", "clickable": "false", "selected": "false", "bounds": "[10,280][200,360]"})
        publisher._last_nodes = [chip]
        device = Device("com.zhiliaoapp.musically", [])
        with self.assertRaises(PublisherError) as raised:
            publisher._enter_videos_grid(device, chip)
        self.assertEqual(raised.exception.code, "VIDEOS_MEDIA")
        self.assertEqual(device.taps, [], "a non-actionable chip is never tapped")

    def test_tiktok_publish_proceeds_directly_to_selection_when_picker_lands_on_videos(self):
        clip = job("tiktok", "safe test")
        device = Device("com.zhiliaoapp.musically", self.tiktok_publish_dumps_prefiltered())
        events = []
        publisher = TikTokPublisher(expected_account="expected.account")
        publisher.prepare(clip, device)
        publisher.publish(clip, device, lambda step, progress, **kwargs: events.append((step, kwargs, len(device.taps))))
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertNotIn((10, 280, 200, 360), device.taps, "the prefiltered Videos chip is never tapped")
        self.assertEqual(device.taps[-1], (520, 2150, 700, 2250), "the flow still reaches the Post tap")

    def test_tiktok_full_profile_to_post_flow_has_monotonic_checkpoints(self):
        clip = job("tiktok", "safe test")
        device = Device("com.zhiliaoapp.musically", self.tiktok_publish_dumps())
        events = []
        publisher = TikTokPublisher(expected_account="expected.account")
        publisher.prepare(clip, device)
        publisher.publish(clip, device, lambda step, progress, **kwargs: events.append((step, kwargs, len(device.taps))))
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertTrue(events[-1][1]["final_action"])
        self.assertEqual(events[-1][2], len(device.taps) - 1)
        self.assertEqual(device.typed, ["safe test"], "the caption is typed in a single pass")
        self.assertIn(("shell", "input", "keyevent", "4"), device.commands, "the IME is closed with back before Post")
        self.assertEqual(device.taps[-1], (520, 2150, 700, 2250))

    def test_tiktok_publish_fails_closed_when_no_candidate_accepts_the_tap(self):
        clip = job("tiktok", "safe test")
        device = Device("com.zhiliaoapp.musically", self.tiktok_publish_dumps(dead_candidates=2))
        events = []
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.15, poll=.05, pause=lambda _: None)
        publisher.prepare(clip, device)
        with self.assertRaises(PublisherError) as raised:
            publisher.publish(clip, device, lambda step, progress, **kwargs: events.append(step))
        self.assertEqual(raised.exception.code, "MEDIA_UNSELECTABLE")
        self.assertEqual(events, ["selecting_media"])
        self.assertEqual(device.typed, [])

    def test_tiktok_missing_posted_confirmation_is_retryable_and_never_re_taps_post(self):
        clip = job("tiktok", "safe test")
        device = Device("com.zhiliaoapp.musically", self.tiktok_publish_dumps()[:-1])
        publisher = TikTokPublisher(expected_account="expected.account", timeout=.15, poll=.05, pause=lambda _: None)
        publisher.prepare(clip, device)
        with self.assertRaises(PublisherError) as raised:
            publisher.publish(clip, device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "POST_UNCONFIRMED")
        self.assertTrue(raised.exception.retryable)
        self.assertTrue(raised.exception.final_action_uncertain)
        self.assertEqual(device.taps.count((520, 2150, 700, 2250)), 1, "Post is tapped exactly once")

    def tiktok_publish_dumps_advancing(self, tail):
        """Full publish script for advance_on_poll devices, ending in `tail`.

        With advance_on_poll=True every dump_ui read consumes one revision,
        so each screen that a guarded helper re-reads as the
        immediately-before dump of a tap must appear twice (arrival
        revision + before-dump copy).  `tail` revisions are served one per
        poll of the post-Post confirmation wait, which the tests drive with
        the injected fake clock.
        """
        profile = [
            node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/o70", "content-desc": "Create"}),
            node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"}),
            node(text="12", **{"resource-id": "com.zhiliaoapp.musically:id/tv_play_count", "bounds": "[80,1100][160,1150]"}),
        ]
        camera = [node(**{"resource-id": "com.zhiliaoapp.musically:id/upload_hot_area", "bounds": "[10,1700][220,1900]"})]
        picker_landing = [node(**{"content-desc": "Videos", "bounds": "[10,280][200,360]"})]
        tile = node(**{"resource-id": "com.zhiliaoapp.musically:id/ofk", "clickable": "false", "bounds": "[0,340][220,560]"})
        label = node(text="0:25", **{"resource-id": "com.zhiliaoapp.musically:id/gi4", "bounds": "[140,520][220,560]"})
        picker = [node(**{"content-desc": "Videos", "bounds": "[10,280][200,360]"}), tile, label]
        selected = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/x4j", "bounds": "[500,2000][700,2100]"})]
        editor = [node(text="Next", clickable="true", **{"resource-id": "com.zhiliaoapp.musically:id/pjg", "bounds": "[500,2050][700,2150]"})]
        caption_idle = [node(text="Add description...", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"})]
        caption_focused = [node(text="", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "true", "bounds": "[10,1300][700,1380]"})]
        caption_typed = [node(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "true", "bounds": "[10,1300][700,1380]"})]
        post_ready = [node(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00", "focused": "false", "bounds": "[10,1300][700,1380]"}), node(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6", "bounds": "[520,2150][700,2250]"})]
        return [
            [node(text="Profile")],
            [node(text="Profile")],
            profile, profile, profile,
            camera, camera,
            picker_landing, picker_landing,
            picker, picker,
            selected, selected,
            editor, editor,
            caption_idle, caption_idle,
            caption_focused,
            caption_typed,
            post_ready, post_ready,
            *tail,
        ]

    def test_tiktok_publish_confirms_late_toast_within_upload_timeout(self):
        # Fake clock: the upload overlay progresses and the "Video posted!"
        # toast only lands ~30s after the Post tap -- far past the generic
        # 15s wait.  The confirmation now waits up to the 90s upload
        # timeout, so publish completes without POST_UNCONFIRMED.
        tail = [
            posting_overlay("20%"),
            posting_overlay("40%"),
            posting_overlay("70%"),
            posting_overlay("90%"),
            [node(text="Video posted!", **{"resource-id": "com.zhiliaoapp.musically:id/zxp", "bounds": "[200,180][520,240]"})],
        ]
        device = Device("com.zhiliaoapp.musically", self.tiktok_publish_dumps_advancing(tail), advance_on_poll=True)
        clip = job("tiktok", "safe test")
        publisher = ClockedTikTokPublisher([0.0, 5.0, 10.0, 20.0, 30.0], expected_account="expected.account", poll=.5, pause=lambda _: None)
        publisher.prepare(clip, device)
        with self.assertLogs("southfarm_publisher.platforms.tiktok", level="INFO") as logs:
            publisher.publish(clip, device, lambda *args, **kwargs: None)
        self.assertEqual(device.taps.count((520, 2150, 700, 2250)), 1, "Post is tapped exactly once")
        self.assertTrue(any("TikTok upload progress: Posting... 20%" in line for line in logs.output), "upload progress is logged for evidence")

    def test_tiktok_publish_confirms_when_upload_overlay_clears_and_post_screen_closes(self):
        # Fake clock: the overlay shows "Posting... 50%", then clears at
        # ~60s with the post screen gone (st6 absent) -- the upload
        # finished.  Even without the toast, that is a confirmation:
        # publish completes and never re-taps Post.
        done_screen = [node(text="@expected.account", **{"resource-id": "com.zhiliaoapp.musically:id/se1"}), node(**{"resource-id": "com.zhiliaoapp.musically:id/i09"})]
        tail = [posting_overlay("50%"), posting_overlay("50%"), posting_overlay("80%"), posting_overlay("80%"), done_screen]
        device = Device("com.zhiliaoapp.musically", self.tiktok_publish_dumps_advancing(tail), advance_on_poll=True)
        clip = job("tiktok", "safe test")
        publisher = ClockedTikTokPublisher([0.0, 15.0, 30.0, 45.0, 60.0], expected_account="expected.account", poll=.5, pause=lambda _: None)
        publisher.prepare(clip, device)
        with self.assertLogs("southfarm_publisher.platforms.tiktok", level="INFO") as logs:
            publisher.publish(clip, device, lambda *args, **kwargs: None)
        self.assertEqual(device.taps.count((520, 2150, 700, 2250)), 1, "Post is tapped exactly once")
        self.assertTrue(any("TikTok upload finished" in line for line in logs.output), "the upload-finished confirmation is logged for evidence")

    def test_tiktok_publish_eternal_upload_overlay_times_out_post_unconfirmed_without_retap(self):
        # Fake clock: the "Posting..." overlay persists past the full 90s
        # upload timeout (the 2026-08-17 lost-WiFi case).  publish fails
        # closed with POST_UNCONFIRMED (retryable, final_action_uncertain)
        # and the Post button is never re-tapped.
        tail = [posting_overlay("0%")] * 15
        device = Device("com.zhiliaoapp.musically", self.tiktok_publish_dumps_advancing(tail), advance_on_poll=True)
        clip = job("tiktok", "safe test")
        publisher = ClockedTikTokPublisher([0.0] + [10.0 * (index + 1) for index in range(9)], expected_account="expected.account", poll=.5, pause=lambda _: None)
        publisher.prepare(clip, device)
        with self.assertLogs("southfarm_publisher.platforms.tiktok", level="INFO"):
            with self.assertRaises(PublisherError) as raised:
                publisher.publish(clip, device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "POST_UNCONFIRMED")
        self.assertTrue(raised.exception.retryable)
        self.assertTrue(raised.exception.final_action_uncertain)
        self.assertEqual(device.taps.count((520, 2150, 700, 2250)), 1, "Post is tapped exactly once, never re-attempted")

    def test_tiktok_post_confirmation_prefers_toast_over_upload_finished_signal(self):
        # Evaluation order: the toast is the first signal accepted.  Even
        # when the same fresh dump also satisfies the upload-finished
        # branch (overlay gone, Post button absent), the toast node wins.
        toast = node(text="Video posted!", **{"resource-id": "com.zhiliaoapp.musically:id/zxp", "bounds": "[200,180][520,240]"})
        publisher = TikTokPublisher(expected_account="expected.account", poll=.05, pause=lambda _: None)
        ticks = iter([0.0, 1.0])
        device = Device("com.zhiliaoapp.musically", [[toast]], advance_on_poll=True)
        confirmed = TikTokPublisher._wait_post_confirmation(publisher, device, clock=lambda: next(ticks))
        self.assertEqual(confirmed["resource-id"], "com.zhiliaoapp.musically:id/zxp")
        self.assertEqual(device.taps, [], "the confirmation wait never taps anything")

    def test_tiktok_post_confirmation_never_accepts_post_screen_without_overlay_or_toast(self):
        # The upload-finished branch is strict: overlay gone but the Post
        # button still on screen is NOT a confirmation (the upload may have
        # failed back onto the post screen).  The wait runs the full
        # deadline and raises UI_TIMEOUT -- publish maps that to
        # POST_UNCONFIRMED.
        post_screen = [node(text="safe test", **{"resource-id": "com.zhiliaoapp.musically:id/h00"}), node(text="Post", **{"resource-id": "com.zhiliaoapp.musically:id/st6", "bounds": "[520,2150][700,2250]"})]
        publisher = TikTokPublisher(expected_account="expected.account", poll=.05, pause=lambda _: None)
        ticks = iter([0.0, 30.0, 60.0, 90.0])
        device = Device("com.zhiliaoapp.musically", [post_screen] * 4, advance_on_poll=True)
        with self.assertRaises(PublisherError) as raised:
            TikTokPublisher._wait_post_confirmation(publisher, device, clock=lambda: next(ticks))
        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertEqual(device.taps, [], "the confirmation wait never taps anything")

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
