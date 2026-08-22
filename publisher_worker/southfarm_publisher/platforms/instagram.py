from __future__ import annotations

import logging
import re
from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..adb_device import SafeAdb
from ..models import PublisherError

logger = logging.getLogger(__name__)


class InstagramPublisher(GuardedPublisher):
    """Reel publishing against the selectors verified live on the device.

    Verified flow: Profile tab -> Create New -> "Create new reel" -> gallery
    (thumbnail + duration label) -> editor Next -> caption field -> Share.
    Verification and cleanup run through the profile post-count delta and the
    "Reel by <display> at row 1, column 1" grid tile.
    """

    # Target application package: bottom-bar tab selectors are scoped to it so
    # SystemUI chrome (3-button navigation exposes a content-desc "Home"
    # navbar button) and launcher nodes are invisible to the tab matchers
    # instead of colliding with the app's own tabs.
    _PACKAGE = "com.instagram.android"
    package = _PACKAGE

    _TITLE = "com.instagram.android:id/action_bar_title"
    _USERNAME_HEADER = "com.instagram.android:id/action_bar_username_container"
    _GALLERY_TITLE = "com.instagram.android:id/gallery_title_text"
    _THUMBNAIL = "com.instagram.android:id/gallery_grid_item_thumbnail"
    _LABEL = "com.instagram.android:id/gallery_grid_item_label"
    _GALLERY_NEXT = "com.instagram.android:id/next_button_textview"
    _EDITOR_NEXT = "com.instagram.android:id/clips_right_action_button"
    _CAPTION_FIELD = "com.instagram.android:id/caption_input_text_view"
    _SHARE = "com.instagram.android:id/share_button"
    _POST_COUNT = "com.instagram.android:id/profile_header_post_count_front_familiar"
    _MEDIA_OPTIONS = "com.instagram.android:id/media_option_button"
    _OPTION_TEXT = "com.instagram.android:id/control_option_text"
    _DIALOG_HEADLINE = "com.instagram.android:id/igds_alert_dialog_headline"
    _DIALOG_PRIMARY = "com.instagram.android:id/igds_alert_dialog_primary_button"

    _POSTS = re.compile(r"(\d+)posts")
    _NEWEST_REEL_TILE = re.compile(r"Reel by .+ at row 1, column 1")
    _GRID_TILE = re.compile(r"Reel by .+ at row \d+, column \d+")
    # Agile post-Share verification timing (user-defined exact sequence,
    # calibrated on the live build where the reel only appeared ~54s after
    # the Share tap -- the old 15/8/8 window was too short, live3):
    _VERIFY_INITIAL_WAIT = 20.0    # fixed propagation wait after the Share tap
    _VERIFY_TAB_WAIT = 3.0         # settle between re-sync tab taps in the verify cycle
    _VERIFY_RETRY_WAITS = (20.0, 10.0)  # non-uniform waits before the retry checks
    _VERIFY_MAX_CHECKS = 1 + len(_VERIFY_RETRY_WAITS)  # re-sync check + one swipe retry per wait
    _IDENTITY_RESYNC_TAB_WAIT = 1.0  # shorter settle for the pre-identity grid recomposition cycle
    # Pull-to-refresh at fixed screen-relative coordinates (720x1640 target).
    # Tree bounds must NEVER drive this gesture: stale a11y geometry served
    # out-of-viewport spans (e.g. [-2160,415]) and produced phantom swipes.
    _REFRESH_SWIPE = (360, 350, 360, 1000, 400)
    # Semantic bottom-bar tabs from the live dump (tab_bar container).
    _PROFILE_TAB = "com.instagram.android:id/profile_tab"
    _HOME_TAB = "com.instagram.android:id/feed_tab"
    # The profile grid serves stale bounds, so the identity phase re-dumps the
    # grid for every attempt; two fresh-dump attempts bound the total tile taps.
    VERIFY_IDENTITY_ATTEMPTS = 2
    # The confirmation headline is surface-dependent ("Delete Post?" on the
    # grid, "Delete reel?" on reels); only these exact variants are accepted.
    _DELETE_HEADLINES = frozenset({"Delete Post?", "Delete reel?"})

    def _nodes(self, device: Any) -> list[dict[str, str]]:
        # The on-device accessibility service repeats every control once per
        # window snapshot: identical attribute vectors (geometry included)
        # cannot be distinct on-screen controls, so collapse the copies to keep
        # the guarded single-control selectors meaningful on real dumps.
        nodes = super()._nodes(device)
        seen: set[tuple[tuple[str, str], ...]] = set()
        unique: list[dict[str, str]] = []
        for node in nodes:
            signature = tuple(sorted(node.items()))
            if signature in seen:
                continue
            seen.add(signature); unique.append(node)
        self._last_nodes = unique
        return unique

    @staticmethod
    def _is_video_tile(node: dict[str, str]) -> bool:
        return node.get("resource-id") == InstagramPublisher._THUMBNAIL and (node.get("content-desc") or "").startswith(("Unselected Video thumbnail", "Selected Video thumbnail"))

    @staticmethod
    def _gallery_arrival(nodes: list[dict[str, str]]) -> dict[str, str] | None:
        # "New reel" is a static TextView: the guarded clickability gate would
        # reject a perfectly rendered gallery with CONTROL_DISABLED.  Prove the
        # arrival by gallery content instead and return the tile the next step
        # acts on; the static title is only the fallback arrival signal.
        tile = next((node for node in nodes if InstagramPublisher._is_video_tile(node)), None)
        if tile is not None: return tile
        return next((node for node in nodes if node.get("resource-id") == InstagramPublisher._GALLERY_TITLE and node.get("text") == "New reel"), None)

    @staticmethod
    def _duration_formats(duration: int) -> set[str]:
        minutes, seconds = divmod(duration, 60)
        return {f"{minutes}:{seconds:02d}"}

    @staticmethod
    def _strictly_overlaps(first: dict[str, str], second: dict[str, str]) -> bool:
        # Real gallery geometry nests each duration label strictly inside its own
        # thumbnail (label bounds are a subset of the tile bounds).  A label that
        # merely touches a neighbouring tile edge belongs to that neighbour, so
        # edge-touching must not associate: it would give every bottom-row tile
        # two labels and reject the whole row.
        ax1, ay1, ax2, ay2 = SafeAdb.bounds(first); bx1, by1, bx2, by2 = SafeAdb.bounds(second)
        return ax1 < bx2 and bx1 < ax2 and ay1 < by2 and by1 < ay2

    def _instagram_video_tiles(self, nodes: list[dict[str, str]], duration: int) -> list[dict[str, str]]:
        """Return only thumbnails with one geometrically-associated real duration label."""
        expected = self._duration_formats(duration)
        labels = [node for node in nodes if node.get("resource-id") == self._LABEL]
        matched: list[dict[str, str]] = []
        for thumbnail in (node for node in nodes if self._is_video_tile(node)):
            related = [label for label in labels if self._strictly_overlaps(thumbnail, label)]
            if len(related) == 1 and related[0].get("text") in expected:
                matched.append(thumbnail)
        return matched

    def _title_node(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return self.optional_account_control(nodes, resource_id=self._TITLE, error="Instagram active profile account")

    def _on_our_profile(self, nodes: list[dict[str, str]]) -> bool:
        title = self._title_node(nodes)
        return title is not None and (title.get("text") == self.expected_account or title.get("content-desc") == self.expected_account)

    def _title_or_create(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return self._title_node(nodes) or self._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)

    def _profile_tab(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        # Package-scoped: foreign-package nodes (SystemUI navbar, launcher
        # icons) are invisible to the semantic Profile match.
        return (self._one(nodes, error="PROFILE_TAB", content_desc="Profile", package=self._PACKAGE, required=False)
                or self._one(nodes, error="PROFILE_TAB", text="Profile", package=self._PACKAGE, required=False))

    def _navigate_profile(self, device: Any) -> list[dict[str, str]]:
        nodes = self._nodes(device)
        if self._title_node(nodes) is not None:
            return nodes
        # Cold start serves partial splash dumps for a few polls before the tab
        # bar renders: wait for the Profile tab within the instance timeout
        # instead of rejecting the very first dump.  Fail-closed is unchanged --
        # a tab that never renders still aborts with PROFILE_TAB, and the tap
        # below still passes the guarded clickability gate (STALE_CONTROL).
        tab = self._profile_tab(nodes)
        if tab is None:
            try:
                tab = self.wait_for(device, error="PROFILE_TAB", predicate=self._profile_tab)
            except PublisherError as error:
                if error.code != "UI_TIMEOUT": raise
                raise PublisherError("PROFILE_TAB", "Instagram Profile tab is required before account verification") from None
        self.tap_and_wait(device, tab, error="PROFILE_ACCOUNT", predicate=self._title_or_create)
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
            self.tap_and_wait(device, tab, error="PROFILE_ACCOUNT", predicate=self._title_or_create)
            if self._on_our_profile(self._last_nodes):
                return self._last_nodes
        raise PublisherError("PROFILE_ACCOUNT", "Instagram own profile could not be reached", retryable=True)

    def _account_row(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        """The switcher row for the expected account (exact username; "Add
        Instagram account" and other rows must never match)."""
        return next((node for node in nodes if (node.get("text", "").strip() == self.expected_account or node.get("content-desc", "").strip() == self.expected_account)), None)

    def _switch_to_expected_account(self, device: Any, nodes: list[dict[str, str]]) -> list[dict[str, str]]:
        """Switch the active Instagram account to the publication account via
        the profile account switcher — the same flow the app's warmup uses
        (ensureCorrectAccount): tap the profile username header, pick the
        expected account in the switcher, then verify by re-reading the header.
        One full retry covers a slow switcher render. Fail-closed is kept: if
        the header or the target account never appear, the run aborts with
        ACCOUNT_MISMATCH instead of posting into the wrong account."""
        for _ in range(2):
            header = next((node for node in nodes if node.get("resource-id") == self._USERNAME_HEADER), None)
            if header is None:
                break
            self._tap(device, header)
            try:
                row = self.wait_for(device, error="ACCOUNT_SWITCHER", predicate=self._account_row)
            except PublisherError as error:
                if error.code != "UI_TIMEOUT":
                    raise
                break
            self._tap(device, row)
            try:
                if self.wait_for(device, error="ACCOUNT_SWITCH", predicate=self._on_our_profile) is not None:
                    return self._last_nodes if self._on_our_profile(self._last_nodes) else self._nodes(device)
            except PublisherError as error:
                if error.code != "UI_TIMEOUT":
                    raise
            # Back to our own profile surface before retrying the switcher.
            try:
                nodes = self._return_to_profile(device)
            except PublisherError as profile_error:
                if profile_error.code not in ("PROFILE_ACCOUNT", "UI_TIMEOUT"):
                    raise
                break
        raise PublisherError("ACCOUNT_MISMATCH", "Instagram active account could not be switched to the publication account")

    def _prepare_active_account(self, device: Any, nodes: list[dict[str, str]]) -> list[dict[str, str]]:
        """Guarantee the active profile matches the publication account,
        switching accounts when needed (owner decision 2026-08-21)."""
        if self._on_our_profile(nodes):
            return nodes
        return self._switch_to_expected_account(device, nodes)

    def _post_counts(self, nodes: list[dict[str, str]]) -> set[int]:
        values: set[int] = set()
        for node in nodes:
            if node.get("resource-id") != self._POST_COUNT:
                continue
            match = self._POSTS.fullmatch((node.get("content-desc") or "").strip())
            if match:
                values.add(int(match.group(1)))
        return values

    def _count_matches(self, nodes: list[dict[str, str]], expected: int) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._POST_COUNT and (node.get("content-desc") or "").strip() == f"{expected}posts"), None)

    def _baseline_ready(self, nodes: list[dict[str, str]]) -> list[dict[str, str]] | None:
        """The profile is baseline-ready when exactly one post count AND at
        least one reel tile have rendered. Both load asynchronously after the
        account switch / profile landing: a single early dump races the grid
        (the 2026-08-21 TILE_BASELINE_INVALID false failure), so poll."""
        counts = self._post_counts(nodes)
        if len(counts) != 1:
            return None
        if not self._tile_signatures(nodes):
            return None
        return nodes

    def prepare(self, job: Any, device: Any) -> None:
        self.selected_account_username(job)
        self._launch(device); nodes = self._navigate_profile(device)
        # Owner decision 2026-08-21: switch accounts like the app's warmup
        # (ensureCorrectAccount) instead of failing closed when another
        # account is active on the phone.
        nodes = self._prepare_active_account(device, nodes)
        title = self.account_control(nodes, resource_id=self._TITLE, error="Instagram active profile account")
        if title.get("text") != self.expected_account and title.get("content-desc") != self.expected_account:
            raise PublisherError("ACCOUNT_MISMATCH", "Instagram active profile account does not match the publication account")
        try:
            # wait_for returns the nodes only once _baseline_ready accepted
            # them (exactly one post count AND at least one reel tile).
            nodes = self.wait_for(device, error="PROFILE_BASELINE", predicate=self._baseline_ready)
        except PublisherError as error:
            if error.code != "UI_TIMEOUT":
                raise
            # Fail-closed after the full polling window, with a precise code.
            late_nodes = self._nodes(device)
            counts = self._post_counts(late_nodes)
            if not counts or len(counts) != 1:
                raise PublisherError("POST_COUNT_INVALID", "Instagram profile post count never rendered") from None
            raise PublisherError("TILE_BASELINE_INVALID", "Instagram profile grid exposes no Reel tiles to baseline against") from None
        counts = self._post_counts(nodes)
        # Baseline evidence is the post count plus the visible grid tile
        # signatures, captured BEFORE publishing: the delta phase proves the
        # new reel by a tile description that did not exist in this baseline
        # (the count reaching baseline+1 remains a complementary signal).
        self._baseline_posts = counts.pop()
        tiles = self._tile_signatures(nodes)
        self._baseline_tiles = tiles
        self._capture_baseline(nodes)

    def _selection_signal(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        selected = next((node for node in nodes if node.get("resource-id") == self._THUMBNAIL and (node.get("content-desc") or "").startswith("Selected Video thumbnail")), None)
        if selected is not None:
            return selected
        return next((node for node in nodes if node.get("resource-id") == self._EDITOR_NEXT), None)

    def _select_video(self, device: Any, duration: int) -> dict[str, str]:
        candidates = self._instagram_video_tiles(self._last_nodes, duration)
        if not candidates:
            raise PublisherError("MEDIA_NOT_FOUND", "Instagram gallery has no selectable video with the expected duration", retryable=True)
        for candidate in candidates:
            # The gallery arrival dump can carry STALE out-of-viewport bounds
            # (live4: the tile arrived with centre y~2250 on a 720x1640
            # screen and self-corrected seconds later).  Tap geometry comes
            # exclusively from a fresh re-dump; a candidate that disappears
            # or keeps off-viewport bounds is discarded and the next one is
            # tried -- never a blind or out-of-viewport tap.
            target = self._fresh_tap_target(device, candidate)
            if target is None:
                continue
            self._tap(device, target)
            try:
                signal = self.wait_for(device, error="MEDIA_SELECTION", predicate=self._selection_signal)
            except PublisherError as error:
                if error.code != "UI_TIMEOUT":
                    raise
                # Blank-frame thumbnails never register the tap: the gallery is
                # unchanged, so the next same-duration candidate is safe to try.
                continue
            if signal.get("resource-id") == self._EDITOR_NEXT:
                return signal
            advance = self.wait_for(device, error="GALLERY_NEXT", resource_id=self._GALLERY_NEXT, text="Next")
            return self.tap_and_wait(device, advance, error="EDITOR_NEXT", resource_id=self._EDITOR_NEXT, content_desc="Next")
        raise PublisherError("MEDIA_UNSELECTABLE", "No Instagram gallery candidate accepted the selection tap", retryable=True)

    @staticmethod
    def _caption_field(nodes: list[dict[str, str]]) -> dict[str, str] | None:
        # "Write a caption" is the static hint of the caption input: require the
        # exact field identity without the clickability gate that a static hint
        # breaks; typing safety stays with the caption echo check below.
        return next((node for node in nodes if node.get("resource-id") == InstagramPublisher._CAPTION_FIELD and node.get("content-desc") == "Write a caption"), None)

    def _caption_echo(self, nodes: list[dict[str, str]], caption: str) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._CAPTION_FIELD and caption in f"{node.get('text', '')} {node.get('content-desc', '')}"), None)

    def _write_caption(self, device: Any, field: dict[str, str], caption: str) -> None:
        self._tap(device, field)
        # Re-locate the field on the focus screen before typing: typing into any
        # other control would silently publish a caption-less reel.
        self.wait_for(device, error="CAPTION_FIELD", predicate=self._caption_field)
        device.text(caption)  # single pass; the field reports text or content-desc
        try:
            self.wait_for(device, error="CAPTION_DIVERGED", predicate=lambda screen: self._caption_echo(screen, caption))
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
            raise PublisherError("CAPTION_DIVERGED", "Caption text diverged before publishing") from None

    def _goto_caption_field(self, device: Any, editor: dict[str, str]) -> dict[str, str]:
        """Tap the editor's Next and land on the caption screen. Some builds
        and states (leftover draft promo) redirect Next into Google Play's
        'Edits' sheet instead: dismiss it and retry once; a second redirect is
        terminal EDITS_HANDOFF (clearly diagnosable, vs UI_TIMEOUT)."""
        self._tap(device, editor)
        try:
            return self.wait_for(device, error="CAPTION_FIELD", predicate=self._caption_field)
        except PublisherError as error:
            if error.code != "UI_TIMEOUT":
                raise
        nodes = self._nodes(device)
        edits_redirect = any(node.get("package") == "com.android.vending" or "Edits" in (node.get("text") or "") for node in nodes)
        if not edits_redirect:
            raise PublisherError("CAPTION_FIELD", "Caption field did not appear after the editor Next tap")
        self._back(device)
        self._tap(device, editor)
        try:
            return self.wait_for(device, error="CAPTION_FIELD", predicate=self._caption_field)
        except PublisherError as error:
            if error.code != "UI_TIMEOUT":
                raise
            raise PublisherError("EDITS_HANDOFF", "Instagram kept redirecting the editor Next into the Edits app") from None

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        self._require_prepared(); validate_caption(job.caption)
        duration = job.media.get("duration_seconds") if isinstance(job.media, dict) else None
        if type(duration) is not int or duration <= 0:
            raise PublisherError("MEDIA_METADATA_INVALID", "Instagram requires verified video duration metadata")
        nodes = self._nodes(device)
        # A leftover draft surfaces a 'Keep editing your draft?' dialog on the
        # way in; discard it so publishing starts clean.
        discard = next((node for node in nodes if (node.get("text") or "") == "Discard"), None)
        if discard is not None:
            self._tap(device, discard)
            nodes = self._nodes(device)
        if any(node.get("resource-id") == self._SHARE for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "Instagram was already in a publish flow; refusing to resume")
        create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)
        if create is None: raise PublisherError("CREATE_CONTROL", "Instagram exact Create New control is absent")
        reel = self.tap_and_wait(device, create, error="REEL_SELECTOR", content_desc="Create new reel")
        self.tap_and_wait(device, reel, error="GALLERY_MEDIA", predicate=self._gallery_arrival); checkpoint("selecting_media", 25, evidence={"platform": "instagram", "stage": "gallery", "duration_label": next(iter(self._duration_formats(duration)))})
        editor = self._select_video(device, duration); checkpoint("editing", 45, evidence={"platform": "instagram", "stage": "editor"})
        field = self._goto_caption_field(device, editor)
        self._write_caption(device, field, job.caption); checkpoint("captioning", 65, evidence={"platform": "instagram", "caption_words": len(job.caption.split())})
        # The IME covers Share after typing: back closes only the keyboard.
        self._back(device)
        self.wait_for(device, error="SHARE_BUTTON", resource_id=self._SHARE, content_desc="Share"); checkpoint("ready_to_publish", 80, evidence={"platform": "instagram", "stage": "share"})
        # _final matches button and context against the raw dump attribute
        # names ("resource-id"/"content-desc"), like the other adapters.
        self._final(device, checkpoint, button={"resource-id": self._SHARE, "content-desc": "Share"}, context={"resource-id": self._CAPTION_FIELD}, evidence={"platform": "instagram", "final": "share"})

    @staticmethod
    def _normalized_text(value: str | None) -> str:
        return " ".join((value or "").split()).casefold()

    def _reel_with_caption(self, nodes: list[dict[str, str]], caption: str) -> dict[str, str] | None:
        """Match the complete caption in any node, without a resource-id gate.

        The live build never exposes clips_caption_component/clips_media_component:
        the caption renders as plain text on rid-less nodes (for example an
        IgTextLayoutView "user <caption>", sometimes duplicated).  Identity is
        proven by whitespace-normalized, casefolded containment of the complete
        caption in a node's text or content-desc.
        """
        wanted = self._normalized_text(caption)
        if not wanted:
            return None
        for node in nodes:
            if wanted in self._normalized_text(node.get("text")) or wanted in self._normalized_text(node.get("content-desc")):
                return node
        return None

    def _newest_reel_tile(self, nodes: list[dict[str, str]], *, missing_error: str) -> dict[str, str]:
        tiles = [node for node in nodes if self._NEWEST_REEL_TILE.fullmatch(node.get("content-desc") or "")]
        if len(tiles) != 1:
            raise PublisherError(missing_error if not tiles else "SELECTOR_COLLISION", "Instagram newest reel tile is absent or ambiguous", retryable=True, final_action_uncertain=True)
        return tiles[0]

    def _tile_signatures(self, nodes: list[dict[str, str]]) -> frozenset[str]:
        """Visible reel-grid signature: every tile's complete description.

        Descriptions are position-based ("Reel by <display> at row N, column
        M"), so a signature change proves the grid changed only through growth
        (a new position/description appearing) -- never through reordering.  A
        partial render (a subset of the baseline tiles) is indistinguishable
        from the pre-publication grid and keeps polling: fail-closed.
        """
        return frozenset(node.get("content-desc", "") for node in nodes if self._GRID_TILE.fullmatch(node.get("content-desc") or ""))

    def _reel_delta_detected(self, nodes: list[dict[str, str]]) -> bool:
        """The new reel is visible: count reached baseline+1 or a new tile appeared."""
        if self._count_matches(nodes, self._baseline_posts + 1) is not None:
            return True
        return bool(self._tile_signatures(nodes) - self._baseline_tiles)

    def _bottom_tab(self, nodes: list[dict[str, str]], *, resource_id: str, label: str) -> dict[str, str]:
        """Exactly one enabled bottom-bar tab; absence or ambiguity fails closed.

        Package-scoped: the SystemUI 3-button navbar exposes a content-desc
        "Home" button that must never match the app's Home tab; nodes of any
        other package are excluded from the match entirely.
        """
        selected = self._one(nodes, error="TAB_BAR", resource_id=resource_id, content_desc=label, package=self._PACKAGE, required=False)
        if selected is None:
            selected = self._one(nodes, error="TAB_BAR", resource_id=resource_id, text=label, package=self._PACKAGE, required=False)
        if selected is None:
            raise PublisherError("TAB_BAR", f"Instagram bottom bar {label} tab is absent", retryable=True)
        return selected

    def _tap_tab(self, device: Any, *, resource_id: str, label: str) -> None:
        """One guarded semantic bottom-bar tap from a fresh dump.

        The tab must be unique, enabled and carry valid bounds; the settle
        lives in _cycle_tab (3s in the verify cycle, 1s in the pre-identity
        recomposition) because the cycle's last tab tap leads straight into
        the pull-to-refresh.
        """
        selected = self._bottom_tab(self._nodes(device), resource_id=resource_id, label=label)
        self._tap(device, selected)

    def _cycle_tab(self, device: Any, *, resource_id: str, label: str, wait: float) -> None:
        """One guarded tab tap plus the `wait` settle.

        Arrival is not polled here: the composite delta check after the
        refresh is the arbiter, and a tap that did not navigate simply shows
        no delta (fail-closed -- never a false completion, only a retry).
        """
        self._tap_tab(device, resource_id=resource_id, label=label)
        self._pause(wait)

    def _tab_cycle_resync(self, device: Any, tab_wait: float) -> None:
        """One full re-sync: Profile -> Home -> Profile -> Bezier refresh.

        The tab cycle recomposes the profile grid on this Instagram build:
        pull-to-refresh alone updates the header post count but keeps serving
        the pre-publication tiles (live3), so the cycle is the mechanism that
        forces the new tile to materialize.  The verify cycle uses 3s settles;
        the pre-identity recomposition uses the shorter 1s settles because it
        only needs the grid rebuilt, not propagation time.  Every tap is
        guarded; the swipe coordinates are screen-fixed and NEVER derived
        from tree bounds.
        """
        self._cycle_tab(device, resource_id=self._PROFILE_TAB, label="Profile", wait=tab_wait)
        self._cycle_tab(device, resource_id=self._HOME_TAB, label="Home", wait=tab_wait)
        self._tap_tab(device, resource_id=self._PROFILE_TAB, label="Profile")
        self._refresh_profile(device)

    def _refresh_profile(self, device: Any) -> None:
        """One reversible pull-to-refresh at fixed screen-relative coordinates.

        The old implementation derived the gesture from tree bounds, which the
        profile grid serves stale (out-of-viewport spans like [-2160,415]) --
        the swipe went to phantom coordinates and never refreshed.  The
        gesture is constant by design: Bezier on devices whose `input`
        supports motionevent, straight swipe otherwise.  Nothing is tapped.
        """
        x1, y1, x2, y2, duration = self._REFRESH_SWIPE
        if hasattr(device, "swipe_bezier"):
            device.swipe_bezier(x1, y1, x2, y2, duration)
        elif hasattr(device, "swipe"):
            device.swipe(x1, y1, x2, y2, duration)
        else:
            raise PublisherError("ADB_SWIPE_UNAVAILABLE", "Instagram verify re-sync requires a swipe gesture", retryable=True)

    def _confirm_identity(self, job: Any, device: Any) -> str | None:
        """Open the newest reel tile and require the published caption.

        Up to VERIFY_IDENTITY_ATTEMPTS fresh-dump attempts, because the
        profile grid serves stale bounds: each attempt re-dumps, taps the
        newest reel tile with bounds from that fresh dump, and requires the
        complete caption as plain text (no resource-id gate).  A wrong or
        caption-less viewer is closed and retried.  Without a confirmed
        identity the check reports None -- never a false completion.  Real
        device/dump failures still propagate: only the absence of positive
        evidence folds into the unverified outcome.
        """
        for _ in range(self.VERIFY_IDENTITY_ATTEMPTS):
            nodes = self._nodes(device)
            try:
                tile = self._newest_reel_tile(nodes, missing_error="VERIFICATION_NO_DELTA")
            except PublisherError as error:
                if error.code not in ("VERIFICATION_NO_DELTA", "SELECTOR_COLLISION"):
                    raise
                return None
            self._tap(device, tile)
            try:
                opened = self.wait_for(device, error="REEL_MISMATCH", predicate=lambda screen: self._reel_with_caption(screen, job.caption))
            except PublisherError as error:
                if error.code != "UI_TIMEOUT":
                    raise
                # Either stale bounds opened an older reel or the caption never
                # rendered: close the viewer and retry once from a fresh dump.
                self._back(device)
                continue
            identity = opened.get("content-desc") or opened.get("text") or tile.get("content-desc") or job.caption
            if identity in self._baseline:
                return None
            return identity
        return None

    def _verify_check(self, job: Any, device: Any) -> str | None:
        """One composite check: delta first, grid recomposition, identity on top.

        Delta: a tile description absent from the pre-publication baseline or
        the post count reading exactly baseline+1.  On delta the grid is
        recomposed with a full tab cycle before any identity tap -- live3
        proved that a swipe-only refresh updates the header count but keeps
        the old tiles, so tapping row 1 column 1 right away opens the
        pre-publication reel.  Only after the recomposition is the newest
        tile opened and required to carry the published caption.  Returns the
        confirmed identity string, or None when this check did not verify.
        """
        nodes = self._nodes(device)
        if not self._reel_delta_detected(nodes):
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
            "platform": "instagram",
            "stage": "verification_pending",
            "post_counts": sorted(self._post_counts(nodes)),
            "tile_signatures": sorted(self._tile_signatures(nodes)),
            "last_dump": nodes,
        }

    def verify(self, job: Any, device: Any) -> str | None:
        """Agile post-Share verification on the user-defined exact timing.

        1. Fixed 20s propagation wait right after the Share tap.
        2. One re-sync cycle (Profile -> 3s -> Home -> 3s -> Profile ->
           fixed-coordinate Bezier pull-to-refresh) then a composite delta +
           identity check: the grid must show a tile absent from the baseline
           or the post count must read baseline+1.
        3. If the reel is not there yet: 20s, swipe + check again.
        4. If still not there: 10s more, swipe + check (third and last check).
        5. Any check that detects delta first recomposes the grid with a full
           tab cycle (Profile -> 1s -> Home -> 1s -> Profile -> refresh):
           swipe-only refresh updates the header count but keeps the old
           tiles on this build (live3).  Only then is the newest reel tile
           opened and required to carry the complete caption; a confirmed
           identity completes immediately.  After the third check the result
           is the worker-local `unverified` state
           (models.PublicationStatus.UNVERIFIED): a terminal outcome that is
           never a failure and never republished, carrying the last dump as
           evidence and a clear "verification pending" log.  A real negative
           signal from Instagram (a dialog or error the adapter already
           detects) still raises and fails the job -- nothing is swallowed
           here beyond the absence of positive evidence.
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
            "verification pending: Instagram reel was published but could not "
            "be verified after %d checks; finishing the job as unverified with "
            "the last dump attached (never republished automatically)",
            self._VERIFY_MAX_CHECKS,
        )
        return None

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def _cleanup_count(self, baseline: list[str]) -> int:
        if not isinstance(baseline, list) or len(baseline) != 1 or not isinstance(baseline[0], str) or not self._POSTS.fullmatch(baseline[0].strip()):
            raise PublisherError("CLEANUP_BASELINE_INVALID", "Instagram cleanup baseline must be the exact pre-publication post-count description")
        return int(self._POSTS.fullmatch(baseline[0].strip()).group(1))

    def _cleanup_preflight(self, expected_identity: str, baseline: list[str], device: Any) -> list[dict[str, str]]:
        if not isinstance(expected_identity, str) or not expected_identity.strip() or expected_identity in (baseline if isinstance(baseline, list) else []):
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Cleanup identity must be a new verified item")
        posts = self._cleanup_count(baseline)
        nodes = self._return_to_profile(device)
        nodes = self._prepare_active_account(device, nodes)
        title = self.account_control(nodes, resource_id=self._TITLE, error="Instagram active profile account")
        if title.get("text") != self.expected_account and title.get("content-desc") != self.expected_account:
            raise PublisherError("ACCOUNT_MISMATCH", "Instagram active profile account does not match the cleanup account")
        if self._post_counts(nodes) != {posts + 1}:
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Instagram profile does not show exactly one test post above the baseline")
        return nodes

    def _sheet_delete_option(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._OPTION_TEXT and node.get("text") == "Delete"), None)

    @staticmethod
    def _delete_confirmation(nodes: list[dict[str, str]]) -> dict[str, str] | None:
        # The headline is a static dialog label, not the tapped control: accept
        # the known surface variants ("Delete Post?" / "Delete reel?") without
        # the clickability gate a static label breaks; the confirm button below
        # keeps the guarded gate.
        return next((node for node in nodes if node.get("resource-id") == InstagramPublisher._DIALOG_HEADLINE and node.get("text") in InstagramPublisher._DELETE_HEADLINES), None)

    def _open_delete_option(self, device: Any) -> dict[str, str]:
        try:
            return self.wait_for(device, error="DELETE_ACTION", predicate=self._sheet_delete_option)
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
        options = [node for node in self._last_nodes if node.get("resource-id") == self._OPTION_TEXT]
        if not options:
            raise PublisherError("DELETE_ACTION", "Instagram delete option is absent", retryable=True)
        if not hasattr(device, "swipe"):
            raise PublisherError("ADB_SWIPE_UNAVAILABLE", "Instagram cleanup sheet scroll requires swipe")
        spans = [SafeAdb.bounds(node) for node in options]
        center_x = (min(x1 for x1, _, _, _ in spans) + max(x2 for _, _, x2, _ in spans)) // 2
        top, bottom = min(y1 for _, y1, _, _ in spans), max(y2 for _, _, _, y2 in spans)
        device.swipe(center_x, bottom, center_x, top, 300)  # scroll the sheet to reveal hidden actions
        return self.wait_for(device, error="DELETE_ACTION", predicate=self._sheet_delete_option)

    def cleanup_test_post(self, expected_identity: str, baseline: list[str], device: Any) -> None:
        posts = self._cleanup_count(baseline)
        nodes = self._cleanup_preflight(expected_identity, baseline, device)
        tile = self._newest_reel_tile(nodes, missing_error="CLEANUP_TARGET")
        self._tap(device, tile)
        try:
            # Stale grid bounds can open the wrong reel: never continue past a
            # reel whose caption is not the authorized test post.
            self.wait_for(device, error="REEL_MISMATCH", predicate=lambda screen: self._reel_with_caption(screen, expected_identity))
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
            raise PublisherError("REEL_MISMATCH", "The opened Instagram reel is not the authorized test post") from None
        menu = self._one(self._last_nodes, error="REEL_MENU", resource_id=self._MEDIA_OPTIONS, content_desc="More actions for this post")
        self._tap(device, menu)
        delete = self._open_delete_option(device)
        self.tap_and_wait(device, delete, error="DELETE_CONFIRMATION", predicate=self._delete_confirmation)
        primary = self._one(self._last_nodes, error="DELETE_PRIMARY", resource_id=self._DIALOG_PRIMARY, text="Delete")
        self.tap_and_wait(device, primary, error="BASELINE_RELOAD", predicate=lambda screen: self._count_matches(screen, posts))
        if self._post_counts(self._last_nodes) != {posts}:
            raise PublisherError("BASELINE_NOT_RESTORED", "Instagram cleanup did not restore the exact baseline post count")
