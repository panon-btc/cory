#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import json
import os
import re
import socket
from dataclasses import dataclass
from pathlib import Path
import shutil
import subprocess
import time
from typing import Any
import urllib.error
import urllib.request


def log(msg: str) -> None:
    print(f"[itest] {msg}", flush=True)


def run(
    cmd: list[str],
    *,
    capture: bool = True,
    check: bool = True,
    env: dict[str, str] | None = None,
) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        check=check,
        text=True,
        capture_output=capture,
        env=env,
    )


@dataclass
class RegtestConfig:
    root_dir: Path
    tmp_dir: Path
    run_id: str
    datadir: Path
    rpc_user: str
    rpc_pass: str
    rpc_port: int
    p2p_port: int
    bitcoind_log: Path


@dataclass
class RegtestHandle:
    cfg: RegtestConfig
    bitcoind: subprocess.Popen[str]
    log_file: Any

    def cli(self, args: list[str], *, rpc_wallet: str | None = None) -> str:
        base = [
            "bitcoin-cli",
            "-regtest",
            f"-datadir={self.cfg.datadir}",
            f"-rpcuser={self.cfg.rpc_user}",
            f"-rpcpassword={self.cfg.rpc_pass}",
            f"-rpcport={self.cfg.rpc_port}",
        ]
        if rpc_wallet:
            base.append(f"-rpcwallet={rpc_wallet}")
        cp = run(base + args, capture=True)
        return cp.stdout.strip()

    def cli_json(self, args: list[str], *, rpc_wallet: str | None = None) -> Any:
        out = self.cli(args, rpc_wallet=rpc_wallet)
        if not out:
            return None
        return json.loads(out)

    def stop(self) -> None:
        try:
            self.cli(["stop"])
        except subprocess.CalledProcessError:
            pass
        try:
            self.bitcoind.wait(timeout=15)
        except subprocess.TimeoutExpired:
            self.bitcoind.kill()
            self.bitcoind.wait(timeout=5)
        self.log_file.close()


def make_config(root_dir: Path) -> RegtestConfig:
    tmp_dir = root_dir / "tmp"
    tmp_dir.mkdir(parents=True, exist_ok=True)

    run_id = f"{dt.datetime.now(dt.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-{os.getpid()}"
    datadir = Path(os.environ.get("DATADIR", str(tmp_dir / f"regtest-it-{run_id}")))
    rpc_user = os.environ.get("RPC_USER", "cory")
    rpc_pass = os.environ.get("RPC_PASS", "corypass")
    rpc_port = int(os.environ.get("RPC_PORT", "18443"))
    p2p_port = int(os.environ.get("P2P_PORT", "18444"))
    bitcoind_log = Path(
        os.environ.get("BITCOIND_LOG", str(tmp_dir / f"regtest-bitcoind-{run_id}.log"))
    )

    return RegtestConfig(
        root_dir=root_dir,
        tmp_dir=tmp_dir,
        run_id=run_id,
        datadir=datadir,
        rpc_user=rpc_user,
        rpc_pass=rpc_pass,
        rpc_port=rpc_port,
        p2p_port=p2p_port,
        bitcoind_log=bitcoind_log,
    )


def start_bitcoind(cfg: RegtestConfig) -> RegtestHandle:
    log(f"run_id={cfg.run_id}")
    log(f"datadir={cfg.datadir}")
    if cfg.datadir.exists():
        shutil.rmtree(cfg.datadir)
    cfg.datadir.mkdir(parents=True, exist_ok=True)

    conf = "\n".join(
        [
            "regtest=1",
            "server=1",
            "daemon=0",
            "txindex=1",
            "fallbackfee=0.0002",
            f"rpcuser={cfg.rpc_user}",
            f"rpcpassword={cfg.rpc_pass}",
            "listen=0",
            "dnsseed=0",
            "discover=0",
            "",
            "[regtest]",
            "rpcbind=127.0.0.1",
            "rpcallowip=127.0.0.1",
            f"rpcport={cfg.rpc_port}",
            f"port={cfg.p2p_port}",
            "",
        ]
    )
    conf_path = cfg.datadir / "bitcoin.conf"
    conf_path.write_text(conf, encoding="utf-8")

    log(f"starting bitcoind, log={cfg.bitcoind_log}")
    log_file = cfg.bitcoind_log.open("w", encoding="utf-8")
    bitcoind = subprocess.Popen(
        ["bitcoind", f"-datadir={cfg.datadir}", f"-conf={conf_path}"],
        stdout=log_file,
        stderr=subprocess.STDOUT,
        text=True,
    )
    handle = RegtestHandle(cfg=cfg, bitcoind=bitcoind, log_file=log_file)

    ready = False
    for _ in range(60):
        try:
            handle.cli(["getblockchaininfo"])
            ready = True
            break
        except subprocess.CalledProcessError:
            time.sleep(1)
    if not ready:
        handle.stop()
        raise RuntimeError("bitcoind RPC did not come up within 60s")

    return handle


def pick_free_port() -> int:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.bind(("127.0.0.1", 0))
    port = sock.getsockname()[1]
    sock.close()
    return port


def wait_for_health(base_url: str, timeout_sec: int = 30) -> None:
    deadline = time.time() + timeout_sec
    last_error: Exception | None = None

    while time.time() < deadline:
        try:
            req = urllib.request.Request(f"{base_url}/api/v1/health", method="GET")
            with urllib.request.urlopen(req, timeout=2) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                if resp.status == 200 and body.get("status") == "ok":
                    return
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as err:
            last_error = err
            time.sleep(0.5)

    raise RuntimeError(f"cory health check did not become ready in time: {last_error}")


def stop_process(proc: subprocess.Popen[str], *, name: str, timeout_sec: int = 15) -> None:
    if proc.poll() is not None:
        return
    log(f"stopping {name}")
    proc.terminate()
    try:
        proc.wait(timeout=timeout_sec)
    except subprocess.TimeoutExpired:
        proc.kill()
        proc.wait(timeout=5)


def start_cory(
    *,
    root_dir: Path,
    rpc_url: str,
    rpc_user: str,
    rpc_pass: str,
    bind: str,
    port: int,
    log_path: Path,
) -> tuple[subprocess.Popen[str], Any, str, str]:
    cmd = [
        "cargo",
        "run",
        "--bin",
        "cory",
        "--",
        "--rpc-url",
        rpc_url,
        "--rpc-user",
        rpc_user,
        "--rpc-pass",
        rpc_pass,
        "--bind",
        bind,
        "--port",
        str(port),
    ]
    log(f"starting cory server, log={log_path}")
    log_file = log_path.open("w", encoding="utf-8")
    proc = subprocess.Popen(
        cmd,
        cwd=root_dir,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    url_pat = re.compile(r"URL:\s+(http://\S+)")
    url = None

    deadline = time.time() + 90
    while time.time() < deadline:
        if proc.poll() is not None:
            raise RuntimeError(f"cory exited during startup with code {proc.returncode}")
        line = proc.stdout.readline()
        if line:
            log_file.write(line)
            log_file.flush()
            if url is None:
                match = url_pat.search(line)
                if match:
                    url = match.group(1).strip()
            if url is not None:
                # No longer waiting for token - auth is automatic via cookies
                return proc, log_file, url, None
        else:
            time.sleep(0.1)

    raise RuntimeError("timed out waiting for cory startup output (URL)")


SATS_PER_BTC = 100_000_000
PER_TX_FEE_SAT = 1_000
MAX_INPUTS_PER_TX = 100
MAX_OUTPUTS_PER_TX = 100


def sat_to_btc(sats: int) -> float:
    return round(sats / SATS_PER_BTC, 8)


def mine_to_wallet(cli, *, wallet: str, blocks: int) -> str:
    mine_addr = cli(["getnewaddress", "", "bech32"], rpc_wallet=wallet)
    cli(["generatetoaddress", str(blocks), mine_addr])
    return mine_addr


def resolve_outpoints_for_addresses(
    cli_json,
    txid: str,
    addresses: list[str],
    output_values: list[int],
) -> list[dict[str, Any]]:
    tx = cli_json(["getrawtransaction", txid, "1"])
    by_addr: dict[str, int] = {}
    for out in tx.get("vout", []):
        script = out.get("scriptPubKey", {})
        addr = script.get("address")
        if addr is not None:
            by_addr[addr] = int(out["n"])

    outpoints = []
    for addr, value_sat in zip(addresses, output_values):
        if addr not in by_addr:
            raise RuntimeError(f"output address {addr} not found in tx {txid}")
        outpoints.append(
            {
                "txid": txid,
                "vout": by_addr[addr],
                "value_sat": value_sat,
                "address": addr,
            }
        )
    return outpoints


def spend_inputs(
    cli,
    cli_json,
    *,
    wallet: str,
    inputs: list[dict[str, Any]],
    output_values: list[int],
) -> tuple[str, list[dict[str, Any]]]:
    if not inputs:
        raise RuntimeError("inputs must not be empty")
    if len(inputs) > MAX_INPUTS_PER_TX:
        raise RuntimeError(
            f"input count {len(inputs)} exceeds MAX_INPUTS_PER_TX={MAX_INPUTS_PER_TX}"
        )
    if len(output_values) > MAX_OUTPUTS_PER_TX:
        raise RuntimeError(
            f"output count {len(output_values)} exceeds MAX_OUTPUTS_PER_TX={MAX_OUTPUTS_PER_TX}"
        )

    input_sum = sum(inp["value_sat"] for inp in inputs)
    output_sum = sum(output_values)
    if output_sum >= input_sum:
        raise RuntimeError(f"output_sum={output_sum} must be less than input_sum={input_sum}")

    addresses = [
        cli(["getnewaddress", "", "bech32"], rpc_wallet=wallet)
        for _ in output_values
    ]
    raw_inputs = [{"txid": inp["txid"], "vout": inp["vout"]} for inp in inputs]
    raw_outputs = {addr: sat_to_btc(sats) for addr, sats in zip(addresses, output_values)}

    raw_hex = cli(
        ["createrawtransaction", json.dumps(raw_inputs), json.dumps(raw_outputs)],
        rpc_wallet=wallet,
    )
    signed = cli_json(["signrawtransactionwithwallet", raw_hex], rpc_wallet=wallet)
    if not signed.get("complete"):
        raise RuntimeError("signrawtransactionwithwallet returned incomplete=false")

    txid = cli(["sendrawtransaction", signed["hex"]], rpc_wallet=wallet)
    outpoints = resolve_outpoints_for_addresses(
        cli_json, txid, addresses, output_values
    )
    return txid, outpoints


def fund_wallet_utxos(
    cli,
    cli_json,
    *,
    source_wallet: str,
    dest_wallet: str,
    count: int,
    value_sat: int,
    mine_addr: str,
) -> list[dict[str, Any]]:
    outpoints: list[dict[str, Any]] = []
    batch_size = 80

    remaining = count
    while remaining > 0:
        batch_count = min(batch_size, remaining)
        addrs = [
            cli(["getnewaddress", "", "bech32"], rpc_wallet=dest_wallet)
            for _ in range(batch_count)
        ]
        outputs = {addr: sat_to_btc(value_sat) for addr in addrs}

        txid = cli(
            ["sendmany", "", json.dumps(outputs), "1", "", "[]", "true"],
            rpc_wallet=source_wallet,
        )
        cli(["generatetoaddress", "1", mine_addr])

        outpoints.extend(
            resolve_outpoints_for_addresses(
                cli_json,
                txid,
                addrs,
                [value_sat for _ in range(batch_count)],
            )
        )
        remaining -= batch_count

    return outpoints


def rust_test_env(cfg: RegtestConfig) -> dict[str, str]:
    env = os.environ.copy()
    env["CORY_TEST_RPC_URL"] = f"http://127.0.0.1:{cfg.rpc_port}"
    env["CORY_TEST_RPC_USER"] = cfg.rpc_user
    env["CORY_TEST_RPC_PASS"] = cfg.rpc_pass
    env.setdefault("RUST_LOG", "cory_core=trace")
    return env


def run_ignored_rust_test(
    cfg: RegtestConfig,
    *,
    test_name: str,
    extra_env: dict[str, str] | None = None,
) -> None:
    run_ignored_rust_test_in_package(
        cfg,
        package="cory-core",
        test_name=test_name,
        extra_env=extra_env,
    )


def run_ignored_rust_test_in_package(
    cfg: RegtestConfig,
    *,
    package: str,
    test_name: str,
    extra_env: dict[str, str] | None = None,
) -> None:
    env = rust_test_env(cfg)
    if extra_env:
        env.update(extra_env)
    log(f"running cargo integration test {package}/{test_name} with --nocapture")
    run(
        [
            "cargo",
            "test",
            "-p",
            package,
            "--test",
            test_name,
            "--",
            "--ignored",
            "--nocapture",
        ],
        capture=False,
        env=env,
    )
