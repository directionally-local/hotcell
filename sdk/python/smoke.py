#!/usr/bin/env python3
"""End-to-end smoke test for the Python SDK.

Spins up the compiled daemon on isolated ports + throwaway state, drives it
entirely through the `hotcell` Python client, then tears everything down. Mirrors
the Node smoke's coverage for the surface the Python SDK exposes.

Run:  npm run smoke:py   (builds the daemon first)
or:   python3 sdk/python/smoke.py
Requires a running Docker-compatible runtime, same as the daemon.
"""

import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", ".."))
sys.path.insert(0, HERE)

from hotcell import EgressPolicy, HotcellClient, HotcellError  # noqa: E402

PORT = 4760
PROXY_PORT = 4761
ENDPOINT = f"http://127.0.0.1:{PORT}"


def log(msg: str) -> None:
    print(f"[py-smoke] {msg}", file=sys.stderr, flush=True)


def wait_healthy(timeout: float = 60.0) -> None:
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(ENDPOINT + "/healthz", timeout=2) as r:
                if r.status == 200:
                    return
        except (urllib.error.URLError, ConnectionError, OSError):
            pass
        time.sleep(0.3)
    raise TimeoutError("daemon did not become healthy in time")


def main() -> int:
    daemon_path = os.path.join(ROOT, "packages", "daemon", "dist", "index.js")
    if not os.path.exists(daemon_path):
        log("daemon not built — run `npm run build` first")
        return 1

    db_dir = tempfile.mkdtemp(prefix="hotcell-pysmoke-db-")
    backup_dir = tempfile.mkdtemp(prefix="hotcell-pysmoke-backups-")
    env = {
        **os.environ,
        "HOTCELL_PORT": str(PORT),
        "HOTCELL_PROXY_PORT": str(PROXY_PORT),
        "HOTCELL_DB": os.path.join(db_dir, "state.db"),
        "HOTCELL_BACKUP_DIR": backup_dir,
        "HOTCELL_REAP_INTERVAL_MS": "0",  # no idle reaper during the test
    }
    daemon = subprocess.Popen(["node", daemon_path], env=env)

    try:
        wait_healthy()
        log(f"daemon up at {ENDPOINT}")
        client = HotcellClient(endpoint=ENDPOINT)

        # capacity() parity with the TS SDK
        snap = client.capacity()
        assert "memory" in snap and "fits" in snap, snap
        log("capacity snapshot works")

        # create-time `setup` provisioning (parity with the TS smoke)
        provisioned = client.get_sandbox(
            setup=["echo provisioned > /workspace/py-setup.txt"]
        )
        assert provisioned.read_file("/workspace/py-setup.txt").strip() == "provisioned"
        provisioned.destroy()
        log("setup provisioning works")

        sb = client.get_sandbox()
        log(f"created sandbox {sb.id}")

        # exec
        r = sb.exec("echo hello from py")
        assert r.stdout.strip() == "hello from py", r.stdout
        assert r.exit_code == 0 and r.success
        log("exec works")

        # files
        sb.write_file("/workspace/py.txt", "file ops work")
        assert sb.read_file("/workspace/py.txt") == "file ops work"
        sb.mkdir("/workspace/sub", parents=True)
        names = {f.name for f in sb.list_files("/workspace")}
        assert "py.txt" in names and "sub" in names, names
        log("files (write/read/mkdir/list) work")

        # env + session
        sb.set_env_vars({"PY_VAR": "from-env"})
        assert sb.exec("echo $PY_VAR").stdout.strip() == "from-env"
        sess = sb.create_session(env={"SESS_VAR": "sess"})
        sess.exec("cd /tmp")
        assert sess.exec("pwd").stdout.strip() == "/tmp", "session cwd did not persist"
        assert sess.exec("echo $SESS_VAR").stdout.strip() == "sess"
        log("env + session cwd/env persistence work")

        # stateful code interpreter
        ctx = sb.create_code_context(language="python")
        ctx.run_code("x = 21")
        res = ctx.run_code("x * 2")
        assert res.error is None, res.error
        assert res.results and res.results[0].text == "42", res.results
        ctx.destroy()
        log("stateful python code context works")

        # metrics + cost
        m = sb.metrics()
        assert m.live is not None, "expected live stats for running sandbox"
        assert m.cost.total >= 0
        log("metrics + cost reachable")

        # egress credential proxy: mint + list + revoke a token (no providers
        # configured here, so the providers list is empty — the SDK surface is
        # what we exercise; the daemon smoke covers key injection + metering).
        minted = sb.create_egress_token()
        assert minted.get("token"), "egress mint returned no token"
        scoped = sb.create_egress_token(
            EgressPolicy(spend_cap_usd=1.0, models=["gpt-4o"])
        )
        assert scoped["policy"]["spendCapUsd"] == 1.0, scoped
        assert scoped["policy"]["models"] == ["gpt-4o"], scoped
        sb.revoke_egress_token(scoped["token"])
        listed = sb.list_egress_tokens()
        assert any(
            t["token"] == minted["token"] for t in listed.get("tokens", [])
        ), "minted token not listed"
        sb.revoke_egress_token(minted["token"])
        assert not any(
            t["token"] == minted["token"]
            for t in sb.list_egress_tokens().get("tokens", [])
        )
        log("egress token mint/list/revoke works")

        # backup / restore rollback
        sb.write_file("/workspace/keep.txt", "v1")
        backup = sb.create_backup()
        sb.write_file("/workspace/after.txt", "post-backup")
        sb.restore_backup(backup.backup_id)
        assert sb.read_file("/workspace/keep.txt") == "v1"
        gone = sb.exec("test -e /workspace/after.txt && echo yes || echo no").stdout.strip()
        assert gone == "no", "restore did not clear post-backup files"
        log("backup/restore rollback works")

        # stop / start persistence
        sb.stop()
        assert sb.status == "stopped"
        sb.start()
        assert sb.status == "running"
        assert sb.read_file("/workspace/keep.txt") == "v1", "workspace lost across stop/start"
        log("stop/start persistence works")

        # pause() parity: container driver degrades to stop-with-volume, and the
        # next operation auto-resumes.
        sb.pause()
        assert sb.status == "paused", sb.status
        assert sb.read_file("/workspace/keep.txt") == "v1", "workspace lost across pause"
        log("pause + auto-resume works")

        # destroy
        sb.destroy()
        try:
            client.get_sandbox(sb.id)
            raise AssertionError("sandbox still exists after destroy")
        except HotcellError as e:
            assert e.status == 404
        log("destroy works")

        log("passed")
        return 0
    except Exception as e:  # noqa: BLE001
        log(f"failed: {e}")
        return 1
    finally:
        daemon.terminate()
        try:
            daemon.wait(timeout=5)
        except subprocess.TimeoutExpired:
            daemon.kill()
        shutil.rmtree(db_dir, ignore_errors=True)
        shutil.rmtree(backup_dir, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
