#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import (
    log,
    make_config,
    pick_free_port,
    run_ignored_rust_test_in_package,
    start_cory,
    start_bitcoind,
    stop_process,
    wait_for_health,
)


def main() -> int:
    root_dir = Path(__file__).resolve().parent.parent.parent
    cfg = make_config(root_dir)

    wallet_miner = os.environ.get("WALLET_MINER", "itest_miner")
    wallet_sink = os.environ.get("WALLET_SINK", "itest_sink")
    bind = "127.0.0.1"
    port = int(os.environ.get("CORY_PORT", str(pick_free_port())))
    cory_log = Path(
        os.environ.get("CORY_LOG", str(cfg.tmp_dir / f"regtest-cory-{cfg.run_id}.log"))
    )
    fixture_file = Path(
        os.environ.get(
            "SERVER_FIXTURE_FILE",
            str(cfg.tmp_dir / f"regtest_server_fixture-{cfg.run_id}.json"),
        )
    )

    handle = start_bitcoind(cfg)
    cory_proc = None
    cory_log_file = None
    try:
        log("creating server test wallets")
        handle.cli(["createwallet", wallet_miner])
        handle.cli(["createwallet", wallet_sink])

        mine_addr = handle.cli(["getnewaddress", "", "bech32"], rpc_wallet=wallet_miner)
        log("mining initial 110 blocks")
        handle.cli(["generatetoaddress", "110", mine_addr])

        recv_addr = handle.cli(["getnewaddress", "", "bech32"], rpc_wallet=wallet_sink)
        txid = handle.cli(["sendtoaddress", recv_addr, "1.0"], rpc_wallet=wallet_miner)
        handle.cli(["generatetoaddress", "1", mine_addr])
        log(f"created fixture transaction txid={txid}")

        rpc_url = f"http://127.0.0.1:{cfg.rpc_port}"
        cory_proc, cory_log_file, base_url, _token = start_cory(
            root_dir=root_dir,
            rpc_url=rpc_url,
            rpc_user=cfg.rpc_user,
            rpc_pass=cfg.rpc_pass,
            bind=bind,
            port=port,
            log_path=cory_log,
        )
        wait_for_health(base_url)
        log(f"cory server ready at {base_url}")

        fixture = {
            "schema_version": 1,
            "base_url": base_url,
            "valid_txid": txid,
        }
        fixture_file.write_text(json.dumps(fixture, indent=2), encoding="utf-8")
        log(f"wrote server fixture to {fixture_file}")

        run_ignored_rust_test_in_package(
            cfg,
            package="cory",
            test_name="regtest_server",
            extra_env={
                "CORY_TEST_SERVER_BASE_URL": base_url,
                "CORY_TEST_SERVER_VALID_TXID": txid,
                "CORY_TEST_SERVER_FIXTURE_FILE": str(fixture_file),
            },
        )
        log("server endpoint integration check passed")
        return 0
    finally:
        if cory_proc is not None:
            stop_process(cory_proc, name="cory")
        if cory_log_file is not None:
            cory_log_file.close()
        handle.stop()


if __name__ == "__main__":
    sys.exit(main())
