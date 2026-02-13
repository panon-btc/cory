mod auth;
mod cli;
mod server;

use std::sync::Arc;

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

    // Generate a secret for JWT signing.
    let jwt_secret = auth::generate_jwt_secret();
    let jwt_manager = Arc::new(auth::JwtManager::new(jwt_secret));

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

    // Initialize caches and label store.
    let cache = Arc::new(cory_core::cache::Cache::new());
    let mut label_store = LabelStore::new();

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
        jwt_manager: jwt_manager.clone(),
        default_limits: graph_limits,
        rpc_concurrency: args.rpc_concurrency,
    };

    let bind_addr = format!("{}:{}", args.bind, args.port);
    let origin = format!("http://{}:{}", args.bind, args.port);
    let router = server::build_router(state, &origin);

    if args.bind == "0.0.0.0" {
        tracing::warn!("server is bound to 0.0.0.0 — it is accessible from the network");
    }

    println!();
    println!("  Cory is running:");
    println!("    URL: http://{bind_addr}");
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
