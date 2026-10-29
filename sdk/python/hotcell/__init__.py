"""hotcell — Python client for the hotcell self-hostable agent sandbox daemon.

Mirrors the TypeScript SDK (and, by extension, the Cloudflare Sandbox surface)
so existing harnesses port with minimal changes, but points at *your* self-hosted
daemon instead of the edge. Dependency-free: standard library only.

    from hotcell import HotcellClient

    client = HotcellClient(endpoint="http://127.0.0.1:4750")
    sandbox = client.get_sandbox()
    result = sandbox.exec("python3 -c 'print(2+2)'")
    print(result.stdout)            # "4\n"
    sandbox.destroy()
"""

from __future__ import annotations

import json
import os
import time
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from typing import Any, Callable, Dict, Iterator, List, Optional, Union
from urllib.parse import quote

__all__ = [
    "HotcellClient",
    "Sandbox",
    "Session",
    "CodeContext",
    "HotcellError",
    "ExecResult",
    "ExecEvent",
    "SandboxInfo",
    "FileInfo",
    "SandboxStats",
    "SandboxUsage",
    "CostBreakdown",
    "SandboxMetrics",
    "ProcessHandle",
    "ExposedPort",
    "SessionInfo",
    "CodeOutput",
    "CodeResult",
    "BackupInfo",
    "FileChangeEvent",
    "EgressPolicy",
    "get_sandbox",
]

DEFAULT_ENDPOINT = "http://127.0.0.1:4750"


class HotcellError(RuntimeError):
    """Raised when the daemon returns a non-2xx response."""

    def __init__(self, method: str, path: str, status: int, body: str):
        super().__init__(f"hotcell {method} {path} -> {status}: {body}")
        self.status = status
        self.body = body


# --- data types ------------------------------------------------------------


@dataclass
class ExecResult:
    stdout: str
    stderr: str
    exit_code: int
    success: bool


@dataclass
class ExecEvent:
    type: str  # "stdout" | "stderr" | "exit"
    data: Optional[str] = None
    exit_code: Optional[int] = None


@dataclass
class SandboxInfo:
    id: str
    image: str
    status: str  # "creating" | "running" | "paused" | "stopped" | "error"
    created_at: str
    labels: Dict[str, str]
    persist: bool
    last_activity_at: str
    sleep_after_ms: int
    limits: Dict[str, Any]  # {memoryMb?, cpus?, pidsLimit?}; {} = unlimited
    # Elaboration of `status`: the provisioning phase while "creating", the
    # failure reason after "error". None in the other states.
    status_reason: Optional[str] = None

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SandboxInfo":
        return cls(
            id=d["id"],
            image=d["image"],
            status=d["status"],
            created_at=d.get("createdAt", ""),
            labels=d.get("labels", {}),
            persist=d.get("persist", True),
            last_activity_at=d.get("lastActivityAt", ""),
            sleep_after_ms=d.get("sleepAfterMs", 0),
            limits=d.get("limits", {}),
            status_reason=d.get("statusReason"),
        )


@dataclass
class FileInfo:
    path: str
    name: str
    is_directory: bool
    size: int
    modified_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "FileInfo":
        return cls(
            path=d["path"],
            name=d["name"],
            is_directory=d.get("isDirectory", False),
            size=d.get("size", 0),
            modified_at=d.get("modifiedAt", ""),
        )


@dataclass
class SandboxStats:
    cpu_percent: float
    cpu_total_usage_ns: int
    online_cpus: int
    mem_bytes: int
    mem_limit_bytes: int
    net_rx_bytes: int
    net_tx_bytes: int
    pids: int
    sampled_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SandboxStats":
        return cls(
            cpu_percent=d.get("cpuPercent", 0.0),
            cpu_total_usage_ns=d.get("cpuTotalUsageNs", 0),
            online_cpus=d.get("onlineCpus", 1),
            mem_bytes=d.get("memBytes", 0),
            mem_limit_bytes=d.get("memLimitBytes", 0),
            net_rx_bytes=d.get("netRxBytes", 0),
            net_tx_bytes=d.get("netTxBytes", 0),
            pids=d.get("pids", 0),
            sampled_at=d.get("sampledAt", ""),
        )


@dataclass
class SandboxUsage:
    cpu_seconds: float
    mem_byte_seconds: float
    egress_bytes: int
    provider_calls: int = 0
    provider_bytes: int = 0
    provider_tokens_in: int = 0
    provider_tokens_out: int = 0
    provider_cost: float = 0.0  # provider-reported LLM cost in USD (OpenRouter usage.cost)

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SandboxUsage":
        return cls(
            cpu_seconds=d.get("cpuSeconds", 0.0),
            mem_byte_seconds=d.get("memByteSeconds", 0.0),
            egress_bytes=d.get("egressBytes", 0),
            provider_calls=d.get("providerCalls", 0),
            provider_bytes=d.get("providerBytes", 0),
            provider_tokens_in=d.get("providerTokensIn", 0),
            provider_tokens_out=d.get("providerTokensOut", 0),
            provider_cost=d.get("providerCost", 0.0),
        )


@dataclass
class CostBreakdown:
    cpu: float
    mem: float
    egress: float
    provider: float  # LLM cost (provider-reported, e.g. OpenRouter usage.cost)
    total: float

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CostBreakdown":
        return cls(
            cpu=d.get("cpu", 0.0),
            mem=d.get("mem", 0.0),
            egress=d.get("egress", 0.0),
            provider=d.get("provider", 0.0),
            total=d.get("total", 0.0),
        )


@dataclass
class SandboxMetrics:
    status: str
    live: Optional[SandboxStats]
    usage: SandboxUsage
    cost: CostBreakdown

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SandboxMetrics":
        live = d.get("live")
        return cls(
            status=d.get("status", ""),
            live=SandboxStats.from_dict(live) if live else None,
            usage=SandboxUsage.from_dict(d.get("usage", {})),
            cost=CostBreakdown.from_dict(d.get("cost", {})),
        )


@dataclass
class ProcessHandle:
    proc_id: str
    pid: int
    command: str
    status: str
    exit_code: Optional[int]
    started_at: str
    log_path: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ProcessHandle":
        return cls(
            proc_id=d["procId"],
            pid=d.get("pid", 0),
            command=d.get("command", ""),
            status=d.get("status", ""),
            exit_code=d.get("exitCode"),
            started_at=d.get("startedAt", ""),
            log_path=d.get("logPath", ""),
        )


@dataclass
class ExposedPort:
    port: int
    expose_id: str
    token: Optional[str]
    created_at: str
    url: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "ExposedPort":
        return cls(
            port=d["port"],
            expose_id=d.get("exposeId", ""),
            token=d.get("token"),
            created_at=d.get("createdAt", ""),
            url=d.get("url", ""),
        )


@dataclass
class SessionInfo:
    session_id: str
    cwd: str
    env: Dict[str, str]
    created_at: str

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "SessionInfo":
        return cls(
            session_id=d["sessionId"],
            cwd=d.get("cwd", ""),
            env=d.get("env", {}),
            created_at=d.get("createdAt", ""),
        )


@dataclass
class CodeOutput:
    type: str
    text: str


@dataclass
class CodeResult:
    stdout: str
    stderr: str
    results: List[CodeOutput]
    error: Optional[str]

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "CodeResult":
        return cls(
            stdout=d.get("stdout", ""),
            stderr=d.get("stderr", ""),
            results=[CodeOutput(type=r.get("type", "text"), text=r.get("text", ""))
                     for r in d.get("results", [])],
            error=d.get("error"),
        )


@dataclass
class BackupInfo:
    backup_id: str
    sandbox_id: str
    created_at: str
    bytes: int

    @classmethod
    def from_dict(cls, d: Dict[str, Any]) -> "BackupInfo":
        return cls(
            backup_id=d["backupId"],
            sandbox_id=d.get("sandboxId", ""),
            created_at=d.get("createdAt", ""),
            bytes=d.get("bytes", 0),
        )


@dataclass
class FileChangeEvent:
    type: str  # "created" | "modified" | "deleted"
    path: str


@dataclass
class EgressPolicy:
    """Per-token egress policy, mirroring the TS ``EgressPolicy``.

    Every field is optional; an empty policy means "unlimited". Enforced by the
    daemon's egress gateway. Pass one to ``create_egress_token()`` or as
    ``get_sandbox(egress=...)`` to bind the minted token to it.
    """

    #: ISO timestamp after which the token is rejected (403).
    expires_at: Optional[str] = None
    #: Sugar accepted on mint: expire ``ttl_ms`` after creation.
    ttl_ms: Optional[int] = None
    #: Cumulative USD this token may spend (402 once reached).
    spend_cap_usd: Optional[float] = None
    #: Sliding-window rate limit, e.g. ``{"calls": 60, "windowMs": 60000}``.
    rate_limit: Optional[Dict[str, Any]] = None
    #: Allowed model ids/prefix-globs. Omit = all.
    models: Optional[List[str]] = None
    #: Allowed provider names. Omit = every configured provider.
    providers: Optional[List[str]] = None

    def to_dict(self) -> Dict[str, Any]:
        """Wire form (camelCase, ``None`` fields omitted)."""
        out: Dict[str, Any] = {}
        if self.expires_at is not None:
            out["expiresAt"] = self.expires_at
        if self.ttl_ms is not None:
            out["ttlMs"] = self.ttl_ms
        if self.spend_cap_usd is not None:
            out["spendCapUsd"] = self.spend_cap_usd
        if self.rate_limit is not None:
            out["rateLimit"] = self.rate_limit
        if self.models is not None:
            out["models"] = self.models
        if self.providers is not None:
            out["providers"] = self.providers
        return out


# --- client ----------------------------------------------------------------


def _is_loopback_endpoint(endpoint: str) -> bool:
    host = (urllib.parse.urlsplit(endpoint).hostname or "").lower()
    return host in ("localhost", "::1") or (
        host.startswith("127.") and host.replace(".", "").isdigit())


def local_api_key(endpoint: str) -> str:
    """The key the local daemon generated (``$HOTCELL_HOME/api-key``, default
    ``~/.hotcell/api-key``), or "" when there is none or the endpoint is not on
    this machine (the local key is never sent anywhere else)."""
    if not _is_loopback_endpoint(endpoint):
        return ""
    home = os.environ.get("HOTCELL_HOME") or os.path.join(os.path.expanduser("~"), ".hotcell")
    try:
        with open(os.path.join(home, "api-key"), encoding="utf-8") as f:
            return f.read().strip()
    except OSError:
        return ""


class HotcellClient:
    """Entry point. Talks to one hotcell daemon over its REST API."""

    def __init__(self, endpoint: Optional[str] = None,
                 api_key: Optional[str] = None):
        self.endpoint = (endpoint or os.environ.get("HOTCELL_ENDPOINT")
                         or DEFAULT_ENDPOINT).rstrip("/")
        # API key sent as `Authorization: Bearer <key>`; the daemon always
        # requires one. Falls back to HOTCELL_API_KEY, then (loopback endpoints
        # only) the key the local daemon generated; see local_api_key().
        self.api_key = api_key or os.environ.get("HOTCELL_API_KEY", "")

    def get_sandbox(
        self,
        id: Optional[str] = None,
        *,
        image: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        labels: Optional[Dict[str, str]] = None,
        persist: Optional[bool] = None,
        sleep_after: Optional[int] = None,
        egress: Optional[Union[bool, "EgressPolicy", Dict[str, Any]]] = None,
        egress_spend_cap_usd: Optional[float] = None,
        setup: Optional[List[str]] = None,
        repo: Optional[str] = None,
        repo_ref: Optional[str] = None,
        driver: Optional[str] = None,
        branch: Optional[str] = None,
        networked: Optional[bool] = None,
        memory_mb: Optional[float] = None,
        cpus: Optional[float] = None,
        pids_limit: Optional[int] = None,
        template: Optional[str] = None,
        detach: Optional[bool] = None,
        on_status: Optional[Callable[[str, SandboxInfo], None]] = None,
    ) -> "Sandbox":
        """Attach to a sandbox by id, or (id omitted) provision a fresh one.

        With ``detach=True`` the daemon returns immediately (status "creating")
        and provisions in the background; this method then polls until the
        sandbox is usable. It changes the transport, not the contract: the call
        still returns only once the sandbox is running and raises (with the
        daemon's reason) if the create fails. Use it for slow creates (repo
        clone + heavy setup). ``on_status`` observes each status/phase
        transition. An older daemon ignores the flag and blocks.
        """
        if id:
            info = self.request("GET", f"/sandboxes/{id}")
            return Sandbox(self, SandboxInfo.from_dict(info))
        body: Dict[str, Any] = {}
        if image is not None:
            body["image"] = image
        if env is not None:
            body["env"] = env
        if labels is not None:
            body["labels"] = labels
        if persist is not None:
            body["persist"] = persist
        if sleep_after is not None:
            body["sleepAfter"] = sleep_after
        if egress is not None:
            body["egress"] = egress.to_dict() if isinstance(egress, EgressPolicy) else egress
        if egress_spend_cap_usd is not None:
            body["egressSpendCapUsd"] = egress_spend_cap_usd
        if setup is not None:
            body["setup"] = setup
        if repo is not None:
            body["repo"] = repo
        if repo_ref is not None:
            body["repoRef"] = repo_ref
        if driver is not None:
            body["driver"] = driver
        if branch is not None:
            body["branch"] = branch
        if networked is not None:
            body["networked"] = networked
        if memory_mb is not None:
            body["memoryMb"] = memory_mb
        if cpus is not None:
            body["cpus"] = cpus
        if pids_limit is not None:
            body["pidsLimit"] = pids_limit
        if template is not None:
            body["template"] = template
        if detach is not None:
            body["detach"] = detach
        parsed = SandboxInfo.from_dict(self.request("POST", "/sandboxes", body))
        if detach:
            if on_status is not None:
                on_status(parsed.status, parsed)
            if parsed.status == "creating":
                parsed = self._wait_for_ready(parsed.id, on_status)
        return Sandbox(self, parsed)

    def _wait_for_ready(
        self,
        id: str,
        on_status: Optional[Callable[[str, SandboxInfo], None]] = None,
    ) -> SandboxInfo:
        """Poll a detached create until it leaves "creating".

        Returns the ready record; raises on "error" (with the daemon's reason)
        or if the record disappears (destroyed mid-create). Transient poll
        failures are retried; there is no overall timeout — creates are
        legitimately long, and each poll is a short request.
        """
        last_seen = ""
        failures = 0
        while True:
            time.sleep(1.5)
            try:
                info = SandboxInfo.from_dict(self.request("GET", f"/sandboxes/{id}"))
                failures = 0
            except HotcellError as err:
                if err.status == 404:
                    raise RuntimeError(f"sandbox {id} was destroyed while being created") from err
                failures += 1
                if failures >= 10:
                    raise
                continue
            except (urllib.error.URLError, OSError):
                failures += 1
                if failures >= 10:
                    raise
                continue
            seen = f"{info.status}\0{info.status_reason or ''}"
            if seen != last_seen:
                last_seen = seen
                if on_status is not None:
                    on_status(info.status, info)
            if info.status == "error":
                raise RuntimeError(
                    f"sandbox create failed: {info.status_reason or 'unknown error'}"
                )
            if info.status != "creating":
                return info

    def list(self) -> List[SandboxInfo]:
        data = self.request("GET", "/sandboxes")
        return [SandboxInfo.from_dict(s) for s in data.get("sandboxes", [])]

    def create_template(self, name: str, from_sandbox: str) -> Dict[str, Any]:
        """Capture a running sandbox as a reusable snapshot template.

        The daemon pauses the guest, writes a full snapshot, and resumes the
        source, so the sandbox keeps running. Only microVM drivers
        (Firecracker) support this.
        """
        return self.request("POST", "/templates", {"name": name, "from": from_sandbox})

    def list_templates(self) -> List[Dict[str, Any]]:
        """List captured templates, newest first."""
        return self.request("GET", "/templates").get("templates", [])

    def delete_template(self, name: str) -> None:
        """Delete a template and its on-disk snapshot."""
        self.request("DELETE", f"/templates/{quote(name, safe='')}")

    def health(self) -> Dict[str, Any]:
        return self.request("GET", "/healthz")

    def info(self) -> Dict[str, Any]:
        """Daemon info: driver, default image, proxy port, cost rates."""
        return self.request("GET", "/info")

    def capacity(self) -> Dict[str, Any]:
        """Host capacity + admission status (committed vs budget memory, how
        many more default-reservation sandboxes still fit)."""
        return self.request("GET", "/capacity")

    def list_backups(self) -> List[BackupInfo]:
        data = self.request("GET", "/backups")
        return [BackupInfo.from_dict(b) for b in data.get("backups", [])]

    def delete_backup(self, backup_id: str) -> None:
        self.request("DELETE", f"/backups/{backup_id}")

    # -- HTTP plumbing ------------------------------------------------------

    def request(self, method: str, path: str, body: Any = None) -> Any:
        """Issue a JSON request and return the parsed response (or None)."""
        resp = self._open(method, path, body=body)
        with resp:
            raw = resp.read()
        return json.loads(raw) if raw else None

    def stream(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: Optional[Dict[str, str]] = None,
    ) -> Iterator[Dict[str, Any]]:
        """Issue a request and yield decoded Server-Sent-Event JSON frames."""
        resp = self._open(method, path, body=body, params=params)
        with resp:
            for raw in resp:
                line = raw.decode("utf-8").rstrip("\r\n")
                if not line.startswith("data:"):
                    continue  # skip comments (": ...") and blank separators
                payload = line[5:].strip()
                if payload:
                    yield json.loads(payload)

    def _open(
        self,
        method: str,
        path: str,
        *,
        body: Any = None,
        params: Optional[Dict[str, str]] = None,
    ):
        url = self.endpoint + path
        if params:
            url += "?" + urllib.parse.urlencode(params)
        data = None
        headers = {}
        key = self.api_key or local_api_key(self.endpoint)
        if key:
            headers["authorization"] = "Bearer " + key
        if body is not None:
            data = json.dumps(body).encode("utf-8")
            headers["content-type"] = "application/json"
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            return urllib.request.urlopen(req)
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")
            raise HotcellError(method, path, e.code, detail) from None


class Sandbox:
    """A single sandbox. Mirrors the TS `Sandbox` class, snake_cased."""

    def __init__(self, client: HotcellClient, info: SandboxInfo):
        self._client = client
        self._info = info

    @property
    def id(self) -> str:
        return self._info.id

    @property
    def status(self) -> str:
        return self._info.status

    @property
    def info(self) -> SandboxInfo:
        return self._info

    # -- exec ---------------------------------------------------------------

    def exec(
        self,
        command: str,
        *,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        session_id: Optional[str] = None,
    ) -> ExecResult:
        """Run a command to completion, returning aggregated output."""
        stdout, stderr, exit_code = [], [], 0
        for event in self.exec_stream(command, cwd=cwd, env=env, session_id=session_id):
            if event.type == "stdout":
                stdout.append(event.data or "")
            elif event.type == "stderr":
                stderr.append(event.data or "")
            elif event.type == "exit":
                exit_code = event.exit_code or 0
        return ExecResult("".join(stdout), "".join(stderr), exit_code, exit_code == 0)

    def exec_stream(
        self,
        command: str,
        *,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
        session_id: Optional[str] = None,
    ) -> Iterator[ExecEvent]:
        """Run a command, yielding output events as they stream in."""
        body = {"command": command, "cwd": cwd, "env": env, "sessionId": session_id}
        for frame in self._client.stream(
            "POST", f"/sandboxes/{self.id}/exec", body=body
        ):
            yield ExecEvent(
                type=frame["type"],
                data=frame.get("data"),
                exit_code=frame.get("exitCode"),
            )

    # -- lifecycle ----------------------------------------------------------

    def stop(self) -> None:
        self._info = SandboxInfo.from_dict(
            self._client.request("POST", f"/sandboxes/{self.id}/stop")
        )

    def start(self) -> None:
        self._info = SandboxInfo.from_dict(
            self._client.request("POST", f"/sandboxes/{self.id}/start")
        )

    def pause(self) -> None:
        """Fast-pause: a memory snapshot on microVM drivers (processes come back
        alive on resume); stop-with-volume on the container driver (workspace
        survives, processes do not). Any later operation auto-resumes."""
        self._info = SandboxInfo.from_dict(
            self._client.request("POST", f"/sandboxes/{self.id}/pause")
        )

    def destroy(self) -> None:
        self._client.request("DELETE", f"/sandboxes/{self.id}")

    def metrics(self) -> SandboxMetrics:
        """Live stats, cumulative usage, and cost. Passive (won't keep alive)."""
        return SandboxMetrics.from_dict(
            self._client.request("GET", f"/sandboxes/{self.id}/metrics")
        )

    def metrics_history(self) -> List[Dict[str, Any]]:
        """Recent live-metrics samples (oldest->newest) for sparklines/history."""
        data = self._client.request("GET", f"/sandboxes/{self.id}/metrics/history")
        return data.get("samples", [])

    # -- egress credential proxy (LLM gateway) ------------------------------

    def create_egress_token(
        self, policy: Optional[Union["EgressPolicy", Dict[str, Any]]] = None
    ) -> Dict[str, Any]:
        """Mint an egress token; returns {token, providers}. Point the sandbox's
        LLM SDK at a provider baseUrl and use the token in place of the real key.

        Pass an ``EgressPolicy`` (or an equivalent dict) to bind the token to a
        TTL, spend cap, rate limit, or model/provider scope."""
        body = policy.to_dict() if isinstance(policy, EgressPolicy) else (policy or {})
        return self._client.request(
            "POST", f"/sandboxes/{self.id}/egress-tokens", body
        )

    def list_egress_tokens(self) -> Dict[str, Any]:
        """List this sandbox's egress tokens and available provider routes."""
        return self._client.request("GET", f"/sandboxes/{self.id}/egress-tokens")

    def revoke_egress_token(self, token: str) -> None:
        """Revoke a previously minted egress token."""
        self._client.request("DELETE", f"/sandboxes/{self.id}/egress-tokens/{token}")

    # -- files --------------------------------------------------------------

    def write_file(self, path: str, content: str, *, mode: Optional[str] = None) -> None:
        self._client.request(
            "POST", f"/sandboxes/{self.id}/files/write",
            {"path": path, "content": content, "mode": mode},
        )

    def read_file(self, path: str) -> str:
        return self._client.request(
            "POST", f"/sandboxes/{self.id}/files/read", {"path": path}
        )["content"]

    def mkdir(self, path: str, *, parents: bool = False) -> None:
        self._client.request(
            "POST", f"/sandboxes/{self.id}/files/mkdir",
            {"path": path, "parents": parents},
        )

    def list_files(self, path: str) -> List[FileInfo]:
        data = self._client.request(
            "POST", f"/sandboxes/{self.id}/files/list", {"path": path}
        )
        return [FileInfo.from_dict(e) for e in data.get("entries", [])]

    def watch(
        self, path: str = "/workspace", *, interval_ms: Optional[int] = None
    ) -> Iterator[FileChangeEvent]:
        """Watch a path recursively, yielding change events until closed."""
        params = {"path": path}
        if interval_ms:
            params["interval"] = str(interval_ms)
        for frame in self._client.stream(
            "GET", f"/sandboxes/{self.id}/watch", params=params
        ):
            yield FileChangeEvent(type=frame["type"], path=frame["path"])

    # -- processes ----------------------------------------------------------

    def start_process(
        self,
        command: str,
        *,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> ProcessHandle:
        return ProcessHandle.from_dict(
            self._client.request(
                "POST", f"/sandboxes/{self.id}/processes",
                {"command": command, "cwd": cwd, "env": env},
            )
        )

    def list_processes(self) -> List[ProcessHandle]:
        data = self._client.request("GET", f"/sandboxes/{self.id}/processes")
        return [ProcessHandle.from_dict(p) for p in data.get("processes", [])]

    def kill_process(self, proc_id: str, signal: Optional[str] = None) -> None:
        self._client.request(
            "DELETE", f"/sandboxes/{self.id}/processes/{proc_id}",
            {"signal": signal} if signal else None,
        )

    def stream_logs(self, proc_id: str, *, follow: bool = False) -> Iterator[str]:
        params = {"follow": "1" if follow else "0"}
        for frame in self._client.stream(
            "GET", f"/sandboxes/{self.id}/processes/{proc_id}/logs", params=params
        ):
            if frame.get("type") == "log":
                yield frame.get("data", "")
            elif frame.get("type") == "end":
                return

    def wait_for_port(
        self,
        port: int,
        *,
        timeout_ms: Optional[int] = None,
        interval_ms: Optional[int] = None,
        host: Optional[str] = None,
    ) -> bool:
        body: Dict[str, Any] = {"port": port}
        if timeout_ms is not None:
            body["timeoutMs"] = timeout_ms
        if interval_ms is not None:
            body["intervalMs"] = interval_ms
        if host is not None:
            body["host"] = host
        return self._client.request(
            "POST", f"/sandboxes/{self.id}/wait-port", body
        )["ready"]

    # -- ports --------------------------------------------------------------

    def expose_port(self, port: int, *, token: Optional[str] = None) -> ExposedPort:
        return ExposedPort.from_dict(
            self._client.request(
                "POST", f"/sandboxes/{self.id}/expose", {"port": port, "token": token}
            )
        )

    def unexpose_port(self, port: int) -> None:
        self._client.request("DELETE", f"/sandboxes/{self.id}/expose/{port}")

    def list_exposed_ports(self) -> List[ExposedPort]:
        data = self._client.request("GET", f"/sandboxes/{self.id}/expose")
        return [ExposedPort.from_dict(p) for p in data.get("exposed", [])]

    # -- env + sessions -----------------------------------------------------

    def set_env_vars(self, env: Dict[str, str]) -> Dict[str, str]:
        return self._client.request(
            "POST", f"/sandboxes/{self.id}/env", {"env": env}
        )["env"]

    def get_env_vars(self) -> Dict[str, str]:
        return self._client.request("GET", f"/sandboxes/{self.id}/env")["env"]

    def create_session(
        self,
        *,
        id: Optional[str] = None,
        cwd: Optional[str] = None,
        env: Optional[Dict[str, str]] = None,
    ) -> "Session":
        info = self._client.request(
            "POST", f"/sandboxes/{self.id}/sessions",
            {"id": id, "cwd": cwd, "env": env},
        )
        return Session(self, SessionInfo.from_dict(info))

    def list_sessions(self) -> List[SessionInfo]:
        data = self._client.request("GET", f"/sandboxes/{self.id}/sessions")
        return [SessionInfo.from_dict(s) for s in data.get("sessions", [])]

    # -- backups ------------------------------------------------------------

    def create_backup(self) -> BackupInfo:
        return BackupInfo.from_dict(
            self._client.request("POST", f"/sandboxes/{self.id}/backups")
        )

    def restore_backup(self, backup_id: str) -> None:
        self._client.request(
            "POST", f"/sandboxes/{self.id}/restore", {"backupId": backup_id}
        )

    def list_backups(self) -> List[BackupInfo]:
        data = self._client.request("GET", f"/sandboxes/{self.id}/backups")
        return [BackupInfo.from_dict(b) for b in data.get("backups", [])]

    # -- code interpreter ---------------------------------------------------

    def create_code_context(self, *, language: str = "python") -> "CodeContext":
        info = self._client.request(
            "POST", f"/sandboxes/{self.id}/code-contexts", {"language": language}
        )
        return CodeContext(self, info["contextId"], info.get("language", language))

    def list_code_contexts(self) -> List[Dict[str, Any]]:
        return self._client.request(
            "GET", f"/sandboxes/{self.id}/code-contexts"
        ).get("contexts", [])

    def run_code(
        self,
        code: str,
        *,
        context: Optional["CodeContext"] = None,
        language: Optional[str] = None,
        timeout_ms: Optional[int] = None,
    ) -> CodeResult:
        return CodeResult.from_dict(
            self._client.request(
                "POST", f"/sandboxes/{self.id}/run-code",
                {
                    "code": code,
                    "contextId": context.context_id if context else None,
                    "language": language,
                    "timeoutMs": timeout_ms,
                },
            )
        )


class Session:
    """A persistent cwd + env overlay; `cd` persists across commands."""

    def __init__(self, sandbox: Sandbox, info: SessionInfo):
        self._sandbox = sandbox
        self._info = info

    @property
    def session_id(self) -> str:
        return self._info.session_id

    def exec(self, command: str, **kwargs: Any) -> ExecResult:
        return self._sandbox.exec(command, session_id=self.session_id, **kwargs)

    def exec_stream(self, command: str, **kwargs: Any) -> Iterator[ExecEvent]:
        return self._sandbox.exec_stream(command, session_id=self.session_id, **kwargs)

    def set_env_vars(self, env: Dict[str, str]) -> SessionInfo:
        self._info = SessionInfo.from_dict(
            self._sandbox._client.request(
                "POST",
                f"/sandboxes/{self._sandbox.id}/sessions/{self.session_id}/env",
                {"env": env},
            )
        )
        return self._info

    def destroy(self) -> None:
        self._sandbox._client.request(
            "DELETE", f"/sandboxes/{self._sandbox.id}/sessions/{self.session_id}"
        )


class CodeContext:
    """A long-lived interpreter kernel; variables/imports persist across runs."""

    def __init__(self, sandbox: Sandbox, context_id: str, language: str):
        self._sandbox = sandbox
        self.context_id = context_id
        self.language = language

    def run_code(self, code: str, *, timeout_ms: Optional[int] = None) -> CodeResult:
        return self._sandbox.run_code(code, context=self, timeout_ms=timeout_ms)

    def destroy(self) -> None:
        self._sandbox._client.request(
            "DELETE",
            f"/sandboxes/{self._sandbox.id}/code-contexts/{self.context_id}",
        )


def get_sandbox(
    client: HotcellClient, id: Optional[str] = None, **options: Any
) -> Sandbox:
    """Convenience matching the Cloudflare `getSandbox(binding, id)` shape."""
    return client.get_sandbox(id, **options)
