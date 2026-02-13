use clap::Parser;

fn parse_nonzero_usize(s: &str) -> Result<usize, String> {
    let n: usize = s.parse().map_err(|e| format!("{e}"))?;
    if n == 0 {
        return Err("value must be at least 1".to_string());
    }
    Ok(n)
}

/// Cory — local Bitcoin transaction ancestry explorer with BIP-329 label editing.
#[derive(Parser)]
#[command(version, about)]
pub struct Cli {
    /// Bitcoin Core RPC URL.
    #[arg(long, default_value = "http://127.0.0.1:8332", env = "CORY_RPC_URL")]
    pub rpc_url: String,

    /// RPC username (optional; not needed for token-in-URL providers).
    #[arg(long, env = "CORY_RPC_USER")]
    pub rpc_user: Option<String>,

    /// RPC password (optional; not needed for token-in-URL providers).
    #[arg(long, env = "CORY_RPC_PASS")]
    pub rpc_pass: Option<String>,

    /// Address to bind the web server to.
    #[arg(long, default_value = "127.0.0.1")]
    pub bind: String,

    /// Port to listen on.
    #[arg(long, default_value = "3080")]
    pub port: u16,

    /// Label pack directories to load (repeatable, read-only in the UI).
    #[arg(long)]
    pub label_pack_dir: Vec<std::path::PathBuf>,

    /// Maximum ancestry graph depth.
    #[arg(long, default_value = "50")]
    pub max_depth: usize,

    /// Maximum number of graph nodes.
    #[arg(long, default_value = "500")]
    pub max_nodes: usize,

    /// Maximum number of graph edges.
    #[arg(long, default_value = "2000")]
    pub max_edges: usize,

    /// Maximum number of transactions to keep in the in-memory cache.
    /// Older entries are evicted in LRU order.
    #[arg(long, default_value = "10000")]
    pub cache_tx_cap: usize,

    /// Maximum number of prevout entries to keep in the in-memory cache.
    #[arg(long, default_value = "50000")]
    pub cache_prevout_cap: usize,

    /// Directory to persist local label files to disk. When set, label
    /// edits are written through to JSONL files in this directory and
    /// loaded on startup. Without this flag, local labels are ephemeral.
    #[arg(long)]
    pub label_dir: Option<std::path::PathBuf>,

    /// Maximum concurrent RPC calls (must be at least 1).
    #[arg(long, default_value = "4", value_parser = parse_nonzero_usize)]
    pub rpc_concurrency: usize,
}
