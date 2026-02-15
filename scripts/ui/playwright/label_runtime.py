from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable

from playwright.sync_api import Locator, Page, expect


# ==============================================================================
# Test Runner Data
# ==============================================================================


@dataclass
class TestResult:
    name: str
    passed: bool
    duration_ms: float
    message: str = ""


@dataclass
class E2ERunner:
    page: Page
    server_url: str
    api_token: str
    scenarios: list[dict[str, Any]]
    results: list[TestResult] = field(default_factory=list)

    # --------------------------------------------------------------------------
    # Generic test harness helpers
    # --------------------------------------------------------------------------
    def run_test(self, name: str, fn) -> None:
        start = time.monotonic()
        try:
            fn()
            elapsed = (time.monotonic() - start) * 1000
            self.results.append(TestResult(name=name, passed=True, duration_ms=elapsed))
            print(f"[PASS] {name} ({elapsed:.0f}ms)")
        except Exception as exc:
            elapsed = (time.monotonic() - start) * 1000
            self.results.append(
                TestResult(name=name, passed=False, duration_ms=elapsed, message=str(exc))
            )
            print(f"[FAIL] {name} ({elapsed:.0f}ms)")
            print(f"       {exc}")

    def print_summary(self) -> int:
        passed = sum(1 for r in self.results if r.passed)
        failed = sum(1 for r in self.results if not r.passed)
        total = len(self.results)
        print()
        print(f"{passed} passed, {failed} failed out of {total} tests")
        return 0 if failed == 0 else 1

    # --------------------------------------------------------------------------
    # Scenario shortcuts
    # --------------------------------------------------------------------------
    @property
    def simple_chain(self) -> dict[str, Any]:
        return next(s for s in self.scenarios if s["name"] == "simple_chain_4")

    @property
    def diamond(self) -> dict[str, Any]:
        return next(s for s in self.scenarios if s["name"] == "diamond_merge")

    def root_txid(self) -> str:
        return self.simple_chain["root_txid"]

    # --------------------------------------------------------------------------
    # Page interaction helpers
    # --------------------------------------------------------------------------
    def ensure_api_token(self) -> None:
        token_input = self.page.get_by_placeholder("paste token from terminal")
        token_input.fill(self.api_token)

    def search_txid(self, txid: str) -> None:
        search_input = self.page.get_by_placeholder("Enter a txid to explore its spending ancestry...")
        search_input.fill(txid)
        self.page.get_by_role("button", name="Search").click()

    def node_locator(self, txid: str) -> Locator:
        return self.page.locator(f'.react-flow__node[data-id="{txid}"]')

    def label_files_section(self) -> Locator:
        return self.page.locator('details:has(summary:has-text("Label Files"))')

    def selected_editor_section(self) -> Locator:
        return self.page.locator('details:has(summary:has-text("Selected Transaction Editor"))')

    def is_visible(self, locator: Locator) -> bool:
        return locator.count() > 0 and locator.first.is_visible()

    def selected_tx_card(self) -> Locator:
        # Use stable card anchors from TargetLabelEditor instead of matching
        # incidental text/structure in the editor section.
        txid = self.root_txid()
        card = self.selected_editor_section().locator(
            f'[data-testid="target-label-editor"][data-label-type="tx"][data-ref-id="{txid}"]'
        )
        expect(card).to_be_visible(timeout=5000)
        return card

    def wait_until(
        self,
        predicate: Callable[[], bool],
        *,
        timeout_ms: int = 12000,
        step_ms: int = 100,
        failure_message: str,
    ) -> None:
        # Central polling utility so tests can model async UI state transitions
        # with explicit failure messages instead of scattered sleep calls.
        steps = max(1, timeout_ms // step_ms)
        for _ in range(steps):
            if predicate():
                return
            self.page.wait_for_timeout(step_ms)
        assert False, failure_message


def fixture_path() -> Path:
    return Path("tmp") / "e2e_import_fixture.jsonl"
