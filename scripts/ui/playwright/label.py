#!/usr/bin/env python3
"""
Playwright E2E entrypoint for the label workflow.

The implementation is split into focused modules:
- `label_runtime.py`: runner and shared interaction helpers
- `label_cases.py`: test cases in execution order
"""
from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path
from typing import Any

# scripts/ui/playwright/ -> scripts/
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent))

try:
    # Import check is kept here so the script exits with a direct installation
    # hint before we import deeper modules that depend on Playwright.
    import playwright.sync_api as _pw  # noqa: F401
except ImportError:
    print(
        "playwright is not installed. "
        "Run: uv pip install playwright && playwright install chromium"
    )
    sys.exit(1)

from playwright.sync_api import sync_playwright  # noqa: E402

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
from ui.playwright.label_cases import build_tests  # noqa: E402
from ui.playwright.label_runtime import E2ERunner, fixture_path  # noqa: E402


# ==============================================================================
# Fixture generation
# ==============================================================================


def generate_import_fixture(scenarios: list[dict[str, Any]]) -> Path:
    path = fixture_path()
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
# CLI + main orchestration
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
        cory_proc, cory_log_file, server_url, api_token = start_cory(
            root_dir=root_dir,
            connection=rpc_url,
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

            runner = E2ERunner(page=page, server_url=server_url, api_token=api_token, scenarios=scenarios)

            for name, fn in build_tests(runner):
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
