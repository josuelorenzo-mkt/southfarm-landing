from __future__ import annotations

from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..adb_device import SafeAdb
from ..models import PublisherError


class InstagramPublisher(GuardedPublisher):
    package = "com.instagram.android"

    @staticmethod
    def _is_video_tile(node: dict[str, str]) -> bool:
        return node.get("content-desc", "").startswith("Video thumbnail")

    @staticmethod
    def _duration_formats(duration: int) -> set[str]:
        minutes, seconds = divmod(duration, 60)
        return {f"{minutes}:{seconds:02d}"}

    @staticmethod
    def _overlaps_or_touches(first: dict[str, str], second: dict[str, str]) -> bool:
        ax1, ay1, ax2, ay2 = SafeAdb.bounds(first); bx1, by1, bx2, by2 = SafeAdb.bounds(second)
        return ax1 < bx2 and bx1 < ax2 and ay1 <= by2 and by1 <= ay2

    def _instagram_video_tiles(self, nodes: list[dict[str, str]], duration: int) -> list[dict[str, str]]:
        """Return only thumbnails with one geometrically-associated real duration label."""
        expected = self._duration_formats(duration)
        labels = [node for node in nodes if node.get("resource-id") == "com.instagram.android:id/gallery_grid_item_label"]
        matched: list[dict[str, str]] = []
        for thumbnail in (node for node in nodes if self._is_video_tile(node)):
            related = [label for label in labels if self._overlaps_or_touches(thumbnail, label)]
            if len(related) == 1 and related[0].get("text") in expected:
                matched.append(thumbnail)
        return matched

    def _navigate_profile(self, device: Any) -> list[dict[str, str]]:
        nodes = self._nodes(device)
        profile = self._one(nodes, error="PROFILE_TAB", text="Profile", required=False) or self._one(nodes, error="PROFILE_TAB", content_desc="Profile", required=False)
        if profile is None:
            raise PublisherError("PROFILE_TAB", "Instagram Profile tab is required before account verification")
        self.tap_and_wait(device, profile, error="PROFILE_ACCOUNT", predicate=lambda screen: self.optional_account_control(screen, resource_id="com.instagram.android:id/action_bar_title", error="Instagram active profile account") or self._one(screen, error="CREATE_CONTROL", content_desc="Create New", required=False) or self._one(screen, error="CREATE_CONTROL", text="Create New", required=False))
        return self._last_nodes

    def prepare(self, job: Any, device: Any) -> None:
        self.selected_account_username(job)
        self._launch(device); nodes = self._navigate_profile(device)
        title = self.account_control(nodes, resource_id="com.instagram.android:id/action_bar_title", error="Instagram active profile account")
        if title.get("text") != self.expected_account and title.get("content-desc") != self.expected_account:
            switcher = self.account_control(nodes, resource_id="com.instagram.android:id/action_bar_username_container", error="Instagram account switcher")
            selected = self.tap_and_wait(device, switcher, error="ACCOUNT_SWITCHER_ITEM", predicate=lambda screen: self.require_account_available(job, screen))
            self.tap_and_wait(device, selected, error="PROFILE_ACCOUNT", predicate=lambda screen: self._profile_account(screen))
            self.account_control(self._last_nodes, resource_id="com.instagram.android:id/action_bar_title", error="Instagram active profile account")
            nodes = self._last_nodes
        self._capture_baseline(nodes)
        self._profile_tiles = [self._tile_signature(node) for node in nodes if "reel" in node.get("content-desc", "").casefold()]
        create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)
        if create is None: raise PublisherError("CREATE_CONTROL", "Instagram exact Create New control is absent")
        reel = self.tap_and_wait(device, create, error="REEL_SELECTOR", content_desc="Create new reel")
        gallery_seed = self.tap_and_wait(device, reel, error="GALLERY_MEDIA", predicate=lambda screen: next((item for item in screen if self._is_video_tile(item)), None))
        self._capture_gallery_baseline(self._last_nodes, self._is_video_tile)
        # Back out before the runner transfers media; stale publish screens are never reused.
        if hasattr(device, "back"): device.back()
        else: device.command("shell", "input", "keyevent", "4")
        self._navigate_profile(device)

    def _profile_account(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        title = self.optional_account_control(nodes, resource_id="com.instagram.android:id/action_bar_title", error="Instagram active profile account")
        if title is not None and (title.get("text") == self.expected_account or title.get("content-desc") == self.expected_account):
            return title
        return None

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        self._require_prepared(); validate_caption(job.caption)
        nodes = self._nodes(device)
        if any(node.get("text") == "About Reels" or node.get("resource-id") == "com.instagram.android:id/clips_nux_sheet_share_button" for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "Instagram was already in a publish flow; refusing to resume")
        else:
            duration = job.media.get("duration_seconds") if isinstance(job.media, dict) else None
            if type(duration) is not int or duration <= 0:
                raise PublisherError("MEDIA_METADATA_INVALID", "Instagram requires verified video duration metadata")
            create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)
            if create is None: raise PublisherError("CREATE_CONTROL", "Instagram create is absent after transfer")
            reel = self.tap_and_wait(device, create, error="REEL_SELECTOR", content_desc="Create new reel")
            self.tap_and_wait(device, reel, error="GALLERY_MEDIA", predicate=lambda screen: next((item for item in screen if item.get("content-desc", "").startswith("Video thumbnail")), None)); checkpoint("selecting_media", 25, evidence={"platform": "instagram", "stage": "reel"})
            gallery = self._last_nodes
            media = self._new_gallery_tile(gallery, lambda node: node in self._instagram_video_tiles(gallery, duration), baseline_predicate=self._is_video_tile)
            editor = self.tap_and_wait(device, media, error="EDITOR_NEXT", resource_id="com.instagram.android:id/clips_right_action_button")
            next_screen = self.tap_and_wait(device, editor, error="CAPTION_OR_PRIVACY", predicate=lambda screen: next((item for item in screen if item.get("text") in {"Continue", "Write a caption and add hashtags..."}), None)); checkpoint("editing", 45, evidence={"platform": "instagram", "stage": "editor"})
            if next_screen.get("text") == "Continue":
                # Continue is permitted only when the known privacy sheet is present.
                if not any(item.get("text") == "Downloads privacy" for item in self._last_nodes): raise PublisherError("PRIVACY_DIALOG_UNKNOWN", "Instagram privacy dialog signature is absent")
                field = self.tap_and_wait(device, next_screen, error="CAPTION_FIELD", text="Write a caption and add hashtags...")
            else: field = next_screen
            self.tap_and_wait(device, field, error="CAPTION_ACTIVE_FIELD", predicate=lambda screen: next((item for item in screen if item.get("class", "").endswith("EditText")), None)); self._caption(device, job.caption)
            checkpoint("captioning", 65, evidence={"platform": "instagram", "caption_words": len(job.caption.split())})
            next_button = self._one(self._nodes(device), error="DETAILS_NEXT", text="Next")
            self.tap_and_wait(device, next_button, error="ABOUT_REELS", text="About Reels"); checkpoint("ready_to_publish", 80, evidence={"platform": "instagram", "stage": "about_reels"})
        self._final(device, checkpoint, button={"text": "Share", "resource-id": "com.instagram.android:id/clips_nux_sheet_share_button"}, context={"text": "About Reels"}, evidence={"platform": "instagram", "final": "share"})

    def verify(self, job: Any, device: Any) -> str:
        nodes = self._navigate_profile(device)
        tiles = [node for node in nodes if "reel" in node.get("content-desc", "").casefold()]
        current = [self._tile_signature(node) for node in tiles]
        if len(current) != len(self._profile_tiles) + 1 or current[1:] != self._profile_tiles:
            raise PublisherError("VERIFICATION_NO_DELTA", "Instagram first profile tile must be exactly one new reel with baseline order preserved", retryable=True, final_action_uncertain=True)
        return tiles[0].get("content-desc") or tiles[0].get("text") or "instagram-reel"

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def cleanup_test_post(self, expected_identity: str, baseline: list[str], device: Any) -> None:
        baseline_sequence = list(baseline)
        nodes = self._cleanup_preflight(expected_identity, baseline, device)
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        menu = self.tap_and_wait(device, target, error="REEL_MENU", resource_id="com.instagram.android:id/reel_more_options")
        delete = self.tap_and_wait(device, menu, error="DELETE_ACTION", resource_id="com.instagram.android:id/delete")
        confirm = self.tap_and_wait(device, delete, error="DELETE_CONFIRMATION", resource_id="com.instagram.android:id/delete")
        self.tap_and_wait(device, confirm, error="BASELINE_RELOAD", predicate=lambda screen: next((item for item in screen if (item.get("content-desc") or item.get("text")) in baseline), None))
        restored = self._restored_identities(self._last_nodes)
        if expected_identity in restored or restored != baseline_sequence: raise PublisherError("BASELINE_NOT_RESTORED", "Instagram cleanup did not restore exact ordered baseline")
