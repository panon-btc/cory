#!/usr/bin/env python3
from __future__ import annotations

import json
import os
from pathlib import Path
import sys
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from common import (
    MAX_INPUTS_PER_TX,
    MAX_OUTPUTS_PER_TX,
    PER_TX_FEE_SAT,
    fund_wallet_utxos,
    log,
    make_config,
    mine_to_wallet,
    run_ignored_rust_test,
    spend_inputs,
    start_bitcoind,
)


def chunked(items: list[dict[str, Any]], size: int) -> list[list[dict[str, Any]]]:
    return [items[i : i + size] for i in range(0, len(items), size)]


def compress_to_single_outpoint(
    cli,
    cli_json,
    *,
    wallet: str,
    mine_wallet: str,
    outpoints: list[dict[str, Any]],
) -> tuple[str, list[dict[str, Any]], list[dict[str, Any]]]:
    if not outpoints:
        raise RuntimeError("outpoints must not be empty")
    if len(outpoints) <= MAX_INPUTS_PER_TX:
        txid, final_outs = spend_inputs(
            cli,
            cli_json,
            wallet=wallet,
            inputs=outpoints,
            output_values=[sum(o["value_sat"] for o in outpoints) - PER_TX_FEE_SAT],
        )
        return txid, final_outs, outpoints

    current = outpoints
    while len(current) > MAX_INPUTS_PER_TX:
        next_round: list[dict[str, Any]] = []
        groups = chunked(current, MAX_INPUTS_PER_TX)
        for group in groups:
            txid, outs = spend_inputs(
                cli,
                cli_json,
                wallet=wallet,
                inputs=group,
                output_values=[sum(o["value_sat"] for o in group) - PER_TX_FEE_SAT],
            )
            _ = txid
            next_round.extend(outs)
        current = next_round
        mine_to_wallet(cli, wallet=mine_wallet, blocks=1)

    txid, final_outs = spend_inputs(
        cli,
        cli_json,
        wallet=wallet,
        inputs=current,
        output_values=[sum(o["value_sat"] for o in current) - PER_TX_FEE_SAT],
    )
    return txid, final_outs, current


def required_seed_utxos(tier: str, stress_target: int) -> int:
    functional_budget = 56
    stress_budget = stress_target + 24
    if tier == "functional":
        return functional_budget
    if tier == "stress":
        return stress_budget
    return functional_budget + stress_budget


def build_fixture_scenarios(
    *,
    cli,
    cli_json,
    wallet_graph: str,
    wallet_miner: str,
    mine_addr: str,
    stress_target: int,
    tier: str,
) -> list[dict[str, Any]]:
    utxos_needed = required_seed_utxos(tier, stress_target)
    log(f"funding {utxos_needed} seed UTXOs for tier={tier}")
    utxos = fund_wallet_utxos(
        cli,
        cli_json,
        source_wallet=wallet_miner,
        dest_wallet=wallet_graph,
        count=utxos_needed,
        value_sat=100_000_000,
        mine_addr=mine_addr,
    )

    def take_utxo() -> dict[str, Any]:
        if not utxos:
            raise RuntimeError("not enough funded UTXOs for scenario generation")
        return utxos.pop(0)

    scenarios: list[dict[str, Any]] = []

    if tier in {"all", "functional"}:
        # small_chain_3
        u0 = take_utxo()
        tx1, o1 = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=[u0],
            output_values=[u0["value_sat"] - 1_000],
        )
        tx2, o2 = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=o1,
            output_values=[o1[0]["value_sat"] - 1_000],
        )
        tx3, _o3 = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=o2,
            output_values=[o2[0]["value_sat"] - 1_000],
        )
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        limits = {"max_depth": 6, "max_nodes": 512, "max_edges": 2048}
        scenarios.append(
            {
                "name": "small_chain_3",
                "tier": "functional",
                "root_txid": tx3,
                "limits": limits,
                "expect_truncated": False,
                "required_nodes": [tx3, tx2, tx1],
                "required_edges": [
                    {
                        "spending_txid": tx3,
                        "input_index": 0,
                        "funding_txid": tx2,
                        "funding_vout": o2[0]["vout"],
                    },
                    {
                        "spending_txid": tx2,
                        "input_index": 0,
                        "funding_txid": tx1,
                        "funding_vout": o1[0]["vout"],
                    },
                ],
            }
        )

        # merge_parent_double_input
        u1 = take_utxo()
        parent_txid, parent_outs = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=[u1],
            output_values=[40_000_000, 59_999_000],
        )
        root_txid, _root_outs = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=parent_outs,
            output_values=[99_997_000],
        )
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        limits = {"max_depth": 6, "max_nodes": 512, "max_edges": 2048}
        scenarios.append(
            {
                "name": "merge_parent_double_input",
                "tier": "functional",
                "root_txid": root_txid,
                "limits": limits,
                "expect_truncated": False,
                "required_nodes": [root_txid, parent_txid],
                "required_edges": [
                    {
                        "spending_txid": root_txid,
                        "input_index": 0,
                        "funding_txid": parent_txid,
                        "funding_vout": parent_outs[0]["vout"],
                    },
                    {
                        "spending_txid": root_txid,
                        "input_index": 1,
                        "funding_txid": parent_txid,
                        "funding_vout": parent_outs[1]["vout"],
                    },
                ],
            }
        )

        # wide_frontier_32 (mine parents before root to avoid mempool ancestor limits)
        wide_inputs = [take_utxo() for _ in range(32)]
        parent_outs: list[dict[str, Any]] = []
        for utxo in wide_inputs:
            _txid, outs = spend_inputs(
                cli,
                cli_json,
                wallet=wallet_graph,
                inputs=[utxo],
                output_values=[utxo["value_sat"] - 1_000],
            )
            parent_outs.extend(outs)
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        wide_root, _wide_root_outs = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=parent_outs,
            output_values=[sum(o["value_sat"] for o in parent_outs) - 32_000],
        )
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        limits = {"max_depth": 6, "max_nodes": 2048, "max_edges": 8192}
        scenarios.append(
            {
                "name": "wide_frontier_32",
                "tier": "functional",
                "root_txid": wide_root,
                "limits": limits,
                "expect_truncated": False,
                "required_nodes": [wide_root],
                "required_edges": [
                    {
                        "spending_txid": wide_root,
                        "input_index": 0,
                        "funding_txid": parent_outs[0]["txid"],
                        "funding_vout": parent_outs[0]["vout"],
                    },
                    {
                        "spending_txid": wide_root,
                        "input_index": 31,
                        "funding_txid": parent_outs[31]["txid"],
                        "funding_vout": parent_outs[31]["vout"],
                    },
                ],
            }
        )

        # deep_chain_near_limit (40 tx chain)
        u2 = take_utxo()
        chain_out = [u2]
        chain_txids: list[str] = []
        for i in range(40):
            txid, chain_out = spend_inputs(
                cli,
                cli_json,
                wallet=wallet_graph,
                inputs=chain_out,
                output_values=[chain_out[0]["value_sat"] - 1_000],
            )
            chain_txids.append(txid)
            if (i + 1) % 20 == 0:
                mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        deep_root = chain_txids[-1]
        limits_full = {"max_depth": 60, "max_nodes": 4096, "max_edges": 8192}
        scenarios.append(
            {
                "name": "deep_chain_40_full",
                "tier": "functional",
                "root_txid": deep_root,
                "limits": limits_full,
                "expect_truncated": False,
                "required_nodes": [deep_root, chain_txids[-2], chain_txids[0]],
                "required_edges": [
                    {
                        "spending_txid": chain_txids[-1],
                        "input_index": 0,
                        "funding_txid": chain_txids[-2],
                        "funding_vout": chain_out[0]["vout"],
                    }
                ],
            }
        )

        limits_depth = {"max_depth": 10, "max_nodes": 4096, "max_edges": 8192}
        scenarios.append(
            {
                "name": "deep_chain_40_depth_limited",
                "tier": "functional",
                "root_txid": deep_root,
                "limits": limits_depth,
                "expect_truncated": True,
                "required_nodes": [deep_root],
                "required_edges": [],
            }
        )

        # node-limit truncation on wide root
        limits_nodes = {"max_depth": 10, "max_nodes": 5, "max_edges": 8192}
        scenarios.append(
            {
                "name": "node_limit_truncation",
                "tier": "functional",
                "root_txid": wide_root,
                "limits": limits_nodes,
                "expect_truncated": True,
                "required_nodes": [wide_root],
                "required_edges": [],
            }
        )

        # edge-limit truncation on wide root
        limits_edges = {"max_depth": 10, "max_nodes": 8192, "max_edges": 10}
        scenarios.append(
            {
                "name": "edge_limit_truncation",
                "tier": "functional",
                "root_txid": wide_root,
                "limits": limits_edges,
                "expect_truncated": True,
                "required_nodes": [wide_root],
                "required_edges": [],
                "expected_exact_node_count": 1,
                "expected_exact_edge_count": 0,
            }
        )

        # spent_prevout_gap
        u3 = take_utxo()
        parent, parent_out = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=[u3],
            output_values=[u3["value_sat"] - 1_000],
        )
        gap_root, _gap_out = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=parent_out,
            output_values=[parent_out[0]["value_sat"] - 1_000],
        )
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        limits_gap = {"max_depth": 0, "max_nodes": 64, "max_edges": 256}
        scenarios.append(
            {
                "name": "spent_prevout_gap",
                "tier": "functional",
                "root_txid": gap_root,
                "limits": limits_gap,
                "expect_truncated": True,
                "required_nodes": [gap_root],
                "required_edges": [
                    {
                        "spending_txid": gap_root,
                        "input_index": 0,
                        "funding_txid": parent,
                        "funding_vout": parent_out[0]["vout"],
                    }
                ],
                "expected_unresolved_input_count": 0,
            }
        )

    if tier in {"all", "stress"}:
        # stress_deep_500
        log(f"building stress_deep_{stress_target}")
        u4 = take_utxo()
        chain_out = [u4]
        deep_txids: list[str] = []
        for i in range(stress_target):
            txid, chain_out = spend_inputs(
                cli,
                cli_json,
                wallet=wallet_graph,
                inputs=chain_out,
                output_values=[chain_out[0]["value_sat"] - 1_000],
            )
            deep_txids.append(txid)
            if (i + 1) % 20 == 0:
                mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
                log(f"stress_deep progress: {i + 1}/{stress_target}")
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
        root_deep = deep_txids[-1]
        limits = {
            "max_depth": stress_target + 20,
            "max_nodes": stress_target + 200,
            "max_edges": (stress_target * 2) + 100,
        }
        scenarios.append(
            {
                "name": f"stress_deep_{stress_target}",
                "tier": "stress",
                "root_txid": root_deep,
                "limits": limits,
                "expect_truncated": False,
                "required_nodes": [root_deep, deep_txids[-2], deep_txids[0]],
                "required_edges": [
                    {
                        "spending_txid": deep_txids[-1],
                        "input_index": 0,
                        "funding_txid": deep_txids[-2],
                        "funding_vout": chain_out[0]["vout"],
                    }
                ],
            }
        )

        # stress_wide_500
        log(f"building stress_wide_{stress_target}")
        seed_inputs = [take_utxo() for _ in range(stress_target)]
        parents: list[dict[str, Any]] = []
        for idx, utxo in enumerate(seed_inputs):
            _txid, outs = spend_inputs(
                cli,
                cli_json,
                wallet=wallet_graph,
                inputs=[utxo],
                output_values=[utxo["value_sat"] - 1_000],
            )
            parents.extend(outs)
            if (idx + 1) % 50 == 0:
                log(f"stress_wide parent progress: {idx + 1}/{stress_target}")
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        wide_root, _wide_out, wide_root_inputs = compress_to_single_outpoint(
            cli,
            cli_json,
            wallet=wallet_graph,
            mine_wallet=wallet_miner,
            outpoints=parents,
        )
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        limits = {
            "max_depth": 6,
            "max_nodes": (stress_target * 3) + 200,
            "max_edges": (stress_target * 4) + 200,
        }
        scenarios.append(
            {
                "name": f"stress_wide_{stress_target}",
                "tier": "stress",
                "root_txid": wide_root,
                "limits": limits,
                "expect_truncated": False,
                "required_nodes": [wide_root],
                "required_edges": [
                    {
                        "spending_txid": wide_root,
                        "input_index": 0,
                        "funding_txid": wide_root_inputs[0]["txid"],
                        "funding_vout": wide_root_inputs[0]["vout"],
                    },
                    {
                        "spending_txid": wide_root,
                        "input_index": len(wide_root_inputs) - 1,
                        "funding_txid": wide_root_inputs[-1]["txid"],
                        "funding_vout": wide_root_inputs[-1]["vout"],
                    },
                ],
            }
        )

        # stress_merge_500
        log(f"building stress_merge_{stress_target}")
        u5 = take_utxo()
        merge_chain_len = max(1, stress_target - 2)
        merge_chain_out = [u5]
        for i in range(merge_chain_len):
            txid, merge_chain_out = spend_inputs(
                cli,
                cli_json,
                wallet=wallet_graph,
                inputs=merge_chain_out,
                output_values=[merge_chain_out[0]["value_sat"] - PER_TX_FEE_SAT],
            )
            _ = txid
            if (i + 1) % 20 == 0:
                mine_to_wallet(cli, wallet=wallet_miner, blocks=1)
                log(f"stress_merge chain progress: {i + 1}/{merge_chain_len}")
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        merge_fanout = min(MAX_OUTPUTS_PER_TX, 100)
        remaining = merge_chain_out[0]["value_sat"] - PER_TX_FEE_SAT
        output_value = remaining // merge_fanout
        if output_value <= 1_000:
            raise RuntimeError("merge parent output value became too small")
        merge_parent, merge_parent_outs = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=merge_chain_out,
            output_values=[output_value for _ in range(merge_fanout)],
        )
        merge_root, _merge_outs = spend_inputs(
            cli,
            cli_json,
            wallet=wallet_graph,
            inputs=merge_parent_outs,
            output_values=[(output_value * merge_fanout) - 2_000],
        )
        mine_to_wallet(cli, wallet=wallet_miner, blocks=1)

        limits = {
            # The merge scenario intentionally builds a long single-input chain
            # before fanout; allow enough depth so this stress case validates a
            # full (non-truncated) merge graph.
            "max_depth": merge_chain_len + 10,
            "max_nodes": 2048,
            "max_edges": (stress_target * 3) + 100,
        }
        scenarios.append(
            {
                "name": f"stress_merge_{stress_target}",
                "tier": "stress",
                "root_txid": merge_root,
                "limits": limits,
                "expect_truncated": False,
                "required_nodes": [merge_root, merge_parent],
                "required_edges": [
                    {
                        "spending_txid": merge_root,
                        "input_index": 0,
                        "funding_txid": merge_parent,
                        "funding_vout": merge_parent_outs[0]["vout"],
                    },
                    {
                        "spending_txid": merge_root,
                        "input_index": merge_fanout - 1,
                        "funding_txid": merge_parent,
                        "funding_vout": merge_parent_outs[-1]["vout"],
                    },
                ],
            }
        )

    return scenarios


def main() -> int:
    root_dir = Path(__file__).resolve().parent.parent.parent
    cfg = make_config(root_dir)

    wallet_miner = os.environ.get("WALLET_MINER", "itest_miner")
    wallet_graph = os.environ.get("WALLET_GRAPH", "itest_graph")
    stress_target = int(os.environ.get("GRAPH_STRESS_TX_TARGET", "500"))
    tier = os.environ.get("GRAPH_SCENARIO_TIER", "all")
    if tier not in {"all", "functional", "stress"}:
        raise RuntimeError("GRAPH_SCENARIO_TIER must be one of: all, functional, stress")

    fixture_file = Path(
        os.environ.get(
            "GRAPH_FIXTURE_FILE",
            str(cfg.tmp_dir / f"regtest_graph_fixture-{cfg.run_id}.json"),
        )
    )

    handle = start_bitcoind(cfg)
    try:
        log("creating graph test wallets")
        handle.cli(["createwallet", wallet_miner])
        handle.cli(["createwallet", wallet_graph])

        mine_addr = mine_to_wallet(handle.cli, wallet=wallet_miner, blocks=130)

        scenarios = build_fixture_scenarios(
            cli=handle.cli,
            cli_json=handle.cli_json,
            wallet_graph=wallet_graph,
            wallet_miner=wallet_miner,
            mine_addr=mine_addr,
            stress_target=stress_target,
            tier=tier,
        )

        payload = {
            "schema_version": 1,
            "tier": tier,
            "stress_target": stress_target,
            "scenarios": scenarios,
        }
        fixture_file.write_text(json.dumps(payload, indent=2), encoding="utf-8")
        log(f"wrote graph fixture to {fixture_file}")

        run_ignored_rust_test(
            cfg,
            test_name="regtest_graph",
            extra_env={
                "CORY_TEST_GRAPH_FIXTURE_FILE": str(fixture_file),
            },
        )
        log(f"graph integration check passed with {len(scenarios)} scenarios")
        return 0
    finally:
        handle.stop()


if __name__ == "__main__":
    sys.exit(main())
