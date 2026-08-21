import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from southfarm_publisher.models import PublicationJob, PublisherError
from southfarm_publisher.platforms.instagram import InstagramPublisher


PACKAGE = "com.instagram.android"
TITLE = f"{PACKAGE}:id/action_bar_title"
POST_COUNT = f"{PACKAGE}:id/profile_header_post_count_front_familiar"
GALLERY_TITLE = f"{PACKAGE}:id/gallery_title_text"
THUMBNAIL = f"{PACKAGE}:id/gallery_grid_item_thumbnail"
LABEL = f"{PACKAGE}:id/gallery_grid_item_label"
GALLERY_NEXT = f"{PACKAGE}:id/next_button_textview"
EDITOR_NEXT = f"{PACKAGE}:id/clips_right_action_button"
CAPTION_FIELD = f"{PACKAGE}:id/caption_input_text_view"
SHARE = f"{PACKAGE}:id/share_button"
CLIPS_MEDIA = f"{PACKAGE}:id/clips_media_component"
MEDIA_OPTIONS = f"{PACKAGE}:id/media_option_button"
OPTION_TEXT = f"{PACKAGE}:id/control_option_text"
DIALOG_HEADLINE = f"{PACKAGE}:id/igds_alert_dialog_headline"
DIALOG_PRIMARY = f"{PACKAGE}:id/igds_alert_dialog_primary_button"
PROFILE_TAB = f"{PACKAGE}:id/profile_tab"
FEED_TAB = f"{PACKAGE}:id/feed_tab"
# Fixed pull-to-refresh gesture: screen-relative, never derived from tree bounds.
REFRESH_SWIPE = (360, 350, 360, 1000, 400)
PROFILE_TAB_BOUNDS = (576, 1456, 720, 1544)
HOME_TAB_BOUNDS = (0, 1456, 144, 1544)
TILE_DESC = "Reel by Expected at row 1, column 1"
TILE_BOUNDS = (10, 1200, 340, 1530)


class Device:
    """Fake device in the repo style: dump_ui serves a queue of UI revisions,
    one per interaction or (with advance_on_poll) per poll.  stale_raises=False
    keeps serving the last revision forever, so guarded waits reach their
    genuine clock deadline instead of the fake's stale-read abort."""

    def __init__(self, dumps, *, advance_on_poll=False, stale_raises=True):
        self.package = PACKAGE
        self.dumps, self.taps, self.typed, self.commands, self.swipes = list(dumps), [], [], [], []
        self._last_dump, self._after_tap, self._stale_reads = None, True, 0
        self.advance_on_poll, self._stale_raises = advance_on_poll, stale_raises

    def foreground_package(self): return self.package

    def dump_ui(self):
        if self._after_tap or self._last_dump is None:
            if not self.dumps:
                if self._stale_raises:
                    raise PublisherError("UI_TIMEOUT", "fake device has no next UI revision")
                return self._last_dump or []
            self._last_dump = self.dumps.pop(0)
            self._after_tap, self._stale_reads = False, 0
        elif self.advance_on_poll and self.dumps:
            self._last_dump = self.dumps.pop(0)
        else:
            self._stale_reads += 1
            if self._stale_raises and self._stale_reads > 3:
                # A timeout does not kill the device: callers that catch
                # UI_TIMEOUT (for example the media-candidate loop, which now
                # re-dumps before the next tap) must be able to read again.
                self._stale_reads = 0
                raise PublisherError("UI_TIMEOUT", "fake device UI did not advance")
        return self._last_dump

    def tap_bounds(self, bounds, delay_seconds=0):
        self.taps.append(bounds); self._after_tap = True; self._stale_reads = 0

    def swipe(self, *args):
        self.swipes.append(("swipe",) + tuple(args)); self._after_tap = True; self._stale_reads = 0

    def swipe_bezier(self, *args):
        self.swipes.append(("swipe_bezier",) + tuple(args)); self._after_tap = True; self._stale_reads = 0

    def text(self, value):
        self.typed.append(value); self._after_tap = True; self._stale_reads = 0

    def command(self, *args, **kwargs):
        self.commands.append(args)
        if "keyevent" in args: self._after_tap = True
        return ""


def node(**values):
    values.setdefault("bounds", "[10,20][110,80]")
    values.setdefault("clickable", "true")
    values.setdefault("enabled", "true")
    return values


def clip(caption="safe publishing test"):
    media = {"id": 3, "size_bytes": 1, "sha256": "a" * 64, "mime_type": "video/mp4", "file_extension": "mp4", "duration_seconds": 25, "width": 1080, "height": 1920, "video_codec": "hevc", "audio_codec": "aac"}
    return PublicationJob(7, 5, 3, "instagram", caption, media, {"id": 9, "username": "expected.account", "display_name": "Expected", "platform": "instagram"})


def grid_tile(desc=TILE_DESC, bounds=(10, 1200, 340, 1530)):
    return node(**{"resource-id": f"{PACKAGE}:id/image_button", "content-desc": desc, "bounds": f"[{bounds[0]},{bounds[1]}][{bounds[2]},{bounds[3]}]"})


def profile_screen(count="8posts"):
    return [
        node(text="expected.account", **{"resource-id": TITLE}),
        node(**{"content-desc": "Create New"}),
        node(clickable="false", **{"resource-id": POST_COUNT, "content-desc": count}),
        grid_tile(),
    ]


def tabbed_profile(count="8posts", *, tiles=(TILE_DESC,), tab="profile", phantom=True):
    """Profile revision with the semantic bottom bar (live tab_bar geometry)."""
    nodes = [
        node(text="expected.account", **{"resource-id": TITLE}),
        node(**{"content-desc": "Create New"}),
        node(clickable="false", **{"resource-id": POST_COUNT, "content-desc": count}),
    ]
    nodes += [grid_tile(desc) for desc in tiles]
    if phantom:
        # Real stale dumps serve out-of-viewport spans; the refresh gesture
        # must never be derived from tree bounds, phantom or not.
        nodes.append(node(clickable="false", text="stale phantom", bounds="[-2160,415][-1440,531]"))
    nodes += [
        node(**{"resource-id": PROFILE_TAB, "content-desc": "Profile", "selected": "true" if tab == "profile" else "false", "bounds": f"[{PROFILE_TAB_BOUNDS[0]},{PROFILE_TAB_BOUNDS[1]}][{PROFILE_TAB_BOUNDS[2]},{PROFILE_TAB_BOUNDS[3]}]"}),
        node(**{"resource-id": FEED_TAB, "content-desc": "Home", "selected": "true" if tab == "home" else "false", "bounds": f"[{HOME_TAB_BOUNDS[0]},{HOME_TAB_BOUNDS[1]}][{HOME_TAB_BOUNDS[2]},{HOME_TAB_BOUNDS[3]}]"}),
    ]
    return nodes


def home_screen():
    return [
        node(clickable="false", text="posted a video 2 minutes ago"),
        node(**{"resource-id": PROFILE_TAB, "content-desc": "Profile", "selected": "false", "bounds": f"[{PROFILE_TAB_BOUNDS[0]},{PROFILE_TAB_BOUNDS[1]}][{PROFILE_TAB_BOUNDS[2]},{PROFILE_TAB_BOUNDS[3]}]"}),
        node(**{"resource-id": FEED_TAB, "content-desc": "Home", "selected": "true", "bounds": f"[{HOME_TAB_BOUNDS[0]},{HOME_TAB_BOUNDS[1]}][{HOME_TAB_BOUNDS[2]},{HOME_TAB_BOUNDS[3]}]"}),
    ]


class InstagramStartupTests(unittest.TestCase):
    def test_cold_start_survives_splash_dumps_until_tab_bar_renders(self):
        # Regression (PROFILE_TAB race): the first post-launch dump used to
        # decide the whole flow, so partial splash dumps without a tab bar
        # aborted prepare immediately; the tab bar is now awaited within the
        # instance timeout and the flow continues from the fourth dump.
        splash = [node(text="Instagram", clickable="false")]
        tab_bar = [node(**{"content-desc": "Profile", "bounds": "[300,2100][420,2220]"})]
        device = Device([splash, splash, splash, tab_bar, tab_bar, profile_screen()], advance_on_poll=True)
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)

        publisher.prepare(clip(), device)

        self.assertEqual(publisher._baseline_posts, 8)
        self.assertEqual(device.taps, [(300, 2100, 420, 2220)], "exactly the Profile tab is tapped once the bar renders")

    def test_publish_accepts_static_gallery_title_and_selects_by_duration(self):
        # Regression (CONTROL_DISABLED in GALLERY_MEDIA): "New reel" is a
        # TextView with clickable=false, so the gated wait used to reject a
        # perfectly rendered gallery; the caption hint "Write a caption" is a
        # static label in the same way.  Real buttons (Create new reel, Next,
        # Share) stay clickable and keep the guarded gate.
        wrong_tile = node(**{"resource-id": THUMBNAIL, "content-desc": "Unselected Video thumbnail created on August 16, 2026 1:28 PM", "bounds": "[0,100][200,300]"})
        wrong_label = node(**{"resource-id": LABEL, "text": "0:14", "bounds": "[120,260][200,300]"})
        right_tile = node(**{"resource-id": THUMBNAIL, "content-desc": "Unselected Video thumbnail created on August 16, 2026 1:35 PM", "bounds": "[0,300][200,500]"})
        right_label = node(**{"resource-id": LABEL, "text": "0:25", "bounds": "[120,460][200,500]"})
        gallery = [node(text="New reel", clickable="false", **{"resource-id": GALLERY_TITLE}), wrong_tile, wrong_label, right_tile, right_label]
        caption = node(text="Write a caption and add hashtags…", clickable="false", **{"resource-id": CAPTION_FIELD, "content-desc": "Write a caption", "bounds": "[10,1900][700,2000]"})
        share = node(**{"resource-id": SHARE, "content-desc": "Share", "bounds": "[600,1400][700,1500]"})
        dumps = [
            [node(**{"content-desc": "Profile", "bounds": "[300,2100][420,2220]"})],
            profile_screen(),
            [node(**{"content-desc": "Create new reel", "bounds": "[20,1500][700,1620]"})],
            gallery,
            [node(**{"resource-id": THUMBNAIL, "content-desc": "Selected Video thumbnail created on August 16, 2026 1:35 PM", "bounds": "[0,300][200,500]"}), node(text="Next", **{"resource-id": GALLERY_NEXT, "bounds": "[500,2050][700,2150]"})],
            [node(**{"resource-id": EDITOR_NEXT, "content-desc": "Next", "bounds": "[500,2100][700,2200]"})],
            [caption, share],
            [node(text="Write a caption and add hashtags…", clickable="false", focused="true", **{"resource-id": CAPTION_FIELD, "content-desc": "Write a caption", "bounds": "[10,1900][700,2000]"})],
            [node(text="safe test", clickable="false", **{"resource-id": CAPTION_FIELD, "content-desc": "Write a caption", "bounds": "[10,1900][700,2000]"})],
            [node(text="safe test", clickable="false", **{"resource-id": CAPTION_FIELD, "bounds": "[10,1900][700,2000]"}), share],
        ]
        device = Device(dumps)
        events = []
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)
        publisher.prepare(clip("safe test"), device)

        publisher.publish(clip("safe test"), device, lambda step, progress, **kwargs: events.append((step, progress, kwargs)))

        self.assertEqual([event[0] for event in events], ["selecting_media", "editing", "captioning", "ready_to_publish", "publishing"])
        self.assertTrue(events[-1][2]["final_action"])
        self.assertEqual(device.typed, ["safe test"])
        self.assertEqual(device.taps[3], (0, 300, 200, 500), "the 0:25 candidate is selected via its duration label")
        self.assertNotIn((0, 100, 200, 300), device.taps, "the wrong-duration tile is never tapped")
        self.assertEqual(device.taps[-1], (600, 1400, 700, 1500))

    def test_verify_completes_on_first_check_delta_with_exact_timing(self):
        # Agile sequence, first check: 20s fixed wait -> Profile->3s->Home->
        # 3s->Profile re-sync cycle -> Bezier refresh -> composite check.
        # The count delta then triggers the pre-identity grid recomposition
        # (Profile->1s->Home->1s->Profile->refresh) before the guarded tile
        # tap.  The post count is a static label (clickable=false): the delta
        # is read by presence, never through the gate, and the caption is
        # matched as plain text without any clips resource-id.  The injected
        # fake clock records exactly 20.0/3.0/3.0/1.0/1.0 -- nothing else.
        waits = []
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=waits.append)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({TILE_DESC})
        dumps = [
            tabbed_profile("8posts"),                 # cycle: Profile tap lookup
            home_screen(),                            # cycle: Home tap lookup
            tabbed_profile("8posts"),                 # cycle: last Profile tap lookup
            tabbed_profile("9posts"),                 # post-refresh composite check: delta
            home_screen(),                            # identity resync: Home tap lookup
            tabbed_profile("9posts"),                 # identity resync: last Profile tap lookup
            tabbed_profile("9posts"),                 # identity grid dump before the tile tap
            [node(text="safe publishing test", clickable="false")],  # opened viewer
        ]
        device = Device(dumps, stale_raises=False)

        self.assertEqual(publisher.verify(clip(), device), "safe publishing test")

        self.assertEqual(device.taps, [PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, TILE_BOUNDS], "the verify cycle and the pre-identity recomposition cycle precede the tile tap")
        self.assertEqual(device.swipes, [("swipe_bezier",) + REFRESH_SWIPE] * 2)
        self.assertEqual(waits, [20.0, 3.0, 3.0, 1.0, 1.0], "exactly 20s propagation wait, 3s cycle settles and 1s pre-identity resync settles; no 20s/10s retries")

    def test_verify_completes_on_third_check_after_20s_and_10s_retries_with_exact_timing(self):
        # The reel only lands by the third check: 20s initial wait, the
        # re-sync cycle, then exactly the non-uniform 20s/10s retries
        # (swipe + check each) and completion on the third check's delta,
        # which first recomposes the grid with the 1s pre-identity cycle.
        # The fake clock records the exact 20/3/3/20/10/1/1 sequence.
        waits = []
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=waits.append)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({TILE_DESC})
        dumps = [
            tabbed_profile("8posts"),
            home_screen(),
            tabbed_profile("8posts"),
            tabbed_profile("8posts"),   # check 1: no delta
            tabbed_profile("8posts"),   # check 2: no delta
            tabbed_profile("9posts"),   # check 3: delta
            home_screen(),              # identity resync: Home tap lookup
            tabbed_profile("9posts"),   # identity resync: last Profile tap lookup
            tabbed_profile("9posts"),   # identity grid dump before the tile tap
            [node(text="safe publishing test", clickable="false")],
        ]
        device = Device(dumps, stale_raises=False)

        self.assertEqual(publisher.verify(clip(), device), "safe publishing test")

        self.assertEqual(device.swipes, [("swipe_bezier",) + REFRESH_SWIPE] * 4)
        self.assertEqual(device.taps, [PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, TILE_BOUNDS])
        self.assertEqual(waits, [20.0, 3.0, 3.0, 20.0, 10.0, 1.0, 1.0])

    def test_verify_returns_unverified_with_evidence_when_reel_never_appears(self):
        # Fail-closed without failure: a grid that never shows the new reel
        # after three checks is NOT an error -- verify returns None (the
        # worker-local `unverified` result), attaches the last dump as
        # evidence and logs "verification pending".  The stale tile is never
        # opened and nothing is republished.
        waits = []
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=waits.append)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({TILE_DESC})
        dumps = [
            tabbed_profile("8posts"),
            home_screen(),
            tabbed_profile("8posts"),
            tabbed_profile("8posts"),
            tabbed_profile("8posts"),
            tabbed_profile("8posts"),
        ]
        device = Device(dumps, stale_raises=False)

        with self.assertLogs("southfarm_publisher.platforms.instagram", level="WARNING") as logs:
            result = publisher.verify(clip(), device)

        self.assertIsNone(result)
        self.assertTrue(any("verification pending" in line for line in logs.output), "a clear verification-pending log is emitted")
        evidence = publisher.verification_evidence
        self.assertEqual((evidence["platform"], evidence["stage"]), ("instagram", "verification_pending"))
        self.assertEqual(evidence["post_counts"], [8])
        self.assertTrue(any(node.get("content-desc") == "8posts" for node in evidence["last_dump"]), "the last dump travels with the job")
        self.assertEqual(device.taps, [PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS], "the stale grid tile is never opened")
        self.assertEqual(device.swipes, [("swipe_bezier",) + REFRESH_SWIPE] * 3)
        self.assertEqual(waits, [20.0, 3.0, 3.0, 20.0, 10.0])

    def test_verify_detects_reel_delta_from_new_tile_signature_without_count_change(self):
        # The tile-signature baseline is primary delta evidence: a new tile
        # description appears while the post count still reads the baseline,
        # and that alone proves the delta; the pre-identity recomposition
        # cycle still runs before the identity tap.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({TILE_DESC})
        shifted = tabbed_profile("8posts", tiles=(TILE_DESC, "Reel by Expected at row 2, column 1"))
        dumps = [
            tabbed_profile("8posts"),
            home_screen(),
            shifted,
            shifted,        # check 1: tile delta, count unchanged
            home_screen(),  # identity resync: Home tap lookup
            shifted,        # identity resync: last Profile tap lookup
            shifted,        # identity grid dump before the tile tap
            [node(text="safe publishing test", clickable="false")],
        ]
        device = Device(dumps, stale_raises=False)

        self.assertEqual(publisher.verify(clip(), device), "safe publishing test")
        self.assertEqual(device.swipes, [("swipe_bezier",) + REFRESH_SWIPE] * 2, "no extra refresh beyond the two resync cycles when the tile delta lands on the first check")
        self.assertEqual(device.taps, [PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, TILE_BOUNDS])

    def test_verify_recomposes_grid_with_tab_cycle_before_identity_tap_after_count_delta(self):
        # live3 regression: a swipe-only refresh updates the header count
        # (9posts) but the grid keeps serving the pre-publication tile, so
        # tapping row 1 column 1 right away would open the OLD reel.  The
        # pre-identity tab cycle (Profile->1s->Home->1s->Profile->refresh)
        # recomposes the grid: the old tile shifts to row 1 column 2 and the
        # new reel lands at row 1 column 1, so the caption confirms and the
        # job completes.
        waits = []
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=waits.append)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({TILE_DESC})
        recomposed = tabbed_profile("9posts", tiles=(TILE_DESC, "Reel by Expected at row 1, column 2"))
        dumps = [
            tabbed_profile("8posts"),   # cycle: Profile tap lookup
            home_screen(),              # cycle: Home tap lookup
            tabbed_profile("8posts"),   # cycle: last Profile tap lookup
            tabbed_profile("9posts"),   # swipe-only refresh: count updated, grid NOT recomposed
            home_screen(),              # identity resync: Home tap lookup
            recomposed,                 # tab cycle recomposed the grid
            recomposed,                 # identity grid dump before the tile tap
            [node(text="safe publishing test", clickable="false")],
        ]
        device = Device(dumps, stale_raises=False)

        self.assertEqual(publisher.verify(clip(), device), "safe publishing test")
        self.assertEqual(device.taps, [PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, TILE_BOUNDS], "the identity tile tap happens only after the recomposition tab cycle")
        self.assertEqual(device.swipes, [("swipe_bezier",) + REFRESH_SWIPE] * 2)
        self.assertEqual(waits, [20.0, 3.0, 3.0, 1.0, 1.0], "the count delta on the swipe-only dump is enough to trigger the 1s pre-identity recomposition")

    def test_verify_reopens_from_fresh_dump_after_stale_bounds_opened_an_older_reel(self):
        # Regression (integration): tapping the tile with bounds from a stale
        # grid dump opened an older reel; the caption check caught the
        # mismatch (fail-closed) and the retry re-dumps the grid, taps the
        # tile with the fresh bounds and confirms the published caption --
        # all within the first check.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({TILE_DESC})

        def profile_with_tile(bounds):
            return [
                node(text="expected.account", **{"resource-id": TITLE}),
                node(clickable="false", **{"resource-id": POST_COUNT, "content-desc": "9posts"}),
                node(**{"resource-id": f"{PACKAGE}:id/image_button", "content-desc": TILE_DESC, "bounds": f"[{bounds[0]},{bounds[1]}][{bounds[2]},{bounds[3]}]"}),
                node(**{"resource-id": PROFILE_TAB, "content-desc": "Profile", "bounds": f"[{PROFILE_TAB_BOUNDS[0]},{PROFILE_TAB_BOUNDS[1]}][{PROFILE_TAB_BOUNDS[2]},{PROFILE_TAB_BOUNDS[3]}]"}),
                node(**{"resource-id": FEED_TAB, "content-desc": "Home", "bounds": f"[{HOME_TAB_BOUNDS[0]},{HOME_TAB_BOUNDS[1]}][{HOME_TAB_BOUNDS[2]},{HOME_TAB_BOUNDS[3]}]"}),
            ]

        stale_bounds, fresh_bounds = (10, 1200, 340, 1530), (20, 1300, 350, 1610)
        older_reel = [node(text="marczell.vibes old caption from a previous post", clickable="false")]
        our_reel = [node(text="marczell.vibes safe publishing test", clickable="false")]
        dumps = [
            tabbed_profile("8posts"),
            home_screen(),
            profile_with_tile(stale_bounds),
            profile_with_tile(stale_bounds),   # composite check: 9posts delta
            home_screen(),                     # identity resync: Home tap lookup
            profile_with_tile(stale_bounds),   # identity resync: last Profile tap lookup
            profile_with_tile(stale_bounds),   # identity grid dump: stale bounds
            older_reel,
            profile_with_tile(fresh_bounds),
            our_reel,
        ]
        device = Device(dumps, stale_raises=False)

        self.assertEqual(publisher.verify(clip(), device), "marczell.vibes safe publishing test")
        self.assertEqual(device.taps[-2:], [stale_bounds, fresh_bounds], "the tile is retapped with the fresh dump bounds")
        self.assertEqual(sum(1 for args in device.commands if "keyevent" in args), 1, "the wrong viewer is closed exactly once")

    def test_verify_unconfirmed_identity_ends_unverified_after_three_checks(self):
        # Delta by count lands on every check but the opened viewer never
        # carries our caption: every check recomposes the grid with the 1s
        # pre-identity cycle and then makes two fresh-dump identity attempts,
        # and after all three checks the result is the worker-local
        # unverified state (None + evidence), never a failure, and nothing is
        # tapped beyond the guarded cycles, tile taps and viewer closes.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        publisher._baseline_posts = 8
        publisher._baseline_tiles = frozenset({TILE_DESC})
        stranger = [node(text="marczell.vibes a completely different older reel", clickable="false")]
        dumps = [tabbed_profile("8posts"), home_screen(), tabbed_profile("8posts")]
        for _ in range(3):
            dumps += [tabbed_profile("9posts"), home_screen(), tabbed_profile("9posts"), tabbed_profile("9posts"), stranger, tabbed_profile("9posts"), stranger]
        device = Device(dumps, stale_raises=False)

        result = publisher.verify(clip(), device)

        self.assertIsNone(result)
        self.assertEqual(publisher.verification_evidence["stage"], "verification_pending")
        self.assertEqual(device.taps[3:], [PROFILE_TAB_BOUNDS, HOME_TAB_BOUNDS, PROFILE_TAB_BOUNDS, TILE_BOUNDS, TILE_BOUNDS] * 3, "each check runs the pre-identity cycle plus two guarded tile taps")
        self.assertEqual(sum(1 for args in device.commands if "keyevent" in args), 6, "each failed attempt closes its viewer")

    def test_verify_resync_fails_closed_on_ambiguous_home_tab_without_blind_tap(self):
        # Fail-closed selector integrity: a duplicated bottom-bar tab (two
        # feed_tab nodes) aborts the tab cycle with SELECTOR_COLLISION; the
        # ambiguous Home tab is never tapped and no swipe follows.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)
        profile = tabbed_profile("8posts")
        two_homes = tabbed_profile("8posts") + [node(**{"resource-id": FEED_TAB, "content-desc": "Home", "bounds": "[0,1456][144,1544]"})]
        device = Device([profile, two_homes], stale_raises=False)

        with self.assertRaises(PublisherError) as raised:
            publisher._tab_cycle_resync(device, publisher._VERIFY_TAB_WAIT)

        self.assertEqual(raised.exception.code, "SELECTOR_COLLISION")
        self.assertEqual(device.taps, [PROFILE_TAB_BOUNDS], "the unambiguous Profile tap happened; the ambiguous Home tab was never tapped")
        self.assertEqual(device.swipes, [], "the ambiguous tab aborts before any swipe")

    def test_prepare_fails_closed_when_profile_grid_has_no_reel_tiles(self):
        # The tile baseline is the verify delta evidence: a profile grid with
        # zero Reel tiles cannot be baselined and prepare fails closed instead
        # of publishing without verifiability.
        profile = [node(text="expected.account", **{"resource-id": TITLE}), node(**{"content-desc": "Create New"}), node(clickable="false", **{"resource-id": POST_COUNT, "content-desc": "8posts"})]
        device = Device([[node(**{"content-desc": "Profile", "bounds": "[300,2100][420,2220]"})], profile], stale_raises=False)
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)

        with self.assertRaises(PublisherError) as raised:
            publisher.prepare(clip(), device)

        self.assertEqual(raised.exception.code, "TILE_BASELINE_INVALID")

    def test_prepare_fails_closed_with_profile_tab_when_tab_never_renders(self):
        # Fail-closed preserved: a tab bar that never renders still aborts with
        # PROFILE_TAB once the startup timeout expires, and never taps.
        splash = [node(text="Instagram", clickable="false")]
        device = Device([splash], stale_raises=False)
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.03, poll=.01, pause=lambda _: None)

        with self.assertRaises(PublisherError) as raised:
            publisher.prepare(clip(), device)

        self.assertEqual(raised.exception.code, "PROFILE_TAB")
        self.assertEqual(device.taps, [])

    def test_publish_fails_closed_when_gallery_never_arrives(self):
        # Fail-closed preserved: a gallery that never renders (neither the
        # static "New reel" title nor any video thumbnail) times out as a
        # GALLERY_MEDIA wait without ever touching a media tile.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.03, poll=.01, pause=lambda _: None)
        publisher._prepared = True
        device = Device([
            [node(**{"content-desc": "Create New", "bounds": "[600,1800][720,1920]"})],
            [node(**{"content-desc": "Create new reel", "bounds": "[20,1500][700,1620]"})],
        ], stale_raises=False)

        with self.assertRaises(PublisherError) as raised:
            publisher.publish(clip("safe test"), device, lambda *args, **kwargs: None)

        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertIn("GALLERY_MEDIA", str(raised.exception))
        self.assertEqual(len(device.taps), 2, "Create New and the reel option were tapped; no media tile was ever touched")
        self.assertEqual(device.typed, [])

    def test_select_video_taps_only_fresh_redump_bounds_after_stale_arrival_geometry(self):
        # live4 regression: the gallery arrival dump served the tile ~1432px
        # below its real position (centre y 2250 on a 720x1640 screen) and
        # the stale bounds would land the tap off screen.  The candidate tap
        # must re-dump, re-locate the tile by identity and dispatch ONLY the
        # fresh in-viewport geometry; selection then proceeds to the editor.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        stale_tile = node(**{"resource-id": THUMBNAIL, "content-desc": "Unselected Video thumbnail created on August 17, 2026 10:00 AM", "bounds": "[243,1922][477,2578]"})
        stale_label = node(**{"resource-id": LABEL, "text": "0:25", "bounds": "[250,2470][470,2578]"})
        publisher._last_nodes = [stale_tile, stale_label]
        fresh_tile = node(**{"resource-id": THUMBNAIL, "content-desc": stale_tile["content-desc"], "bounds": "[243,402][477,818]"})
        fresh_label = node(**{"resource-id": LABEL, "text": "0:25", "bounds": "[250,762][470,818]"})
        selected_screen = [
            node(**{"resource-id": THUMBNAIL, "content-desc": "Selected Video thumbnail created on August 17, 2026 10:00 AM", "bounds": "[243,402][477,818]"}),
            node(text="Next", **{"resource-id": GALLERY_NEXT, "bounds": "[600,1456][720,1560]"}),
        ]
        editor = [node(**{"resource-id": EDITOR_NEXT, "content-desc": "Next", "bounds": "[600,1456][720,1560]"})]
        device = Device([[fresh_tile, fresh_label], selected_screen, editor])

        selected = publisher._select_video(device, 25)

        self.assertEqual(selected["resource-id"], EDITOR_NEXT)
        self.assertEqual(device.taps[0], (243, 402, 477, 818), "the tap dispatches the fresh re-dump bounds, never the stale arrival geometry")
        self.assertNotIn((243, 1922, 477, 2578), device.taps, "the stale arrival geometry is never tapped")
        for bounds in device.taps:
            x1, y1, x2, y2 = bounds
            self.assertTrue(0 <= x1 <= x2 <= 720 and 0 <= y1 <= y2 <= 1640, f"tap {bounds} lands inside the 720x1640 viewport")

    def test_select_video_discards_candidates_that_persist_outside_the_viewport(self):
        # Fail-closed live4 rule: a candidate whose fresh re-dumps keep
        # serving off-viewport bounds -- fully outside like live4, or only
        # partially outside -- is discarded after two re-dumps; with no
        # candidate left the selection aborts MEDIA_UNSELECTABLE and NOTHING
        # is ever tapped.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        first_tile = node(**{"resource-id": THUMBNAIL, "content-desc": "Unselected Video thumbnail created on August 17, 2026 10:00 AM", "bounds": "[243,1922][477,2578]"})
        second_tile = node(**{"resource-id": THUMBNAIL, "content-desc": "Unselected Video thumbnail created on August 17, 2026 9:59 AM", "bounds": "[480,1500][700,1700]"})
        first_label = node(**{"resource-id": LABEL, "text": "0:25", "bounds": "[250,2470][470,2578]"})
        second_label = node(**{"resource-id": LABEL, "text": "0:25", "bounds": "[500,1660][700,1700]"})
        publisher._last_nodes = [first_tile, first_label, second_tile, second_label]
        # Every fresh re-dump keeps both candidates off the viewport.
        stale = [first_tile, first_label, second_tile, second_label]
        device = Device([stale] * 4, advance_on_poll=True)

        with self.assertRaises(PublisherError) as raised:
            publisher._select_video(device, 25)

        self.assertEqual(raised.exception.code, "MEDIA_UNSELECTABLE")
        self.assertEqual(device.taps, [], "no tap is ever dispatched from out-of-viewport geometry")

    def test_select_video_moves_to_next_candidate_when_fresh_dump_finally_lands_the_tile(self):
        # Candidate 1 persists outside the viewport across both re-dumps and
        # is discarded; candidate 2 re-localizes with valid bounds on its
        # first re-dump and carries the selection with the fresh geometry.
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.05, poll=.01, pause=lambda _: None)
        first_tile = node(**{"resource-id": THUMBNAIL, "content-desc": "Unselected Video thumbnail created on August 17, 2026 10:00 AM", "bounds": "[243,1922][477,2578]"})
        first_label = node(**{"resource-id": LABEL, "text": "0:25", "bounds": "[250,2470][470,2578]"})
        second_stale = node(**{"resource-id": THUMBNAIL, "content-desc": "Unselected Video thumbnail created on August 17, 2026 9:59 AM", "bounds": "[480,1700][700,1900]"})
        second_stale_label = node(**{"resource-id": LABEL, "text": "0:25", "bounds": "[500,1860][700,1900]"})
        publisher._last_nodes = [first_tile, first_label, second_stale, second_stale_label]
        second_fresh = node(**{"resource-id": THUMBNAIL, "content-desc": second_stale["content-desc"], "bounds": "[480,420][700,740]"})
        second_fresh_label = node(**{"resource-id": LABEL, "text": "0:25", "bounds": "[500,680][700,740]"})
        selected_screen = [
            node(**{"resource-id": THUMBNAIL, "content-desc": "Selected Video thumbnail created on August 17, 2026 9:59 AM", "bounds": "[480,420][700,740]"}),
            node(text="Next", **{"resource-id": GALLERY_NEXT, "bounds": "[600,1456][720,1560]"}),
        ]
        editor = [node(**{"resource-id": EDITOR_NEXT, "content-desc": "Next", "bounds": "[600,1456][720,1560]"})]
        # Re-dumps 1-2: candidate 1 still off the viewport (discarded);
        # re-dump 3: candidate 2 has corrected geometry and is tapped.
        dumps = [
            [first_tile, first_label, second_stale, second_stale_label],
            [first_tile, first_label, second_stale, second_stale_label],
            [first_tile, first_label, second_fresh, second_fresh_label],
            selected_screen, selected_screen, selected_screen, editor,
        ]
        device = Device(dumps, advance_on_poll=True)

        selected = publisher._select_video(device, 25)

        self.assertEqual(selected["resource-id"], EDITOR_NEXT)
        self.assertEqual(device.taps[0], (480, 420, 700, 740), "candidate 2 is tapped with its fresh re-dump bounds")
        self.assertNotIn((243, 1922, 477, 2578), device.taps, "the discarded candidate is never tapped")
        for bounds in device.taps:
            x1, y1, x2, y2 = bounds
            self.assertTrue(0 <= x1 <= x2 <= 720 and 0 <= y1 <= y2 <= 1640, f"tap {bounds} lands inside the 720x1640 viewport")

    def cleanup_flow(self, headline, *, stale_raises=True):
        """Full cleanup revision sequence around a delete dialog with `headline`."""
        expected = "safe publishing test"
        account = node(text="expected.account", **{"resource-id": TITLE})
        tile = node(**{"content-desc": "Reel by Expected at row 1, column 1", "bounds": "[10,1200][340,1530]"})
        dialog = [node(text=headline, clickable="false", **{"resource-id": DIALOG_HEADLINE}), node(text="Delete", **{"resource-id": DIALOG_PRIMARY, "bounds": "[100,900][300,980]"})]
        dumps = [
            [account, node(clickable="false", **{"resource-id": POST_COUNT, "content-desc": "9posts"}), tile],
            [node(**{"resource-id": CLIPS_MEDIA, "content-desc": "Reel by expected.account. Double tap to play or pause."}), node(text=expected, clickable="false"), node(**{"resource-id": MEDIA_OPTIONS, "content-desc": "More actions for this post"})],
            [node(text="Delete", **{"resource-id": OPTION_TEXT})],
            dialog,
            [account, node(clickable="false", **{"resource-id": POST_COUNT, "content-desc": "8posts"}), tile],
        ]
        if not stale_raises:
            dumps = dumps[:4]
        return Device(dumps, stale_raises=stale_raises)

    def test_cleanup_confirms_both_delete_dialog_headline_variants(self):
        # Regression (DELETE_CONFIRMATION on reels): the real dialog headline is
        # surface-dependent ("Delete Post?" / "Delete reel?"); both variants
        # confirm through the guarded primary Delete button and restore the
        # baseline post count.
        for headline in ("Delete Post?", "Delete reel?"):
            with self.subTest(headline=headline):
                device = self.cleanup_flow(headline)
                publisher = InstagramPublisher(expected_account="expected.account", timeout=.5, poll=.02, pause=lambda _: None)

                publisher.cleanup_test_post("safe publishing test", ["8posts"], device)

                self.assertEqual(device.taps[-1], (100, 900, 300, 980), "the guarded dialog primary Delete is the last tap")
                self.assertEqual(len(device.taps), 4)

    def test_cleanup_fails_closed_on_unknown_delete_dialog_headline(self):
        # Fail-closed preserved: an unrecognized confirmation headline (even
        # with a Delete primary button present) never confirms the deletion.
        device = self.cleanup_flow("Delete your account?", stale_raises=False)
        publisher = InstagramPublisher(expected_account="expected.account", timeout=.03, poll=.01, pause=lambda _: None)

        with self.assertRaises(PublisherError) as raised:
            publisher.cleanup_test_post("safe publishing test", ["8posts"], device)

        self.assertEqual(raised.exception.code, "UI_TIMEOUT")
        self.assertIn("DELETE_CONFIRMATION", str(raised.exception))
        self.assertNotIn((100, 900, 300, 980), device.taps, "the destructive dialog Delete is never tapped on an unrecognized headline")
        self.assertEqual(len(device.taps), 3, "tile, reel menu and sheet Delete were tapped; the dialog was never confirmed")


if __name__ == "__main__":
    unittest.main()
