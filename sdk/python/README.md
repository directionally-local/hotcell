# hotcell (Python SDK)

Dependency-free Python client for the [hotcell](https://github.com/directionally-local/hotcell)
self-hostable agent sandbox daemon. Mirrors the TypeScript SDK surface (snake_cased)
so the same workflows work from either language.

```python
from hotcell import HotcellClient

client = HotcellClient(endpoint="http://127.0.0.1:4750")  # or $HOTCELL_ENDPOINT
sandbox = client.get_sandbox()                          # create a fresh sandbox

# run a command
result = sandbox.exec("python3 -c 'print(2 + 2)'")
print(result.stdout, result.exit_code)                  # "4\n" 0

# files
sandbox.write_file("/workspace/hi.txt", "hello")
print(sandbox.read_file("/workspace/hi.txt"))           # "hello"

# stateful code interpreter
ctx = sandbox.create_code_context(language="python")
ctx.run_code("x = 21")
print(ctx.run_code("x * 2").results[0].text)            # "42"

# metrics + cost
m = sandbox.metrics()
print(m.cost.total, m.usage.cpu_seconds)

sandbox.destroy()
```

Standard library only (`urllib`, `json`) — no third-party dependencies. Requires
Python ≥ 3.9 and a running hotcell daemon.

## Surface

`HotcellClient`: `get_sandbox`, `list`, `health`, `info`, `capacity`, `list_backups`,
`delete_backup`.

`Sandbox`: `exec`, `exec_stream`, `stop`, `start`, `pause`, `destroy`, `metrics`,
`write_file`, `read_file`, `mkdir`, `list_files`, `watch`, `start_process`,
`list_processes`, `kill_process`, `stream_logs`, `wait_for_port`, `expose_port`,
`unexpose_port`, `list_exposed_ports`, `set_env_vars`, `get_env_vars`,
`create_session`, `list_sessions`, `create_backup`, `restore_backup`,
`list_backups`, `create_code_context`, `list_code_contexts`, `run_code`,
`create_egress_token`, `list_egress_tokens`, `revoke_egress_token`.

`Session`: `exec`, `exec_stream`, `set_env_vars`, `destroy`.
`CodeContext`: `run_code`, `destroy`.
