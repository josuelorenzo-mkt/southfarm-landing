from __future__ import annotations

from typing import Any, Callable

from .common import GuardedPublisher, validate_caption
from ..adb_device import SafeAdb
from ..models import PublisherError


class TikTokPublisher(GuardedPublisher):
    package = "com.zhiliaoapp.musically"

    @staticmethod
    def _is_video_tile(node: dict[str, str]) -> bool:
        return node.get("resource-id") == "com.zhiliaoapp.musically:id/ica"

    @staticmethod
    def _is_profile_cover(node: dict[str, str]) -> bool:
        return node.get("resource-id") == "com.zhiliaoapp.musically:id/ev2"

    @staticmethod
    def _count_belongs_to_cover(cover: dict[str, str], count: dict[str, str]) -> bool:
        cx1, cy1, cx2, cy2 = SafeAdb.bounds(cover); px1, py1, px2, py2 = SafeAdb.bounds(count)
        return cx1 <= (px1 + px2) // 2 <= cx2 and cy1 <= (py1 + py2) // 2 <= cy2

    def _capture_profile_tiles(self, nodes: list[dict[str, str]]) -> None:
        self._profile_tiles = [self._tile_signature(node) for node in nodes if self._is_profile_cover(node)]

    def _verified_new_profile_tile(self, nodes: list[dict[str, str]]) -> dict[str, str]:
        covers = [node for node in nodes if self._is_profile_cover(node)]
        baseline = getattr(self, "_profile_tiles", [])
        current = [self._tile_signature(node) for node in covers]
        if len(current) != len(baseline) + 1 or current[1:] != baseline:
            raise PublisherError("VERIFICATION_NO_DELTA", "TikTok first profile tile must be exactly one new cover", retryable=True, final_action_uncertain=True)
        candidate = covers[0]
        counts = [node for node in nodes if node.get("resource-id") == "com.zhiliaoapp.musically:id/tv_play_count" and self._count_belongs_to_cover(candidate, node)]
        if len(counts) != 1 or counts[0].get("text") != "0":
            raise PublisherError("VERIFICATION_VIEW_COUNT", "New TikTok cover must have exactly zero visible plays", retryable=True, final_action_uncertain=True)
        return candidate

    def _navigate_profile(self, device: Any) -> list[dict[str, str]]:
        nodes = self._nodes(device)
        profile = self._one(nodes, error="PROFILE_TAB", text="Profile", required=False) or self._one(nodes, error="PROFILE_TAB", content_desc="Profile", required=False)
        if profile is None:
            raise PublisherError("PROFILE_TAB", "TikTok Profile tab is required before account verification")
        self.tap_and_wait(device, profile, error="PROFILE_ACCOUNT", predicate=lambda screen: self._one(screen, error="PROFILE_ACCOUNT", resource_id="com.zhiliaoapp.musically:id/profile_account", required=False) or self._expected_profile_label(screen) or self._one(screen, error="CREATE_CONTROL", content_desc="Create", required=False) or self._one(screen, error="CREATE_CONTROL", text="Create", required=False))
        return self._last_nodes

    def prepare(self, job: Any, device: Any) -> None:
        self.selected_account_username(job)
        self._launch(device); nodes = self._navigate_profile(device)
        profile_account = self._one(nodes, error="PROFILE_ACCOUNT", resource_id="com.zhiliaoapp.musically:id/profile_account", required=False) or self._expected_profile_label(nodes)
        if profile_account is None:
            raise PublisherError("ACCOUNT_UNAVAILABLE", "TikTok profile account label is unavailable")
        if profile_account.get("text") != self.expected_account and profile_account.get("content-desc") != self.expected_account:
            selected = self.tap_and_wait(device, profile_account, error="ACCOUNT_SWITCHER_ITEM", predicate=lambda screen: self.require_account_available(job, screen))
            self.tap_and_wait(device, selected, error="PROFILE_ACCOUNT", predicate=lambda screen: self._profile_account(screen))
            self._account(self._last_nodes)
            nodes = self._last_nodes
        self._capture_baseline(nodes)
        self._capture_profile_tiles(nodes)
        # exact Create is required; Create a Story is a different destructive flow.
        create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create", required=False)
        if create is None: raise PublisherError("CREATE_CONTROL", "TikTok exact Create control is absent")
        upload = self.tap_and_wait(device, create, error="UPLOAD_SELECTOR", text="Upload")
        self.tap_and_wait(device, upload, error="GALLERY_MEDIA", predicate=lambda screen: next((item for item in screen if self._is_video_tile(item)), None))
        self._capture_gallery_baseline(self._last_nodes, self._is_video_tile)
        if hasattr(device, "back"): device.back()
        else: device.command("shell", "input", "keyevent", "4")
        self._navigate_profile(device)

    def _profile_account(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        account = self._one(nodes, error="PROFILE_ACCOUNT", resource_id="com.zhiliaoapp.musically:id/profile_account", required=False) or self._expected_profile_label(nodes)
        if account is not None and (account.get("text") == self.expected_account or account.get("content-desc") == self.expected_account):
            return account
        return None

    def _expected_profile_label(self, nodes: list[dict[str, str]]) -> dict[str, str] | None:
        exact = [node for node in nodes if node.get("text") == self.expected_account or node.get("content-desc") == self.expected_account]
        return exact[0] if len(exact) == 1 else None

    def publish(self, job: Any, device: Any, checkpoint: Callable[..., None]) -> None:
        self._require_prepared(); validate_caption(job.caption); nodes = self._nodes(device)
        if any(node.get("text") == "Add description..." for node in nodes):
            raise PublisherError("MID_FLOW_ABORT", "TikTok was already in a publish flow; refusing to resume")
        else:
            create = self._one(nodes, error="CREATE_CONTROL", content_desc="Create", required=False) or self._one(nodes, error="CREATE_CONTROL", text="Create", required=False)
            if create is None: raise PublisherError("CREATE_CONTROL", "TikTok create is absent after transfer")
            upload = self.tap_and_wait(device, create, error="UPLOAD_SELECTOR", text="Upload")
            self.tap_and_wait(device, upload, error="GALLERY_MEDIA", predicate=lambda screen: next((item for item in screen if item.get("resource-id") == "com.zhiliaoapp.musically:id/ica"), None)); checkpoint("selecting_media", 25, evidence={"platform": "tiktok", "baseline": "profile"})
            gallery = self._last_nodes
            media = self._new_gallery_tile(gallery, self._is_video_tile)
            next_one = self.tap_and_wait(device, media, error="GALLERY_NEXT", text="Next (1)")
            editor = self.tap_and_wait(device, next_one, error="EDITOR_NEXT", text="Next")
            self.tap_and_wait(device, editor, error="CAPTION_FIELD", text="Add description..."); checkpoint("editing", 45, evidence={"platform": "tiktok", "stage": "editor"})
        field = self._one(self._last_nodes, error="CAPTION_FIELD", text="Add description...", required=False) or self._one(self._last_nodes, error="CAPTION_FIELD", resource_id="com.zhiliaoapp.musically:id/h00")
        self.tap_and_wait(device, field, error="CAPTION_ACTIVE_FIELD", predicate=lambda screen: next((item for item in screen if item.get("class", "").endswith("EditText")), None)); self._caption(device, job.caption); checkpoint("captioning", 65, evidence={"platform": "tiktok", "caption_words": len(job.caption.split())})
        details = self._nodes(device)
        if not any(node.get("text") in {"Everyone can view this post", "Public"} for node in details): raise PublisherError("VISIBILITY_NOT_PUBLIC", "TikTok public visibility is not explicitly visible")
        checkpoint("ready_to_publish", 80, evidence={"platform": "tiktok", "stage": "details"})
        self._final(device, checkpoint, button={"text": "Post", "resource-id": "com.zhiliaoapp.musically:id/st6"}, context={"text": "Add description..."}, evidence={"platform": "tiktok", "final": "post"})

    def verify(self, job: Any, device: Any) -> str:
        nodes = self._navigate_profile(device)
        candidate = self._verified_new_profile_tile(nodes)
        return candidate.get("content-desc") or candidate.get("text") or "tiktok-post"

    def cleanup(self, job: Any, device: Any) -> None:
        return None

    def cleanup_test_post(self, expected_identity: str, baseline: list[str], device: Any) -> None:
        baseline_sequence = list(baseline)
        nodes = self._cleanup_preflight(expected_identity, baseline, device)
        target = self._one(nodes, error="CLEANUP_TARGET", content_desc=expected_identity, required=False) or self._one(nodes, error="CLEANUP_TARGET", text=expected_identity)
        menu = self.tap_and_wait(device, target, error="VIDEO_MENU", resource_id="com.zhiliaoapp.musically:id/vbn")
        # Documented actions carousel: swipe before exposing the exact delete control.
        if not hasattr(device, "swipe"): raise PublisherError("ADB_SWIPE_UNAVAILABLE", "TikTok cleanup requires SafeAdb swipe")
        before_swipe = self._nodes(device)
        stale = self._matching_signatures(before_swipe, text=None, content_desc=None, resource_id="com.zhiliaoapp.musically:id/fq5", context=None, predicate=None)
        device.swipe(900, 900, 100, 900, 300)
        delete = self._wait_for_fresh(device, stale, error="DELETE_ACTION", resource_id="com.zhiliaoapp.musically:id/fq5")
        confirm = self.tap_and_wait(device, delete, error="DELETE_CONFIRMATION", resource_id="com.zhiliaoapp.musically:id/fq5")
        self.tap_and_wait(device, confirm, error="BASELINE_RELOAD", predicate=lambda screen: next((item for item in screen if (item.get("content-desc") or item.get("text")) in baseline), None))
        restored = self._restored_identities(self._last_nodes)
        if expected_identity in restored or restored != baseline_sequence: raise PublisherError("BASELINE_NOT_RESTORED", "TikTok cleanup did not restore exact ordered baseline")
