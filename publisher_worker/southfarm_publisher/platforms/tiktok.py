from __future__ import annotations

from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..models import PublisherError


class TikTokPublisher(GuardedPublisher):
    package = "com.zhiliaoapp.musically"

    def prepare(self, job: Any, device: Any) -> None:
        self._launch(device); nodes = self._nodes(device); self._account(nodes)
        self._capture_baseline(nodes)
        # exact Create is required; Create a Story is a different destructive flow.
        create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create", required=False)
        if create is None: raise PublisherError("CREATE_CONTROL", "TikTok exact Create control is absent")
        self._entry_node = self.tap_and_wait(device, create, error="UPLOAD_SELECTOR", text="Upload")

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        self._require_prepared(); validate_caption(job.caption); nodes = [self._entry_node] if hasattr(self, "_entry_node") else self._nodes(device)
        if any(node.get("text") == "Add description..." for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "TikTok was already in a publish flow; refusing to resume")
        else:
            upload = self._one(nodes, error="UPLOAD_SELECTOR", text="Upload", required=False) or self._one(nodes, error="UPLOAD_SELECTOR", resource_id="com.zhiliaoapp.musically:id/upload_hot_area")
            self.tap_and_wait(device, upload, error="GALLERY_MEDIA", predicate=lambda screen: next((item for item in screen if item.get("resource-id") == "com.zhiliaoapp.musically:id/ica"), None)); checkpoint("selecting_media", 25, evidence={"platform": "tiktok", "baseline": "profile"})
            gallery = self._last_nodes; remote = f"publication-{job.id}-{job.media_id}.{job.media['file_extension']}"
            candidates = [node for node in gallery if node.get("resource-id") == "com.zhiliaoapp.musically:id/ica" and node.get("content-desc") == remote]
            if len(candidates) != 1: raise PublisherError("MEDIA_AMBIGUOUS", "TikTok gallery media is absent or ambiguous")
            next_one = self.tap_and_wait(device, candidates[0], error="GALLERY_NEXT", text="Next (1)")
            editor = self.tap_and_wait(device, next_one, error="EDITOR_NEXT", text="Next")
            self.tap_and_wait(device, editor, error="CAPTION_FIELD", text="Add description..."); checkpoint("editing", 45, evidence={"platform": "tiktok", "stage": "editor"})
        field = self._one(self._last_nodes, error="CAPTION_FIELD", text="Add description...", required=False) or self._one(self._last_nodes, error="CAPTION_FIELD", resource_id="com.zhiliaoapp.musically:id/h00")
        self.tap_and_wait(device, field, error="CAPTION_ACTIVE_FIELD", predicate=lambda screen: next((item for item in screen if item.get("class", "").endswith("EditText")), None)); self._caption(device, job.caption); checkpoint("captioning", 65, evidence={"platform": "tiktok", "caption_words": len(job.caption.split())})
        details = self._nodes(device)
        if not any(node.get("text") in {"Everyone can view this post", "Public"} for node in details): raise PublisherError("VISIBILITY_NOT_PUBLIC", "TikTok public visibility is not explicitly visible")
        checkpoint("ready_to_publish", 80, evidence={"platform": "tiktok", "stage": "details"})
        self._final(device, checkpoint, button={"text": "Post", "resource-id": "com.zhiliaoapp.musically:id/st6"}, context={"text": "Add description..."}, evidence={"platform": "tiktok", "final": "post"})

    def verify(self, job: Any, device: Any) -> str:
        nodes = self._nodes(device)
        profile = self._one(nodes, error="PROFILE_TAB", text="Profile", required=False) or self._one(nodes, error="PROFILE_TAB", content_desc="Profile", required=False)
        if profile is not None:
            self.tap_and_wait(device, profile, error="PROFILE_ACCOUNT", text=self.expected_account)
            nodes = self._last_nodes
        self._account(nodes)
        return self._identity(nodes, job.caption, marker="0")

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def cleanup_test_post(self, expected_identity: str, baseline: set[str], device: Any) -> None:
        nodes = self._cleanup_preflight(expected_identity, baseline, device)
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        menu = self.tap_and_wait(device, target, error="VIDEO_MENU", content_desc="More actions")
        delete = self.tap_and_wait(device, menu, error="DELETE_ACTION", text="Delete")
        confirm = self.tap_and_wait(device, delete, error="DELETE_CONFIRMATION", text="Delete")
        self.tap_and_wait(device, confirm, error="BASELINE_RELOAD", predicate=lambda screen: next((item for item in screen if (item.get("content-desc") or item.get("text")) in baseline), None))
        restored = {value for node in self._last_nodes for value in (node.get("content-desc"), node.get("text")) if value}
        if expected_identity in restored or restored != baseline: raise PublisherError("BASELINE_NOT_RESTORED", "TikTok cleanup did not restore exact baseline")
