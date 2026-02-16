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
    let rpc_client = cory_core::rpc::HttpRpcClient::new(
        &args.connection,
        args.rpc_user.as_deref(),
        args.rpc_pass.as_deref(),
        args.rpc_cookie_file.as_deref(),
        args.rpc_requests_per_second,
        args.rpc_batch_chunk_size,
    )
    .map_err(|err| {
        let message = format_rpc_connect_error(&args.connection, &err.to_string());
        eyre!(message).wrap_err("while attempting to configure Bitcoin Core RPC client")
    })?;
    let rpc: Arc<dyn cory_core::rpc::BitcoinRpc> = Arc::new(rpc_client);

    let chain_info = rpc.get_blockchain_info().await.map_err(|err| {
        let message = format_rpc_connect_error(&args.connection, &err.to_string());
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

    // Initialize caches and label store.
    let cache = Arc::new(cory_core::cache::Cache::with_capacity(
        args.cache_tx_cap,
        args.cache_prevout_cap,
    ));
    let mut label_store = LabelStore::new();
    for dir in &args.labels_rw {
        label_store
            .load_rw_dir(dir)
            .context("load --labels-rw directory")?;
        tracing::info!(path = %dir.display(), "loaded labels-rw directory");
    }
    for dir in &args.labels_ro {
        label_store
            .load_ro_dir(dir)
            .context("load --labels-ro directory")?;
        tracing::info!(path = %dir.display(), "loaded labels-ro directory");
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

// ==============================================================================
// Startup Helpers
// ==============================================================================

/// Tiny hex-encoding helper to avoid adding a `hex` crate dependency.
fn hex_encode(bytes: impl AsRef<[u8]>) -> String {
    bytes.as_ref().iter().map(|b| format!("{b:02x}")).collect()
}

fn format_rpc_connect_error(connection: &str, source_error: &str) -> String {
    let mut lines = vec![
        format!("could not connect to RPC endpoint `{connection}`"),
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
            "hint: authentication failed; verify token-in-URL, --rpc-user/--rpc-pass, or --rpc-cookie-file".into(),
        );
    } else if source_error.contains("404") {
        lines.push(
            "hint: endpoint path is invalid; verify the full RPC URL including token path".into(),
        );
    } else if source_error.contains("cookie")
        || source_error.contains("both rpc user and rpc pass must be set together")
    {
        lines.push("hint: use --rpc-user/--rpc-pass together, or provide --rpc-cookie-file".into());
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
