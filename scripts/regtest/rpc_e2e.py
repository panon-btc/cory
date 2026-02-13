#!/usr/bin/env python3
import os
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import (
    log,
    make_config,
    run_ignored_rust_test,
    start_bitcoind,
)


def main() -> int:
    root_dir = Path(__file__).resolve().parent.parent.parent
    cfg = make_config(root_dir)

    wallet = os.environ.get("WALLET", "itest")
    sink_wallet = os.environ.get("SINK_WALLET", "itest_sink")
    tx_count = int(os.environ.get("TX_COUNT", "8"))
    txids_file = Path(
        os.environ.get("TXIDS_FILE", str(cfg.tmp_dir / f"regtest_txids-{cfg.run_id}.txt"))
    )
    outpoints_file = Path(
        os.environ.get(
            "OUTPOINTS_FILE", str(cfg.tmp_dir / f"regtest_outpoints-{cfg.run_id}.txt")
        )
    )

    handle = start_bitcoind(cfg)
    try:
        log("creating wallets")
        handle.cli(["createwallet", wallet])
        handle.cli(["createwallet", sink_wallet])

        mine_addr = handle.cli(["getnewaddress", "", "bech32"], rpc_wallet=wallet)
        log("mining initial 110 blocks")
        handle.cli(["generatetoaddress", "110", mine_addr])

        txids_file.write_text("", encoding="utf-8")
        outpoints_file.write_text("", encoding="utf-8")

        log(f"creating {tx_count} transactions")
        for idx in range(tx_count):
            recv_addr = handle.cli(["getnewaddress", "", "bech32"], rpc_wallet=sink_wallet)
            txid = handle.cli(["sendtoaddress", recv_addr, "1.0"], rpc_wallet=wallet)
            with txids_file.open("a", encoding="utf-8") as f:
                f.write(f"{txid}\n")

            tx = handle.cli_json(["getrawtransaction", txid, "1"])
            vout_match = None
            for output in tx.get("vout", []):
                spk = output.get("scriptPubKey", {})
                if spk.get("address") == recv_addr:
                    vout_match = output.get("n")
                    break
            if vout_match is None:
                raise RuntimeError(
                    f"no matching recipient output found in tx {txid} for address {recv_addr}"
                )

            outpoint = f"{txid}:{vout_match}"
            with outpoints_file.open("a", encoding="utf-8") as f:
                f.write(f"{outpoint}\n")

            handle.cli(["generatetoaddress", "1", mine_addr])
            log(f"tx {idx + 1}/{tx_count}: {txid} outpoint={outpoint}")

        run_ignored_rust_test(
            cfg,
            test_name="regtest_rpc",
            extra_env={
                "CORY_TEST_TXIDS_FILE": str(txids_file),
                "CORY_TEST_OUTPOINTS_FILE": str(outpoints_file),
            },
        )
        log(f"integration check passed for {tx_count} transactions")
        return 0
    finally:
        handle.stop()


if __name__ == "__main__":
    sys.exit(main())
