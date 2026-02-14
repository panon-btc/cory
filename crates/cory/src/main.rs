mod cli;
mod server;

use std::sync::Arc;

use bitcoin::Network;
use clap::Parser;
use eyre::{eyre, WrapErr};

use cory_core::labels::LabelStore;

#[tokio::main]
async fn main() -> eyre::Result<()> {
    let args = cli::Cli::parse();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .with_file(true)
        .with_line_number(true)
        .with_level(true)
        .init();

    // Generate a random API token for this server session.
    let api_token = {
        use rand::Rng;
        let bytes: [u8; 16] = rand::thread_rng().r#gen();
        hex_encode(bytes)
    };

    // Connect to Bitcoin Core RPC and verify the connection succeeds
    // before starting the server.
    let rpc: Arc<dyn cory_core::rpc::BitcoinRpc> = Arc::new(cory_core::rpc::HttpRpcClient::new(
        &args.rpc_url,
        args.rpc_user.as_deref(),
        args.rpc_pass.as_deref(),
    ));

    let chain_info = rpc.get_blockchain_info().await.map_err(|err| {
        let message = format_rpc_connect_error(&args.rpc_url, &err.to_string());
        eyre!(message).wrap_err("while attempting to connect to Bitcoin Core RPC")
    })?;

    tracing::info!(
        chain = %chain_info.chain,
        blocks = chain_info.blocks,
        "connected to Bitcoin Core"
    );
    if chain_info.pruned {
        tracing::warn!("node is pruned — fetching old transactions may fail");
    }

    // Verify txindex is available by attempting to fetch a confirmed transaction.
    // Without txindex, getrawtransaction only works for mempool transactions,
    // making graph traversal fail on confirmed ancestors.
    if chain_info.blocks > 0 {
        check_txindex_available(rpc.as_ref()).await;
    }

    // Initialize caches and label store.
    let cache = Arc::new(cory_core::cache::Cache::with_capacity(
        args.cache_tx_cap,
        args.cache_prevout_cap,
    ));
    let mut label_store = match &args.label_dir {
        Some(dir) => {
            let store =
                LabelStore::with_persistence(dir).context("load persisted label directory")?;
            tracing::info!(path = %dir.display(), "loaded persisted label store");
            store
        }
        None => LabelStore::new(),
    };

    // Load label pack directories.
    for dir in &args.label_pack_dir {
        label_store
            .load_pack_dir(dir)
            .context("load label pack directory")?;
        tracing::info!(path = %dir.display(), "loaded label pack");
    }

    let graph_limits = cory_core::GraphLimits {
        max_depth: args.max_depth,
        max_nodes: args.max_nodes,
        max_edges: args.max_edges,
    };

    let state = server::AppState {
        rpc,
        cache,
        labels: Arc::new(tokio::sync::RwLock::new(label_store)),
        api_token: api_token.clone(),
        default_limits: graph_limits,
        rpc_concurrency: args.rpc_concurrency,
        network: map_chain_to_network(&chain_info.chain)?,
    };

    let bind_addr = format!("{}:{}", args.bind, args.port);
    let origin = format!("http://{}:{}", args.bind, args.port);
    let router = server::build_router(state, &origin);

    if args.bind == "0.0.0.0" {
        tracing::warn!("server is bound to 0.0.0.0 — it is accessible from the network");
    }

    println!();
    println!("  Cory is running:");
    println!("    URL:       http://{bind_addr}?token={api_token}");
    println!();

    let listener = tokio::net::TcpListener::bind(&bind_addr)
        .await
        .context("bind TCP listener")?;

    tracing::info!("listening on {bind_addr}");
    axum::serve(listener, router)
        .await
        .context("run HTTP server")?;

    Ok(())
}

/// Tiny hex-encoding helper to avoid adding a `hex` crate dependency.
fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

/// Best-effort check that txindex is available. If `getrawtransaction` fails
/// for any known confirmed txid, we warn the user with an actionable message.
/// This uses the genesis coinbase txid for the chain, which is always confirmed
/// but only retrievable with txindex (the genesis coinbase is special on mainnet,
/// but works on regtest/testnet/signet).
async fn check_txindex_available(rpc: &dyn cory_core::rpc::BitcoinRpc) {
    // Use a zero txid as a probe — it will always fail without txindex.
    // We specifically care about the error type: "No such mempool or blockchain
    // transaction" means txindex is missing, other errors are unrelated.
    let probe_txid: bitcoin::Txid =
        "0000000000000000000000000000000000000000000000000000000000000001"
            .parse()
            .expect("valid dummy txid");

    match rpc.get_transaction(&probe_txid).await {
        Ok(_) => {
            // Unexpectedly succeeded — txindex is definitely available.
        }
        Err(e) => {
            let msg = e.to_string();
            // "No such mempool or blockchain transaction" is the Bitcoin Core
            // error when txindex is disabled and the tx is not in mempool.
            // We can't distinguish "not found because txindex is off" from
            // "not found because the txid doesn't exist", so we emit an
            // info-level message rather than an error.
            if msg.contains("No such mempool") || msg.contains("not found") {
                tracing::info!(
                    "txindex probe inconclusive — if graph queries fail for confirmed \
                     transactions, ensure bitcoind is running with -txindex=1"
                );
            }
            // Other errors (network, auth) are already covered by the
            // initial getblockchaininfo check.
        }
    }
}

fn format_rpc_connect_error(rpc_url: &str, source_error: &str) -> String {
    let mut lines = vec![
        format!("could not connect to RPC endpoint `{rpc_url}`"),
        format!("RPC error: {source_error}"),
    ];

    if source_error.contains("Could not resolve host") || source_error.contains("dns error") {
        lines.push(
            "hint: hostname resolution failed; verify the endpoint hostname and your DNS/network"
                .into(),
        );
    } else if source_error.contains("tls")
        || source_error.contains("certificate")
        || source_error.contains("SSL")
    {
        lines.push(
            "hint: TLS handshake failed; verify certificate trust and that the endpoint uses HTTPS"
                .into(),
        );
    } else if source_error.contains("401") || source_error.contains("403") {
        lines.push(
            "hint: authentication failed; verify token-in-URL or --rpc-user/--rpc-pass".into(),
        );
    } else if source_error.contains("404") {
        lines.push(
            "hint: endpoint path is invalid; verify the full RPC URL including token path".into(),
        );
    } else if source_error.contains("error sending request for url") {
        lines.push("hint: request could not be sent; verify URL format, network access, and endpoint reachability".into());
    }

    lines.join("\n")
}

fn map_chain_to_network(chain: &str) -> eyre::Result<Network> {
    match chain {
        "main" => Ok(Network::Bitcoin),
        "test" => Ok(Network::Testnet),
        "signet" => Ok(Network::Signet),
        "regtest" => Ok(Network::Regtest),
        _ => Err(eyre!(
            "unrecognized chain name `{chain}` from getblockchaininfo"
        )),
    }
}
