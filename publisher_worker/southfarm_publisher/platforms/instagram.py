from __future__ import annotations

from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..models import PublisherError


class InstagramPublisher(GuardedPublisher):
    package = "com.instagram.android"

    def prepare(self, job: Any, device: Any) -> None:
        self._launch(device); nodes = self._nodes(device); self._account(nodes)
        self._capture_baseline(nodes)
        create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create New", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create New", required=False)
        if create: self._tap(device, create)

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        self._require_prepared(); validate_caption(job.caption)
        nodes = self._nodes(device)
        if any(node.get("text") == "About Reels" or node.get("resource-id") == "com.instagram.android:id/clips_nux_sheet_share_button" for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "Instagram was already in a publish flow; refusing to resume")
        else:
            duration = job.media.get("duration_seconds") if isinstance(job.media, dict) else None
            if type(duration) is not int or duration <= 0:
                raise PublisherError("MEDIA_METADATA_INVALID", "Instagram requires verified video duration metadata")
            reel = self._one(nodes, error="REEL_SELECTOR", content_desc="Create new reel", required=False) or self._one(nodes, error="REEL_SELECTOR", text="Reel")
            self.tap_and_wait(device, reel, error="GALLERY_MEDIA", predicate=lambda screen: next((item for item in screen if item.get("content-desc", "").startswith("Video thumbnail")), None)); checkpoint("selecting_media", 25, evidence={"platform": "instagram", "stage": "reel"})
            gallery = self._last_nodes
            duration_marker = f"0:{duration:02d}"
            media = [node for node in gallery if node.get("content-desc", "").startswith("Video thumbnail") and duration_marker in node.get("content-desc", "")]
            if len(media) != 1: raise PublisherError("MEDIA_AMBIGUOUS", "Instagram gallery lacks one verified new video thumbnail")
            editor = self.tap_and_wait(device, media[0], error="EDITOR_NEXT", resource_id="com.instagram.android:id/clips_right_action_button")
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
        if profile is not None:
            self.tap_and_wait(device, profile, error="PROFILE_ACCOUNT", text=self.expected_account)
            nodes = self._last_nodes
        self._account(nodes)
        return self._identity(nodes, job.caption, marker="reel")

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def cleanup_test_post(self, expected_identity: str, baseline: set[str], device: Any) -> None:
        nodes = self._cleanup_preflight(expected_identity, baseline, device)
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        menu = self.tap_and_wait(device, target, error="REEL_MENU", content_desc="More options")
        delete = self.tap_and_wait(device, menu, error="DELETE_ACTION", text="Delete")
        confirm = self.tap_and_wait(device, delete, error="DELETE_CONFIRMATION", text="Delete")
        self.tap_and_wait(device, confirm, error="BASELINE_RELOAD", predicate=lambda screen: next((item for item in screen if (item.get("content-desc") or item.get("text")) in baseline), None))
        restored = {value for node in self._last_nodes for value in (node.get("content-desc"), node.get("text")) if value}
        if expected_identity in restored or restored != baseline: raise PublisherError("BASELINE_NOT_RESTORED", "Instagram cleanup did not restore exact baseline")
