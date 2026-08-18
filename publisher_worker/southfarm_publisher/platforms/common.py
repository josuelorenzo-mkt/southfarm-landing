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
    # YouTube Shorts hard-limits captions to 100 characters.  The limit is
    # platform-specific and shares the CAPTION_INVALID code (never retryable):
    # Instagram and TikTok have no documented character cap, so their
    # validation is the shared 10-word rule only.
    if youtube and len(caption) > 100:
        raise PublisherError("CAPTION_INVALID", "YouTube Shorts captions must contain at most 100 characters")


def enabled(node: dict[str, str]) -> bool:
    return node.get("enabled", "true").lower() != "false" and node.get("clickable", "true").lower() != "false"


class GuardedPublisher:
    package = ""

    # Physical display of the target device family (720x1640).  Bounds-driven
    # taps must stay inside it: the on-device accessibility service serves
    # occasional stale, out-of-viewport geometry in otherwise fresh dumps
    # (live2 profile-grid spans like [-2160,415]; live4 gallery tiles ~1432px
    # below their real position) that self-corrects seconds later.
    viewport: tuple[int, int] = (720, 1640)

    def __init__(self, *, expected_account: str, forbidden_accounts: set[str] | None = None, pause: Callable[[float], None] = time.sleep, timeout: float = 15.0, poll: float = 0.5, viewport: tuple[int, int] | None = None):
        if not isinstance(expected_account, str) or not expected_account.strip():
            raise PublisherError("ACCOUNT_SNAPSHOT_INVALID", "A non-empty expected social account is required")
        self.expected_account = expected_account.strip()
        self.forbidden_accounts = {item.strip().lstrip('@').casefold() for item in (forbidden_accounts or ()) if item.strip()}
        self._pause, self.timeout, self.poll = pause, max(0.1, float(timeout)), max(0.05, float(poll))
        if viewport is not None:
            if not (isinstance(viewport, tuple) and len(viewport) == 2 and all(isinstance(value, int) and value > 0 for value in viewport)):
                raise PublisherError("CONFIG_INVALID", "viewport must be a positive integer (width, height) pair")
            self.viewport = viewport
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
    def _node_in_package(node: dict[str, str], package: str) -> bool:
        """Require `node` to belong to `package`, making foreign-package
        controls (SystemUI navbar, launcher) invisible to the selector.

        Live uiautomator dumps carry a `package` attribute on every node:
        when present it must equal the target exactly, so a SystemUI
        "Home" navbar button can never collide with the app's own Home tab.
        Synthetic test nodes and older fixtures predate that attribute, so
        the resource-id prefix is the fallback identity gate (real
        resource-ids always start with "<package>:id/...").  A node with
        neither attribute (a bare text/content-desc match) still passes --
        on the real device the service always supplies the package, so this
        fallback can only materialize in unit fixtures.
        """
        node_package = node.get("package")
        if node_package is not None and node_package != package:
            return False
        resource_id = node.get("resource-id") or ""
        if resource_id and not resource_id.startswith(package + ":"):
            return False
        return True

    @staticmethod
    def _matches(node: dict[str, str], *, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, package: str | None = None) -> bool:
        return (text is None or node.get("text") == text) and (content_desc is None or node.get("content-desc") == content_desc) and (resource_id is None or node.get("resource-id") == resource_id) and (package is None or GuardedPublisher._node_in_package(node, package))

    def _one(self, nodes: list[dict[str, str]], *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, package: str | None = None, required: bool = True) -> dict[str, str] | None:
        matches = [node for node in nodes if self._matches(node, text=text, content_desc=content_desc, resource_id=resource_id, package=package)]
        if len(matches) > 1:
            raise PublisherError("SELECTOR_COLLISION", f"Ambiguous {error} selector")
        if not matches:
            if required: raise PublisherError(error, f"Required {error} control is absent", retryable=True)
            return None
        if self._clickable_target(matches[0], nodes) is None:
            raise PublisherError("CONTROL_DISABLED", f"Required {error} control is disabled")
        SafeAdb.bounds(matches[0])
        return matches[0]

    def _parent_node(self, node: dict[str, str], nodes: list[dict[str, str]]) -> dict[str, str] | None:
        """Immediate container of `node` in a flat accessibility dump.

        The dump is a flat pre-order document: a node's parent is the
        narrowest node that appears earlier in the document and strictly
        contains the node's center.  Stacked equal-area wrappers resolve to
        the deepest (latest) copy, so walking parents terminates through
        zero-size containers.
        """
        try:
            x1, y1, x2, y2 = SafeAdb.bounds(node)
        except PublisherError:
            return None
        center_x, center_y = (x1 + x2) // 2, (y1 + y2) // 2
        try:
            position = nodes.index(node)
        except ValueError:
            position = len(nodes)
        parent: dict[str, str] | None = None
        parent_area: int | None = None
        parent_position = -1
        for current_position, candidate in enumerate(nodes[:position]):
            if candidate is node:
                continue
            try:
                cx1, cy1, cx2, cy2 = SafeAdb.bounds(candidate)
            except PublisherError:
                continue
            if not (cx1 <= center_x <= cx2 and cy1 <= center_y <= cy2):
                continue
            area = (cx2 - cx1) * (cy2 - cy1)
            if parent_area is None or area < parent_area or (area == parent_area and current_position > parent_position):
                parent, parent_area, parent_position = candidate, area, current_position
        return parent

    def _clickable_target(self, node: dict[str, str], nodes: list[dict[str, str]], *, max_ancestors: int = 4) -> dict[str, str] | None:
        """Actionable tap target for a control matched by semantic identity.

        A node that is already clickable and enabled is its own target.  A
        non-clickable leaf is rescued through its nearest clickable ancestor
        (live TikTok build: the editor "Next" TextView reports
        clickable=false while its LinearLayout parent carries the tap),
        walking at most `max_ancestors` levels up the flat dump.  An ancestor
        whose bounds are invalid or outside the viewport, or a
        clickable-but-disabled ancestor, discards the target (fail-closed):
        None means the control cannot be tapped safely, and callers either
        raise CONTROL_DISABLED or discard the candidate.
        """
        if enabled(node):
            return node
        if node.get("clickable", "true").lower() != "false":
            # Clickable but disabled: the control itself refuses the tap and
            # a larger container must never be tapped instead.
            return None
        current = node
        for _ in range(max(1, int(max_ancestors))):
            parent = self._parent_node(current, nodes)
            if parent is None:
                return None
            if not self._bounds_inside_viewport(parent):
                return None
            if parent.get("clickable", "true").lower() != "false":
                return parent if enabled(parent) else None
            current = parent
        return None

    def _tap(self, device: Any, node: dict[str, str]) -> None:
        device.tap_bounds(SafeAdb.bounds(node))

    @staticmethod
    def _same_control(node: dict[str, str], template: dict[str, str]) -> bool:
        # Logical control identity is semantic only.  Bounds are deliberately
        # excluded: re-localization exists to REPLACE the possibly stale
        # arrival geometry with the fresh dump's.
        return (node.get("resource-id") == template.get("resource-id")
                and node.get("content-desc") == template.get("content-desc")
                and node.get("text") == template.get("text"))

    def _bounds_inside_viewport(self, node: dict[str, str]) -> bool:
        # Fail-closed geometry gate: a tap may only land on a control whose
        # bounds sit FULLY inside the physical viewport.  Fully-outside AND
        # partially-outside bounds are rejected -- partial visibility cannot
        # prove that the tap lands on the intended control.
        try:
            x1, y1, x2, y2 = SafeAdb.bounds(node)
        except PublisherError:
            return False
        width, height = self.viewport
        return x1 >= 0 and y1 >= 0 and x2 <= width and y2 <= height

    def _fresh_tap_target(self, device: Any, node: dict[str, str], *, re_dumps: int = 2) -> dict[str, str] | None:
        """Re-locate `node` on a fresh dump; accept only in-viewport bounds.

        The accessibility service occasionally serves stale out-of-viewport
        geometry in fresh dumps (live4: an Instagram gallery tile arrived
        ~1432px below its real position and self-corrected seconds later), so
        tap geometry must NEVER come from the arrival dump.  This helper
        requests up to `re_dumps` fresh dumps, re-locates the node by its
        semantic identity (resource-id + content-desc + text) and, when the
        leaf is not itself clickable, re-resolves its nearest clickable
        ancestor over the SAME fresh dump (the ancestor may shift bounds
        between dumps).  The resolved target is accepted only with bounds
        fully inside the viewport.  A node that disappears, an ancestor with
        off-viewport bounds, or a leaf without any clickable ancestor within
        the configured levels yields None so the caller discards the
        candidate instead of dispatching a blind or out-of-viewport tap.
        """
        for _ in range(max(1, int(re_dumps))):
            fresh_nodes = self._nodes(device)
            fresh = next((item for item in fresh_nodes if self._same_control(item, node)), None)
            if fresh is None:
                continue
            target = self._clickable_target(fresh, fresh_nodes)
            if target is not None and self._bounds_inside_viewport(target):
                return target
        return None

    def tap_and_wait(self, device: Any, node: dict[str, str], *, error: str, text: str | None = None, content_desc: str | None = None, resource_id: str | None = None, context: dict[str, str] | None = None, predicate: Callable[[list[dict[str, str]]], dict[str, str] | None] | None = None) -> dict[str, str]:
        """Perform one reversible navigation tap, then require a fresh next screen."""
        # An ADB tap returning successfully is not evidence that the app accepted it.
        # Take an immediately-before dump and refuse to accept a target from that
        # same UI revision (for example a stale dialog already left on screen).
        before = self._nodes(device)
        selected = self._one(before, error="STALE_CONTROL", text=node.get("text"), content_desc=node.get("content-desc"), resource_id=node.get("resource-id"))
        before_targets = self._matching_signatures(before, text=text, content_desc=content_desc, resource_id=resource_id, context=context, predicate=predicate)
        self._tap(device, self._clickable_target(selected, before) or selected)
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
        """Return exactly one account identity label, otherwise fail closed."""
        matches = [node for node in nodes if node.get("resource-id") == resource_id]
        if len(matches) != 1:
            raise PublisherError("ACCOUNT_UNAVAILABLE", f"{error} is absent or ambiguous")
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
        self._tap(device, self._clickable_target(selected, nodes) or selected)

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
