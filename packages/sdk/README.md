# @hotcell/sdk

TypeScript client for [**hotcell**](https://github.com/directionally-local/hotcell) — self-hostable sandbox infrastructure for AI agents. Zero runtime dependencies; mirrors the Cloudflare Sandbox SDK surface so existing harnesses port with minimal changes, but points at *your* self-hosted daemon.

```bash
npm install @hotcell/sdk
```

```ts
import { HotcellClient } from "@hotcell/sdk";

const client = new HotcellClient({ endpoint: "http://127.0.0.1:4750" /*, apiKey */ });

const sandbox = await client.getSandbox();              // fresh sandbox
const { stdout } = await sandbox.exec("python3 -c 'print(2+2)'");

await sandbox.writeFile("/workspace/app.py", "print('hi')");
for await (const ev of sandbox.execStream("python3 /workspace/app.py")) {
  if (ev.type === "stdout") process.stdout.write(ev.data);
}

await sandbox.destroy();
```

## Highlights

- `exec` / `execStream`, `writeFile`/`readFile`/`mkdir`/`listFiles`, `watch`
- background processes (`startProcess`/`listProcesses`/`killProcess`/`streamLogs`/`waitForPort`)
- preview URLs (`exposePort`), persistent `Session`s, stateful `CodeContext`s
- backups, lifecycle (`stop`/`start`, idle auto-pause), `metrics`/`metricsHistory`
- egress credential proxy: `createEgressToken`/`listEgressTokens`/`revokeEgressToken`, or create with `{ egress: true }`

Configure the endpoint via the constructor or `HOTCELL_ENDPOINT`, and the API key via `apiKey` or `HOTCELL_API_KEY`. For a daemon on this machine you can skip the key: the client reads the one the daemon generated in `${HOTCELL_HOME:-~/.hotcell}/api-key` (loopback endpoints only, Node 20.16+).

See the [main README](https://github.com/directionally-local/hotcell) for the daemon, CLI, dashboard, and full docs.

## License

Apache-2.0
