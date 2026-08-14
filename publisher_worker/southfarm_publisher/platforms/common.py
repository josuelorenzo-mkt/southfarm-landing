from __future__ import annotations

import re
import time
from typing import Any, Callable

from ..adb_device import SafeAdb
from ..models import PublisherError


def word_count(caption: str) -> int:
    return len(re.findall(r"\S+", caption or ""))


def validate_caption(caption: str, *, youtube: bool = False) -> None:
    if not 1 <= word_count(caption) <= 10:
        raise PublisherError("CAPTION_INVALID", "Captions must contain between 1 and 10 words")
    if youtube and len(caption) > 100:
        raise PublisherError("CAPTION_TOO_LONG", "YouTube captions must contain at most 100 characters")


def enabled(node: dict[str, str]) -> bool:
    return node.get("enabled", "true").lower() != "false" and node.get("clickable", "true").lower() != "false"


class GuardedPublisher:
    package = ""

    def __init__(self, *, expected_account: str, forbidden_accounts: set[str] | None = None, pause: Callable[[float], None] = time.sleep, timeout: float = 15.0, poll: float = 0.5):
        if not isinstance(expected_account, str) or not expected_account.strip():
            raise PublisherError("ACCOUNT_SNAPSHOT_INVALID", "A non-empty expected social account is required")
        self.expected_account = expected_account.strip()
        self.forbidden_accounts = {item.strip().lstrip('@').casefold() for item in (forbidden_accounts or ()) if item.strip()}
        self._pause, self.timeout, self.poll = pause, max(0.1, float(timeout)), max(0.05, float(poll))
        self._prepared = False
        self._baseline: set[str] = set()

    def _require_package(self, device: Any) -> None:
        current = device.foreground_package()
        if current != self.package:
            raise PublisherError("WRONG_PACKAGE", "Expected social application is not in foreground", retryable=True)

    def _launch(self, device: Any) -> None:
        device.command("shell", "monkey", "-p", self.package, "1")

    def _nodes(self, device: Any) -> list[dict[str, str]]:
        self._require_package(device)
        nodes = device.dump_ui()
        if not isinstance(nodes, list):
            raise PublisherError("UI_DUMP_INVALID", "Device UI dump is invalid", retryable=True)
        self._last_nodes = nodes
        return nodes

    def wait_for(self, device: Any, *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, context: dict[str, str] | None = None, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None] | None = None, clock: Callable[[], float] = time.monotonic) -> dict[str, str]:
        deadline = clock() + self.timeout
        while True:
            nodes = self._nodes(device)
            if predicate is not None:
                found = predicate(nodes)
                if found is not None: return found
            elif context is None or any(all(item.get(key) == value for key, value in context.items()) for item in nodes):
                found = self._one(nodes, error=error, text=text, content_desc=content_desc, resource_id=resource_id, required=False)
                if found is not None: return found
            if clock() >= deadline: raise PublisherError("UI_TIMEOUT", f"Timed out waiting for {error}", retryable=True)
            self._pause(self.poll)

    @staticmethod
    def _matches(node: dict[str, str], *, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None) -> bool:
        return (text is None or node.get("text") == text) and (content_desc is None or node.get("content-desc") == content_desc) and (resource_id is None or node.get("resource-id") == resource_id)

    def _one(self, nodes: list[dict[str, str]], *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, required: bool = True) -> dict[str, str] | None:
        matches = [node for node in nodes if self._matches(node, text=text, content_desc=content_desc, resource_id=resource_id)]
        if len(matches) > 1:
            raise PublisherError("SELECTOR_COLLISION", f"Ambiguous {error} selector")
        if not matches:
            if required: raise PublisherError(error, f"Required {error} control is absent", retryable=True)
            return None
        if not enabled(matches[0]): raise PublisherError("CONTROL_DISABLED", f"Required {error} control is disabled")
        SafeAdb.bounds(matches[0])
        return matches[0]

    def _tap(self, device: Any, node: dict[str, str]) -> None:
        device.tap_bounds(SafeAdb.bounds(node))

    def tap_and_wait(self, device: Any, node: dict[str, str], *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, context: dict[str, str] | None = None, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None] | None = None) -> dict[str, str]:
        """Perform one reversible navigation tap, then require a fresh next screen."""
        # An ADB tap returning successfully is not evidence that the app accepted it.
        # Take an immediately-before dump and refuse to accept a target from that
        # same UI revision (for example a stale dialog already left on screen).
        before = self._nodes(device)
        selected = self._one(before, error="STALE_CONTROL", text=node.get("text"), content_desc=node.get("content-desc"), resource_id=node.get("resource-id"))
        before_targets = self._matching_signatures(before, text=text, content_desc=content_desc, resource_id=resource_id, context=context, predicate=predicate)
        self._tap(device, selected)
        return self._wait_for_fresh(device, before_targets, error=error, text=text, content_desc=content_desc, resource_id=resource_id, context=context, predicate=predicate)

    @staticmethod
    def _node_fingerprint(node: dict[str, str]) -> tuple[tuple[str, str], ...]:
        # Geometry and transient widget state may drift without navigation.  A
        # logical target is defined only by stable semantic identity.
        ignored = {"bounds", "enabled", "clickable", "focused", "selected", "checked", "index"}
        return tuple(sorted((str(key), str(value)) for key, value in node.items() if key not in ignored))

    def _matching_signatures(self, nodes: list[dict[str, str]], *, text: str | None, content_desc: str | None, resource_id: str | None, context: dict[str, str] | None, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None] | None) -> set[tuple[tuple[str, str], ...]]:
        if predicate is not None:
            try:
                found = predicate(nodes)
            except PublisherError:
                found = None
        elif context is None or any(all(item.get(key) == value for key, value in context.items()) for item in nodes):
            matches = [node for node in nodes if self._matches(node, text=text, content_desc=content_desc, resource_id=resource_id)]
            found = matches[0] if len(matches) == 1 else None
        else:
            found = None
        return {self._node_fingerprint(found)} if found is not None else set()

    def _wait_for_fresh(self, device: Any, before_targets: set[tuple[tuple[str, str], ...]], *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, context: dict[str, str] | None = None, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None] | None = None, clock: Callable[[], float] = time.monotonic) -> dict[str, str]:
        deadline = clock() + self.timeout
        target_disappeared = not before_targets
        while True:
            nodes = self._nodes(device)
            if predicate is not None:
                found = predicate(nodes)
            elif context is None or any(all(item.get(key) == value for key, value in context.items()) for item in nodes):
                found = self._one(nodes, error=error, text=text, content_desc=content_desc, resource_id=resource_id, required=False)
            else:
                found = None
            if found is None:
                target_disappeared = True
            else:
                signature = self._node_fingerprint(found)
                if target_disappeared or signature not in before_targets:
                    return found
            if clock() >= deadline:
                raise PublisherError("UI_TIMEOUT", f"Timed out waiting for fresh {error}", retryable=True)
            self._pause(self.poll)

    def _account(self, nodes: list[dict[str, str]]) -> None:
        if self.expected_account.lstrip('@').casefold() in self.forbidden_accounts:
            raise PublisherError("FORBIDDEN_ACCOUNT", "This social account is forbidden for publishing")
        exact = [node for node in nodes if node.get("text") == self.expected_account or node.get("content-desc") == self.expected_account]
        if len(exact) != 1:
            raise PublisherError("ACCOUNT_MISMATCH", "Expected authenticated account label is absent or ambiguous")

    def selected_account_username(self, job: Any) -> str:
        """Validate the immutable selected-account snapshot before any UI action."""
        account = getattr(job, "account", None)
        username = account.get("username") if isinstance(account, dict) else None
        if not isinstance(username, str) or not username.strip():
            raise PublisherError("ACCOUNT_SNAPSHOT_INVALID", "Publication job lacks a safe expected account")
        if username != self.expected_account:
            raise PublisherError("ACCOUNT_MISMATCH", "Publication account snapshot does not match the configured adapter")
        if self.expected_account.lstrip('@').casefold() in self.forbidden_accounts:
            raise PublisherError("FORBIDDEN_ACCOUNT", "This social account is forbidden for publishing")
        return username

    def require_account_available(self, job: Any, nodes: list[dict[str, str]]) -> dict[str, str]:
        """Require one exact match for the immutable account snapshot in a switcher."""
        username = self.selected_account_username(job)
        exact = [node for node in nodes if node.get("text") == username or node.get("content-desc") == username]
        clickable = [node for node in exact if node.get("clickable", "true").lower() != "false"]
        if clickable:
            if len(clickable) != 1 or not enabled(clickable[0]):
                raise PublisherError("ACCOUNT_UNAVAILABLE", "The selected scanned account is unavailable on this device")
            return clickable[0]
        if len(exact) != 1:
            raise PublisherError("ACCOUNT_UNAVAILABLE", "The selected scanned account is unavailable on this device")
        return exact[0]

    def account_control(self, nodes: list[dict[str, str]], *, resource_id: str, error: str) -> dict[str, str]:
        """Return exactly one account-scoped control, otherwise fail closed."""
        matches = [node for node in nodes if node.get("resource-id") == resource_id]
        if len(matches) != 1:
            raise PublisherError("ACCOUNT_UNAVAILABLE", f"{error} is absent or ambiguous")
        if not enabled(matches[0]):
            raise PublisherError("ACCOUNT_UNAVAILABLE", f"{error} is unavailable")
        SafeAdb.bounds(matches[0])
        return matches[0]

    def optional_account_control(self, nodes: list[dict[str, str]], *, resource_id: str, error: str) -> dict[str, str] | None:
        matches = [node for node in nodes if node.get("resource-id") == resource_id]
        if len(matches) > 1:
            raise PublisherError("ACCOUNT_UNAVAILABLE", f"{error} is ambiguous")
        return matches[0] if matches else None

    def select_account(self, job: Any, device: Any) -> None:
        """Validate the selected scanned account before a platform-specific switch."""
        self.require_account_available(job, self._nodes(device))

    def _capture_baseline(self, nodes: list[dict[str, str]]) -> None:
        self._baseline = {value for node in nodes for value in (node.get("content-desc"), node.get("text")) if value}
        self._prepared = True

    @staticmethod
    def _tile_signature(node: dict[str, str]) -> tuple[str, str, str, str]:
        # Bounds are display positions, not a media identity: inserting a first
        # tile shifts every existing item.  Keep only stable UI identity fields.
        return (node.get("resource-id", ""), node.get("content-desc", ""), node.get("text", ""), node.get("class", ""))

    def _capture_gallery_baseline(self, nodes: list[dict[str, str]], predicate: Callable[[dict[str, str]], bool]) -> None:
        self._gallery_baseline = [self._tile_signature(node) for node in nodes if predicate(node)]

    def _new_gallery_tile(self, nodes: list[dict[str, str]], predicate: Callable[[dict[str, str]], bool], *, baseline_predicate: Callable[[dict[str, str]], bool] | None = None) -> dict[str, str]:
        candidates = [node for node in nodes if (baseline_predicate or predicate)(node)]
        current = [self._tile_signature(node) for node in candidates]
        baseline = getattr(self, "_gallery_baseline", [])
        if len(current) != len(baseline) + 1 or current[1:] != baseline:
            if len(current) <= len(baseline):
                raise PublisherError("MEDIA_BASELINE_MISSING", "Gallery baseline changed unexpectedly")
            raise PublisherError("MEDIA_BASELINE_ORDER_CHANGED", "Gallery baseline order changed unexpectedly")
        if not predicate(candidates[0]):
            raise PublisherError("MEDIA_AMBIGUOUS", "The new first gallery tile does not match expected media")
        self._chosen_tile = current[0]
        return candidates[0]

    def _require_prepared(self) -> None:
        if not self._prepared:
            raise PublisherError("FLOW_NOT_PREPARED", "Publication must begin from the verified account profile and baseline")

    def _caption(self, device: Any, caption: str, *, youtube: bool = False) -> None:
        validate_caption(caption, youtube=youtube)
        words = caption.split()
        for index, word in enumerate(words):
            device.text((" " if index else "") + word)
            nodes = self._nodes(device)
            expected = " ".join(words[:index + 1])
            fields = [node for node in nodes if node.get("class", "").endswith("EditText")]
            if len(fields) != 1:
                raise PublisherError("CAPTION_NOT_OBSERVABLE", "Active caption field is absent or ambiguous")
            observed = " ".join((fields[0].get("text") or fields[0].get("content-desc") or "").split())
            if observed != expected:
                raise PublisherError("CAPTION_DIVERGED", "Caption text diverged before publishing")

    def _final(self, device: Any, checkpoint: Callable[..., None], *, button: dict[str, str], context: dict[str, str], evidence: dict[str, Any]) -> None:
        # Context and final button must occur in the same fresh dump.  The checkpoint
        # is intentionally before the one irreversible tap; a thrown checkpoint leaves it untouched.
        nodes = self._nodes(device)
        if not any(all(node.get(key) == value for key, value in context.items()) for node in nodes):
            raise PublisherError("FINAL_CONTEXT_MISSING", "Final publish context is absent")
        selected = self._one(nodes, error="FINAL_ACTION", text=button.get("text"), content_desc=button.get("content-desc"), resource_id=button.get("resource-id"))
        checkpoint("publishing", 90, final_action=True, evidence=evidence)
        self._tap(device, selected)

    def _identity(self, nodes: list[dict[str, str]], caption: str, *, marker: str) -> str:
        prefix = caption.strip().lower()
        matches = []
        for node in nodes:
            value = f"{node.get('text', '')} {node.get('content-desc', '')}".lower()
            if prefix in value and marker.lower() in value:
                matches.append(node)
        if len(matches) != 1:
            raise PublisherError("VERIFICATION_MISSING", "The exact newly published item is not uniquely visible", retryable=True, final_action_uncertain=True)
        identity = matches[0].get("content-desc") or matches[0].get("text") or caption
        if identity in self._baseline:
            raise PublisherError("VERIFICATION_NO_DELTA", "The matching item predates this publication", retryable=True, final_action_uncertain=True)
        return identity

    def _cleanup_preflight(self, expected_identity: str, baseline: list[str], device: Any) -> list[dict[str, str]]:
        if not isinstance(baseline, list):
            raise PublisherError("CLEANUP_BASELINE_INVALID", "Cleanup baseline must preserve ordered identities and duplicates")
        baseline_sequence = list(baseline)
        if not expected_identity or expected_identity in baseline:
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Cleanup identity must be a new verified item")
        nodes = self._nodes(device); self._account(nodes)
        identities = [node.get("content-desc") or node.get("text") for node in nodes if (node.get("content-desc") or node.get("text")) and (node.get("content-desc") or node.get("text")) not in {"More actions", "More options"}]
        expected = list(baseline_sequence)
        account_index = expected.index(self.expected_account) if self.expected_account in expected else 0
        expected.insert(account_index + 1, expected_identity)
        if identities != expected:
            raise PublisherError("CLEANUP_IDENTITY_MISMATCH", "Cleanup screen must contain exactly baseline plus verified item")
        return nodes

    @staticmethod
    def _restored_identities(nodes: list[dict[str, str]]) -> list[str]:
        return [node.get("content-desc") or node.get("text") for node in nodes if (node.get("content-desc") or node.get("text")) and (node.get("content-desc") or node.get("text")) not in {"More actions", "More options"}]
