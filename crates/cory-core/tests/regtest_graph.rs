use std::collections::HashSet;
use std::sync::Once;
use std::{env, fs};

use bitcoin::Txid;
use cory_core::cache::Cache;
use cory_core::graph::build_ancestry;
use cory_core::rpc::HttpRpcClient;
use cory_core::types::GraphLimits;
use serde::Deserialize;

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

#[derive(Debug, Deserialize)]
struct GraphFixture {
    schema_version: u32,
    scenarios: Vec<GraphScenario>,
}

#[derive(Debug, Deserialize)]
struct GraphScenario {
    name: String,
    root_txid: String,
    limits: FixtureLimits,
    expect_truncated: bool,
    #[serde(default)]
    required_edges: Vec<FixtureEdge>,
    #[serde(default)]
    required_nodes: Vec<String>,
    #[serde(default)]
    expected_exact_node_count: Option<usize>,
    #[serde(default)]
    expected_exact_edge_count: Option<usize>,
    #[serde(default)]
    expected_unresolved_input_count: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct FixtureLimits {
    max_depth: usize,
    max_nodes: usize,
    max_edges: usize,
}

#[derive(Debug, Deserialize)]
struct FixtureEdge {
    spending_txid: String,
    input_index: u32,
    funding_txid: String,
    funding_vout: u32,
}

#[tokio::test(flavor = "multi_thread")]
#[ignore = "requires local regtest bitcoind; run scripts/regtest/graph.py"]
async fn regtest_graph_builder_handles_functional_and_stress_scenarios() {
    init_tracing();

    let rpc_url = env::var("CORY_TEST_RPC_URL").expect("CORY_TEST_RPC_URL must be set");
    let rpc_user = env::var("CORY_TEST_RPC_USER").expect("CORY_TEST_RPC_USER must be set");
    let rpc_pass = env::var("CORY_TEST_RPC_PASS").expect("CORY_TEST_RPC_PASS must be set");
    let fixture_file =
        env::var("CORY_TEST_GRAPH_FIXTURE_FILE").expect("CORY_TEST_GRAPH_FIXTURE_FILE must be set");

    let fixture_raw =
        fs::read_to_string(&fixture_file).expect("graph fixture file must be readable");
    let fixture: GraphFixture =
        serde_json::from_str(&fixture_raw).expect("graph fixture file must contain valid JSON");

    assert_eq!(
        fixture.schema_version, 1,
        "graph fixture schema version must be 1"
    );
    assert!(
        !fixture.scenarios.is_empty(),
        "graph fixture must include at least one scenario"
    );

    let rpc = HttpRpcClient::new(&rpc_url, Some(&rpc_user), Some(&rpc_pass));

    for scenario in fixture.scenarios {
        let root_txid: Txid = scenario
            .root_txid
            .parse()
            .expect("scenario root txid must parse");
        let limits = GraphLimits {
            max_depth: scenario.limits.max_depth,
            max_nodes: scenario.limits.max_nodes,
            max_edges: scenario.limits.max_edges,
        };

        // Use a fresh cache per scenario so assertions are independent.
        let cache = Cache::new();

        eprintln!(
            "[itest][graph] scenario={} root={} limits=({}, {}, {})",
            scenario.name, root_txid, limits.max_depth, limits.max_nodes, limits.max_edges
        );
        let graph = build_ancestry(&rpc, &cache, root_txid, &limits, 8)
            .await
            .expect("regtest graph build must succeed");

        assert_eq!(
            graph.root_txid, root_txid,
            "scenario={} root txid must match",
            scenario.name
        );
        assert_eq!(
            graph.truncated, scenario.expect_truncated,
            "scenario={} truncated flag mismatch",
            scenario.name
        );
        assert!(
            graph.nodes.contains_key(&root_txid),
            "scenario={} root node must be present",
            scenario.name
        );
        assert!(
            graph.nodes.len() <= limits.max_nodes,
            "scenario={} node_count exceeds limit: {} > {}",
            scenario.name,
            graph.nodes.len(),
            limits.max_nodes
        );
        assert!(
            graph.edges.len() <= limits.max_edges,
            "scenario={} edge_count exceeds limit: {} > {}",
            scenario.name,
            graph.edges.len(),
            limits.max_edges
        );
        assert_eq!(
            graph.stats.node_count,
            graph.nodes.len(),
            "scenario={} stats.node_count mismatch",
            scenario.name
        );
        assert_eq!(
            graph.stats.edge_count,
            graph.edges.len(),
            "scenario={} stats.edge_count mismatch",
            scenario.name
        );

        let got_edges: HashSet<(String, u32, String, u32)> = graph
            .edges
            .iter()
            .map(|edge| {
                (
                    edge.spending_txid.to_string(),
                    edge.input_index,
                    edge.funding_txid.to_string(),
                    edge.funding_vout,
                )
            })
            .collect();

        for want in &scenario.required_edges {
            let key = (
                want.spending_txid.clone(),
                want.input_index,
                want.funding_txid.clone(),
                want.funding_vout,
            );
            assert!(
                got_edges.contains(&key),
                "scenario={} missing required edge: {:?}",
                scenario.name,
                key
            );
        }

        for required_node in &scenario.required_nodes {
            let required_txid: Txid = required_node
                .parse()
                .expect("required node txid in fixture must parse");
            assert!(
                graph.nodes.contains_key(&required_txid),
                "scenario={} missing required node {}",
                scenario.name,
                required_node
            );
        }

        if let Some(expected_nodes) = scenario.expected_exact_node_count {
            assert_eq!(
                graph.nodes.len(),
                expected_nodes,
                "scenario={} exact node_count mismatch",
                scenario.name
            );
        }
        if let Some(expected_edges) = scenario.expected_exact_edge_count {
            assert_eq!(
                graph.edges.len(),
                expected_edges,
                "scenario={} exact edge_count mismatch",
                scenario.name
            );
        }

        for edge in &graph.edges {
            assert!(
                graph.nodes.contains_key(&edge.spending_txid),
                "scenario={} edge spending node must exist: {}",
                scenario.name,
                edge.spending_txid
            );
        }
        if !graph.truncated {
            for edge in &graph.edges {
                assert!(
                    graph.nodes.contains_key(&edge.funding_txid),
                    "scenario={} non-truncated graph has edge to missing funding node {}",
                    scenario.name,
                    edge.funding_txid
                );
            }
        }

        if let Some(expected_unresolved) = scenario.expected_unresolved_input_count {
            let root = graph
                .nodes
                .get(&root_txid)
                .expect("root node must exist in graph nodes map");
            let unresolved = root
                .inputs
                .iter()
                .filter(|input| input.value.is_none())
                .count();
            assert_eq!(
                unresolved, expected_unresolved,
                "scenario={} unresolved root input count mismatch",
                scenario.name
            );
        }
    }

    eprintln!("[itest][graph] integration test completed");
}
