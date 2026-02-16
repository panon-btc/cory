use clap::Parser;

fn parse_nonzero_usize(s: &str) -> Result<usize, String> {
    let n: usize = s.parse().map_err(|e| format!("{e}"))?;
    if n == 0 {
        return Err("value must be at least 1".to_string());
    }
    Ok(n)
}

fn parse_nonzero_u32(s: &str) -> Result<u32, String> {
    let n: u32 = s.parse().map_err(|e| format!("{e}"))?;
    if n == 0 {
        return Err("value must be at least 1".to_string());
    }
    Ok(n)
}

/// Cory — local Bitcoin transaction ancestry explorer with BIP-329 label editing.
#[derive(Parser)]
#[command(version, about)]
pub struct Cli {
    /// Bitcoin RPC connection target (HTTP URL).
    #[arg(
        long,
        default_value = "http://127.0.0.1:8332",
        env = "CORY_CONNECTION",
        help_heading = "RPC"
    )]
    pub connection: String,

    /// RPC username (optional; not needed for token-in-URL providers).
    #[arg(long, env = "CORY_RPC_USER", help_heading = "RPC")]
    pub rpc_user: Option<String>,

    /// RPC password (optional; not needed for token-in-URL providers).
    #[arg(long, env = "CORY_RPC_PASS", help_heading = "RPC")]
    pub rpc_pass: Option<String>,

    /// RPC cookie file with `username:password` for local node auth.
    #[arg(long, env = "CORY_RPC_COOKIE_FILE", help_heading = "RPC")]
    pub rpc_cookie_file: Option<std::path::PathBuf>,

    /// Optional RPC request rate limit in requests/second (must be >= 1).
    #[arg(
        long,
        env = "CORY_RPC_REQUESTS_PER_SECOND",
        value_parser = parse_nonzero_u32,
        help_heading = "RPC"
    )]
    pub rpc_requests_per_second: Option<u32>,

    /// Maximum number of RPC calls per JSON-RPC batch chunk (must be >= 1).
    #[arg(
        long,
        env = "CORY_RPC_BATCH_CHUNK_SIZE",
        default_value = "10",
        value_parser = parse_nonzero_usize,
        help_heading = "RPC"
    )]
    pub rpc_batch_chunk_size: usize,

    /// Maximum concurrent RPC calls (must be at least 1).
    #[arg(
        long,
        default_value = "4",
        value_parser = parse_nonzero_usize,
        help_heading = "RPC"
    )]
    pub rpc_concurrency: usize,

    /// Address to bind the web server to.
    #[arg(long, default_value = "127.0.0.1", help_heading = "Server")]
    pub bind: String,

    /// Port to listen on.
    #[arg(long, default_value = "3080", help_heading = "Server")]
    pub port: u16,

    /// Editable label directories (repeatable). Labels loaded from these
    /// directories are editable in the UI and auto-flushed to disk.
    #[arg(long, help_heading = "Labels")]
    pub labels_rw: Vec<std::path::PathBuf>,

    /// Read-only label directories (repeatable). Labels loaded from these
    /// directories appear in the UI but cannot be edited.
    #[arg(long, help_heading = "Labels")]
    pub labels_ro: Vec<std::path::PathBuf>,

    /// Maximum ancestry graph depth.
    #[arg(long, default_value = "50", help_heading = "Graph Limits")]
    pub max_depth: usize,

    /// Maximum number of graph nodes.
    #[arg(long, default_value = "500", help_heading = "Graph Limits")]
    pub max_nodes: usize,

    /// Maximum number of graph edges.
    #[arg(long, default_value = "2000", help_heading = "Graph Limits")]
    pub max_edges: usize,

    /// Maximum number of transactions to keep in the in-memory cache.
    /// Older entries are evicted in LRU order.
    #[arg(long, default_value = "10000", help_heading = "Cache")]
    pub cache_tx_cap: usize,

    /// Maximum number of prevout entries to keep in the in-memory cache.
    #[arg(long, default_value = "50000", help_heading = "Cache")]
    pub cache_prevout_cap: usize,
}
