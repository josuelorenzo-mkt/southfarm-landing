from __future__ import annotations

from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..models import PublisherError


class InstagramPublisher(GuardedPublisher):
    package = "com.instagram.android"

    @staticmethod
    def _is_video_tile(node: dict[str, str]) -> bool:
        return node.get("content-desc", "").startswith("Video thumbnail")

    @staticmethod
    def _duration_formats(duration: int) -> set[str]:
        minutes, seconds = divmod(duration, 60)
        return {f"{minutes}:{seconds:02d}", f"{duration} seconds", f"{duration} second"}

    def prepare(self, job: Any, device: Any) -> None:
        self._launch(device); nodes = self._nodes(device); self._account(nodes)
        self._capture_baseline(nodes)
        self._profile_tiles = {self._tile_signature(node) for node in nodes if "reel" in node.get("content-desc", "").casefold()}
        create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)
        if create is None: raise PublisherError("CREATE_CONTROL", "Instagram exact Create New control is absent")
        reel = self.tap_and_wait(device, create, error="REEL_SELECTOR", content_desc="Create new reel")
        gallery_seed = self.tap_and_wait(device, reel, error="GALLERY_MEDIA", predicate=lambda screen: next((item for item in screen if self._is_video_tile(item)), None))
        self._capture_gallery_baseline(self._last_nodes, self._is_video_tile)
        # Back out before the runner transfers media; stale publish screens are never reused.
        if hasattr(device, "back"): device.back()
        else: device.command("shell", "input", "keyevent", "4")
        profile = self.wait_for(device, error="PROFILE_RETURN", text=self.expected_account)
        self._account(self._last_nodes)

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
            duration_marker = f"0:{duration:02d}"
            media = self._new_gallery_tile(gallery, lambda node: self._is_video_tile(node) and any(item in node.get("content-desc", "") for item in self._duration_formats(duration)))
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
        nodes = self._nodes(device)
        profile = self._one(nodes, error="PROFILE_TAB", text="Profile", required=False) or self._one(nodes, error="PROFILE_TAB", content_desc="Profile", required=False)
        if profile is None: raise PublisherError("PROFILE_TAB", "Instagram Profile tab is required for verification", retryable=True, final_action_uncertain=True)
        self.tap_and_wait(device, profile, error="PROFILE_ACCOUNT", text=self.expected_account)
        nodes = self._last_nodes
        self._account(nodes)
        candidates = [node for node in nodes if "reel" in node.get("content-desc", "").casefold() and self._tile_signature(node) not in self._profile_tiles]
        if len(candidates) != 1: raise PublisherError("VERIFICATION_NO_DELTA", "Instagram profile must show exactly one new reel tile", retryable=True, final_action_uncertain=True)
        return candidates[0].get("content-desc") or candidates[0].get("text") or "instagram-reel"

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def cleanup_test_post(self, expected_identity: str, baseline: set[str], device: Any) -> None:
        nodes = self._cleanup_preflight(expected_identity, baseline, device)
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        menu = self.tap_and_wait(device, target, error="REEL_MENU", resource_id="com.instagram.android:id/reel_more_options")
        delete = self.tap_and_wait(device, menu, error="DELETE_ACTION", resource_id="com.instagram.android:id/delete")
        confirm = self.tap_and_wait(device, delete, error="DELETE_CONFIRMATION", resource_id="com.instagram.android:id/delete")
        self.tap_and_wait(device, confirm, error="BASELINE_RELOAD", predicate=lambda screen: next((item for item in screen if (item.get("content-desc") or item.get("text")) in baseline), None))
        restored = {value for node in self._last_nodes for value in (node.get("content-desc"), node.get("text")) if value}
        if expected_identity in restored or restored != baseline: raise PublisherError("BASELINE_NOT_RESTORED", "Instagram cleanup did not restore exact baseline")
