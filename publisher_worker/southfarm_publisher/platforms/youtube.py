from __future__ import annotations

import logging
import re
import time
from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..adb_device import SafeAdb
from ..models import PublicationStatus, PublisherError

logger = logging.getLogger(__name__)

# Selectors verified live on the device (channel "Marczell Wisdom", recon of
# 2026-08-17).  Every screen comes from the accessibility-service dump EXCEPT
# Add details, which Google protects (empty service tree) and therefore
# requires a one-off uiautomator dump
# (`SafeAdb.dump_ui_explicit("uiautomator")`).
_YT = "com.google.android.youtube:id/"
_PACKAGE = "com.google.android.youtube"


class YouTubeShortPublisher(GuardedPublisher):
    """Shorts publishing against the verified YouTube creation flow.

    Verified flow (recon 2026-08-17): Home bottom-bar Create (desc 'Create',
    NO resource-id) -> camera gallery delegate -> picker thumbnails (desc
    carries the file name; NOT clickable - direct center-bounds tap) -> Next
    (multi_select_next_button) -> trim Done (creation_next_button) -> editor
    Next (shorts_post_bottom_button) -> Add details (uiautomator ONLY:
    EditText hint 'Caption your Short' has no resource-id; upload via
    upload_bottom_button) -> upload window (channel marker or main-screen
    return; the Upload tap is never repeated).

    Identity: the bottom-bar 'You' tab DOES navigate (live 2026-08-17 -- the
    old "dead control" note was wrong): it shows the '@handle' label, and
    "View channel" opens the channel profile whose Shorts grid (default
    'Latest' order, newest first, tile desc "<caption truncated ~80 chars>,
    <views> - play Short" with a special 'Drafts' tile) is the
    pre-publication baseline.  The new Short is the first grid tile whose
    desc starts with the caption prefix and carries "No views".

    Verification is the agile post-upload sequence (20s fixed wait,
    Home -> You -> View channel re-sync cycle, fixed-coordinate Bezier
    refresh, caption-prefix + "No views" grid delta, caption-prefix player
    identity).  When the player never exposes the caption, the delta tile's
    own description (prefix + "No views" + absent from the baseline) IS the
    identity -- completion is never blocked by that alone.  After the third
    check without confirmation the job ends as the worker-local UNVERIFIED
    status with evidence and a "verification pending" log.

    YouTube Shorts captions are limited to 100 characters: publish() refuses
    a longer caption with CAPTION_INVALID before any UI interaction.
    """

    package = _PACKAGE
    _PACKAGE = _PACKAGE

    _GALLERY = _YT + "reel_camera_gallery_button_delegate"
    _THUMB = _YT + "thumb_image_view"
    _SELECTED = _YT + "selected_state"
    _PICKER_NEXT = _YT + "multi_select_next_button"
    _TRIM_DONE = _YT + "creation_next_button"
    _EDITOR_NEXT = _YT + "shorts_post_bottom_button"
    _UPLOAD = _YT + "upload_bottom_button"
    _CAPTION_HINT = "Caption your Short"
    _CHANNEL_MARKER = "Uploaded to Your Channel"
    _TABS_BAR_TAB = _YT + "tabs_bar_text_tab_view"
    _DRAFTS_TILE = "Drafts"
    _PLAY_SHORT_SUFFIX = " - play Short"
    _NO_VIEWS = "No views"
    _CAPTION_PREFIX_CHARS = 50
    _VIEW_CHANNEL = "View channel"
    # Camera-close bottom sheet (BACK over a Shorts camera clip): the sheet
    # offers Delete (local draft discard) / Save and exit / Cancel.  Delete
    # removes a LOCAL project only -- nothing is ever published by it.
    _SHEET_DELETE_ACTIONS = frozenset({"Delete", "Discard edits"})
    _SHEET_COMPANIONS = frozenset({"Save and exit", "Cancel"})

    # Agile post-upload verification timing (user-defined exact sequence):
    _VERIFY_INITIAL_WAIT = 20.0    # fixed propagation wait after upload confirmation
    _VERIFY_TAB_WAIT = 3.0         # settle between re-sync navigation taps
    _VERIFY_RETRY_WAITS = (20.0, 10.0)  # non-uniform waits before the retry checks
    _VERIFY_MAX_CHECKS = 1 + len(_VERIFY_RETRY_WAITS)  # re-sync check + one refresh retry per wait
    # Pull-to-refresh at fixed screen-relative coordinates (720x1640 target):
    # tree bounds must NEVER drive this gesture (stale a11y geometry serves
    # out-of-viewport spans), so the Instagram/TikTok-calibrated Bezier is
    # reused verbatim.
    _REFRESH_SWIPE = (360, 350, 360, 1000, 400)
    # The grid serves stale bounds: two fresh-dump identity attempts bound
    # the total tile taps before falling back to the delta tile description.
    VERIFY_IDENTITY_ATTEMPTS = 2

    # Upload confirmation window: after the ONE Upload tap, wait up to 90s
    # for the channel marker or for the upload to finish (main screen with
    # the bottom bar and no upload UI).  The tap is never re-attempted.
    # The marker is the strong signal (it can surface ~30s after the tap);
    # the main-screen signal is weak and only counts after this grace since
    # the upload UI was last seen, so an early restored screen never
    # confirms an upload that has not settled yet.
    _UPLOAD_CONFIRM_TIMEOUT = 90.0
    _UPLOAD_MAINSCREEN_GRACE = 10.0

    def _back(self, device: Any) -> None:
        if hasattr(device, "back"): device.back()
        else: device.command("shell", "input", "keyevent", "4")

    def _create_control(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        # Package-scoped: foreign-package chrome (SystemUI navbar, launcher)
        # is invisible to the semantic Create match.
        return (self._one(nodes, error="CREATE_CONTROL", content_desc="Create", package=self._PACKAGE, required=False)
                or self._one(nodes, error="CREATE_CONTROL", text="Create", package=self._PACKAGE, required=False))

    def _bottom_tab(self, nodes: list[dict[str, str]], *, label: str) -> dict[str, str] | None:
        """Exactly one package-scoped bottom-bar tab; absence is None, ambiguity fails closed.

        The live bottom bar (Home/Shorts/Create/Subscriptions/You) carries NO
        resource-id: tabs are semantic content-desc/text Buttons scoped to the
        app package so the SystemUI 3-button navbar "Home" button can never
        collide with the app's own Home tab.
        """
        return (self._one(nodes, error="TAB_BAR", content_desc=label, package=self._PACKAGE, required=False)
                or self._one(nodes, error="TAB_BAR", text=label, package=self._PACKAGE, required=False))

    def _tap_tab(self, device: Any, *, label: str) -> None:
        """One guarded semantic bottom-bar tap from a fresh dump.

        The tab must be unique, enabled and carry valid bounds, and the tap
        lands on the actionable target (the clickable container when the
        matched label is a non-clickable leaf -- live run: the You label
        reported clickable=false inside its clickable Button).  Arrival is
        not polled here: the composite delta check after the refresh is the
        arbiter, and a tap that did not navigate simply shows no delta
        (fail-closed -- never a false completion, only a retry).
        """
        nodes = self._nodes(device)
        tab = self._bottom_tab(nodes, label=label)
        if tab is None:
            raise PublisherError("TAB_BAR", f"YouTube bottom bar {label} tab is absent", retryable=True)
        target = self._clickable_target(tab, nodes)
        if target is None:
            raise PublisherError("CONTROL_DISABLED", f"YouTube bottom bar {label} tab has no actionable target", retryable=True)
        self._tap(device, target)

    def _cycle_tab(self, device: Any, *, label: str, wait: float) -> None:
        self._tap_tab(device, label=label)
        self._pause(wait)

    def _identity_node(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        """The 'You' tab handle label ('@<username>', text or content-desc)."""
        expected = "@" + self.expected_account
        matches = [node for node in nodes if node.get("text") == expected or node.get("content-desc") == expected]
        return matches[0] if len(matches) == 1 else None

    def _view_channel_control(self, nodes: list[dict[str, str]], *, required: bool = True) -> dict[str, str] | None:
        """Exactly one actionable "View channel" control.

        The You screen carries the label twice: a non-clickable avatar
        ImageView and the clickable button.  Only the clickable copy is a
        navigation control; absence or ambiguity fails closed.
        """
        matches = [node for node in nodes
                   if GuardedPublisher._node_in_package(node, self._PACKAGE)
                   and (node.get("content-desc") or "") == self._VIEW_CHANNEL
                   and node.get("clickable", "true").lower() != "false"]
        if len(matches) > 1:
            raise PublisherError("CHANNEL_NAVIGATION", "YouTube View channel control is ambiguous")
        if not matches:
            if required:
                raise PublisherError("CHANNEL_NAVIGATION", "YouTube View channel control is absent")
            return None
        SafeAdb.bounds(matches[0])
        return matches[0]

    def _you_reached(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        """You-tab arrival: the account handle or the View channel control."""
        handle = self._identity_node(nodes)
        if handle is not None:
            return handle
        return self._view_channel_control(nodes, required=False)

    def _navigate_you(self, device: Any) -> list[dict[str, str]]:
        nodes = self._nodes(device)
        if self._identity_node(nodes) is not None:
            return nodes
        tab = self._bottom_tab(nodes, label="You")
        if tab is None:
            raise PublisherError("YOU_TAB", "YouTube You tab is required before account verification", retryable=True)
        self.tap_and_wait(device, tab, error="YOU_ACCOUNT", predicate=self._you_reached)
        return self._last_nodes

    def _require_identity(self, nodes: list[dict[str, str]]) -> None:
        """The You screen must show exactly the publication '@handle'."""
        if self._identity_node(nodes) is None:
            # Account switching is deliberately not automated: fail closed.
            raise PublisherError("ACCOUNT_MISMATCH", "YouTube active account does not match the publication account")

    @classmethod
    def _is_short_tile(cls, node: dict[str, str]) -> bool:
        desc = node.get("content-desc") or ""
        return desc.endswith(cls._PLAY_SHORT_SUFFIX) and desc != cls._DRAFTS_TILE

    def _grid_tiles(self, nodes: list[dict[str, str]]) -> list[dict[str, str]]:
        """Channel Shorts grid tiles in document order (the special 'Drafts' tile excluded)."""
        return [node for node in nodes if self._is_short_tile(node)]

    def _channel_reached(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        markers = [node for node in nodes
                   if node.get("resource-id") == self._TABS_BAR_TAB
                   or (node.get("content-desc") or "") == self._DRAFTS_TILE
                   or self._is_short_tile(node)]
        return markers[0] if markers else None

    def _open_channel(self, device: Any) -> list[dict[str, str]]:
        control = self._view_channel_control(self._last_nodes)
        self._tap(device, control)
        try:
            self.wait_for(device, error="CHANNEL_PROFILE", predicate=self._channel_reached)
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
            raise PublisherError("CHANNEL_PROFILE", "YouTube channel profile could not be reached", retryable=True) from None
        return self._last_nodes

    def _camera_exit_sheet(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        """The camera-close sheet's Delete/Discard control, only inside a recognizable sheet.

        BACK over a Shorts camera clip opens a bottom sheet "Delete / Save
        and exit / Cancel".  Tapping Delete discards the LOCAL camera project
        (nothing published); blind repeated backs can loop this sheet, so the
        sheet is handled with one explicit tap.  A Delete without the
        Save/Cancel companions is unknown and fails closed.
        """
        deletes = [node for node in nodes if (node.get("content-desc") or "") in self._SHEET_DELETE_ACTIONS]
        if not deletes:
            return None
        if not any((node.get("content-desc") or "") in self._SHEET_COMPANIONS for node in nodes):
            raise PublisherError("CAMERA_SHEET_UNKNOWN", "YouTube camera exit sheet is present without its Save and exit/Cancel companions")
        if len(deletes) != 1 or deletes[0].get("clickable", "true").lower() == "false":
            raise PublisherError("CAMERA_SHEET_UNKNOWN", "YouTube camera exit sheet Delete control is absent, ambiguous or not actionable")
        SafeAdb.bounds(deletes[0])
        return deletes[0]

    def _normalize_to_main(self, device: Any) -> None:
        """Reach a main screen (bottom-bar Create present) from residual state.

        Every iteration decides from a fresh dump: on a main screen return;
        on the camera-close sheet tap Delete explicitly (local draft discard,
        nothing published -- never blind repeated backs over the sheet);
        otherwise one controlled back.  After the bounded iterations a main
        screen is required, fail-closed.
        """
        for _ in range(3):
            nodes = self._nodes(device)
            if self._create_control(nodes) is not None:
                return
            sheet_delete = self._camera_exit_sheet(nodes)
            if sheet_delete is not None:
                self._tap(device, sheet_delete)
                continue
            self._back(device)
        nodes = self._nodes(device)
        if self._create_control(nodes) is None:
            raise PublisherError("CREATE_CONTROL", "YouTube main screen with the Create control is required before publishing", retryable=True)

    def _return_to_main(self, device: Any) -> list[dict[str, str]]:
        """Reach a main screen for publishing: controlled backs out of pages, then the Home tab."""
        for _ in range(3):
            nodes = self._nodes(device)
            if self._create_control(nodes) is not None:
                return nodes
            if self._bottom_tab(nodes, label="Home") is not None:
                self._tap_tab(device, label="Home")
                continue
            self._back(device)
        nodes = self._nodes(device)
        if self._create_control(nodes) is None:
            raise PublisherError("CREATE_CONTROL", "YouTube main screen with the Create control is required before publishing", retryable=True)
        return nodes

    def prepare(self, job: Any, device: Any) -> None:
        self.selected_account_username(job)
        self._launch(device)
        # R1 normalization: residual camera state exits through the explicit
        # sheet Delete, never through blind repeated backs.
        self._normalize_to_main(device)
        nodes = self._navigate_you(device)
        # Identity: the You tab shows the '@handle' label; a missing or
        # different account fails closed (account switching is never automated).
        self._require_identity(nodes)
        nodes = self._open_channel(device)
        # Baseline: the ordered content-desc list of the Shorts grid tiles
        # (default 'Latest' order, newest first).  The 'Drafts' tile is not a
        # Short and is ignored.  A post-less grid is a valid empty baseline.
        tiles = self._grid_tiles(nodes)
        self._baseline_tiles = [tile.get("content-desc") for tile in tiles if tile.get("content-desc")]
        if not self._baseline_tiles:
            logger.warning("Shorts grid baseline empty; the caption-prefix delta is the only verification signal")
        self._capture_baseline(nodes)
        self._prepared = True
        self._expected_caption = job.caption

    def _explicit_nodes(self, device: Any, source: str) -> list[dict[str, str]]:
        """Fresh one-off dump via `source` (uiautomator for protected screens)."""
        self._require_package(device)
        if not hasattr(device, "dump_ui_explicit"): raise PublisherError("UI_DUMP_UNAVAILABLE", "One-off uiautomator dump is unavailable on this device", retryable=True)
        nodes = device.dump_ui_explicit(source)
        if not isinstance(nodes, list):
            raise PublisherError("UI_DUMP_INVALID", "Device UI dump is invalid", retryable=True)
        self._last_nodes = nodes
        return nodes

    def _picker_thumbnails(self, nodes: list[dict[str, str]]) -> list[dict[str, str]]:
        return [node for node in nodes if node.get("resource-id") == self._THUMB and node.get("content-desc")]

    def _selected_badge(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if node.get("resource-id") == self._SELECTED), None)

    def _select_thumbnail(self, device: Any, remote: str) -> dict[str, str]:
        """Tap a picker thumbnail directly at its center.

        Verified risk: thumbnails are NOT clickable (clickable=false; the
        GridView handles the click), so guarded tap_and_wait is unusable.  The
        tap is proven accepted only by the rid selected_state badge (text '1').
        Preference is the tile whose desc is the pushed file name; otherwise
        the first visible thumbnail of the grid.  A tap that does not register
        (unchanged picker, no badge) is retried once on the SAME tile: every
        other tile is a different video and must never be published.
        """
        nodes = self._last_nodes
        thumbnails = self._picker_thumbnails(nodes)
        if not thumbnails:
            raise PublisherError("MEDIA_NOT_FOUND", "YouTube media picker has no thumbnails", retryable=True)
        matching = [node for node in thumbnails if node.get("content-desc") == remote]
        if len(matching) > 1:
            raise PublisherError("MEDIA_AMBIGUOUS", "Exact YouTube picker media is absent or ambiguous")
        candidate = matching[0] if matching else thumbnails[0]
        for _attempt in range(2):
            self._tap(device, candidate)
            try:
                return self.wait_for(device, error="MEDIA_SELECTION", predicate=self._selected_badge)
            except PublisherError as error:
                if error.code != "UI_TIMEOUT":
                    raise
                # The tap did not register: the picker is unchanged, so one
                # retry of the same tile is safe.
                continue
        raise PublisherError("MEDIA_UNSELECTABLE", "No YouTube picker thumbnail accepted the selection tap", retryable=True)

    def _add_details_nodes(self, device: Any) -> list[dict[str, str]]:
        """Add-details tree: the service dump is EMPTY on this Google-protected
        screen, so a one-off uiautomator dump is the only valid source."""
        return self._explicit_nodes(device, "uiautomator")

    def _wait_details(self, device: Any, *, error: str, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None]) -> dict[str, str]:
        """wait_for against the uiautomator source (Add details only)."""
        deadline = time.monotonic() + self.timeout
        while True:
            found = predicate(self._add_details_nodes(device))
            if found is not None: return found
            if time.monotonic() >= deadline: raise PublisherError("UI_TIMEOUT", f"Timed out waiting for {error}", retryable=True)
            self._pause(self.poll)

    def _caption_field(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        # The EditText has NO resource-id on this screen: the single EditText
        # of the Add-details tree is the caption field.
        fields = [node for node in nodes if node.get("class", "").endswith("EditText")]
        return fields[0] if len(fields) == 1 else None

    def _write_caption(self, device: Any, caption: str) -> None:
        def hinted(nodes: list[dict[str, str]]) -> dict[str, str] | None:
            field = self._caption_field(nodes)
            return field if field is not None and self._CAPTION_HINT in f"{field.get('text', '')} {field.get('content-desc', '')}" else None
        field = self._wait_details(device, error="CAPTION_FIELD", predicate=hinted)
        self._tap(device, field)
        device.text(caption)  # single pass
        # Re-dump via uiautomator: the echo is only observable there.
        echo = self._caption_field(self._add_details_nodes(device))
        observed = " ".join((echo.get("text") or echo.get("content-desc") or "").split()) if echo is not None else ""
        if observed != caption:
            raise PublisherError("CAPTION_DIVERGED", "YouTube caption text diverged before publishing")
        # Close the IME so the Upload control is reachable.
        self._back(device)

    def _final_upload(self, device: Any, checkpoint: Callable[..., None], caption: str) -> None:
        """Replicates GuardedPublisher._final's fail-closed protection with a
        uiautomator source: the runner requires the publishing checkpoint
        (final_action=True) to be PERSISTED before the one irreversible tap,
        and the context+button must coexist in one fresh dump.  The stock
        _final uses self._nodes (service), which cannot see Add details."""
        nodes = self._add_details_nodes(device)
        field = self._caption_field(nodes)
        if field is None or caption not in f"{field.get('text', '')} {field.get('content-desc', '')}":
            raise PublisherError("FINAL_CONTEXT_MISSING", "Final publish context is absent")
        button = self._one(nodes, error="FINAL_ACTION", text="Upload Short", resource_id=self._UPLOAD)
        checkpoint("publishing", 90, final_action=True, evidence={"platform": "youtube", "final": "upload_short", "dump_source": "uiautomator"})
        self._tap(device, button)

    def _refuse_mid_flow(self, nodes: list[dict[str, str]]) -> None:
        if any(node.get("text") == self._CAPTION_HINT for node in nodes) or any(node.get("resource-id") == self._UPLOAD for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "YouTube was already in a publish flow; refusing to resume")

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        # The 100-character Shorts limit is refused BEFORE any app action.
        validate_caption(job.caption, youtube=True)
        self._require_prepared()
        remote = f"publication-{job.id}-{job.media_id}.{job.media['file_extension']}"
        nodes = self._nodes(device)
        self._refuse_mid_flow(nodes)
        nodes = self._return_to_main(device)
        self._refuse_mid_flow(nodes)
        create = self._create_control(nodes)
        if create is None:
            raise PublisherError("CREATE_CONTROL", "YouTube exact Create control is absent", retryable=True)
        gallery = self.tap_and_wait(device, create, error="GALLERY_MEDIA", resource_id=self._GALLERY)
        picker = self.tap_and_wait(device, gallery, error="PICKER_MEDIA", predicate=lambda screen: next((item for item in screen if item.get("resource-id") == self._THUMB and item.get("content-desc")), None))
        checkpoint("selecting_media", 25, evidence={"platform": "youtube", "remote_name": remote})
        self._select_thumbnail(device, remote)
        next_one = self.tap_and_wait(device, self._one(self._last_nodes, error="GALLERY_NEXT", text="Next", resource_id=self._PICKER_NEXT), error="TRIM_DONE", text="Done", resource_id=self._TRIM_DONE)
        # Verified risk: the trim->editor transition is slow; the guard's
        # default timeout already retries, the generous wait is tap_and_wait's.
        editor = self.tap_and_wait(device, next_one, error="EDITOR_NEXT", text="Next", resource_id=self._EDITOR_NEXT)
        checkpoint("editing", 45, evidence={"platform": "youtube", "stage": "editor"})
        # The editor->details transition lands on a screen the service dump
        # cannot see (empty tree), so freshness is proven on the uiautomator
        # side by _write_caption's hinted-field wait instead of tap_and_wait.
        self._tap(device, editor)
        self._write_caption(device, job.caption)
        checkpoint("captioning", 65, evidence={"platform": "youtube", "caption_words": len(job.caption.split())})
        checkpoint("ready_to_publish", 80, evidence={"platform": "youtube", "stage": "details"})
        self._final_upload(device, checkpoint, job.caption)
        try:
            self._wait_upload_confirmation(device)
        except PublisherError as error:
            if error.code != "UI_TIMEOUT": raise
            # Never re-tap Upload: the one irreversible tap may already count.
            raise PublisherError("UPLOAD_UNCONFIRMED", "YouTube did not confirm the uploaded Short", retryable=True, final_action_uncertain=True) from None

    def _channel_marker_node(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if self._CHANNEL_MARKER in f"{node.get('text', '')} {node.get('content-desc', '')}"), None)

    @staticmethod
    def _upload_percent(nodes: list[dict[str, str]]) -> str | None:
        return next((node.get("text") for node in nodes if re.fullmatch(r"\d{1,3}%", node.get("text") or "")), None)

    @staticmethod
    def _uploading_overlay(nodes: list[dict[str, str]]) -> dict[str, str] | None:
        return next((node for node in nodes if (node.get("text") or "").startswith("Uploading")), None)

    def _upload_ui_present(self, nodes: list[dict[str, str]]) -> bool:
        return self._uploading_overlay(nodes) is not None or self._upload_percent(nodes) is not None

    def _wait_upload_confirmation(self, device: Any, *, clock: Callable[[], float] = time.monotonic) -> dict[str, str]:
        """Wait up to _UPLOAD_CONFIRM_TIMEOUT for proof that the Upload went out.

        The channel marker ('Uploaded to Your Channel') was the historical
        post-share signal; it was NOT re-validated on the 2026-08-17 recon,
        so the wait keeps it inside the upload window.  Every iteration reads
        a FRESH dump and accepts, in this evaluation order:

          1. the channel marker, or
          2. upload completion: the main screen is restored (bottom-bar
             Create present) AND no upload UI (overlay / percent) remains
             AND _UPLOAD_MAINSCREEN_GRACE has elapsed since the upload UI
             was last seen (live run: an early restored screen confirmed
             at 3s while the marker only surfaced ~30s later).

        Upload progress percentages are logged for run evidence.  The wait
        NEVER dispatches a tap: the Upload tap remains the single
        irreversible action and is never re-attempted.  A deadline expiry
        raises UI_TIMEOUT, which publish maps to UPLOAD_UNCONFIRMED.
        """
        deadline = clock() + self._UPLOAD_CONFIRM_TIMEOUT
        last_percent: str | None = None
        ui_last_seen = deadline - self._UPLOAD_CONFIRM_TIMEOUT
        while True:
            nodes = self._nodes(device)
            now = clock()
            marker = self._channel_marker_node(nodes)
            if marker is not None:
                logger.info("YouTube upload confirmed: %s", self._CHANNEL_MARKER)
                return marker
            overlay = self._uploading_overlay(nodes)
            percent = self._upload_percent(nodes)
            if overlay is not None or percent is not None:
                ui_last_seen = now
            if percent is not None and percent != last_percent:
                last_percent = percent
                label = " ".join(part for part in ((overlay.get("text") if overlay is not None else "Uploading..."), percent) if part)
                logger.info("YouTube upload progress: %s", label)
            if (self._create_control(nodes) is not None and not self._upload_ui_present(nodes)
                    and now - ui_last_seen >= self._UPLOAD_MAINSCREEN_GRACE):
                logger.info("YouTube upload finished: the main screen is restored without upload UI")
                return nodes[0] if nodes else {}
            if now >= deadline:
                raise PublisherError("UI_TIMEOUT", "Timed out waiting for UPLOAD_CONFIRMATION", retryable=True)
            self._pause(self.poll)

    def _caption_prefix(self, caption: str) -> str:
        return caption[:self._CAPTION_PREFIX_CHARS]

    def _channel_delta(self, nodes: list[dict[str, str]], caption: str) -> dict[str, str] | None:
        """The new Short: the FIRST grid tile (Drafts excluded) whose desc
        starts with the caption prefix AND carries "No views", absent from the
        pre-publication baseline.  Live grid order is default 'Latest', so the
        fresh Short is the first real tile; a matching desc that already
        existed in the baseline is ambiguous and reported as no-delta (the
        check keeps polling, fail-closed)."""
        prefix = self._caption_prefix(caption)
        baseline = list(getattr(self, "_baseline_tiles", []))
        for tile in self._grid_tiles(nodes):
            desc = tile.get("content-desc") or ""
            if not desc.startswith(prefix) or self._NO_VIEWS not in desc:
                continue
            if desc in baseline:
                return None
            return tile
        return None

    def _player_caption(self, nodes: list[dict[str, str]], caption: str) -> dict[str, str] | None:
        """Caption PREFIX in any player node's text or content-desc.

        Grid tiles themselves also start with the caption prefix (their desc
        is "<caption truncated>, <views> - play Short"), so tile-shaped nodes
        (desc ending in ' - play Short', or the 'Drafts' tile) are excluded:
        the player must expose the caption as its own text/desc node.
        """
        prefix = self._caption_prefix(caption)
        for node in nodes:
            if self._is_short_tile(node) or (node.get("content-desc") or "") == self._DRAFTS_TILE:
                continue
            value = node.get("text") or node.get("content-desc")
            if value and value.startswith(prefix):
                return node
        return None

    def _confirm_identity(self, job: Any, device: Any) -> str | None:
        """Open the delta tile and require the caption prefix in the player.

        Up to VERIFY_IDENTITY_ATTEMPTS fresh-dump attempts: each attempt
        re-dumps, re-locates the delta tile with bounds from that fresh dump
        (never the delta dump's geometry), taps it and requires the caption
        prefix in the player (text or desc).  A wrong or caption-less viewer
        is closed and retried.  A confirmed identity that predates this
        publication (present in the baseline snapshot) is treated as
        no-delta.  When the player never exposes the caption (possible on
        this build), the identity IS the delta tile's own description
        (caption prefix + "No views" + absent from the baseline) --
        completion is never blocked by that alone.  Without any delta tile
        the check reports None so the verify cycle keeps polling.
        """
        delta_tile: dict[str, str] | None = None
        for _ in range(self.VERIFY_IDENTITY_ATTEMPTS):
            nodes = self._nodes(device)
            tile = self._channel_delta(nodes, job.caption)
            if tile is None:
                return None
            delta_tile = tile
            target = self._fresh_tap_target(device, tile)
            if target is None:
                # The tile never re-localized with in-viewport bounds: no tap
                # was dispatched, so retry from a fresh dump.
                continue
            self._tap(device, target)
            try:
                opened = self.wait_for(device, error="REEL_MISMATCH", predicate=lambda screen: self._player_caption(screen, job.caption))
            except PublisherError as error:
                if error.code != "UI_TIMEOUT":
                    raise
                # Either stale bounds opened an older Short or the caption
                # never rendered: close the viewer and retry once.
                self._back(device)
                continue
            identity = opened.get("content-desc") or opened.get("text") or tile.get("content-desc") or job.caption
            if identity in self._baseline:
                return None
            return identity
        if delta_tile is not None:
            identity = delta_tile.get("content-desc") or job.caption
            logger.info("YouTube player did not expose the caption; the delta tile description is the identity")
            return identity
        return None

    def _verify_check(self, job: Any, device: Any) -> str | None:
        """One composite check: caption-prefix delta first, identity on top."""
        nodes = self._nodes(device)
        if self._channel_delta(nodes, job.caption) is None:
            return None
        return self._confirm_identity(job, device)

    def _refresh_profile(self, device: Any) -> None:
        """One reversible pull-to-refresh at fixed screen-relative coordinates.

        The gesture is constant by design: Bezier on devices whose `input`
        supports motionevent, straight swipe otherwise.  Nothing is tapped
        and tree bounds NEVER drive the gesture.
        """
        x1, y1, x2, y2, duration = self._REFRESH_SWIPE
        if hasattr(device, "swipe_bezier"):
            device.swipe_bezier(x1, y1, x2, y2, duration)
        elif hasattr(device, "swipe"):
            device.swipe(x1, y1, x2, y2, duration)
        else:
            raise PublisherError("ADB_SWIPE_UNAVAILABLE", "YouTube verify re-sync requires a swipe gesture", retryable=True)

    def _tab_cycle_resync(self, device: Any, tab_wait: float) -> None:
        """One full re-sync: Home -> You -> channel grid -> Bezier refresh.

        The cycle recomposes the channel grid on this build: pull-to-refresh
        alone keeps serving the pre-publication tiles, so the Home<->You
        cycle through the channel profile is the mechanism that forces the
        new tile to materialize.  Every tap is guarded; the swipe
        coordinates are screen-fixed.
        """
        self._cycle_tab(device, label="Home", wait=tab_wait)
        self._cycle_tab(device, label="You", wait=tab_wait)
        self._enter_channel(device)
        self._refresh_profile(device)

    def _enter_channel(self, device: Any) -> None:
        """Reach the channel grid from wherever the You tab landed.

        After an upload the You tap can land directly on the channel page
        (post-upload auto-navigation): the View channel control does not
        exist there, but the grid already is the fresh screen this cycle
        needs, so the navigation tap is skipped instead of failing.  A
        screen that offers neither the control nor the channel grid is
        unknown and fails closed.
        """
        nodes = self._nodes(device)
        control = self._view_channel_control(nodes, required=False)
        if control is not None:
            self._tap(device, control)
            return
        if self._channel_reached(nodes) is None:
            raise PublisherError("CHANNEL_NAVIGATION", "YouTube verify re-sync reached neither the You screen nor the channel page", retryable=True)

    def _verification_pending_evidence(self) -> dict[str, Any]:
        """Serializable snapshot of the last verification state for the job.

        The publication is real but unproven: the last observed dump travels
        with the job so a human can confirm it without re-publishing.
        """
        nodes = self._last_nodes or []
        return {
            "platform": "youtube",
            "stage": "verification_pending",
            "baseline_tiles": list(getattr(self, "_baseline_tiles", [])),
            "grid_tiles": [node.get("content-desc") for node in self._grid_tiles(nodes)],
            "last_dump": nodes,
        }

    def verify(self, job: Any, device: Any) -> str | PublicationStatus:
        """Agile post-upload verification on the user-defined exact timing.

        1. Fixed 20s propagation wait right after the upload confirmation.
        2. One re-sync cycle (Home -> 3s -> You -> 3s -> View channel ->
           fixed-coordinate Bezier pull-to-refresh) then a composite delta +
           identity check: the first non-Draft grid tile must start with the
           caption prefix and carry "No views", absent from the baseline.
        3. If the Short is not there yet: 20s, swipe + check again.
        4. If still not there: 10s more, swipe + check (third and last check).
        5. On delta the tile is opened from a fresh dump and required to
           carry the caption prefix in the player; when the player never
           exposes the caption, the delta tile description (prefix +
           "No views" + not in the baseline) IS the identity -- completion
           is never blocked by that alone.  After the third check the result
           is the worker-local `unverified` state
           (models.PublicationStatus.UNVERIFIED): a terminal outcome that is
           never a failure and never republished, carrying the last dump as
           evidence and a clear "verification pending" log.  A real negative
           signal from YouTube (a dialog or error the adapter already
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
            "verification pending: YouTube Short was published but could not "
            "be verified after %d checks; finishing the job as unverified with "
            "the last dump attached (never republished automatically)",
            self._VERIFY_MAX_CHECKS,
        )
        return PublicationStatus.UNVERIFIED

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def _tile_gone(self, nodes: list[dict[str, str]], identity: str) -> dict[str, str] | None:
        """Cleanup completion predicate: any node once the tile is absent."""
        if any((node.get("content-desc") or node.get("text")) == identity for node in nodes):
            return None
        return nodes[0] if nodes else None

    def cleanup_test_post(self, expected_identity: str, baseline: list[str], device: Any) -> None:
        if not isinstance(baseline, list):
            raise PublisherError("CLEANUP_BASELINE_INVALID", "Cleanup baseline must preserve ordered identities and duplicates")
        if not expected_identity or expected_identity in baseline:
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Cleanup identity must be a new verified item")
        nodes = self._nodes(device)
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        _, top, _, bottom = self._bounds(target)
        # Verified: the tile's own 3-dot control, geometrically associated.
        associated = [node for node in nodes if (node.get("content-desc") or node.get("text")) == "More actions" and self._bounds(node)[1] <= bottom and self._bounds(node)[3] >= top]
        if len(associated) != 1: raise PublisherError("CLEANUP_MENU_COLLISION", "YouTube More actions must be geometrically associated with the verified card")
        # Direct tap: sibling tiles carry their own "More actions" control, so
        # re-locating by description would collide; geometry already bound this
        # one to the verified tile.
        self._tap(device, associated[0])
        sheet = self.wait_for(device, error="DELETE_ACTION", text="Delete")
        confirm = self.tap_and_wait(device, sheet, error="DELETE_CONFIRMATION", text="Delete this video?")
        delete = self._one(self._last_nodes, error="DELETE_PRIMARY", text="Delete")
        self.tap_and_wait(device, delete, error="BASELINE_RELOAD", predicate=lambda screen: self._tile_gone(screen, expected_identity))

    @staticmethod
    def _bounds(node: dict[str, str]) -> tuple[int, int, int, int]:
        return SafeAdb.bounds(node)
