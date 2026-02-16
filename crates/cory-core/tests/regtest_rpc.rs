use std::sync::Once;
use std::{env, fs};

use bitcoin::{OutPoint, Txid};
use cory_core::rpc::{BitcoinRpc, HttpRpcClient};

static TRACING_INIT: Once = Once::new();

fn init_tracing() {
    TRACING_INIT.call_once(|| {
        let _ = tracing_subscriber::fmt()
            .with_env_filter(
                tracing_subscriber::EnvFilter::try_from_default_env()
                    .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("cory_core=debug")),
            )
            .with_target(true)
            .try_init();
    });
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires local regtest bitcoind; run scripts/regtest/rpc_e2e.py"]
async fn regtest_rpc_client_parses_blockchain_info_and_transactions() {
    init_tracing();

    let rpc_url = env::var("CORY_TEST_RPC_URL").expect("CORY_TEST_RPC_URL must be set");
    let rpc_user = env::var("CORY_TEST_RPC_USER").expect("CORY_TEST_RPC_USER must be set");
    let rpc_pass = env::var("CORY_TEST_RPC_PASS").expect("CORY_TEST_RPC_PASS must be set");
    let txids_file = env::var("CORY_TEST_TXIDS_FILE").expect("CORY_TEST_TXIDS_FILE must be set");
    let outpoints_file =
        env::var("CORY_TEST_OUTPOINTS_FILE").expect("CORY_TEST_OUTPOINTS_FILE must be set");

    let rpc = HttpRpcClient::new(&rpc_url, Some(&rpc_user), Some(&rpc_pass), None, None, 10)
        .expect("rpc client must construct");

    eprintln!("[itest] checking get_blockchain_info against {rpc_url}");
    let info = rpc
        .get_blockchain_info()
        .await
        .expect("regtest get_blockchain_info must succeed");
    assert_eq!(info.chain, "regtest");
    assert!(
        info.blocks >= 110,
        "regtest must have mined setup blocks before running tx checks"
    );

    let txids_raw = fs::read_to_string(&txids_file).expect("txid fixture file must be readable");
    let mut txids = Vec::new();
    for line in txids_raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        txids.push(trimmed.parse::<Txid>().expect("fixture txid must parse"));
    }
    assert!(!txids.is_empty(), "fixture txid list must not be empty");
    eprintln!(
        "[itest] validating {} transactions via get_transaction",
        txids.len()
    );

    for txid in txids {
        let tx = rpc
            .get_transaction(&txid)
            .await
            .expect("regtest get_transaction must succeed");
        assert_eq!(tx.txid, txid, "decoded txid must match requested txid");
        assert!(
            !tx.outputs.is_empty(),
            "decoded transaction must include at least one output"
        );

        for output in &tx.outputs {
            assert!(
                !output.script_pub_key.is_empty(),
                "decoded output script must not be empty"
            );
        }
    }

    let outpoints_raw =
        fs::read_to_string(&outpoints_file).expect("outpoint fixture file must be readable");
    let mut outpoints = Vec::new();
    for line in outpoints_raw.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let (txid_str, vout_str) = trimmed
            .split_once(':')
            .expect("outpoint line must be formatted as txid:vout");
        let txid: Txid = txid_str.parse().expect("fixture outpoint txid must parse");
        let vout: u32 = vout_str.parse().expect("fixture outpoint vout must parse");
        outpoints.push(OutPoint::new(txid, vout));
    }
    assert!(
        !outpoints.is_empty(),
        "fixture outpoint list must not be empty"
    );
    eprintln!(
        "[itest] validating {} outpoints via get_tx_outs (batch)",
        outpoints.len()
    );
    let batch = rpc
        .get_tx_outs(&outpoints)
        .await
        .expect("regtest get_tx_outs must succeed for fixture outpoints");
    assert_eq!(
        batch.len(),
        outpoints.len(),
        "batch result length must match request length"
    );
    for txout in &batch {
        let txout = txout
            .as_ref()
            .expect("fixture outpoint in batch result must still be unspent");
        assert!(
            txout.value.to_sat() > 0,
            "fixture outpoint value must be positive"
        );
        assert!(
            !txout.script_pub_key.is_empty(),
            "fixture outpoint script must not be empty"
        );
    }

    // Also validate single-request path for a subset.
    eprintln!("[itest] validating subset via get_tx_out (single)");
    for outpoint in outpoints.iter().take(3) {
        let txout = rpc
            .get_tx_out(&outpoint.txid, outpoint.vout)
            .await
            .expect("regtest get_tx_out must succeed for fixture outpoint");
        let txout = txout.expect("fixture outpoint must still be unspent");
        assert!(
            txout.value.to_sat() > 0,
            "fixture outpoint value must be positive"
        );
        assert!(
            !txout.script_pub_key.is_empty(),
            "fixture outpoint script must not be empty"
        );
    }
    eprintln!("[itest] integration test completed");
}
