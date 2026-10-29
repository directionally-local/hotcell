package proto

// JSON message bodies carried in Control and Result frames. Field names and
// shapes mirror the daemon's wire types (packages/daemon/src/types.ts and
// driver/types.ts) so the host-side driver can marshal/unmarshal with the same
// vocabulary it already uses for the container driver — the whole point of the
// abstraction is that nothing above the driver changes.

// ProtoVersion is bumped when the wire format changes incompatibly. The guest
// reports it in Hello so the host can refuse a mismatched agent.
const ProtoVersion = 1

// Hello is the unsolicited greeting the guest agent sends on stream 0 the
// moment a connection is established. The host driver's create() blocks on it
// to know the guest is up and the agent is serving.
type Hello struct {
	Event   string `json:"event"` // always "hello"
	Agent   string `json:"agent"` // "hotcell-agent"
	Version string `json:"version"`
	Proto   int    `json:"proto"`
}

// Request is the Control-frame body that invokes one agent method. A single
// flat struct (rather than a union) keeps decoding to one json.Unmarshal; each
// method reads only the fields it needs. Method names match the Driver surface.
type Request struct {
	Method string `json:"method"`

	// exec / startProcess / pty
	Command string            `json:"command,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`

	// file ops (writeFile/readFile/mkdir/listFiles)
	Path    string `json:"path,omitempty"`
	Content string `json:"content,omitempty"` // writeFile body (UTF-8)
	Mode    string `json:"mode,omitempty"`    // octal string, e.g. "0644"
	Parents bool   `json:"parents,omitempty"` // mkdir -p

	// waitForPort / tcpConnect / egressListen
	Port       int    `json:"port,omitempty"`
	Host       string `json:"host,omitempty"`
	TimeoutMs  int    `json:"timeoutMs,omitempty"`
	IntervalMs int    `json:"intervalMs,omitempty"`

	// egressListen: host vsock port to dial per relayed connection (defaults to
	// the in-guest `port` when 0).
	VsockPort int `json:"vsockPort,omitempty"`

	// pty resize
	Cols int `json:"cols,omitempty"`
	Rows int `json:"rows,omitempty"`

	// reseed: give a snapshot-restored clone a fresh identity. Every field is
	// optional; an empty request still reseeds the kernel CRNG (the one thing a
	// fork MUST do — clones otherwise share the template's entropy state).
	Hostname     string `json:"hostname,omitempty"`
	MachineID    string `json:"machineId,omitempty"`
	UnixTime     int64  `json:"unixTime,omitempty"`     // host wall clock, seconds; 0 = leave the guest clock alone
	EntropyBytes int    `json:"entropyBytes,omitempty"` // extra CRNG entropy to mix in (default 256)
}

// Result is the terminal Result-frame body for a request.
type Result struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	// ExitCode is set by exec (and process waits). Pointer so 0 is distinct from
	// "not applicable".
	ExitCode *int `json:"exitCode,omitempty"`
	// Value carries a method's return payload: readFile → string, listFiles →
	// []FileInfo, waitForPort → bool, stats → SandboxStats.
	Value any `json:"value,omitempty"`
}

// FileInfo mirrors the daemon's FileInfo (types.ts).
type FileInfo struct {
	Path        string `json:"path"`
	Name        string `json:"name"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	ModifiedAt  string `json:"modifiedAt"` // RFC3339
}

// SandboxStats mirrors the daemon's SandboxStats (driver/types.ts). The guest
// fills it from /proc + cgroup files; the host passes it straight through to
// the existing metrics sampler and cost meter unchanged.
type SandboxStats struct {
	CPUPercent      float64 `json:"cpuPercent"`
	CPUTotalUsageNs uint64  `json:"cpuTotalUsageNs"`
	OnlineCPUs      int     `json:"onlineCpus"`
	MemBytes        uint64  `json:"memBytes"`
	MemLimitBytes   uint64  `json:"memLimitBytes"`
	NetRxBytes      uint64  `json:"netRxBytes"`
	NetTxBytes      uint64  `json:"netTxBytes"`
	Pids            int     `json:"pids"`
	SampledAt       string  `json:"sampledAt"` // RFC3339
}
