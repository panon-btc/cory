#!/usr/bin/env python3
"""
Playwright E2E tests for the label workflow in the Cory UI.

Exercises the full label lifecycle through a real browser: file creation,
import, export, per-node label editing with autosave, and removal.
Requires: `uv pip install playwright && playwright install chromium`.
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

# scripts/ui/playwright/ → scripts/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from common import (
    log,
    make_config,
    mine_to_wallet,
    pick_free_port,
    start_bitcoind,
    start_cory,
    stop_process,
    wait_for_health,
)

# Reuse scenario builder from the manual fixtures script.
from ui.manual_fixtures import build_scenarios

try:
    from playwright.sync_api import sync_playwright, expect, Page
except ImportError:
    print("playwright is not installed. Run: uv pip install playwright && playwright install chromium")
    sys.exit(1)


# ==============================================================================
# Test infrastructure
# ==============================================================================

@dataclass
class TestResult:
    name: str
    passed: bool
    duration_ms: float
    message: str = ""


@dataclass
class E2ERunner:
    """Holds browser page, server details, and scenario data. Collects test results."""

    page: Page
    server_url: str
    api_token: str
    scenarios: list[dict[str, Any]]
    results: list[TestResult] = field(default_factory=list)

    def run_test(self, name: str, fn):
        """Execute a single test function, recording pass/fail and timing."""
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

    # -- Helpers ---------------------------------------------------------------

    @property
    def simple_chain(self) -> dict[str, Any]:
        return next(s for s in self.scenarios if s["name"] == "simple_chain_4")

    @property
    def diamond(self) -> dict[str, Any]:
        return next(s for s in self.scenarios if s["name"] == "diamond_merge")

    def root_txid(self) -> str:
        return self.simple_chain["root_txid"]

    def second_txid(self) -> str:
        """A txid from the simple chain that is not the root (for multi-node tests)."""
        related = self.simple_chain["related_txids"]
        return related[-2] if len(related) >= 2 else related[0]

    def search_txid(self, txid: str) -> None:
        """Enter a txid in the header search and trigger search."""
        search_input = self.page.get_by_placeholder(
            "Enter a txid to explore its spending ancestry..."
        )
        search_input.fill(txid)
        self.page.get_by_role("button", name="Search").click()

    def enter_api_token(self) -> None:
        """Paste the API token into the header token input."""
        token_input = self.page.get_by_placeholder("paste token from terminal")
        token_input.fill(self.api_token)

    def panel(self):
        """Return a locator scoped to the label panel (right sidebar)."""
        return self.page.locator('h3:has-text("Label Files")').locator("..")

    def node_locator(self, txid: str):
        """Return a locator for a React Flow node by its data-id (txid)."""
        return self.page.locator(f'.react-flow__node[data-id="{txid}"]')


# ==============================================================================
# Individual tests
# ==============================================================================

def test_graph_renders_after_search(r: E2ERunner) -> None:
    r.page.goto(r.server_url)
    r.enter_api_token()
    r.search_txid(r.root_txid())

    # Wait for graph nodes to appear.
    r.page.locator(".react-flow__node").first.wait_for(state="visible", timeout=15000)
    node_count = r.page.locator(".react-flow__node").count()
    assert node_count > 0, f"Expected graph nodes, got {node_count}"

    # Stats overlay should mention "transactions".
    stats = r.page.get_by_text("transactions")
    expect(stats).to_be_visible(timeout=5000)


def test_empty_label_state(r: E2ERunner) -> None:
    # Panel should show empty state before any label files exist.
    panel = r.panel()
    expect(panel.get_by_text("No local label files loaded.")).to_be_visible(timeout=5000)

    # Nodes should show the "create first" message since no local files loaded.
    node = r.node_locator(r.root_txid())
    expect(node.get_by_text("Create or import a label file first.")).to_be_visible(timeout=5000)


def test_create_label_file(r: E2ERunner) -> None:
    panel = r.panel()
    panel.get_by_placeholder("New file name").fill("test-labels")
    panel.get_by_role("button", name="Create").click()

    # File should appear in the list with "0 labels".
    expect(panel.get_by_text("test-labels")).to_be_visible(timeout=5000)
    expect(panel.get_by_text("0 labels")).to_be_visible(timeout=5000)


def test_duplicate_create_fails(r: E2ERunner) -> None:
    panel = r.panel()
    panel.get_by_placeholder("New file name").fill("test-labels")
    panel.get_by_role("button", name="Create").click()

    # Panel should show an error about creation failure.
    error_text = panel.locator("p").filter(has_text="Create failed")
    expect(error_text).to_be_visible(timeout=5000)


def test_import_jsonl(r: E2ERunner) -> None:
    panel = r.panel()

    # The hidden file input is the one we need to interact with.
    file_input = panel.locator('input[type="file"]')
    fixture_path = _fixture_path()
    file_input.set_input_files(str(fixture_path))

    # The import name is the filename without the .jsonl extension:
    # "e2e_import_fixture.jsonl" → "e2e_import_fixture".
    expect(panel.get_by_text("e2e_import_fixture")).to_be_visible(timeout=5000)
    expect(panel.get_by_text("2 labels")).to_be_visible(timeout=5000)


def test_duplicate_import_fails(r: E2ERunner) -> None:
    panel = r.panel()

    # Capture alert dialog message.
    alert_messages: list[str] = []

    def handle_dialog(dialog):
        alert_messages.append(dialog.message)
        dialog.accept()

    r.page.on("dialog", handle_dialog)

    file_input = panel.locator('input[type="file"]')
    fixture_path = _fixture_path()
    file_input.set_input_files(str(fixture_path))

    # Wait for the error to appear in the panel.
    error_text = panel.locator("p").filter(has_text="already exists")
    expect(error_text).to_be_visible(timeout=5000)

    # Also verify the alert was shown.
    assert any(
        "already exists" in msg for msg in alert_messages
    ), f"Expected alert containing 'already exists', got: {alert_messages}"

    r.page.remove_listener("dialog", handle_dialog)


def test_node_add_label_autosave(r: E2ERunner) -> None:
    node = r.node_locator(r.root_txid())

    # Click the "+" button to start adding a label.
    add_btn = node.get_by_title("Add label")
    expect(add_btn).to_be_visible(timeout=5000)
    add_btn.click()

    # A dropdown (select) should appear — pick the first available file.
    select = node.locator("select")
    expect(select).to_be_visible(timeout=3000)
    options = select.locator("option")
    first_option_value = options.first.get_attribute("value")
    select.select_option(first_option_value)

    # Type a label value.
    label_input = node.get_by_placeholder("Label")
    label_input.fill("my-e2e-label")

    # Wait for the autosave indicator to show "saved" (2s debounce + save time).
    # The new-label form's indicator has title="saved" when the save succeeds.
    saved_indicator = node.locator('span[title="saved"]')
    expect(saved_indicator).to_be_visible(timeout=10000)

    # After save the add form collapses and the label appears as an editable
    # row. The label text lives inside an <input value="...">, which is not
    # in inner_text(). Verify via the input's value property.
    r.page.wait_for_timeout(1500)
    inputs = node.locator('input[type="text"]')
    found = False
    for i in range(inputs.count()):
        if inputs.nth(i).input_value() == "my-e2e-label":
            found = True
            break
    assert found, "Expected an input with value 'my-e2e-label' in the node"


def test_node_edit_label_autosave(r: E2ERunner) -> None:
    node = r.node_locator(r.root_txid())

    # Find the editable input that currently holds "my-e2e-label" by checking
    # input_value() (the DOM property), not the HTML attribute.
    inputs = node.locator('input[type="text"]')
    label_input = None
    for i in range(inputs.count()):
        if inputs.nth(i).input_value() == "my-e2e-label":
            label_input = inputs.nth(i)
            break
    assert label_input is not None, "Could not find input with value 'my-e2e-label'"

    # Clear and retype.
    label_input.fill("edited-label")

    # Wait for autosave — the state indicator next to this row cycles through
    # dirty → saving → saved.
    saved_indicator = node.locator('span[title="saved"]')
    expect(saved_indicator).to_be_visible(timeout=10000)

    # Verify the updated value persists.
    expect(label_input).to_have_value("edited-label", timeout=3000)


def test_node_delete_label(r: E2ERunner) -> None:
    node = r.node_locator(r.root_txid())

    # There may be multiple delete buttons (one per editable label row).
    # Delete the first one — the one whose adjacent input holds "edited-label".
    delete_btn = node.get_by_title("Delete label").first
    expect(delete_btn).to_be_visible(timeout=5000)

    delete_count_before = node.get_by_title("Delete label").count()
    delete_btn.click()

    # One fewer delete button should remain.
    if delete_count_before == 1:
        expect(node.get_by_title("Delete label")).not_to_be_visible(timeout=5000)
        # The "+" button should reappear since one file has no label for this node.
        add_btn = node.get_by_title("Add label")
        expect(add_btn).to_be_visible(timeout=5000)
    else:
        r.page.wait_for_timeout(1000)
        delete_count_after = node.get_by_title("Delete label").count()
        assert delete_count_after == delete_count_before - 1, (
            f"Expected {delete_count_before - 1} delete buttons, got {delete_count_after}"
        )


def test_all_files_labeled_message(r: E2ERunner) -> None:
    node = r.node_locator(r.root_txid())

    # Keep adding labels until all local files are covered for this node.
    # The imported file may already have a label for the root txid.
    for attempt in range(3):
        add_btn = node.get_by_title("Add label")
        if add_btn.count() == 0:
            break
        add_btn.click()

        label_input = node.get_by_placeholder("Label")
        expect(label_input).to_be_visible(timeout=3000)
        label_input.fill(f"cover-file-{attempt}")

        saved_indicator = node.locator('span[title="saved"]')
        expect(saved_indicator).to_be_visible(timeout=10000)
        r.page.wait_for_timeout(1500)

    # Now all files should have labels for this node.
    expect(
        node.get_by_text("Labels already exist for all local files.")
    ).to_be_visible(timeout=5000)


def test_export_label_file(r: E2ERunner) -> None:
    panel = r.panel()

    # Newer Chromium versions expose showSaveFilePicker even in headless mode,
    # which opens a native dialog that Playwright cannot interact with. Remove
    # it so the code falls through to the anchor-download path that Playwright
    # can intercept.
    r.page.evaluate("delete window.showSaveFilePicker")

    test_labels_li = panel.locator("li").filter(has_text="test-labels")
    export_btn = test_labels_li.get_by_role("button", name="Export")

    with r.page.expect_download(timeout=10000) as download_info:
        export_btn.click()

    download = download_info.value
    assert download.suggested_filename.endswith(
        ".jsonl"
    ), f"Expected .jsonl filename, got: {download.suggested_filename}"

    # Read the downloaded content and verify it contains tx label entries.
    tmp_path = Path("tmp") / f"e2e_export_{download.suggested_filename}"
    download.save_as(str(tmp_path))
    content = tmp_path.read_text(encoding="utf-8")
    assert '"type":"tx"' in content or '"type": "tx"' in content, (
        f"Expected JSONL content to contain tx label entries, got: {content[:200]}"
    )


def test_remove_label_file(r: E2ERunner) -> None:
    panel = r.panel()

    # Install dialog handler to accept the confirm prompt.
    def accept_dialog(dialog):
        dialog.accept()

    r.page.on("dialog", accept_dialog)

    # Remove the "test-labels" file.
    test_labels_li = panel.locator("li").filter(has_text="test-labels")
    remove_btn = test_labels_li.get_by_role("button", name="Remove")
    remove_btn.click()

    # The file should disappear from the list.
    expect(test_labels_li).not_to_be_visible(timeout=5000)

    r.page.remove_listener("dialog", accept_dialog)


def test_no_export_all_control(r: E2ERunner) -> None:
    # There should be no "Export all" button anywhere on the page.
    count = r.page.get_by_text("Export all").count()
    assert count == 0, f"Expected 0 'Export all' controls, found {count}"


def test_viewport_stable_on_create(r: E2ERunner) -> None:
    # React Flow renders the viewport as a <g> or <div> with an inline
    # style.transform (not an SVG transform attribute). Read it via JS.
    viewport = r.page.locator(".react-flow__viewport")
    transform_before = viewport.evaluate(
        "el => el.style.transform || el.getAttribute('transform') || ''"
    )
    assert transform_before, "Could not read viewport transform"

    # Create a new file.
    panel = r.panel()
    panel.get_by_placeholder("New file name").fill("viewport-test")
    panel.get_by_role("button", name="Create").click()

    # Give UI time to settle after the non-graph-refreshing create.
    r.page.wait_for_timeout(1000)

    transform_after = viewport.evaluate(
        "el => el.style.transform || el.getAttribute('transform') || ''"
    )
    assert (
        transform_before == transform_after
    ), f"Viewport changed after file create: {transform_before} -> {transform_after}"

    # Clean up: remove the file we just created.
    def accept_dialog(dialog):
        dialog.accept()

    r.page.on("dialog", accept_dialog)
    li = panel.locator("li").filter(has_text="viewport-test")
    li.get_by_role("button", name="Remove").click()
    expect(li).not_to_be_visible(timeout=5000)
    r.page.remove_listener("dialog", accept_dialog)


def test_drag_preserved_on_save(r: E2ERunner) -> None:
    node = r.node_locator(r.root_txid())

    # Read initial position.
    box_before = node.bounding_box()
    assert box_before is not None, "Could not get node bounding box"

    # Drag the node 50px down. The drag handle is the node itself (outside
    # the nodrag region).
    node.hover()
    r.page.mouse.down()
    r.page.mouse.move(box_before["x"] + box_before["width"] / 2, box_before["y"] + 50)
    r.page.mouse.up()

    r.page.wait_for_timeout(500)
    box_after_drag = node.bounding_box()
    assert box_after_drag is not None, "Could not get node bounding box after drag"

    # Now add a label and let autosave fire. The node position should not jump.
    add_btn = node.get_by_title("Add label")
    if add_btn.count() > 0:
        add_btn.click()
        label_input = node.get_by_placeholder("Label")
        label_input.fill("drag-test-label")

        saved_indicator = node.locator('span[title="saved"]')
        expect(saved_indicator).to_be_visible(timeout=10000)
        r.page.wait_for_timeout(1000)

    box_after_save = node.bounding_box()
    assert box_after_save is not None, "Could not get node bounding box after save"

    # Allow a small tolerance for rounding.
    dx = abs(box_after_save["x"] - box_after_drag["x"])
    dy = abs(box_after_save["y"] - box_after_drag["y"])
    assert dx < 5 and dy < 5, (
        f"Node position shifted after save: dx={dx:.1f}, dy={dy:.1f}"
    )


# ==============================================================================
# Fixture generation
# ==============================================================================

def _fixture_path() -> Path:
    return Path("tmp") / "e2e_import_fixture.jsonl"


def generate_import_fixture(scenarios: list[dict[str, Any]]) -> Path:
    """Write a small JSONL file referencing known txids for import testing."""
    path = _fixture_path()
    path.parent.mkdir(parents=True, exist_ok=True)

    # Pick two txids from different scenarios.
    simple = next(s for s in scenarios if s["name"] == "simple_chain_4")
    diamond = next(s for s in scenarios if s["name"] == "diamond_merge")

    lines = [
        json.dumps({"type": "tx", "ref": simple["root_txid"], "label": "e2e-label-0"}),
        json.dumps({"type": "tx", "ref": diamond["root_txid"], "label": "e2e-label-1"}),
    ]
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    log(f"wrote import fixture: {path} ({len(lines)} records)")
    return path


# ==============================================================================
# Main
# ==============================================================================

def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Playwright E2E tests for label workflows.")
    parser.add_argument("--headed", action="store_true", help="Show browser window.")
    parser.add_argument("--slowmo", type=int, default=0, help="Playwright slow motion (ms).")
    parser.add_argument(
        "--profile",
        choices=["fast", "balanced", "rich"],
        default="fast",
        help="Fixture size profile (default: fast).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    # scripts/ui/playwright/label.py → project root
    root_dir = Path(__file__).resolve().parent.parent.parent.parent
    cfg = make_config(root_dir)

    port = pick_free_port()
    cory_log = cfg.tmp_dir / f"label_e2e_cory-{cfg.run_id}.log"

    handle = start_bitcoind(cfg)
    cory_proc = None
    cory_log_file = None
    interrupted = False

    def mark_interrupt(_signum, _frame):
        nonlocal interrupted
        interrupted = True

    previous_sigint = signal.signal(signal.SIGINT, mark_interrupt)

    try:
        log("creating wallets")
        handle.cli(["createwallet", "e2e_miner"])
        handle.cli(["createwallet", "e2e_graph"])

        mine_addr = mine_to_wallet(handle.cli, wallet="e2e_miner", blocks=130)

        log(f"building scenarios profile={args.profile}")
        scenarios = build_scenarios(
            cli=handle.cli,
            cli_json=handle.cli_json,
            wallet_graph="e2e_graph",
            wallet_miner="e2e_miner",
            mine_addr=mine_addr,
            profile=args.profile,
        )

        # Generate the JSONL fixture for import tests.
        generate_import_fixture(scenarios)

        rpc_url = f"http://127.0.0.1:{cfg.rpc_port}"
        cory_proc, cory_log_file, server_url, api_token = start_cory(
            root_dir=root_dir,
            rpc_url=rpc_url,
            rpc_user=cfg.rpc_user,
            rpc_pass=cfg.rpc_pass,
            bind="127.0.0.1",
            port=port,
            log_path=cory_log,
        )
        wait_for_health(server_url)
        log(f"server ready: {server_url}")
        log(f"api token: {api_token}")

        # -- Browser phase ----------------------------------------------------

        with sync_playwright() as pw:
            browser = pw.chromium.launch(
                headless=not args.headed,
                slow_mo=args.slowmo,
            )
            page = browser.new_page()

            runner = E2ERunner(
                page=page,
                server_url=server_url,
                api_token=api_token,
                scenarios=scenarios,
            )

            # Tests run sequentially — each builds on the state left by
            # the previous one.
            tests = [
                ("test_graph_renders_after_search", lambda: test_graph_renders_after_search(runner)),
                ("test_empty_label_state", lambda: test_empty_label_state(runner)),
                ("test_create_label_file", lambda: test_create_label_file(runner)),
                ("test_duplicate_create_fails", lambda: test_duplicate_create_fails(runner)),
                ("test_import_jsonl", lambda: test_import_jsonl(runner)),
                ("test_duplicate_import_fails", lambda: test_duplicate_import_fails(runner)),
                ("test_node_add_label_autosave", lambda: test_node_add_label_autosave(runner)),
                ("test_node_edit_label_autosave", lambda: test_node_edit_label_autosave(runner)),
                ("test_node_delete_label", lambda: test_node_delete_label(runner)),
                ("test_all_files_labeled_message", lambda: test_all_files_labeled_message(runner)),
                ("test_export_label_file", lambda: test_export_label_file(runner)),
                ("test_remove_label_file", lambda: test_remove_label_file(runner)),
                ("test_no_export_all_control", lambda: test_no_export_all_control(runner)),
                ("test_viewport_stable_on_create", lambda: test_viewport_stable_on_create(runner)),
                ("test_drag_preserved_on_save", lambda: test_drag_preserved_on_save(runner)),
            ]

            for name, fn in tests:
                if interrupted:
                    break
                runner.run_test(name, fn)

            browser.close()

        return runner.print_summary()

    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        if cory_proc is not None:
            stop_process(cory_proc, name="cory")
        if cory_log_file is not None:
            cory_log_file.close()
        handle.stop()


if __name__ == "__main__":
    sys.exit(main())
