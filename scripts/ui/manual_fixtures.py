#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import signal
import sys
import time
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import (
    PER_TX_FEE_SAT,
    fund_wallet_utxos,
    log,
    make_config,
    mine_to_wallet,
    pick_free_port,
    sat_to_btc,
    spend_inputs,
    start_bitcoind,
    start_cory,
    stop_process,
    wait_for_health,
)


def send_raw_with_outputs(
    cli,
    cli_json,
    *,
    wallet: str,
    inputs: list[dict[str, Any]],
    outputs: dict[str, float],
    op_return_data_hex: str | None = None,
    sequence: int | None = None,
) -> str:
    raw_inputs = []
    for inp in inputs:
        raw_in = {"txid": inp["txid"], "vout": inp["vout"]}
        if sequence is not None:
            raw_in["sequence"] = sequence
        raw_inputs.append(raw_in)

    raw_outputs: dict[str, Any] = dict(outputs)
    if op_return_data_hex is not None:
        raw_outputs["data"] = op_return_data_hex

    raw_hex = cli(
        ["createrawtransaction", json.dumps(raw_inputs), json.dumps(raw_outputs)],
        rpc_wallet=wallet,
    )
    signed = cli_json(["signrawtransactionwithwallet", raw_hex], rpc_wallet=wallet)
    if not signed.get("complete"):
        raise RuntimeError("signrawtransactionwithwallet returned incomplete=false")
    return cli(["sendrawtransaction", signed["hex"]], rpc_wallet=wallet)


def build_scenarios(
    *,
    cli,
    cli_json,
    wallet_graph: str,
    wallet_miner: str,
    mine_addr: str,
    profile: str,
) -> list[dict[str, Any]]:
    profile_cfg = {
        "fast": {"fan": 20, "equal": 5, "long_depth": 52},
        "balanced": {"fan": 24, "equal": 6, "long_depth": 60},
        "rich": {"fan": 40, "equal": 10, "long_depth": 80},
    }
    cfg = profile_cfg[profile]
    fan_count = cfg["fan"]
    equal_count = cfg["equal"]
    long_depth = cfg["long_depth"]

    # We pre-fund many small UTXOs to keep scenario construction deterministic and
    # independent from wallet coin selection.
    seed_count = 120
    utxos = fund_wallet_utxos(
        cli,
        cli_json,
        source_wallet=wallet_miner,
        dest_wallet=wallet_graph,
        mine_addr=mine_addr,
        count=seed_count,
        value_sat=100_000_000,
    )

    def take_utxo() -> dict[str, Any]:
        if not utxos:
            raise RuntimeError("not enough funded UTXOs for scenario generation")
        return utxos.pop(0)

    scenarios: list[dict[str, Any]] = []

    # 1) Simple payment chain (3-5 hops).
    simple = [take_utxo()]
    simple_txids: list[str] = []
    for _ in range(4):
        txid, simple = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=simple,
            output_values=[simple[0]["value_sat"] - PER_TX_FEE_SAT],
        )
        simple_txids.append(txid)
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    scenarios.append(
        {
            "name": "simple_chain_4",
            "description": "Linear ancestry chain with four hops.",
            "root_txid": simple_txids[-1],
            "related_txids": simple_txids,
            "suggested_ui_checks": [
                "Graph renders a single path with one parent per node.",
                "No truncation expected with default limits.",
            ],
            "why_interesting": "Baseline shape for sanity checks.",
            "ui_focus": "Verify depth progression and edge direction.",
        }
    )

    # 2) Diamond/merge DAG.
    parent_txid, parent_outs = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=[take_utxo()],
        output_values=[49_999_000, 49_999_000],
    )
    left_txid, left_out = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=[parent_outs[0]],
        output_values=[49_998_000],
    )
    right_txid, right_out = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=[parent_outs[1]],
        output_values=[49_998_000],
    )
    merge_txid, _ = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=left_out + right_out,
        output_values=[99_994_000],
    )
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    scenarios.append(
        {
            "name": "diamond_merge",
            "description": "Split into two branches that merge back into one root.",
            "root_txid": merge_txid,
            "related_txids": [merge_txid, left_txid, right_txid, parent_txid],
            "suggested_ui_checks": [
                "Merged parent appears once as a deduped DAG node.",
                "Root has two input edges from different branch txs.",
            ],
            "why_interesting": "Validates merge handling and de-duplication.",
            "ui_focus": "Look for shared ancestor behavior.",
        }
    )

    # 3) Fan-in consolidation (20+ inputs -> 1 output).
    fan_in_inputs = [take_utxo() for _ in range(fan_count)]
    fan_in_txid, _ = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=fan_in_inputs,
        output_values=[sum(x["value_sat"] for x in fan_in_inputs) - (fan_count * PER_TX_FEE_SAT)],
    )
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    scenarios.append(
        {
            "name": f"fan_in_{fan_count}",
            "description": f"Consolidation transaction spending {fan_count} inputs.",
            "root_txid": fan_in_txid,
            "related_txids": [fan_in_txid] + [x["txid"] for x in fan_in_inputs],
            "suggested_ui_checks": [
                "Root has many incoming ancestry edges.",
                "Check performance on wide incoming edge sets.",
            ],
            "why_interesting": "Exercises dense input fan-in rendering.",
            "ui_focus": "Inspect edge count and node detail stability.",
        }
    )

    # 4) Fan-out payout (1 input -> 20+ outputs).
    fan_out_input = take_utxo()
    fan_out_each = (fan_out_input["value_sat"] - PER_TX_FEE_SAT) // fan_count
    fan_out_values = [fan_out_each for _ in range(fan_count)]
    fan_out_txid, fan_out_outs = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=[fan_out_input],
        output_values=fan_out_values,
    )
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    scenarios.append(
        {
            "name": f"fan_out_{fan_count}",
            "description": f"Single-input payout creating {fan_count} outputs.",
            "root_txid": fan_out_txid,
            "related_txids": [fan_out_txid, fan_out_input["txid"]],
            "suggested_ui_checks": [
                "Root has one parent in ancestry despite many outputs.",
                "Node detail should show large output list cleanly.",
            ],
            "why_interesting": "Shows output-heavy tx detail handling.",
            "ui_focus": "Inspect output rendering and labeling controls.",
        }
    )

    # 5) Coinjoin-like equal-output transaction.
    coinjoin_inputs = [take_utxo() for _ in range(equal_count)]
    equal_value = (sum(i["value_sat"] for i in coinjoin_inputs) - (equal_count * PER_TX_FEE_SAT)) // equal_count
    coinjoin_values = [equal_value for _ in range(equal_count)]
    coinjoin_txid, _ = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=coinjoin_inputs,
        output_values=coinjoin_values,
    )
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    scenarios.append(
        {
            "name": f"coinjoin_like_equal_outputs_{equal_count}",
            "description": "Multi-input transaction with equal-valued outputs.",
            "root_txid": coinjoin_txid,
            "related_txids": [coinjoin_txid] + [x["txid"] for x in coinjoin_inputs],
            "suggested_ui_checks": [
                "Equal output amounts are visible in tx detail.",
                "No heuristic claims should imply deterministic linkage.",
            ],
            "why_interesting": "Resembles common collaborative spend patterns.",
            "ui_focus": "Verify value symmetry and neutral interpretation.",
        }
    )

    # 6) CPFP-style pair (parent + child), intentionally left unconfirmed.
    cpfp_parent_in = take_utxo()
    cpfp_parent_txid, cpfp_parent_out = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=[cpfp_parent_in],
        output_values=[cpfp_parent_in["value_sat"] - 5_000],
    )
    cpfp_child_txid, _ = spend_inputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=cpfp_parent_out,
        output_values=[cpfp_parent_out[0]["value_sat"] - 25_000],
    )
    scenarios.append(
        {
            "name": "cpfp_parent_child",
            "description": "Unconfirmed parent with child paying a higher fee.",
            "root_txid": cpfp_child_txid,
            "related_txids": [cpfp_child_txid, cpfp_parent_txid],
            "suggested_ui_checks": [
                "Root ancestry includes the unconfirmed parent.",
                "Fee and feerate differ notably between parent and child.",
            ],
            "why_interesting": "Shows package-like ancestor relationships.",
            "ui_focus": "Compare fee metrics parent vs child.",
        }
    )
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

    # 7) RBF-signaling transaction and replacement.
    rbf_input = take_utxo()
    rbf_addr_1 = cli(["getnewaddress", "", "bech32"], rpc_wallet=wallet_graph)
    rbf_addr_2 = cli(["getnewaddress", "", "bech32"], rpc_wallet=wallet_graph)
    rbf_txid_1 = send_raw_with_outputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=[rbf_input],
        outputs={rbf_addr_1: sat_to_btc(rbf_input["value_sat"] - 5_000)},
        sequence=0xFFFFFFFD,
    )
    rbf_txid_2 = send_raw_with_outputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=[rbf_input],
        outputs={rbf_addr_2: sat_to_btc(rbf_input["value_sat"] - 25_000)},
        sequence=0xFFFFFFFD,
    )
    # TODO: expose a `--rbf-policy` fallback mode if users run regtest nodes
    # with non-default replacement policies that reject BIP125 replacement.
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    scenarios.append(
        {
            "name": "rbf_replacement",
            "description": "RBF-signaling transaction replaced by a higher-fee spend.",
            "root_txid": rbf_txid_2,
            "related_txids": [rbf_txid_1, rbf_txid_2],
            "suggested_ui_checks": [
                "Replacement tx appears as current spend of the same outpoint.",
                "RBF signaling metadata is visible on the replacement path.",
            ],
            "why_interesting": "Validates replaceability and mempool replacement behavior.",
            "ui_focus": "Inspect sequence-based signaling and tx history context.",
        }
    )

    # 8) OP_RETURN-carrying transaction.
    opret_input = take_utxo()
    opret_pay_addr = cli(["getnewaddress", "", "bech32"], rpc_wallet=wallet_graph)
    opret_txid = send_raw_with_outputs(
        cli,
        cli_json,
        wallet=wallet_graph,
        inputs=[opret_input],
        outputs={opret_pay_addr: sat_to_btc(opret_input["value_sat"] - 8_000)},
        op_return_data_hex="636f72792d75692d66697874757265",
    )
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    scenarios.append(
        {
            "name": "op_return_payload",
            "description": "Transaction includes an OP_RETURN data output.",
            "root_txid": opret_txid,
            "related_txids": [opret_txid],
            "suggested_ui_checks": [
                "Output script classification includes OP_RETURN.",
                "Data-carrying output does not break graph or label UI.",
            ],
            "why_interesting": "Covers non-spendable output script types.",
            "ui_focus": "Confirm script type enrichment and output listing.",
        }
    )

    # 9) Long chain exceeding default graph depth (50).
    deep_out = [take_utxo()]
    deep_txids: list[str] = []
    for idx in range(long_depth):
        deep_txid, deep_out = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=deep_out,
            output_values=[deep_out[0]["value_sat"] - PER_TX_FEE_SAT],
        )
        deep_txids.append(deep_txid)
        if (idx + 1) % 20 == 0:
            mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
    scenarios.append(
        {
            "name": f"deep_chain_{long_depth}_for_truncation",
            "description": "Long ancestry chain meant to exceed default max_depth=50.",
            "root_txid": deep_txids[-1],
            "related_txids": [deep_txids[-1], deep_txids[-2], deep_txids[0]],
            "suggested_ui_checks": [
                "Default graph request reports truncated=true.",
                "Increasing max_depth query parameter reveals deeper ancestry.",
            ],
            "why_interesting": "Demonstrates limit-driven truncation behavior.",
            "ui_focus": "Check truncated flag and depth stats in API response.",
        }
    )

    return scenarios


def print_scenario_table(scenarios: list[dict[str, Any]]) -> None:
    print()
    print("Scenario Catalog")
    print("=" * 130)
    print(f"{'name':<36} {'root txid':<64} {'why interesting':<32} {'what to look for in UI'}")
    print("-" * 130)
    for s in scenarios:
        print(
            f"{s['name']:<36} {s['root_txid']:<64} {s['why_interesting']:<32} {s['ui_focus']}"
        )
    print("-" * 130)


def print_examples(server_url: str, api_token: str, scenarios: list[dict[str, Any]]) -> None:
    deep = next(s for s in scenarios if s["name"].startswith("deep_chain_"))
    diamond = next(s for s in scenarios if s["name"] == "diamond_merge")

    print()
    print("Copy/Paste Examples")
    print("=" * 130)
    print("1) UI walkthrough (diamond merge):")
    print(f"   Open: {server_url}/")
    print(f"   Search txid: {diamond['root_txid']}")
    print("   Inspect that two branches merge to a shared ancestor.")
    print()
    print("2) API check for truncation (long chain):")
    print(
        f"   curl -s \"{server_url}/api/v1/graph/tx/{deep['root_txid']}\" | jq '.truncated,.stats.max_depth_reached'"
    )
    print()
    print("3) Mutating API example with token (set label on deep root):")
    print(
        "   curl -s -X POST "
        f"\"{server_url}/api/v1/labels/set\" "
        "-H \"content-type: application/json\" "
        f"-H \"x-api-token: {api_token}\" "
        f"-d '{{\"type\":\"tx\",\"ref\":\"{deep['root_txid']}\",\"label\":\"manual-fixture\"}}'"
    )


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Generate manual regtest UI fixtures and run a live cory server."
    )
    parser.add_argument(
        "--no-hold",
        action="store_true",
        help="Exit after setup instead of waiting for manual exploration.",
    )
    parser.add_argument(
        "--profile",
        choices=["fast", "balanced", "rich"],
        default="balanced",
        help="Fixture size profile.",
    )
    parser.add_argument(
        "--bind",
        default="127.0.0.1",
        help="Address to bind the cory server to.",
    )
    parser.add_argument(
        "--port",
        type=int,
        default=0,
        help="Server port (default: auto-pick free port).",
    )
    parser.add_argument(
        "--wallet-miner",
        default=os.environ.get("WALLET_MINER", "ui_miner"),
        help="Regtest miner wallet name.",
    )
    parser.add_argument(
        "--wallet-graph",
        default=os.environ.get("WALLET_GRAPH", "ui_graph"),
        help="Regtest graph wallet name.",
    )
    parser.add_argument(
        "--fixture-file",
        default=None,
        help="Fixture output path (default: tmp/ui_manual_fixture-<run_id>.json).",
    )
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root_dir = Path(__file__).resolve().parent.parent.parent
    cfg = make_config(root_dir)

    port = args.port or pick_free_port()
    local_labels = Path(cfg.tmp_dir / f"ui_manual_labels-{cfg.run_id}.jsonl")
    cory_log = Path(cfg.tmp_dir / f"ui_manual_cory-{cfg.run_id}.log")
    fixture_file = (
        Path(args.fixture_file)
        if args.fixture_file is not None
        else Path(cfg.tmp_dir / f"ui_manual_fixture-{cfg.run_id}.json")
    )

    handle = start_bitcoind(cfg)
    cory_proc = None
    cory_log_file = None
    interrupted = False

    def mark_interrupt(_signum, _frame) -> None:
        nonlocal interrupted
        interrupted = True

    previous_sigint = signal.signal(signal.SIGINT, mark_interrupt)
    try:
        log("creating UI fixture wallets")
        handle.cli(["createwallet", args.wallet_miner])
        handle.cli(["createwallet", args.wallet_graph])

        mine_addr = mine_to_wallet(handle.cli, wallet=args.wallet_miner, blocks=130)
        log(f"building manual scenarios profile={args.profile}")
        scenarios = build_scenarios(
            cli=handle.cli,
            cli_json=handle.cli_json,
            wallet_graph=args.wallet_graph,
            wallet_miner=args.wallet_miner,
            mine_addr=mine_addr,
            profile=args.profile,
        )

        rpc_url = f"http://127.0.0.1:{cfg.rpc_port}"
        cory_proc, cory_log_file, server_url, api_token = start_cory(
            root_dir=root_dir,
            rpc_url=rpc_url,
            rpc_user=cfg.rpc_user,
            rpc_pass=cfg.rpc_pass,
            bind=args.bind,
            port=port,
            local_labels=local_labels,
            log_path=cory_log,
        )
        wait_for_health(server_url)

        fixture = {
            "schema_version": 1,
            "run_id": cfg.run_id,
            "server_url": server_url,
            "api_token": api_token,
            "scenarios": [
                {
                    "name": s["name"],
                    "description": s["description"],
                    "root_txid": s["root_txid"],
                    "related_txids": s["related_txids"],
                    "suggested_ui_checks": s["suggested_ui_checks"],
                }
                for s in scenarios
            ],
        }
        fixture_file.write_text(json.dumps(fixture, indent=2), encoding="utf-8")

        print()
        print(f"Run ID:      {cfg.run_id}")
        print(f"Server URL:  {server_url}")
        print(f"API Token:   {api_token}")
        print(f"Fixture:     {fixture_file}")
        print(f"bitcoind log:{cfg.bitcoind_log}")
        print(f"cory log:    {cory_log}")

        print_scenario_table(scenarios)
        print_examples(server_url, api_token, scenarios)

        print()
        print("Shutdown")
        print("=" * 130)
        if args.no_hold:
            print("No-hold mode enabled; exiting after setup.")
            return 0

        print("Manual session is live. Press Ctrl+C in this terminal to stop cory and bitcoind.")
        while not interrupted:
            time.sleep(0.25)
        print("Received Ctrl+C, shutting down...")
        return 0
    finally:
        signal.signal(signal.SIGINT, previous_sigint)
        if cory_proc is not None:
            stop_process(cory_proc, name="cory")
        if cory_log_file is not None:
            cory_log_file.close()
        handle.stop()


if __name__ == "__main__":
    sys.exit(main())
