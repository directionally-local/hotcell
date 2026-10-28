//go:build !linux

package server

import (
	"runtime"

	"github.com/directionally-local/hotcell/agent/proto"
)

// readStats is a stub for non-Linux builds (the agent only ever runs as a Linux
// guest; this exists so the server package compiles and its protocol/handlers
// are testable on the developer's macOS box). Real /proc + cgroup reads live in
// stats_linux.go. Only OnlineCPUs is meaningfully reported here.
func readStats() proto.SandboxStats {
	return proto.SandboxStats{OnlineCPUs: runtime.NumCPU()}
}
