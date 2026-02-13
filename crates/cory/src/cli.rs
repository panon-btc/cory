use std::path::PathBuf;

use clap::Parser;

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

    /// Label pack directories to load (repeatable).
    #[arg(long)]
    pub label_pack_dir: Vec<PathBuf>,

    /// Path to the local labels JSONL file for persistence.
    /// If omitted, labels are in-memory only.
    #[arg(long)]
    pub local_labels: Option<PathBuf>,

    /// Maximum ancestry graph depth.
    #[arg(long, default_value = "50")]
    pub max_depth: usize,

    /// Maximum number of graph nodes.
    #[arg(long, default_value = "500")]
    pub max_nodes: usize,

    /// Maximum number of graph edges.
    #[arg(long, default_value = "2000")]
    pub max_edges: usize,

    /// Maximum concurrent RPC calls.
    #[arg(long, default_value = "4")]
    pub rpc_concurrency: usize,
}
