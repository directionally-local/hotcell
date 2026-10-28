package main

import (
	"fmt"
	"net"
	"os"
	"strings"
)

// listenSpec parses a scheme://addr listen spec for the dev/test transport.
// Supported: tcp://host:port and unix:///path/to.sock. Available on all OSes so
// the agent can be driven locally without a microVM.
func listenSpec(spec string) (net.Listener, error) {
	scheme, addr, ok := strings.Cut(spec, "://")
	if !ok {
		return nil, fmt.Errorf("HOTCELL_AGENT_LISTEN must be scheme://addr, got %q", spec)
	}
	switch scheme {
	case "tcp":
		return net.Listen("tcp", addr)
	case "unix":
		os.Remove(addr) // clear a stale socket from a prior run
		ln, err := net.Listen("unix", addr)
		if err != nil {
			return nil, err
		}
		// The host daemon may be non-root while the container agent runs as root.
		// Make the socket connectable; the host mounts it inside a daemon-owned
		// 0700 directory, so other host users cannot reach it.
		if err := os.Chmod(addr, 0o666); err != nil {
			ln.Close()
			os.Remove(addr)
			return nil, fmt.Errorf("chmod unix agent socket: %w", err)
		}
		return ln, nil
	default:
		return nil, fmt.Errorf("unsupported HOTCELL_AGENT_LISTEN scheme %q (use tcp:// or unix://)", scheme)
	}
}
