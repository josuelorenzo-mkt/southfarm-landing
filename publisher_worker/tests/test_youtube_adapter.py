import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.models import PublicationJob, PublicationStatus, PublisherError
from southfarm_publisher.platforms.youtube import YouTubeShortPublisher

_YT = "com.google.android.youtube:id/"
ACCOUNT = "expected.account"
HANDLE = "@expected.account"
CAPTION = "safe test"
REMOTE = "publication-7-3.mp4"
IDENTITY = f"{CAPTION}, No views - play Short"
UPLOAD_BOUNDS = (20, 1400, 700, 1520)
YOU_TAB_BOUNDS = (576, 1448, 720, 1544)
HOME_TAB_BOUNDS = (0, 1448, 144, 1544)
VIEW_CHANNEL_BOUNDS = (32, 368, 352, 432)
REFRESH = ("bezier", 360, 350, 360, 1000, 400)


class DualDumpDevice:
    """Fake device with two independent dump channels.

    The service channel (dump_ui) cannot see the Google-protected Add-details
    screen; the uiautomator channel (dump_ui_explicit) carries it.  Every
    tap/text/keyevent advances the service queue; stale reads repeat the last
    screen and eventually raise, exactly like the other scripted fakes.
    With advance_on_poll=True every dump_ui read consumes the next revision
    (the upload-confirmation tests drive the polls with a fake clock).
    """

    PACKAGE = "com.google.android.youtube"

    def __init__(self, service, uia=None, *, advance_on_poll=False):
        self.service, self.uia = list(service), list(uia or [])
        self._last, self._after, self._stale = None, True, 0
        self.advance_on_poll = advance_on_poll
        self.taps, self.typed, self.commands, self.swipes = [], [], [], []
        self.service_reads, self.explicit_calls, self.served_service, self.served_uia = 0, [], [], []

    def foreground_package(self): return self.PACKAGE

    def dump_ui(self):
        self.service_reads += 1
        if self._after or self._last is None:
            if not self.service: raise PublisherError("UI_TIMEOUT", "fake device has no next service UI revision")
            self._last = self.service.pop(0); self._after = False; self._stale = 0
        elif self.advance_on_poll and self.service:
            self._last = self.service.pop(0)
        else:
            self._stale += 1
            if self._stale > 3: raise PublisherError("UI_TIMEOUT", "fake device service UI did not advance")
        self.served_service.append(self._last)
        return self._last

    def dump_ui_explicit(self, source):
        self.explicit_calls.append(source)
        if not self.uia: raise PublisherError("UI_TIMEOUT", "fake device has no next uiautomator revision")
        screen = self.uia.pop(0); self.served_uia.append(screen)
        return screen

    def tap_bounds(self, bounds, delay_seconds=0): self.taps.append(bounds); self._after = True; self._stale = 0
    def text(self, value): self.typed.append(value); self._after = True; self._stale = 0
    def swipe_bezier(self, x1, y1, x2, y2, duration): self.swipes.append(("bezier", x1, y1, x2, y2, duration)); self._after = True; self._stale = 0
    def swipe(self, x1, y1, x2, y2, duration): self.swipes.append(("linear", x1, y1, x2, y2, duration)); self._after = True; self._stale = 0
    def command(self, *args, **kwargs):
        self.commands.append(args)
        if "keyevent" in args or "monkey" in args: self._after = True
        return ""


class ClockedYouTubePublisher(YouTubeShortPublisher):
    """YouTubeShortPublisher whose upload confirmation wait runs on a fake clock."""

    def __init__(self, ticks, **kwargs):
        super().__init__(**kwargs)
        self._confirmation_ticks = iter(ticks)

    def _wait_upload_confirmation(self, device):
        return YouTubeShortPublisher._wait_upload_confirmation(self, device, clock=lambda: next(self._confirmation_ticks))


def node(**values):
    values.setdefault("bounds", "[10,20][110,80]")
    values.setdefault("clickable", "true")
    values.setdefault("enabled", "true")
    return values


def job(caption=CAPTION):
    return PublicationJob(7, 5, 3, "youtube", caption, {"id": 3, "size_bytes": 1, "sha256": "a" * 64, "mime_type": "video/mp4", "file_extension": "mp4", "duration_seconds": 25, "width": 1080, "height": 1920, "video_codec": "hevc", "audio_codec": "aac"}, {"id": 9, "username": ACCOUNT, "display_name": "Expected", "platform": "youtube"})


def bottom_tabs():
    # Live bottom bar (recon 2026-08-17): tabs are Buttons WITHOUT resource-id,
    # semantic content-desc only (Home/Shorts/Create/Subscriptions/You).
    return [
        node(**{"content-desc": "Home", "bounds": f"[{HOME_TAB_BOUNDS[0]},{HOME_TAB_BOUNDS[1]}][{HOME_TAB_BOUNDS[2]},{HOME_TAB_BOUNDS[3]}]"}),
        node(**{"content-desc": "Create", "bounds": "[288,1448][432,1544]"}),
        node(**{"content-desc": "You", "bounds": f"[{YOU_TAB_BOUNDS[0]},{YOU_TAB_BOUNDS[1]}][{YOU_TAB_BOUNDS[2]},{YOU_TAB_BOUNDS[3]}]"}),
    ]


def main_screen():
    return bottom_tabs()


def you_screen(handle=HANDLE):
    # The '@handle' label (text AND content-desc) plus the actionable
    # View channel button (the avatar ImageView copy is not clickable).
    return [
        node(text=handle, **{"content-desc": handle}),
        node(**{"content-desc": "View channel", "bounds": f"[{VIEW_CHANNEL_BOUNDS[0]},{VIEW_CHANNEL_BOUNDS[1]}][{VIEW_CHANNEL_BOUNDS[2]},{VIEW_CHANNEL_BOUNDS[3]}]"}),
        *bottom_tabs(),
    ]


def channel_screen(*tiles):
    # The channel profile grid: the special 'Drafts' tile precedes the Shorts
    # tiles (default 'Latest' order, newest first).
    return [node(**{"content-desc": "Drafts"}), *[node(**{"content-desc": desc}) for desc in tiles]]


def baseline_channel():
    return channel_screen("older Short, 12 views - play Short")


def delta_channel():
    return channel_screen(IDENTITY, "older Short, 12 views - play Short")


def camera_screen():
    return [node(**{"resource-id": _YT + "reel_camera_gallery_button_delegate", "content-desc": "Import video from photo library"})]


def picker_screen():
    # Verified: the thumbnail is NOT clickable (clickable=false); the GridView
    # handles the click, so selection uses a direct center-bounds tap.
    return [node(**{"resource-id": _YT + "thumb_image_view", "content-desc": REMOTE, "clickable": "false", "bounds": "[0,100][200,300]"})]


def picker_selected():
    return picker_screen() + [node(**{"resource-id": _YT + "selected_state", "text": "1"}), node(text="Next", **{"resource-id": _YT + "multi_select_next_button"})]


def trim_screen():
    return [node(text="Done", **{"resource-id": _YT + "creation_next_button"})]


def editor_screen():
    return [node(text="Next", **{"resource-id": _YT + "shorts_post_bottom_button"})]


def post_share_screen():
    # Post-share screen: the channel marker plus the new tile, with the
    # bottom bar on screen (the agile verify cycle starts with a Home tap).
    return [node(text="Uploaded to Your Channel"), node(**{"content-desc": IDENTITY}), *bottom_tabs()]


def upload_overlay(percent):
    # Live-agnostic upload overlay: an "Uploading..." status plus "N%".
    return [
        node(text="Uploading your Short", clickable="false", **{"resource-id": _YT + "upload_status", "bounds": "[216,1373][696,1411]"}),
        node(text=percent, clickable="false", **{"resource-id": _YT + "upload_percent", "bounds": "[136,1373][216,1411]"}),
    ]


def uia_details(text=""):
    return [node(**{"class": "android.widget.EditText", "text": text, "content-desc": "Caption your Short"})]


def uia_ready():
    return uia_details(CAPTION) + [node(text="Upload Short", **{"resource-id": _YT + "upload_bottom_button", "bounds": f"[{UPLOAD_BOUNDS[0]},{UPLOAD_BOUNDS[1]}][{UPLOAD_BOUNDS[2]},{UPLOAD_BOUNDS[3]}]"})]


def happy_flows(*, extra_service_between=()):
    service = [main_screen(), you_screen(), baseline_channel(), main_screen(), camera_screen(), picker_screen(), *extra_service_between, picker_selected(), trim_screen(), editor_screen(), post_share_screen()]
    return service, [uia_details(), uia_details(CAPTION), uia_ready()]


def youtube_publish_dumps_advancing(tail):
    """Full publish script for advance_on_poll devices, ending in `tail`.

    With advance_on_poll=True every dump_ui read consumes one revision, so
    each screen that a guarded helper re-reads as the immediately-before
    dump of a tap must appear twice.  `tail` revisions are served one per
    poll of the post-Upload confirmation wait, driven by the fake clock.
    """
    service = [
        main_screen(),        # normalize
        you_screen(),         # navigate You (handle present: no tap needed)
        baseline_channel(),   # View channel tap arrival
        main_screen(),        # publish first dump (MID_FLOW)
        main_screen(),        # _return_to_main read
        main_screen(),        # create tap before-read
        camera_screen(),      # gallery arrival
        camera_screen(),      # gallery tap before-read
        picker_screen(),      # picker arrival
        picker_selected(),    # thumbnail tap arrival (selected badge)
        picker_selected(),    # picker Next before-read
        trim_screen(),        # trim arrival
        trim_screen(),        # trim Done before-read
        editor_screen(),      # editor arrival
        *tail,
    ]
    return service, [uia_details(), uia_details(CAPTION), uia_ready()]


class YouTubeAdapterTests(unittest.TestCase):
    def make_publisher(self, **kwargs):
        kwargs.setdefault("expected_account", ACCOUNT)
        kwargs.setdefault("timeout", 1.0)
        kwargs.setdefault("poll", 0.05)
        kwargs.setdefault("pause", lambda _: None)
        return YouTubeShortPublisher(**kwargs)

    def recorder(self, device):
        events = []
        def checkpoint(step, progress, final_action=False, evidence=None):
            events.append((step, progress, final_action, len(device.taps)))
        return checkpoint, events

    def grid(self, *descs):
        return [node(**{"content-desc": "Drafts"}), *[node(**{"content-desc": desc}) for desc in descs]]

    # ---- publish flow ----

    def test_publish_happy_path_taps_upload_only_after_publishing_checkpoint_persisted(self):
        service, uia = happy_flows()
        device = DualDumpDevice(service, uia)
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        taps_after_prepare = len(device.taps)
        checkpoint, events = self.recorder(device)
        publisher.publish(job(), device, checkpoint)

        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertTrue(events[-1][2], "the publishing checkpoint must be the final action")
        self.assertNotIn(UPLOAD_BOUNDS, device.taps[:events[-1][3]], "fail-closed: the irreversible Upload tap happens only after the publishing checkpoint persisted")
        self.assertEqual(device.taps.count(UPLOAD_BOUNDS), 1)
        self.assertEqual(device.typed, [CAPTION], "the title is typed in a single pass")
        self.assertIn(("shell", "input", "keyevent", "4"), device.commands, "the IME is closed with back before Upload")
        self.assertIn((0, 100, 200, 300), device.taps, "the non-clickable thumbnail is tapped directly at its center")
        self.assertLess(device.taps.index((0, 100, 200, 300)), device.taps.index(UPLOAD_BOUNDS), "thumbnail selection precedes the irreversible upload tap")
        self.assertEqual(taps_after_prepare, 2, "prepare performs exactly the You-tab and View-channel navigation taps")
        self.assertEqual(device.taps[:2], [YOU_TAB_BOUNDS, VIEW_CHANNEL_BOUNDS], "prepare navigates Home -> You -> View channel")

    def test_add_details_screen_comes_only_from_the_uiautomator_source(self):
        service, uia = happy_flows()
        device = DualDumpDevice(service, uia)
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        publisher.publish(job(), device, lambda *args, **kwargs: None)

        self.assertEqual(device.explicit_calls, ["uiautomator"] * 3, "Add details is read exclusively via one-off uiautomator dumps")
        for screen in device.served_service:
            self.assertFalse(any("Caption your Short" in f"{item.get('text', '')} {item.get('content-desc', '')}" for item in screen), "the service channel never carries the protected Add-details screen")
        self.assertTrue(any(any(item.get("text") == CAPTION for item in screen) for screen in device.served_uia), "the caption echo is verified on the uiautomator tree")

    def test_diverged_caption_never_reaches_the_upload_tap(self):
        service, uia = happy_flows()
        uia[1] = uia_details("wrong words")
        device = DualDumpDevice(service, uia)
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        checkpoint, events = self.recorder(device)
        with self.assertRaises(PublisherError) as raised:
            publisher.publish(job(), device, checkpoint)
        self.assertEqual(raised.exception.code, "CAPTION_DIVERGED")
        self.assertEqual(device.typed, [CAPTION])
        self.assertNotIn(UPLOAD_BOUNDS, device.taps)
        self.assertEqual([event[0] for event in events], ["selecting_media", "editing"])
        self.assertEqual(sum(1 for args in device.commands if "keyevent" in args), 1, "only the return-to-main back runs; the IME back happens only after a verified echo")

    def test_thumbnail_without_selected_state_badge_is_retried_on_the_same_tile(self):
        service, uia = happy_flows(extra_service_between=(picker_screen(),))
        device = DualDumpDevice(service, uia)
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        publisher.publish(job(), device, lambda *args, **kwargs: None)

        self.assertEqual(device.taps.count((0, 100, 200, 300)), 2, "an unacknowledged selection tap is retried on the same thumbnail")
        self.assertIn(UPLOAD_BOUNDS, device.taps, "the flow still completes after the retry")

    def test_thumbnail_that_never_shows_the_badge_fails_closed(self):
        service, uia = happy_flows(extra_service_between=(picker_screen(),))
        service = service[:7]  # the badge screen never arrives
        device = DualDumpDevice(service, uia)
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        checkpoint, events = self.recorder(device)
        with self.assertRaises(PublisherError) as raised:
            publisher.publish(job(), device, checkpoint)
        self.assertEqual(raised.exception.code, "MEDIA_UNSELECTABLE")
        self.assertEqual([event[0] for event in events], ["selecting_media"])
        self.assertNotIn(UPLOAD_BOUNDS, device.taps)

    def test_duplicate_remote_media_tiles_fail_closed_before_any_thumbnail_tap(self):
        # Migrated from test_platform_adapters.py: two picker tiles carrying the
        # pushed file name mean the remote media is ambiguous, so publishing
        # must stop before tapping either thumbnail.
        duplicate_picker = [node(**{"resource-id": _YT + "thumb_image_view", "content-desc": REMOTE, "clickable": "false", "bounds": "[0,100][200,300]"}),
                            node(**{"resource-id": _YT + "thumb_image_view", "content-desc": REMOTE, "clickable": "false", "bounds": "[0,300][200,500]"})]
        device = DualDumpDevice([main_screen(), you_screen(), baseline_channel(), main_screen(), camera_screen(), duplicate_picker], [])
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        checkpoint, events = self.recorder(device)
        with self.assertRaises(PublisherError) as raised:
            publisher.publish(job(), device, checkpoint)
        self.assertEqual(raised.exception.code, "MEDIA_AMBIGUOUS")
        self.assertEqual([event[0] for event in events], ["selecting_media"])
        self.assertNotIn((0, 100, 200, 300), device.taps)
        self.assertNotIn((0, 300, 200, 500), device.taps)
        self.assertNotIn(UPLOAD_BOUNDS, device.taps)
        self.assertEqual(device.typed, [])

    # ---- caption limits ----

    def test_publish_rejects_caption_over_100_chars_before_any_app_action(self):
        long_caption = "safe caption " + "a" * 110  # 123 chars, 3 words
        clip = job(long_caption)
        device = DualDumpDevice([main_screen()], [])
        with self.assertRaises(PublisherError) as raised:
            self.make_publisher().publish(clip, device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "CAPTION_INVALID")
        self.assertFalse(raised.exception.retryable, "the Shorts 100-character limit is never retryable")
        self.assertIn("100", str(raised.exception), "the limit message must be explicit")
        self.assertEqual(device.taps, [], "the limit is enforced before any tap")
        self.assertEqual(device.service_reads, 0, "the limit is enforced before the app is even read")

    def test_long_caption_passes_instagram_and_tiktok_validation(self):
        from southfarm_publisher.platforms.common import validate_caption
        long_caption = "safe caption " + "a" * 110
        # Instagram and TikTok have no documented character cap: their
        # validation is the shared 10-word rule only.
        validate_caption(long_caption)
        with self.assertRaises(PublisherError) as raised:
            validate_caption(long_caption, youtube=True)
        self.assertEqual(raised.exception.code, "CAPTION_INVALID")
        self.assertFalse(raised.exception.retryable)

    # ---- prepare: identity, baseline, R1 sheet ----

    def test_prepare_verifies_handle_identity_and_captures_grid_baseline(self):
        device = DualDumpDevice([main_screen(), you_screen(), baseline_channel()], [])
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        self.assertEqual(publisher._baseline_tiles, ["older Short, 12 views - play Short"], "the Drafts tile is excluded from the baseline")
        self.assertEqual(device.taps, [YOU_TAB_BOUNDS, VIEW_CHANNEL_BOUNDS], "Home -> You -> View channel is the exact prepare navigation")

    def test_prepare_rejects_wrong_handle_with_account_mismatch(self):
        wrong = [node(text="@wrong.account", **{"content-desc": "@wrong.account"}),
                 node(**{"content-desc": "View channel", "bounds": f"[{VIEW_CHANNEL_BOUNDS[0]},{VIEW_CHANNEL_BOUNDS[1]}][{VIEW_CHANNEL_BOUNDS[2]},{VIEW_CHANNEL_BOUNDS[3]}]"}),
                 *bottom_tabs()]
        device = DualDumpDevice([main_screen(), wrong], [])
        with self.assertRaises(PublisherError) as raised:
            self.make_publisher().prepare(job(), device)
        self.assertEqual(raised.exception.code, "ACCOUNT_MISMATCH")
        self.assertEqual(device.taps, [YOU_TAB_BOUNDS], "only the You-tab navigation occurs before account rejection")
        self.assertEqual(device.typed, [])

    def test_prepare_accepts_empty_grid_baseline_with_warning(self):
        # A channel whose grid holds only the Drafts tile has no Shorts:
        # the empty baseline is valid and logged.
        device = DualDumpDevice([main_screen(), you_screen(), channel_screen()], [])
        publisher = self.make_publisher()
        with self.assertLogs("southfarm_publisher.platforms.youtube", level="WARNING") as logs:
            publisher.prepare(job(), device)
        self.assertEqual(publisher._baseline_tiles, [])
        self.assertTrue(any("baseline empty" in line for line in logs.output))

    def test_prepare_discards_camera_exit_sheet_with_explicit_delete_tap(self):
        # R1: BACK over a Shorts camera clip opens the sheet Delete / Save and
        # exit / Cancel.  The sheet is handled with one explicit Delete tap
        # (local draft discard -- nothing published), never blind backs.
        sheet = [node(**{"content-desc": "Delete", "bounds": "[0,1206][720,1318]"}),
                 node(**{"content-desc": "Save and exit", "bounds": "[0,1318][720,1430]"}),
                 node(**{"content-desc": "Cancel", "bounds": "[0,1432][720,1544]"})]
        device = DualDumpDevice([sheet, main_screen(), you_screen(), baseline_channel()], [])
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        self.assertEqual(device.taps[0], (0, 1206, 720, 1318), "the sheet Delete discards the local camera draft explicitly")
        self.assertEqual(sum(1 for args in device.commands if "keyevent" in args), 0, "never a blind back while the sheet is open")
        self.assertEqual(publisher._baseline_tiles, ["older Short, 12 views - play Short"])

    def test_prepare_fails_closed_on_unknown_camera_sheet(self):
        # A Delete control without its Save and exit/Cancel companions is not
        # the known sheet: nothing is tapped.
        device = DualDumpDevice([[node(**{"content-desc": "Delete"})]], [])
        with self.assertRaises(PublisherError) as raised:
            self.make_publisher().prepare(job(), device)
        self.assertEqual(raised.exception.code, "CAMERA_SHEET_UNKNOWN")
        self.assertEqual(device.taps, [])

    def test_prepare_normalizes_residual_flow_with_backs_before_publishing(self):
        residual = [node(**{"class": "android.widget.EditText", "text": "", "content-desc": "Caption your Short"}), node(text="Upload Short", **{"resource-id": _YT + "upload_bottom_button"})]
        device = DualDumpDevice([residual, main_screen(), you_screen(), baseline_channel()], [])
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        self.assertTrue(publisher._prepared)
        self.assertEqual(sum(1 for args in device.commands if "keyevent" in args), 1, "one controlled back closes the residual flow")
        self.assertEqual(device.taps, [YOU_TAB_BOUNDS, VIEW_CHANNEL_BOUNDS], "normalization uses backs only; navigation stays You + View channel")

    def test_residual_publish_flow_is_refused_without_taps(self):
        residual = [node(text=ACCOUNT, **{"resource-id": _YT + "account_name"}), node(**{"content-desc": "Create"}), node(text="Upload Short", **{"resource-id": _YT + "upload_bottom_button"})]
        device = DualDumpDevice([main_screen(), you_screen(), baseline_channel(), residual], [])
        publisher = self.make_publisher()
        publisher.prepare(job(), device)
        with self.assertRaises(PublisherError) as raised:
            publisher.publish(job(), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "MID_FLOW_ABORT")
        self.assertEqual(device.taps, [YOU_TAB_BOUNDS, VIEW_CHANNEL_BOUNDS], "prepare navigation only; publish dispatches no tap before the abort")

    # ---- channel delta ----

    def test_channel_delta_prefers_front_no_views_tile_with_prefix(self):
        publisher = self.make_publisher()
        nodes = self.grid(IDENTITY, "older Short, 12 views - play Short")
        self.assertEqual(publisher._channel_delta(nodes, CAPTION)["content-desc"], IDENTITY)

    def test_channel_delta_matches_truncated_tile_desc_prefix(self):
        # Live tiles truncate the caption (~80 chars): the delta matches the
        # 50-char caption prefix even when the tile desc is cut short.
        caption = "safeword " + "a" * 80  # 89 chars, 2 words
        publisher = self.make_publisher()
        truncated = caption[:80] + ", No views - play Short"
        self.assertEqual(publisher._channel_delta(self.grid(truncated), caption)["content-desc"], truncated)

    def test_channel_delta_rejects_views_that_are_not_no_views(self):
        publisher = self.make_publisher()
        self.assertIsNone(publisher._channel_delta(self.grid(f"{CAPTION}, 23 views - play Short"), CAPTION), "a viewed tile is never the new Short")
        self.assertIsNone(publisher._channel_delta(self.grid("unrelated, No views - play Short"), CAPTION), "a tile without the caption prefix is never the new Short")

    def test_channel_delta_rejects_baseline_preexisting_desc(self):
        publisher = self.make_publisher()
        publisher._baseline_tiles = [IDENTITY]
        self.assertIsNone(publisher._channel_delta(self.grid(IDENTITY), CAPTION), "a matching desc that predates the publication is ambiguous, not the delta")

    def test_channel_delta_ignores_the_drafts_tile(self):
        publisher = self.make_publisher()
        self.assertEqual([tile.get("content-desc") for tile in publisher._grid_tiles(self.grid("older, 1 views - play Short"))], ["older, 1 views - play Short"])
        self.assertIsNone(publisher._channel_delta([node(**{"content-desc": "Drafts"})], CAPTION))

    def test_channel_grid_helpers_parse_the_recon_fixture(self):
        # Sanitized 2026-08-17 channel-profile dump (ytrecon-003/019):
        # Shorts/Posts tabs, Latest sort, the Drafts tile and live tiles.
        nodes = [dict(item.attrib) for item in ET.parse(Path(__file__).with_name("fixtures") / "youtube_channel_profile.xml").iter("node")]
        publisher = self.make_publisher()
        tiles = publisher._grid_tiles(nodes)
        self.assertEqual(len(tiles), 2, "only the two play-Short tiles are Shorts; Drafts is excluded")
        self.assertIn("23 views - play Short", tiles[0].get("content-desc"))
        self.assertIsNone(publisher._channel_delta(nodes, "safe test"))
        self.assertEqual(publisher._channel_reached(nodes), nodes[0], "the channel tabs prove the profile arrival")

    # ---- agile verify ----

    def test_verify_completes_on_first_check_with_exact_timing(self):
        # 20s fixed wait -> Home->3s->You->3s->View channel -> Bezier refresh
        # -> composite check: the front "No views" tile with the caption
        # prefix is opened from a fresh dump and the player confirms the
        # caption prefix.  The injected fake clock records exactly 20/3/3.
        waits = []
        publisher = self.make_publisher(pause=waits.append)
        publisher._baseline_tiles = ["older Short, 12 views - play Short"]
        device = DualDumpDevice([post_share_screen(), main_screen(), you_screen(), delta_channel(), [node(text=CAPTION)]], [])

        self.assertEqual(publisher.verify(job(), device), CAPTION)

        self.assertEqual(device.taps, [HOME_TAB_BOUNDS, YOU_TAB_BOUNDS, VIEW_CHANNEL_BOUNDS, (10, 20, 110, 80)], "Home, You, View channel, then the delta tile")
        self.assertEqual(device.swipes, [REFRESH])
        self.assertEqual(waits, [20.0, 3.0, 3.0], "exactly 20s propagation wait and 3s cycle settles; no 20s/10s retries")

    def test_verify_completes_on_third_check_after_20_and_10_retries(self):
        # The new tile only lands by the third check: 20s initial wait, the
        # re-sync cycle, then exactly the non-uniform 20s/10s retries
        # (refresh + check each) and completion on the third check's delta.
        waits = []
        publisher = self.make_publisher(pause=waits.append)
        publisher._baseline_tiles = ["older Short, 12 views - play Short"]
        dumps = [post_share_screen(), main_screen(), you_screen(), baseline_channel(), baseline_channel(), delta_channel(), [node(text=CAPTION)]]
        device = DualDumpDevice(dumps, [])

        self.assertEqual(publisher.verify(job(), device), CAPTION)

        self.assertEqual(device.swipes, [REFRESH] * 3, "the re-sync cycle plus both retry refreshes")
        self.assertEqual(waits, [20.0, 3.0, 3.0, 20.0, 10.0])

    def test_verify_returns_unverified_with_evidence_and_log_when_delta_never_appears(self):
        # Fail-closed without failure: a grid that never shows the new Short
        # after three checks is NOT an error -- verify returns the worker-local
        # UNVERIFIED status (never republished), attaches the last dump as
        # evidence and logs "verification pending".  No tile is ever opened.
        waits = []
        publisher = self.make_publisher(pause=waits.append)
        publisher._baseline_tiles = ["older Short, 12 views - play Short"]
        device = DualDumpDevice([post_share_screen(), main_screen(), you_screen(), baseline_channel(), baseline_channel(), baseline_channel()], [])

        with self.assertLogs("southfarm_publisher.platforms.youtube", level="WARNING") as logs:
            result = publisher.verify(job(), device)

        self.assertEqual(result, PublicationStatus.UNVERIFIED)
        self.assertTrue(any("verification pending" in line for line in logs.output), "a clear verification-pending log is emitted")
        evidence = publisher.verification_evidence
        self.assertEqual((evidence["platform"], evidence["stage"]), ("youtube", "verification_pending"))
        self.assertEqual(evidence["baseline_tiles"], ["older Short, 12 views - play Short"])
        self.assertEqual(evidence["grid_tiles"], ["older Short, 12 views - play Short"])
        self.assertTrue(any(item.get("content-desc") == "older Short, 12 views - play Short" for item in evidence["last_dump"]), "the last dump travels with the job")
        self.assertEqual(device.taps, [HOME_TAB_BOUNDS, YOU_TAB_BOUNDS, VIEW_CHANNEL_BOUNDS], "only the re-sync navigation is tapped; no tile is ever opened")
        self.assertEqual(device.swipes, [REFRESH] * 3)
        self.assertEqual(waits, [20.0, 3.0, 3.0, 20.0, 10.0])

    def test_verify_falls_back_to_delta_tile_identity_when_player_hides_caption(self):
        # The player never exposes the caption across both fresh-dump
        # attempts: the identity IS the delta tile description (prefix +
        # "No views" + not in the baseline) and verification completes --
        # completion is never blocked by that alone.
        wrong = [node(text="some other reel")]
        publisher = self.make_publisher()
        publisher._baseline_tiles = ["older Short, 12 views - play Short"]
        dumps = [post_share_screen(), main_screen(), you_screen(),
                 delta_channel(), wrong,
                 delta_channel(), wrong]
        device = DualDumpDevice(dumps, [])

        self.assertEqual(publisher.verify(job(), device), IDENTITY)

        self.assertEqual(device.taps, [HOME_TAB_BOUNDS, YOU_TAB_BOUNDS, VIEW_CHANNEL_BOUNDS, (10, 20, 110, 80), (10, 20, 110, 80)], "two guarded identity tile taps across two fresh-dump attempts")
        self.assertEqual(sum(1 for args in device.commands if "keyevent" in args), 2, "each failed attempt closes its viewer")

    def test_verify_treats_preexisting_baseline_identity_as_no_delta(self):
        # The player confirms the caption but the identity already exists in
        # the pre-publication baseline: no-delta, the cycle keeps polling and
        # the job ends unverified -- never an immediate error.
        waits = []
        publisher = self.make_publisher(pause=waits.append)
        publisher._baseline_tiles = ["older Short, 12 views - play Short"]
        publisher._baseline = {CAPTION}
        device = DualDumpDevice([post_share_screen(), main_screen(), you_screen(),
                                 delta_channel(), [node(text=CAPTION)],
                                 baseline_channel(), baseline_channel()], [])

        result = publisher.verify(job(), device)

        self.assertEqual(result, PublicationStatus.UNVERIFIED, "a baseline-preexisting identity is no-delta, not a failure")
        self.assertEqual(device.taps, [HOME_TAB_BOUNDS, YOU_TAB_BOUNDS, VIEW_CHANNEL_BOUNDS, (10, 20, 110, 80)], "the identity tap happened; the baseline guard kept the cycle polling")

    def test_verify_resync_skips_view_channel_when_you_lands_on_channel(self):
        # Live run (ytverify1): after an upload, tapping You landed directly
        # on the CHANNEL page -- the View channel control does not exist
        # there.  The re-sync must continue (the grid is already the fresh
        # screen) instead of aborting with CHANNEL_NAVIGATION: no navigation
        # tap, straight to the refresh and the composite check.
        waits = []
        publisher = self.make_publisher(pause=waits.append)
        publisher._baseline_tiles = ["older Short, 12 views - play Short"]
        device = DualDumpDevice([post_share_screen(), main_screen(), delta_channel(), delta_channel(), [node(text=CAPTION)]], [])

        self.assertEqual(publisher.verify(job(), device), CAPTION)

        self.assertEqual(device.taps, [HOME_TAB_BOUNDS, YOU_TAB_BOUNDS, (10, 20, 110, 80)], "Home and You tabs, NO View channel tap, then the delta tile")
        self.assertEqual(device.swipes, [REFRESH])
        self.assertEqual(waits, [20.0, 3.0, 3.0])

    def test_verify_resync_fails_closed_when_neither_you_nor_channel(self):
        # A screen that offers neither the View channel control nor the
        # channel grid is unknown: fail closed with CHANNEL_NAVIGATION
        # instead of tapping anything.
        publisher = self.make_publisher()
        publisher._baseline_tiles = ["older Short, 12 views - play Short"]
        device = DualDumpDevice([post_share_screen(), main_screen(), [node(text="somewhere else")]], [])

        with self.assertRaises(PublisherError) as raised:
            publisher.verify(job(), device)

        self.assertEqual(raised.exception.code, "CHANNEL_NAVIGATION")
        self.assertEqual(device.taps, [HOME_TAB_BOUNDS, YOU_TAB_BOUNDS], "only the two tab taps happened")

    def test_tab_tap_targets_clickable_container_when_label_is_not_clickable(self):
        # Live run: the You tab label reported clickable=false inside its
        # clickable Button container; the tap must use the container bounds.
        screen = [
            node(**{"content-desc": "Home", "bounds": f"[{HOME_TAB_BOUNDS[0]},{HOME_TAB_BOUNDS[1]}][{HOME_TAB_BOUNDS[2]},{HOME_TAB_BOUNDS[3]}]"}),
            node(bounds=f"[{YOU_TAB_BOUNDS[0]},{YOU_TAB_BOUNDS[1]}][{YOU_TAB_BOUNDS[2]},{YOU_TAB_BOUNDS[3]}]"),
            node(**{"content-desc": "You", "clickable": "false", "bounds": "[629,1510][667,1534]"}),
        ]
        device = DualDumpDevice([screen], [])
        self.make_publisher()._tap_tab(device, label="You")

        self.assertEqual(device.taps, [YOU_TAB_BOUNDS], "the clickable container is tapped, not the non-clickable label")

    # ---- upload confirmation window ----

    def test_upload_confirmed_by_marker_within_timeout_window(self):
        # Fake clock: the upload overlay progresses and the channel marker
        # only lands ~30s after the Upload tap -- far past the generic 15s
        # wait.  The confirmation window waits up to 90s, so publish
        # completes and never re-taps Upload.
        tail = [upload_overlay("20%"), upload_overlay("60%"), post_share_screen()]
        device = DualDumpDevice(*youtube_publish_dumps_advancing(tail), advance_on_poll=True)
        publisher = ClockedYouTubePublisher([0.0, 15.0, 30.0, 45.0], expected_account=ACCOUNT, timeout=1.0, poll=0.05, pause=lambda _: None)
        publisher.prepare(job(), device)
        with self.assertLogs("southfarm_publisher.platforms.youtube", level="INFO") as logs:
            publisher.publish(job(), device, lambda *args, **kwargs: None)
        self.assertEqual(device.taps.count(UPLOAD_BOUNDS), 1, "Upload is tapped exactly once")
        self.assertTrue(any("YouTube upload progress: Uploading your Short 20%" in line for line in logs.output), "upload progress is logged for evidence")
        self.assertTrue(any("YouTube upload confirmed" in line for line in logs.output), "the channel marker confirms within the window")

    def test_upload_confirmed_when_main_screen_restored_without_upload_ui(self):
        # Fake clock: the overlay shows progress and then clears with the
        # main screen (bottom-bar Create) restored -- the upload finished.
        # Even without the marker that is a confirmation.
        tail = [upload_overlay("50%"), upload_overlay("80%"), main_screen()]
        device = DualDumpDevice(*youtube_publish_dumps_advancing(tail), advance_on_poll=True)
        publisher = ClockedYouTubePublisher([0.0, 30.0, 60.0, 75.0], expected_account=ACCOUNT, timeout=1.0, poll=0.05, pause=lambda _: None)
        publisher.prepare(job(), device)
        with self.assertLogs("southfarm_publisher.platforms.youtube", level="INFO") as logs:
            publisher.publish(job(), device, lambda *args, **kwargs: None)
        self.assertEqual(device.taps.count(UPLOAD_BOUNDS), 1, "Upload is tapped exactly once")
        self.assertTrue(any("YouTube upload finished" in line for line in logs.output), "the upload-finished confirmation is logged for evidence")

    def test_upload_eternal_ui_persisting_90s_is_unconfirmed_without_retap(self):
        # Fake clock: the upload UI persists past the full 90s window.
        # publish fails closed with UPLOAD_UNCONFIRMED (retryable,
        # final_action_uncertain) and the Upload button is never re-tapped.
        tail = [upload_overlay("0%")] * 15
        device = DualDumpDevice(*youtube_publish_dumps_advancing(tail), advance_on_poll=True)
        publisher = ClockedYouTubePublisher([0.0] + [10.0 * (index + 1) for index in range(9)], expected_account=ACCOUNT, timeout=1.0, poll=0.05, pause=lambda _: None)
        publisher.prepare(job(), device)
        with self.assertLogs("southfarm_publisher.platforms.youtube", level="INFO"):
            with self.assertRaises(PublisherError) as raised:
                publisher.publish(job(), device, lambda *args, **kwargs: None)
        self.assertEqual(raised.exception.code, "UPLOAD_UNCONFIRMED")
        self.assertTrue(raised.exception.retryable)
        self.assertTrue(raised.exception.final_action_uncertain)
        self.assertEqual(device.taps.count(UPLOAD_BOUNDS), 1, "Upload is tapped exactly once, never re-attempted")

    def test_upload_confirmation_prefers_marker_over_upload_finished_signal(self):
        # Evaluation order: the marker is the first signal accepted.  Even
        # when the same fresh dump also satisfies the upload-finished branch
        # (bottom bar present, no upload UI), the marker node wins.
        marker_screen = [node(text="Uploaded to Your Channel"), *bottom_tabs()]
        publisher = self.make_publisher()
        ticks = iter([0.0, 1.0])
        device = DualDumpDevice([marker_screen], [], advance_on_poll=True)
        confirmed = YouTubeShortPublisher._wait_upload_confirmation(publisher, device, clock=lambda: next(ticks))
        self.assertIn("Uploaded to Your Channel", f"{confirmed.get('text', '')} {confirmed.get('content-desc', '')}")
        self.assertEqual(device.taps, [], "the confirmation wait never taps anything")

    def test_upload_main_screen_at_3s_waits_for_grace_before_confirming(self):
        # Live run: the main screen came back 3s after the Upload tap while
        # the channel marker only surfaced ~30s later.  An early restored
        # screen must NOT confirm: the weak main-screen signal only counts
        # once _UPLOAD_MAINSCREEN_GRACE (10s) has elapsed since the upload
        # UI was last seen (here: UI at 3s, sightings at 3s/12s do not
        # confirm, the 14s poll -- 11s after the last upload UI -- does).
        publisher = self.make_publisher()
        ticks = iter([0.0, 3.0, 12.0, 14.0])
        dumps = [upload_overlay("40%"), main_screen(), main_screen()]
        device = DualDumpDevice(dumps, [], advance_on_poll=True)
        with self.assertLogs("southfarm_publisher.platforms.youtube", level="INFO") as logs:
            YouTubeShortPublisher._wait_upload_confirmation(publisher, device, clock=lambda: next(ticks))
        self.assertEqual(len(device.served_service), 3, "the 3s and 12s main-screen sightings did not confirm; polling continued to the 14s poll")
        self.assertTrue(any("YouTube upload finished" in line for line in logs.output), "the confirmation arrives through the main-screen signal, after the grace")

    # ---- cleanup ----

    def test_cleanup_deletes_the_tile_through_sheet_and_dialog(self):
        tile = node(**{"content-desc": IDENTITY, "bounds": "[0,100][600,200]"})
        dots = node(**{"content-desc": "More actions", "bounds": "[610,100][700,200]"})
        device = DualDumpDevice(
            [[node(text=ACCOUNT), tile, dots, node(**{"content-desc": "older post - play Short"})],
             [node(text="Edit"), node(text="Delete")],
             [node(text="Delete this video?"), node(text="Delete", bounds="[20,1200][700,1300]")],
             [node(text=ACCOUNT), node(**{"content-desc": "older post - play Short"})]],
            [])
        self.make_publisher().cleanup_test_post(IDENTITY, ["expected.account", "older post - play Short"], device)
        self.assertEqual(len(device.taps), 3, "3-dot, sheet Delete, dialog Delete")

    def test_cleanup_fails_closed_when_the_three_dot_is_not_geometrically_associated(self):
        device = DualDumpDevice([[node(text=ACCOUNT), node(**{"content-desc": IDENTITY, "bounds": "[0,100][600,200]"}), node(**{"content-desc": "More actions", "bounds": "[610,300][700,400]"})]], [])
        with self.assertRaises(PublisherError) as raised:
            self.make_publisher().cleanup_test_post(IDENTITY, ["expected.account"], device)
        self.assertEqual(raised.exception.code, "CLEANUP_MENU_COLLISION")
        self.assertEqual(device.taps, [])

    def test_cleanup_rejects_malformed_baseline_without_any_tap(self):
        device = DualDumpDevice([[]], [])
        with self.assertRaises(PublisherError) as raised:
            self.make_publisher().cleanup_test_post(IDENTITY, "expected.account", device)
        self.assertEqual(raised.exception.code, "CLEANUP_BASELINE_INVALID")
        self.assertEqual(device.taps, [])

    def test_cleanup_noop_for_runner(self):
        self.assertIsNone(self.make_publisher().cleanup(job(), DualDumpDevice([[]], [])))


if __name__ == "__main__":
    unittest.main()
