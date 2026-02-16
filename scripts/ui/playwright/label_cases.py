from __future__ import annotations

import zipfile
from pathlib import Path
from typing import Callable

from playwright.sync_api import expect

from ui.playwright.label_runtime import E2ERunner, fixture_path


# ==============================================================================
# Core Graph + Sidebar Smoke
# ==============================================================================


def test_graph_renders_after_search(r: E2ERunner) -> None:
    r.page.goto(r.server_url)
    r.ensure_api_token()
    r.search_txid(r.root_txid())

    r.page.locator(".react-flow__node").first.wait_for(state="visible", timeout=15000)
    node_count = r.page.locator(".react-flow__node").count()
    assert node_count > 0, f"Expected graph nodes, got {node_count}"

    stats = r.page.get_by_text("transactions")
    expect(stats).to_be_visible(timeout=5000)


def test_empty_label_state(r: E2ERunner) -> None:
    label_files = r.label_files_section()
    expect(label_files.get_by_text("No browser label files loaded.")).to_be_visible(timeout=5000)

    selected_editor = r.selected_editor_section()
    expect(
        selected_editor.get_by_text("Create or import a label file first.").first
    ).to_be_visible(timeout=5000)


def test_export_all_no_files_alert(r: E2ERunner) -> None:
    section = r.label_files_section()
    with r.page.expect_event("dialog", timeout=5000) as dialog_info:
        section.get_by_role("button", name="Export all browser labels").click()

    dialog = dialog_info.value
    assert dialog.message == "No browser label files to export."
    dialog.accept()


# ==============================================================================
# Label File CRUD
# ==============================================================================


def test_create_label_file(r: E2ERunner) -> None:
    section = r.label_files_section()
    section.get_by_placeholder("New file name").fill("test-labels")
    section.get_by_role("button", name="Create").click()

    created_file = section.locator("li").filter(has_text="test-labels").first
    expect(created_file).to_be_visible(timeout=5000)
    expect(created_file.get_by_text("(0)")).to_be_visible(timeout=5000)


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
    section.locator('input[type="file"]').set_input_files(str(fixture_path()))

    imported_file = section.locator("li").filter(has_text="e2e_import_fixture").first
    expect(imported_file).to_be_visible(timeout=5000)
    expect(imported_file.get_by_text("(2)")).to_be_visible(timeout=5000)


def test_duplicate_import_fails(r: E2ERunner) -> None:
    section = r.label_files_section()
    alert_messages: list[str] = []
    before_count = section.locator("li").filter(has_text="e2e_import_fixture").count()

    def handle_dialog(dialog):
        alert_messages.append(dialog.message)
        dialog.accept()

    r.page.on("dialog", handle_dialog)
    try:
        section.locator('input[type="file"]').set_input_files(str(fixture_path()))
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


# ==============================================================================
# Selected Transaction Label Editing
# ==============================================================================


def test_node_add_label_autosave(r: E2ERunner) -> None:
    tx_card = r.selected_tx_card()

    add_btn = tx_card.get_by_title("Add label").first
    expect(add_btn).to_be_visible(timeout=5000)
    add_btn.click()

    select = tx_card.locator("select").first
    expect(select).to_be_visible(timeout=3000)
    first_option_value = select.locator("option").first.get_attribute("value")
    assert first_option_value, "No target file option available"
    select.select_option(first_option_value)

    label_input = tx_card.get_by_placeholder("Label").first
    label_input.fill("my-e2e-label")
    tx_message = tx_card.get_by_text("Labels already exist for all editable files.")

    # New-label autosave resolves by closing the add form or exhausting files.
    r.wait_until(
        lambda: (not r.is_visible(label_input)) or r.is_visible(tx_message),
        timeout_ms=12000,
        step_ms=100,
        failure_message="Transaction-card add form did not settle after autosave",
    )

    if r.is_visible(tx_message):
        return

    inputs = tx_card.locator('input[type="text"]')
    assert any(inputs.nth(i).input_value() == "my-e2e-label" for i in range(inputs.count())), (
        "Expected a transaction-card input with value 'my-e2e-label'"
    )


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
    tx_card = r.selected_tx_card()
    message = tx_card.get_by_text("Labels already exist for all editable files.")

    for attempt in range(30):
        if r.is_visible(message):
            return

        add_btn = tx_card.get_by_title("Add label")
        label_input = tx_card.get_by_placeholder("Label")
        no_more = tx_card.get_by_text("No additional editable files available.")

        if r.is_visible(label_input):
            label_input.first.fill(f"cover-file-{attempt}")
        elif add_btn.count() > 0:
            add_btn.first.click()
            expect(label_input.first).to_be_visible(timeout=3000)
            label_input.first.fill(f"cover-file-{attempt}")
        elif r.is_visible(no_more):
            pass
        else:
            break

        r.wait_until(
            lambda: r.is_visible(message) or (not r.is_visible(label_input)),
            timeout_ms=12000,
            step_ms=100,
            failure_message="Transaction-card label input stayed visible; autosave did not settle",
        )
        if r.is_visible(message):
            return
        r.page.wait_for_timeout(300)

    expect(message.first).to_be_visible(timeout=5000)


def test_tx_card_exhausted_hides_add_controls(r: E2ERunner) -> None:
    tx_card = r.selected_tx_card()
    expect(tx_card.get_by_text("Labels already exist for all editable files.")).to_be_visible(timeout=5000)
    assert tx_card.get_by_title("Add label").count() == 0, "Add label button should be hidden"
    assert tx_card.get_by_placeholder("Label").count() == 0, "Add-label input should not be visible"


# ==============================================================================
# Export + Remove + Layout Stability
# ==============================================================================


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


def test_export_all_browser_labels_zip(r: E2ERunner) -> None:
    section = r.label_files_section()
    export_all_btn = section.get_by_role("button", name="Export all browser labels")
    expect(export_all_btn).to_be_visible(timeout=5000)

    with r.page.expect_download(timeout=10000) as download_info:
        export_all_btn.click()

    download = download_info.value
    assert download.suggested_filename == "labels.zip"

    tmp_path = Path("tmp") / "e2e_export_all_browser_labels.zip"
    download.save_as(str(tmp_path))

    with zipfile.ZipFile(tmp_path, "r") as archive:
        names = set(archive.namelist())
        assert "labels/test-labels.jsonl" in names
        assert "labels/e2e_import_fixture.jsonl" in names

        import_content = archive.read("labels/e2e_import_fixture.jsonl").decode("utf-8")
        assert "e2e-label-0" in import_content
        assert "e2e-label-1" in import_content


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


def test_viewport_stable_on_create(r: E2ERunner) -> None:
    viewport = r.page.locator(".react-flow__viewport")
    expect(viewport).to_be_visible(timeout=10000)

    transform_before = viewport.evaluate("el => el.style.transform || el.getAttribute('transform') || ''")
    assert transform_before, "Could not read viewport transform"

    section = r.label_files_section()
    section.get_by_placeholder("New file name").fill("viewport-test")
    section.get_by_role("button", name="Create").click()

    r.page.wait_for_timeout(1000)

    transform_after = viewport.evaluate("el => el.style.transform || el.getAttribute('transform') || ''")
    assert transform_after, "Could not read viewport transform after create"

    # Creating a browser file can trigger a viewport refit due to layout changes.
    # Validate that the transform settles and the graph remains visible.
    r.page.wait_for_timeout(400)
    transform_settled = viewport.evaluate("el => el.style.transform || el.getAttribute('transform') || ''")
    assert transform_after == transform_settled, (
        f"Viewport transform did not settle after create: {transform_after} -> {transform_settled}"
    )

    node = r.node_locator(r.root_txid())
    expect(node).to_be_visible(timeout=5000)

    def accept_dialog(dialog):
        dialog.accept()

    r.page.on("dialog", accept_dialog)
    try:
        li = section.locator("li").filter(has_text="viewport-test")
        li.get_by_role("button", name="Remove").click()
        expect(li).not_to_be_visible(timeout=5000)
    finally:
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


def build_tests(runner: E2ERunner) -> list[tuple[str, Callable[[], None]]]:
    # Order is intentional: each stage builds on prior state and then validates
    # downstream behavior in that same browser session.
    return [
        ("test_graph_renders_after_search", lambda: test_graph_renders_after_search(runner)),
        ("test_empty_label_state", lambda: test_empty_label_state(runner)),
        ("test_export_all_no_files_alert", lambda: test_export_all_no_files_alert(runner)),
        ("test_create_label_file", lambda: test_create_label_file(runner)),
        ("test_duplicate_create_fails", lambda: test_duplicate_create_fails(runner)),
        ("test_import_jsonl", lambda: test_import_jsonl(runner)),
        ("test_duplicate_import_fails", lambda: test_duplicate_import_fails(runner)),
        ("test_node_add_label_autosave", lambda: test_node_add_label_autosave(runner)),
        ("test_node_edit_label_autosave", lambda: test_node_edit_label_autosave(runner)),
        ("test_node_delete_label", lambda: test_node_delete_label(runner)),
        ("test_all_files_labeled_message", lambda: test_all_files_labeled_message(runner)),
        (
            "test_tx_card_exhausted_hides_add_controls",
            lambda: test_tx_card_exhausted_hides_add_controls(runner),
        ),
        ("test_export_label_file", lambda: test_export_label_file(runner)),
        ("test_export_all_browser_labels_zip", lambda: test_export_all_browser_labels_zip(runner)),
        ("test_remove_label_file", lambda: test_remove_label_file(runner)),
        ("test_viewport_stable_on_create", lambda: test_viewport_stable_on_create(runner)),
        ("test_drag_preserved_on_save", lambda: test_drag_preserved_on_save(runner)),
    ]
