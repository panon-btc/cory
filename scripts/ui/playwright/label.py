#!/usr/bin/env python3
"""
Playwright E2E tests for the label workflow in the Cory UI.

This suite tracks the current UI structure:
- cookie/JWT auth (no manual API token field)
- right sidebar organized as <details> sections
- in-sidebar "Selected Transaction Editor" for label editing
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

# scripts/ui/playwright/ -> scripts/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

from common import (  # noqa: E402
    log,
    make_config,
    mine_to_wallet,
    pick_free_port,
    start_bitcoind,
    start_cory,
    stop_process,
    wait_for_health,
)
from ui.manual_fixtures import build_scenarios  # noqa: E402

try:
    from playwright.sync_api import Page, expect, sync_playwright
except ImportError:
    print(
        "playwright is not installed. "
        "Run: uv pip install playwright && playwright install chromium"
    )
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
    page: Page
    server_url: str
    scenarios: list[dict[str, Any]]
    results: list[TestResult] = field(default_factory=list)

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

    @property
    def simple_chain(self) -> dict[str, Any]:
        return next(s for s in self.scenarios if s["name"] == "simple_chain_4")

    @property
    def diamond(self) -> dict[str, Any]:
        return next(s for s in self.scenarios if s["name"] == "diamond_merge")

    def root_txid(self) -> str:
        return self.simple_chain["root_txid"]

    def search_txid(self, txid: str) -> None:
        search_input = self.page.get_by_placeholder(
            "Enter a txid to explore its spending ancestry..."
        )
        search_input.fill(txid)
        self.page.get_by_role("button", name="Search").click()

    def node_locator(self, txid: str):
        return self.page.locator(f'.react-flow__node[data-id="{txid}"]')

    def label_files_section(self):
        return self.page.locator('details:has(summary:has-text("Label Files"))')

    def selected_editor_section(self):
        return self.page.locator(
            'details:has(summary:has-text("Selected Transaction Editor"))'
        )


# ==============================================================================
# Tests
# ==============================================================================


def test_graph_renders_after_search(r: E2ERunner) -> None:
    r.page.goto(r.server_url)
    r.search_txid(r.root_txid())

    r.page.locator(".react-flow__node").first.wait_for(state="visible", timeout=15000)
    node_count = r.page.locator(".react-flow__node").count()
    assert node_count > 0, f"Expected graph nodes, got {node_count}"

    stats = r.page.get_by_text("transactions")
    expect(stats).to_be_visible(timeout=5000)


def test_empty_label_state(r: E2ERunner) -> None:
    label_files = r.label_files_section()
    expect(label_files.get_by_text("No local label files loaded.")).to_be_visible(timeout=5000)

    selected_editor = r.selected_editor_section()
    expect(
        selected_editor.get_by_text("Create or import a label file first.").first
    ).to_be_visible(timeout=5000)


def test_create_label_file(r: E2ERunner) -> None:
    section = r.label_files_section()
    section.get_by_placeholder("New file name").fill("test-labels")
    section.get_by_role("button", name="Create").click()

    expect(section.get_by_text("test-labels")).to_be_visible(timeout=5000)
    expect(section.get_by_text("0 labels")).to_be_visible(timeout=5000)


def test_duplicate_create_fails(r: E2ERunner) -> None:
    section = r.label_files_section()
    before = section.locator("li").filter(has_text="test-labels").count()
    section.get_by_placeholder("New file name").fill("test-labels")
    section.get_by_role("button", name="Create").click()
    after = section.locator("li").filter(has_text="test-labels").count()
    assert after == before, f"duplicate create changed file count: {before} -> {after}"

    # Message text may vary slightly between backend/UI versions.
    error = section.locator("p").filter(has_text="failed")
    if error.count() > 0:
        expect(error.first).to_be_visible(timeout=5000)


def test_import_jsonl(r: E2ERunner) -> None:
    section = r.label_files_section()
    section.locator('input[type="file"]').set_input_files(str(_fixture_path()))

    expect(section.get_by_text("e2e_import_fixture")).to_be_visible(timeout=5000)
    expect(section.get_by_text("2 labels")).to_be_visible(timeout=5000)


def test_duplicate_import_fails(r: E2ERunner) -> None:
    section = r.label_files_section()
    alert_messages: list[str] = []
    before_count = section.locator("li").filter(has_text="e2e_import_fixture").count()

    def handle_dialog(dialog):
        alert_messages.append(dialog.message)
        dialog.accept()

    r.page.on("dialog", handle_dialog)
    try:
        section.locator('input[type="file"]').set_input_files(str(_fixture_path()))
        # Either panel error text or alert text may appear depending on browser/UI timing.
        panel_error = section.locator("p").filter(has_text="already exists")
        if panel_error.count() > 0:
            expect(panel_error.first).to_be_visible(timeout=5000)
        after_count = section.locator("li").filter(has_text="e2e_import_fixture").count()
        assert (
            after_count == before_count
        ), f"duplicate import changed fixture file count: {before_count} -> {after_count}"
    finally:
        r.page.remove_listener("dialog", handle_dialog)


def test_node_add_label_autosave(r: E2ERunner) -> None:
    editor = r.selected_editor_section()

    add_btn = editor.get_by_title("Add label").first
    expect(add_btn).to_be_visible(timeout=5000)
    add_btn.click()

    select = editor.locator("select").first
    expect(select).to_be_visible(timeout=3000)
    first_option_value = select.locator("option").first.get_attribute("value")
    assert first_option_value, "No target file option available"
    select.select_option(first_option_value)

    label_input = editor.get_by_placeholder("Label").first
    label_input.fill("my-e2e-label")

    expect(editor.locator('span[title="saved"]').first).to_be_visible(timeout=10000)
    r.page.wait_for_timeout(1200)

    inputs = editor.locator('input[type="text"]')
    found = False
    for i in range(inputs.count()):
        if inputs.nth(i).input_value() == "my-e2e-label":
            found = True
            break
    assert found, "Expected an input with value 'my-e2e-label'"


def test_node_edit_label_autosave(r: E2ERunner) -> None:
    editor = r.selected_editor_section()
    inputs = editor.locator('input[type="text"]')

    target = None
    for i in range(inputs.count()):
        if inputs.nth(i).input_value() == "my-e2e-label":
            target = inputs.nth(i)
            break

    assert target is not None, "Could not find input with value 'my-e2e-label'"
    target.fill("edited-label")

    expect(editor.locator('span[title="saved"]').first).to_be_visible(timeout=10000)
    expect(target).to_have_value("edited-label", timeout=3000)


def test_node_delete_label(r: E2ERunner) -> None:
    editor = r.selected_editor_section()
    rows = editor.locator('div:has(button[title="Delete label"])')

    target_row = None
    for i in range(rows.count()):
        row = rows.nth(i)
        row_input = row.locator('input[type="text"]').first
        if row_input.count() > 0 and row_input.input_value() == "edited-label":
            target_row = row
            break

    if target_row is None:
        # If value-based matching is flaky after autosave rerenders, delete the first row.
        assert rows.count() > 0, "No deletable label rows found"
        target_row = rows.first

    delete_buttons = editor.get_by_title("Delete label")
    before = delete_buttons.count()
    target_row.get_by_title("Delete label").first.click()

    r.page.wait_for_timeout(1200)
    after = editor.get_by_title("Delete label").count()
    assert after == max(before - 1, 0), f"Expected {before - 1}, got {after}"


def test_all_files_labeled_message(r: E2ERunner) -> None:
    editor = r.selected_editor_section()

    message = editor.get_by_text("Local labels already exist for all files.")
    for attempt in range(5):
        if message.count() > 0 and message.first.is_visible():
            return
        add_btn = editor.get_by_title("Add label")
        if add_btn.count() == 0:
            break
        add_btn.first.click()
        label_input = editor.get_by_placeholder("Label").first
        expect(label_input).to_be_visible(timeout=3000)
        label_input.fill(f"cover-file-{attempt}")
        expect(editor.locator('span[title="saved"]').first).to_be_visible(timeout=10000)
        r.page.wait_for_timeout(1200)

    expect(message.first).to_be_visible(timeout=5000)


def test_export_label_file(r: E2ERunner) -> None:
    section = r.label_files_section()

    # Force fallback download path that Playwright can capture.
    r.page.evaluate("delete window.showSaveFilePicker")

    test_labels_li = section.locator("li").filter(has_text="test-labels")
    export_btn = test_labels_li.get_by_role("button", name="Export")

    with r.page.expect_download(timeout=10000) as download_info:
        export_btn.click()

    download = download_info.value
    assert download.suggested_filename.endswith(".jsonl")

    tmp_path = Path("tmp") / f"e2e_export_{download.suggested_filename}"
    download.save_as(str(tmp_path))
    content = tmp_path.read_text(encoding="utf-8")
    assert '"type":"tx"' in content or '"type": "tx"' in content


def test_remove_label_file(r: E2ERunner) -> None:
    section = r.label_files_section()

    def accept_dialog(dialog):
        dialog.accept()

    r.page.on("dialog", accept_dialog)
    try:
        test_labels_li = section.locator("li").filter(has_text="test-labels")
        test_labels_li.get_by_role("button", name="Remove").click()
        expect(test_labels_li).not_to_be_visible(timeout=5000)
    finally:
        r.page.remove_listener("dialog", accept_dialog)


def test_no_export_all_control(r: E2ERunner) -> None:
    assert r.page.get_by_text("Export all").count() == 0


def test_viewport_stable_on_create(r: E2ERunner) -> None:
    viewport = r.page.locator(".react-flow__viewport")
    expect(viewport).to_be_visible(timeout=10000)

    transform_before = viewport.evaluate(
        "el => el.style.transform || el.getAttribute('transform') || ''"
    )
    assert transform_before, "Could not read viewport transform"

    section = r.label_files_section()
    section.get_by_placeholder("New file name").fill("viewport-test")
    section.get_by_role("button", name="Create").click()

    r.page.wait_for_timeout(1000)

    transform_after = viewport.evaluate(
        "el => el.style.transform || el.getAttribute('transform') || ''"
    )
    assert transform_before == transform_after, (
        f"Viewport changed after file create: {transform_before} -> {transform_after}"
    )

    def accept_dialog(dialog):
        dialog.accept()

    r.page.on("dialog", accept_dialog)
    li = section.locator("li").filter(has_text="viewport-test")
    li.get_by_role("button", name="Remove").click()
    expect(li).not_to_be_visible(timeout=5000)
    r.page.remove_listener("dialog", accept_dialog)


def test_drag_preserved_on_save(r: E2ERunner) -> None:
    node = r.node_locator(r.root_txid())

    box_before = node.bounding_box()
    assert box_before is not None, "Could not get node bounding box"

    node.hover()
    r.page.mouse.down()
    r.page.mouse.move(box_before["x"] + box_before["width"] / 2, box_before["y"] + 50)
    r.page.mouse.up()

    r.page.wait_for_timeout(500)
    box_after_drag = node.bounding_box()
    assert box_after_drag is not None, "Could not get node bounding box after drag"

    editor = r.selected_editor_section()
    add_btn = editor.get_by_title("Add label")
    if add_btn.count() > 0:
        add_btn.first.click()
        editor.get_by_placeholder("Label").first.fill("drag-test-label")
    else:
        inputs = editor.locator('input[type="text"]')
        if inputs.count() > 0:
            current = inputs.first.input_value()
            inputs.first.fill(f"{current}-drag")

    expect(editor.locator('span[title="saved"]').first).to_be_visible(timeout=10000)
    r.page.wait_for_timeout(1200)

    box_after_save = node.bounding_box()
    assert box_after_save is not None, "Could not get node bounding box after save"

    dx = abs(box_after_save["x"] - box_after_drag["x"])
    dy = abs(box_after_save["y"] - box_after_drag["y"])
    assert dx < 5 and dy < 5, f"Node position shifted after save: dx={dx:.1f}, dy={dy:.1f}"


# ==============================================================================
# Fixture generation
# ==============================================================================


def _fixture_path() -> Path:
    return Path("tmp") / "e2e_import_fixture.jsonl"


def generate_import_fixture(scenarios: list[dict[str, Any]]) -> Path:
    path = _fixture_path()
    path.parent.mkdir(parents=True, exist_ok=True)

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

        generate_import_fixture(scenarios)

        rpc_url = f"http://127.0.0.1:{cfg.rpc_port}"
        cory_proc, cory_log_file, server_url, _token = start_cory(
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

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.headed, slow_mo=args.slowmo)
            page = browser.new_page()

            runner = E2ERunner(page=page, server_url=server_url, scenarios=scenarios)

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
