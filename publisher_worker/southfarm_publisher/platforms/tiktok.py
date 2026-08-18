from __future__ import annotations

import logging
import re
import time
from typing import Any, Callable

from .common import GuardedPublisher, enabled, validate_caption
from ..adb_device import SafeAdb
from ..models import PublicationStatus, PublisherError

logger = logging.getLogger(__name__)


class TikTokPublisher(GuardedPublisher):
    """Post publishing against the selectors verified live on the device.

    Verified flow: Profile tab -> identity "@handle" -> Create tab -> camera
    upload hot area -> picker "Videos" filter (thumbnail plus duration label)
    -> picker Next -> editor Next -> caption field -> back over the IME ->
    Post -> "Video posted!" toast.  Verification runs the agile post-Post
    sequence (fixed propagation wait, tab-cycle re-sync, ordered play-count
    grid delta and caption-confirmed identity); cleanup reopens the post and
    requires the caption from rid "desc" before any destructive action.
    """

    # Target application package: bottom-bar tab selectors are scoped to it so
    # SystemUI chrome (3-button navigation exposes a content-desc "Home"
    # navbar button) and launcher nodes are invisible to the tab matchers
    # instead of colliding with the app's own tabs.
    _PACKAGE = "com.zhiliaoapp.musically"
    package = _PACKAGE

    _TAB_CREATE = "com.zhiliaoapp.musically:id/o70"
    _TAB_PROFILE = "com.zhiliaoapp.musically:id/o76"
    _IDENTITY = "com.zhiliaoapp.musically:id/se1"
    _DISPLAY = "com.zhiliaoapp.musically:id/sh3"
    _UPLOAD_HOT_AREA = "com.zhiliaoapp.musically:id/upload_hot_area"
    _THUMBNAIL = "com.zhiliaoapp.musically:id/ofk"
    _DURATION_LABEL = "com.zhiliaoapp.musically:id/gi4"
    _PICKER_NEXT = "com.zhiliaoapp.musically:id/x4j"
    _EDITOR_NEXT = "com.zhiliaoapp.musically:id/pjg"
    _CAPTION_FIELD = "com.zhiliaoapp.musically:id/h00"
    _POST_BUTTON = "com.zhiliaoapp.musically:id/st6"
    _POSTED_TOAST = "com.zhiliaoapp.musically:id/zxp"
    _UPLOAD_STATUS = "com.zhiliaoapp.musically:id/su6"   # overlay text "Posting..."
    _UPLOAD_PERCENT = "com.zhiliaoapp.musically:id/su5"  # overlay text "N%"
    _PROFILE_GRID = "com.zhiliaoapp.musically:id/i09"
    _PLAY_COUNT = "com.zhiliaoapp.musically:id/tv_play_count"
    _SHARE_SHEET = "com.zhiliaoapp.musically:id/fzi"
    _SHEET_DELETE = "com.zhiliaoapp.musically:id/vbn"
    _DELETE_CONFIRM = "com.zhiliaoapp.musically:id/fq5"
    _OPENED_CAPTION = "com.zhiliaoapp.musically:id/desc"

    # A ~48MB video upload takes far longer than the generic 15s wait: after
    # the Post tap TikTok shows the upload overlay ("Posting... N%") and the
    # "Video posted!" toast only lands once the upload finishes (live
    # 2026-08-17, where the lost-WiFi run stalled at "Posting... 0%").
    _POST_UPLOAD_TIMEOUT = 90.0

    # Agile post-Post verification timing (the same user-defined exact
    # sequence as the Instagram adapter, calibrated on the live build where
    # the new tile only materialized well after the Post tap):
    _VERIFY_INITIAL_WAIT = 20.0    # fixed propagation wait after the "Video posted!" toast
    _VERIFY_TAB_WAIT = 3.0         # settle between re-sync tab taps in the verify cycle
    _VERIFY_RETRY_WAITS = (20.0, 10.0)  # non-uniform waits before the retry checks
    _VERIFY_MAX_CHECKS = 1 + len(_VERIFY_RETRY_WAITS)  # re-sync check + one swipe retry per wait
    _IDENTITY_RESYNC_TAB_WAIT = 1.0  # shorter settle for the pre-identity grid recomposition cycle
    # Pull-to-refresh at fixed screen-relative coordinates (720x1640 target).
    # Tree bounds must NEVER drive this gesture: stale a11y geometry served
    # out-of-viewport spans and produced phantom swipes.  The TikTok fixtures
    # (tiktok_*.xml) carry no alternative gesture geometry, so the
    # Instagram-calibrated coordinates are reused verbatim.
    _REFRESH_SWIPE = (360, 350, 360, 1000, 400)
    # The profile grid serves stale bounds, so the identity phase re-dumps the
    # grid for every attempt; two fresh-dump attempts bound the total tile taps.
    VERIFY_IDENTITY_ATTEMPTS = 2

    # The feed preload duplicates off-screen controls (for example "Share
    # video" appears twice): only bounds that start inside the live viewport
    # are on-screen controls.
    _VIEWPORT_X, _VIEWPORT_Y = 720, 1640
    _SHEET_ROW_Y = 1430

    # Late-render play counts (live 2026-08-17): the profile grid can arrive
    # with tiles whose tv_play_count counters render seconds after the dump.
    # The baseline row is re-dumped briefly before accepting an empty one.
    _BASELINE_COUNT_RETRIES = 3
    _BASELINE_COUNT_RETRY_PAUSE = 2.0

    @classmethod
    def _in_viewport(cls, node: dict[str, str]) -> bool:
        try:
            x1, y1, _, _ = SafeAdb.bounds(node)
        except PublisherError:
            return False
        return x1 < cls._VIEWPORT_X and y1 < cls._VIEWPORT_Y

    @staticmethod
    def _duration_formats(duration: int) -> set[str]:
        # Live picker labels show both "M:SS" and "00:SS" for sub-minute clips.
        minutes, seconds = divmod(duration, 60)
        formats = {f"{minutes}:{seconds:02d}"}
        if minutes == 0:
            formats.add(f"00:{seconds:02d}")
        return formats

    def _identity_node(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return self.optional_account_control(nodes, resource_id=self._IDENTITY, error="TikTok active profile account")

    def _on_our_profile(self, nodes: list[dict[str, str]]) -> bool:
        identity = self._identity_node(nodes)
        expected = "@" + self.expected_account
        return identity is not None and (identity.get("text") == expected or identity.get("content-desc") == expected)

    def _profile_reached(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        # Profile-only markers (identity handle, display name, grid): the
        # bottom tab bar repeats on every screen, so it proves nothing.
        identity = self._identity_node(nodes)
        if identity is not None:
            return identity
        return next((node for node in nodes if node.get("resource-id") in {self._DISPLAY, self._PROFILE_GRID}), None)

    def _profile_tab(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return (self._one(nodes, error="PROFILE_TAB", resource_id=self._TAB_PROFILE, package=self._PACKAGE, required=False)
                or self._one(nodes, error="PROFILE_TAB", content_desc="Profile", package=self._PACKAGE, required=False)
                or self._one(nodes, error="PROFILE_TAB", text="Profile", package=self._PACKAGE, required=False))

    def _navigate_profile(self, device: Any) -> list[dict[str, str]]:
        nodes = self._nodes(device)
        if self._identity_node(nodes) is not None:
            return nodes
        tab = self._profile_tab(nodes)
        if tab is None:
            raise PublisherError("PROFILE_TAB", "TikTok Profile tab is required before account verification")
        self.tap_and_wait(device, tab, error="PROFILE_ACCOUNT", predicate=self._profile_reached)
        return self._last_nodes

    def _back(self, device: Any) -> None:
        if hasattr(device, "back"): device.back()
        else: device.command("shell", "input", "keyevent", "4")

    def _return_to_profile(self, device: Any) -> list[dict[str, str]]:
        """Reach our own profile: controlled backs out of overlays, then the Profile tab."""
        for _ in range(3):
            nodes = self._nodes(device)
            if self._on_our_profile(nodes):
                return nodes
            tab = self._profile_tab(nodes)
            if tab is None:
                self._back(device)
                continue
            self.tap_and_wait(device, tab, error="PROFILE_ACCOUNT", predicate=self._profile_reached)
            if self._on_our_profile(self._last_nodes):
                return self._last_nodes
        raise PublisherError("PROFILE_ACCOUNT", "TikTok own profile could not be reached", retryable=True)

    def _visible_play_counts(self, nodes: list[dict[str, str]]) -> list[dict[str, str]]:
        return [node for node in nodes if node.get("resource-id") == self._PLAY_COUNT and self._in_viewport(node)]

    def _profile_delta(self, nodes: list[dict[str, str]], baseline: list[str]) -> dict[str, str] | None:
        """Delta = a NEW "0" play-count tile prepended in front of the baseline.

        Live 2026-08-17 (ttverify4): the exact ["0"] + baseline row never
        materializes on screen.  The new tile is prepended, the last baseline
        tile falls behind the bottom bar (the rendered row is shorter), old
        counts drift organically (209 -> 210), and a draft tile can occupy the
        first grid slot without a visible count of its own.  The delta signal
        is therefore the prepend alone: the FIRST visible grid count is "0"
        AND the pre-publication baseline did NOT lead with "0" (a
        baseline-led "0" is ambiguous -- it could be the previous post that
        still shows zero plays).  Counts after the front tile are never
        compared.  Without any visible count there is no delta: the verify
        cycle keeps polling, fail-closed as before.
        """
        if not any(node.get("resource-id") == self._PROFILE_GRID for node in nodes):
            return None
        counts = self._visible_play_counts(nodes)
        if not counts:
            return None
        if counts[0].get("text") != "0":
            return None
        if baseline and baseline[0] == "0":
            return None
        return counts[0]

    @staticmethod
    def _contains_center(node: dict[str, str], center_x: int, center_y: int) -> bool:
        x1, y1, x2, y2 = SafeAdb.bounds(node)
        return x1 <= center_x <= x2 and y1 <= center_y <= y2

    def _tile_anchor(self, nodes: list[dict[str, str]], leaf: dict[str, str]) -> dict[str, str]:
        """Smallest clickable node containing the leaf center, else the leaf itself."""
        lx1, ly1, lx2, ly2 = SafeAdb.bounds(leaf)
        center_x, center_y = (lx1 + lx2) // 2, (ly1 + ly2) // 2
        leaf_area = (lx2 - lx1) * (ly2 - ly1)
        anchors: list[tuple[int, dict[str, str]]] = []
        for node in nodes:
            if node is leaf:
                continue
            try:
                x1, y1, x2, y2 = SafeAdb.bounds(node)
            except PublisherError:
                continue
            area = (x2 - x1) * (y2 - y1)
            if area <= leaf_area or node.get("clickable", "false").lower() == "false":
                continue
            if x1 <= center_x <= x2 and y1 <= center_y <= y2:
                anchors.append((area, node))
        return min(anchors, key=lambda pair: pair[0])[1] if anchors else leaf

    def _profile_grid_present(self, nodes: list[dict[str, str]]) -> bool:
        """Does this dump show the profile video grid at all?

        The grid container proves the profile has (or is rendering) tiles;
        a genuinely post-less profile has no grid and needs no count retry.
        """
        return any(node.get("resource-id") == self._PROFILE_GRID for node in nodes)

    def prepare(self, job: Any, device: Any) -> None:
        self.selected_account_username(job)
        self._launch(device); nodes = self._navigate_profile(device)
        identity = self.account_control(nodes, resource_id=self._IDENTITY, error="TikTok active profile account")
        expected = "@" + self.expected_account
        if identity.get("text") != expected and identity.get("content-desc") != expected:
            # Account switching is deliberately not automated: fail closed instead.
            raise PublisherError("ACCOUNT_MISMATCH", "TikTok active profile account does not match the publication account")
        # Baseline evidence is the ordered visible play-count row: publishing
        # prepends exactly one "0" tile to the newest-first profile grid.  A
        # grid that rendered tiles before its counters is re-dumped briefly
        # (the live build served the grid with zero tv_play_count nodes); a
        # post-less profile has no grid and an empty row is valid there.
        # Counts that never render are accepted with a warning -- the
        # identity gate then becomes the only verification signal.
        counts = [node.get("text") for node in self._visible_play_counts(nodes)]
        if not counts and self._profile_grid_present(nodes):
            for _ in range(self._BASELINE_COUNT_RETRIES):
                self._pause(self._BASELINE_COUNT_RETRY_PAUSE)
                nodes = self._nodes(device)
                counts = [node.get("text") for node in self._visible_play_counts(nodes)]
                if counts:
                    break
            else:
                logger.warning("play-count baseline empty; identity gate is the only verification signal")
        self._baseline_play_counts = counts
        self._capture_baseline(nodes)

    def _upload_hot_area(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._UPLOAD_HOT_AREA), None)

    def _videos_tab(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("content-desc") == "Videos" and self._in_viewport(node)), None)

    def _video_grid(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._THUMBNAIL and self._in_viewport(node)), None)

    def _enter_videos_grid(self, device: Any, videos: dict[str, str]) -> None:
        """Reach the picker video grid, skipping a no-op chip tap when the
        picker already landed on the Videos filter.

        Live build (2026-08-17): after the upload hot-area tap the picker can
        arrive already filtered -- the Videos chip reports selected="true" /
        clickable="false" and the thumbnail grid is already rendered.  A tap
        on that chip is a no-op, so _wait_for_fresh can never observe a fresh
        grid and the flow burned a deterministic 15s VIDEOS_MEDIA timeout.
        When the current dump already shows the grid or a selected chip, the
        transition is skipped and selection proceeds on the live screen.
        Only a clickable, unselected chip receives the guarded tap
        (fail-closed intact: the grid must still appear fresh afterwards);
        any other grid-less state fails closed with VIDEOS_MEDIA.
        """
        nodes = self._last_nodes
        if self._video_grid(nodes) is not None:
            return
        current = self._videos_tab(nodes)
        if current is not None and current.get("selected", "false").lower() == "true":
            return
        if current is not None and current.get("clickable", "false").lower() != "false":
            self.tap_and_wait(device, videos, error="VIDEOS_MEDIA", predicate=self._video_grid)
            return
        raise PublisherError("VIDEOS_MEDIA", "TikTok picker Videos chip is not actionable and the video grid is absent", retryable=True)

    def _video_candidates(self, nodes: list[dict[str, str]], duration: int) -> list[dict[str, str]]:
        """Duration labels with exactly one geometrically-associated thumbnail, in document order."""
        expected = self._duration_formats(duration)
        tiles = [node for node in nodes if node.get("resource-id") == self._THUMBNAIL]
        candidates: list[dict[str, str]] = []
        for label in nodes:
            if label.get("resource-id") != self._DURATION_LABEL or label.get("text") not in expected:
                continue
            lx1, ly1, lx2, ly2 = SafeAdb.bounds(label)
            related = [tile for tile in tiles if self._contains_center(tile, (lx1 + lx2) // 2, (ly1 + ly2) // 2)]
            if len(related) == 1:
                candidates.append(label)  # the tap on the label propagates to its tile
        return candidates

    def _selection_signal(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._PICKER_NEXT and node.get("text") == "Next" and enabled(node)), None)

    def _select_media(self, device: Any, duration: int) -> dict[str, str]:
        candidates = self._video_candidates(self._last_nodes, duration)
        if not candidates:
            raise PublisherError("MEDIA_NOT_FOUND", "TikTok picker has no selectable video with the expected duration", retryable=True)
        for candidate in candidates:
            # The picker arrival dump can carry stale out-of-viewport bounds
            # (same a11y failure mode as the Instagram live4 gallery tile).
            # Tap geometry comes exclusively from a fresh re-dump; a candidate
            # that disappears or keeps off-viewport bounds is discarded and
            # the next one is tried -- never a blind or out-of-viewport tap.
            target = self._fresh_tap_target(device, candidate)
            if target is None:
                continue
            self._tap(device, target)
            try:
                signal = self.wait_for(device, error="MEDIA_SELECTION", predicate=self._selection_signal)
            except PublisherError as error:
                if error.code != "UI_TIMEOUT": raise
                # Dead tap: the picker is unchanged, so the next same-duration
                # candidate (document order) is safe to try.
                continue
            return self.tap_and_wait(device, signal, error="EDITOR_NEXT", resource_id=self._EDITOR_NEXT, text="Next")
        raise PublisherError("MEDIA_UNSELECTABLE", "No TikTok picker candidate accepted the selection tap", retryable=True)

    def _caption_field(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._CAPTION_FIELD), None)

    def _focused_caption(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._CAPTION_FIELD and node.get("focused") == "true"), None)

    def _caption_echo(self, nodes: list[dict[str, str]], caption: str) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._CAPTION_FIELD and caption in f"{node.get('text', '')} {node.get('content-desc', '')}"), None)

    def _write_caption(self, device: Any, field: dict[str, str], caption: str) -> None:
        self.tap_and_wait(device, field, error="CAPTION_ACTIVE", predicate=self._focused_caption)
        device.text(caption)  # single pass; the field reports text or content-desc
        try:
            self.wait_for(device, error="CAPTION_DIVERGED", predicate=lambda screen: self._caption_echo(screen, caption))
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
            raise PublisherError("CAPTION_DIVERGED", "Caption text diverged before publishing") from None

    def _posted_toast(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._POSTED_TOAST and (node.get("text") or "").startswith("Video posted!")), None)

    def _posting_overlay(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._UPLOAD_STATUS and (node.get("text") or "").startswith("Posting")), None)

    def _upload_percent(self, nodes: list[dict[str, str]]) -> str | None:
        return next((node.get("text") for node in nodes if node.get("resource-id") == self._UPLOAD_PERCENT and re.fullmatch(r"\d{1,3}%", node.get("text") or "")), None)

    def _post_button_on_screen(self, nodes: list[dict[str, str]]) -> bool:
        return any(node.get("resource-id") == self._POST_BUTTON for node in nodes)

    def _wait_post_confirmation(self, device: Any, *, clock: Callable[[], float] = time.monotonic) -> dict[str, str]:
        """Wait up to _POST_UPLOAD_TIMEOUT for proof that the Post went out.

        Live 2026-08-17: a ~48MB upload lasts far longer than the generic
        15s wait -- after the Post tap TikTok shows the upload overlay
        (su6 "Posting..." + su5 "N%") and the "Video posted!" toast only
        arrives once the upload finishes.  Every iteration reads a FRESH
        dump and accepts, in this evaluation order:

          1. the "Video posted!" toast (the original signal), or
          2. upload completion: the "Posting..." overlay is gone AND the
             post screen is no longer on screen (the Post button st6 is
             absent from the dump).

        The upload progress is logged whenever the overlay percent changes
        ("Posting... N%") for run evidence.  The wait NEVER dispatches a
        tap: the Post tap remains the single irreversible action and is
        never re-attempted.  A deadline expiry raises the same UI_TIMEOUT
        as before, which publish maps to POST_UNCONFIRMED (the
        eternal-upload / lost-network case).
        """
        deadline = clock() + self._POST_UPLOAD_TIMEOUT
        last_percent: str | None = None
        reported = False
        while True:
            nodes = self._nodes(device)
            toast = self._posted_toast(nodes)
            if toast is not None:
                return toast
            overlay = self._posting_overlay(nodes)
            percent = self._upload_percent(nodes)
            if overlay is not None and (not reported or percent != last_percent):
                reported = True
                last_percent = percent
                label = " ".join(part for part in (overlay.get("text") or "Posting...", percent) if part)
                logger.info("TikTok upload progress: %s", label)
            if overlay is None and not self._post_button_on_screen(nodes):
                logger.info("TikTok upload finished: posting overlay gone and the post screen is closed")
                return nodes[0] if nodes else {}
            if clock() >= deadline:
                raise PublisherError("UI_TIMEOUT", "Timed out waiting for POST_CONFIRMATION", retryable=True)
            self._pause(self.poll)

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        self._require_prepared(); validate_caption(job.caption)
        duration = job.media.get("duration_seconds") if isinstance(job.media, dict) else None
        if type(duration) is not int or duration <= 0:
            raise PublisherError("MEDIA_METADATA_INVALID", "TikTok requires verified video duration metadata")
        nodes = self._nodes(device)
        if any(node.get("resource-id") == self._CAPTION_FIELD for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "TikTok was already in a publish flow; refusing to resume")
        create = self._one(nodes, error="CREATE_CONTROL", resource_id=self._TAB_CREATE, required=False) or self._one(nodes, error="CREATE_CONTROL", content_desc="Create", required=False)
        if create is None: raise PublisherError("CREATE_CONTROL", "TikTok Create tab is absent from the profile screen")
        hot_area = self.tap_and_wait(device, create, error="UPLOAD_HOT_AREA", predicate=self._upload_hot_area)
        videos = self.tap_and_wait(device, hot_area, error="VIDEOS_FILTER", predicate=self._videos_tab)
        self._enter_videos_grid(device, videos)
        checkpoint("selecting_media", 25, evidence={"platform": "tiktok", "stage": "picker", "duration_formats": sorted(self._duration_formats(duration))})
        editor_next = self._select_media(device, duration); checkpoint("editing", 45, evidence={"platform": "tiktok", "stage": "editor"})
        self.tap_and_wait(device, editor_next, error="CAPTION_FIELD", predicate=self._caption_field)
        field = self._one(self._last_nodes, error="CAPTION_FIELD", resource_id=self._CAPTION_FIELD)
        self._write_caption(device, field, job.caption); checkpoint("captioning", 65, evidence={"platform": "tiktok", "caption_words": len(job.caption.split())})
        # The IME covers Post after typing: back closes only the keyboard.
        self._back(device)
        self.wait_for(device, error="POST_BUTTON", resource_id=self._POST_BUTTON, text="Post"); checkpoint("ready_to_publish", 80, evidence={"platform": "tiktok", "stage": "post"})
        # _final matches button and context against the raw dump attribute
        # names ("resource-id"/"text"), like the other adapters.
        self._final(device, checkpoint, button={"resource-id": self._POST_BUTTON, "text": "Post"}, context={"resource-id": self._CAPTION_FIELD}, evidence={"platform": "tiktok", "final": "post"})
        try:
            self._wait_post_confirmation(device)
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
            # Never re-tap Post: the one irreversible tap may already count.
            raise PublisherError("POST_UNCONFIRMED", "TikTok did not confirm the posted video", retryable=True, final_action_uncertain=True) from None

    def _opened_caption(self, nodes: list[dict[str, str]], caption: str) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._OPENED_CAPTION and caption in f"{node.get('text', '')} {node.get('content-desc', '')}"), None)

    def _home_tab(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        # Package-scoped: the SystemUI 3-button navbar exposes a content-desc
        # "Home" button that used to collide with the app's Home tab (o74)
        # and abort the verify tab cycle with SELECTOR_COLLISION.  Nodes of
        # any other package are excluded from the match entirely.
        return (self._one(nodes, error="TAB_BAR", content_desc="Home", package=self._PACKAGE, required=False)
                or self._one(nodes, error="TAB_BAR", text="Home", package=self._PACKAGE, required=False))

    def _tap_tab(self, device: Any, *, label: str) -> None:
        """One guarded semantic bottom-bar tap from a fresh dump.

        The tab must be unique, enabled and carry valid bounds; the settle
        lives in _cycle_tab (3s in the verify cycle, 1s in the pre-identity
        recomposition) because the cycle's last tab tap leads straight into
        the pull-to-refresh.  Absence or ambiguity fails closed.
        """
        nodes = self._nodes(device)
        tab = self._profile_tab(nodes) if label == "Profile" else self._home_tab(nodes)
        if tab is None:
            raise PublisherError("TAB_BAR", f"TikTok bottom bar {label} tab is absent", retryable=True)
        self._tap(device, self._clickable_target(tab, nodes) or tab)

    def _cycle_tab(self, device: Any, *, label: str, wait: float) -> None:
        """One guarded tab tap plus the `wait` settle.

        Arrival is not polled here: the composite delta check after the
        refresh is the arbiter, and a tap that did not navigate simply shows
        no delta (fail-closed -- never a false completion, only a retry).
        """
        self._tap_tab(device, label=label)
        self._pause(wait)

    def _tab_cycle_resync(self, device: Any, tab_wait: float) -> None:
        """One full re-sync: Profile -> Home -> Profile -> Bezier refresh.

        The tab cycle recomposes the profile grid on this TikTok build:
        pull-to-refresh alone keeps serving the pre-publication tiles, so the
        cycle is the mechanism that forces the new tile to materialize.  The
        verify cycle uses 3s settles; the pre-identity recomposition uses the
        shorter 1s settles because it only needs the grid rebuilt, not
        propagation time.  Every tap is guarded; the swipe coordinates are
        screen-fixed and NEVER derived from tree bounds.
        """
        self._cycle_tab(device, label="Profile", wait=tab_wait)
        self._cycle_tab(device, label="Home", wait=tab_wait)
        self._tap_tab(device, label="Profile")
        self._refresh_profile(device)

    def _refresh_profile(self, device: Any) -> None:
        """One reversible pull-to-refresh at fixed screen-relative coordinates.

        The gesture is constant by design: Bezier on devices whose `input`
        supports motionevent, straight swipe otherwise.  Nothing is tapped.
        """
        x1, y1, x2, y2, duration = self._REFRESH_SWIPE
        if hasattr(device, "swipe_bezier"):
            device.swipe_bezier(x1, y1, x2, y2, duration)
        elif hasattr(device, "swipe"):
            device.swipe(x1, y1, x2, y2, duration)
        else:
            raise PublisherError("ADB_SWIPE_UNAVAILABLE", "TikTok verify re-sync requires a swipe gesture", retryable=True)

    def _confirm_identity(self, job: Any, device: Any) -> str | None:
        """Open the newest grid tile and require the published caption.

        Up to VERIFY_IDENTITY_ATTEMPTS fresh-dump attempts, because the
        profile grid serves stale bounds: each attempt re-dumps, re-locates
        the tile anchor with bounds from that fresh dump (never the delta
        dump's geometry), taps it and requires the caption in rid "desc".  A
        wrong or caption-less viewer is closed and retried.  An identity that
        predates this publication (present in the baseline snapshot) is
        treated as no-delta: the check reports None so the verify cycle keeps
        polling -- never an error, never a false completion.  Real
        device/dump failures still propagate: only the absence of positive
        evidence folds into the unverified outcome.
        """
        baseline = list(getattr(self, "_baseline_play_counts", []))
        for _ in range(self.VERIFY_IDENTITY_ATTEMPTS):
            nodes = self._nodes(device)
            tile = self._profile_delta(nodes, baseline)
            if tile is None:
                return None
            target = self._fresh_tap_target(device, self._tile_anchor(nodes, tile))
            if target is None:
                # The anchor never re-localized with in-viewport bounds: no
                # tap was dispatched, so retry from a fresh dump.
                continue
            self._tap(device, target)
            try:
                opened = self.wait_for(device, error="REEL_MISMATCH", predicate=lambda screen: self._opened_caption(screen, job.caption))
            except PublisherError as error:
                if error.code != "UI_TIMEOUT":
                    raise
                # Either stale bounds opened an older post or the caption never
                # rendered: close the viewer and retry once from a fresh dump.
                self._back(device)
                continue
            identity = opened.get("text") or opened.get("content-desc") or job.caption
            if identity in self._baseline:
                return None
            return identity
        return None

    def _verify_check(self, job: Any, device: Any) -> str | None:
        """One composite check: delta first, grid recomposition, identity on top.

        Delta: the grid's FIRST visible play count is "0" (the new post,
        prepended) and the baseline row did not lead with "0" -- the exact
        ["0"] + baseline row never materializes on screen (live 2026-08-17):
        the last baseline tile falls behind the bottom bar, old counts drift
        and a draft tile can occupy the first grid slot.  On delta the grid
        is recomposed with a full tab cycle before any identity tap -- a
        swipe-only refresh keeps the old tiles on this build (same lesson as
        the Instagram live3 run), so tapping the anchor right away could open
        the pre-publication tile.  Only after the recomposition is the tile
        opened and required to carry the published caption.  Returns the
        confirmed identity string, or None when this check did not verify.
        """
        nodes = self._nodes(device)
        baseline = list(getattr(self, "_baseline_play_counts", []))
        if self._profile_delta(nodes, baseline) is None:
            return None
        self._tab_cycle_resync(device, self._IDENTITY_RESYNC_TAB_WAIT)
        return self._confirm_identity(job, device)

    def _verification_pending_evidence(self) -> dict[str, Any]:
        """Serializable snapshot of the last verification state for the job.

        The publication is real but unproven: the last observed dump travels
        with the job so a human can confirm it without re-publishing.
        """
        nodes = self._last_nodes or []
        return {
            "platform": "tiktok",
            "stage": "verification_pending",
            "play_counts": [node.get("text") for node in self._visible_play_counts(nodes)],
            "last_dump": nodes,
        }

    def verify(self, job: Any, device: Any) -> str | PublicationStatus:
        """Agile post-Post verification on the user-defined exact timing.

        1. Fixed 20s propagation wait right after the "Video posted!" toast.
        2. One re-sync cycle (Profile -> 3s -> Home -> 3s -> Profile ->
           fixed-coordinate Bezier pull-to-refresh) then a composite delta +
           identity check: the grid's first visible play count must be the
           "0" of the prepended new tile and the baseline must not have led
           with "0" (prepend delta, never exact row equality).
        3. If the tile is not there yet: 20s, swipe + check again.
        4. If still not there: 10s more, swipe + check (third and last check).
        5. Any check that detects delta first recomposes the grid with a full
           tab cycle (Profile -> 1s -> Home -> 1s -> Profile -> refresh):
           swipe-only refresh keeps the old tiles on this build (live3
           lesson).  Only then is the newest tile anchor opened from a fresh
           dump and required to carry the complete caption; a confirmed
           identity completes immediately.  After the third check the result
           is the worker-local `unverified` state
           (models.PublicationStatus.UNVERIFIED): a terminal outcome that is
           never a failure and never republished, carrying the last dump as
           evidence and a clear "verification pending" log.  A real negative
           signal from TikTok (a dialog or error the adapter already detects)
           still raises and fails the job -- nothing is swallowed here beyond
           the absence of positive evidence.
        """
        self._pause(self._VERIFY_INITIAL_WAIT)
        self._tab_cycle_resync(device, self._VERIFY_TAB_WAIT)
        identity = self._verify_check(job, device)
        for wait in self._VERIFY_RETRY_WAITS:
            if identity is not None:
                return identity
            self._pause(wait)
            self._refresh_profile(device)
            identity = self._verify_check(job, device)
        if identity is not None:
            return identity
        self.verification_evidence = self._verification_pending_evidence()
        logger.warning(
            "verification pending: TikTok post was published but could not "
            "be verified after %d checks; finishing the job as unverified with "
            "the last dump attached (never republished automatically)",
            self._VERIFY_MAX_CHECKS,
        )
        return PublicationStatus.UNVERIFIED

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def _cleanup_preflight(self, expected_identity: str, baseline: list[str], device: Any) -> list[dict[str, str]]:
        if not isinstance(baseline, list) or not baseline or not all(isinstance(item, str) and item.strip() for item in baseline):
            raise PublisherError("CLEANUP_BASELINE_INVALID", "TikTok cleanup baseline must be the exact ordered pre-publication play-count row")
        if not isinstance(expected_identity, str) or not expected_identity.strip() or expected_identity in baseline:
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Cleanup identity must be a new verified item")
        nodes = self._return_to_profile(device)
        identity = self.account_control(nodes, resource_id=self._IDENTITY, error="TikTok active profile account")
        expected_handle = "@" + self.expected_account
        if identity.get("text") != expected_handle and identity.get("content-desc") != expected_handle:
            raise PublisherError("ACCOUNT_MISMATCH", "TikTok active profile account does not match the cleanup account")
        if [node.get("text") for node in self._visible_play_counts(nodes)] != ["0"] + list(baseline):
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "TikTok profile does not show exactly one zero-play tile above the baseline")
        return nodes

    def _share_button(self, nodes: list[dict[str, str]]) -> dict[str, str]:
        # The feed preload keeps an off-screen duplicate: only on-screen
        # bounds count, and exactly one of them must exist.
        matches = [node for node in nodes if node.get("resource-id") == self._SHARE_SHEET and node.get("content-desc") == "Share video" and self._in_viewport(node)]
        if not matches:
            raise PublisherError("SHARE_CONTROL", "TikTok share control is absent on screen", retryable=True)
        if len(matches) > 1:
            raise PublisherError("SELECTOR_COLLISION", "Ambiguous SHARE_CONTROL selector")
        SafeAdb.bounds(matches[0])
        return matches[0]

    def _visible_delete(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._SHEET_DELETE and node.get("content-desc") == "Delete" and self._in_viewport(node)), None)

    def _open_delete(self, device: Any) -> dict[str, str]:
        try:
            return self.wait_for(device, error="DELETE_ACTION", predicate=self._visible_delete)
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
        if not hasattr(device, "swipe"):
            raise PublisherError("ADB_SWIPE_UNAVAILABLE", "TikTok cleanup sheet scroll requires swipe")
        # The action row is horizontally scrolleable: swipe it to reveal Delete.
        device.swipe(600, self._SHEET_ROW_Y, 100, self._SHEET_ROW_Y, 300)
        return self.wait_for(device, error="DELETE_ACTION", predicate=self._visible_delete)

    def cleanup_test_post(self, expected_identity: str, baseline: list[str], device: Any) -> None:
        nodes = self._cleanup_preflight(expected_identity, baseline, device)
        counts = self._visible_play_counts(nodes)
        self._tap(device, self._tile_anchor(nodes, counts[0]))
        try:
            # Never continue past a post whose caption is not the authorized
            # test post: stale grid bounds may have opened the wrong video.
            self.wait_for(device, error="REEL_MISMATCH", predicate=lambda screen: self._opened_caption(screen, expected_identity))
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
            raise PublisherError("REEL_MISMATCH", "The opened TikTok post is not the authorized test post") from None
        self._tap(device, self._share_button(self._last_nodes))
        delete = self._open_delete(device)
        self.tap_and_wait(device, delete, error="DELETE_CONFIRMATION", resource_id=self._DELETE_CONFIRM, text="Delete")
        confirm = self._one(self._last_nodes, error="DELETE_PRIMARY", resource_id=self._DELETE_CONFIRM, text="Delete")
        expected_counts = list(baseline)
        # Cleanup restores the EXACT pre-publication row (no prepend
        # ambiguity here): _profile_delta's prepend signal cannot detect a
        # restored baseline, so the reload predicate compares the full row
        # and returns the first visible count node once it matches.
        def baseline_restored(screen: list[dict[str, str]]) -> dict[str, str] | None:
            counts = self._visible_play_counts(screen)
            if [node.get("text") for node in counts] != expected_counts:
                return None
            return counts[0]
        self.tap_and_wait(device, confirm, error="BASELINE_RELOAD", predicate=baseline_restored)
        if [node.get("text") for node in self._visible_play_counts(self._last_nodes)] != expected_counts:
            raise PublisherError("BASELINE_NOT_RESTORED", "TikTok cleanup did not restore the exact baseline play-count row")
