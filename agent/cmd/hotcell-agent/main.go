// Command hotcell-agent is the in-sandbox agent: a tiny static Linux binary that
// runs inside each microVM (as PID 1 / init under the Firecracker and Apple VZ
// drivers) and serves the proto protocol to the daemon over vsock. It is the
// per-sandbox piece that replaces `docker exec` once there is no Docker — and
// is shared verbatim by both microVM drivers.
//
// Transport selection:
//   - HOTCELL_AGENT_LISTEN set (e.g. "tcp://127.0.0.1:9000" or "unix:///tmp/a.sock")
//     → listen there. This is the dev/test path and works on any OS, so the
//     agent can be exercised on a developer's macOS box without a guest.
//   - otherwise → vsock (Linux only; the production path inside a guest).
package main

import (
	"log"
	"net"
	"os"

	"github.com/sinameraji/hotcell/agent/server"
)


// agentEnv reads a config var with legacy fallback: HOTCELL_<name> wins, then
// the pre-rename SBX_<name>, so old driver builds keep working.
func agentEnv(name string) string {
	if v := os.Getenv("HOTCELL_" + name); v != "" {
		return v
	}
	return os.Getenv("SBX_" + name)
}

func main() {
	log.SetFlags(log.LstdFlags | log.Lmicroseconds)
	log.SetPrefix("hotcell-agent ")

	platformInit() // e.g. bring up loopback in slim guests (no ip/ifconfig)
	ln, err := listen()
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	// This is a transport-only setting. Do not pass it through the agent's
	// inherited environment to user commands launched inside the sandbox.
	_ = os.Unsetenv("HOTCELL_AGENT_LISTEN")
	_ = os.Unsetenv("SBX_AGENT_LISTEN")
	ag := server.New()
	ag.EgressDial = egressDial
	log.Printf("listening on %s (version %s)", ln.Addr(), server.Version)

	for {
		conn, err := ln.Accept()
		if err != nil {
			log.Printf("accept: %v", err)
			return
		}
		go func(c net.Conn) {
			if err := ag.Serve(c); err != nil {
				log.Printf("serve: %v", err)
			}
		}(conn)
	}
}

// listen picks the transport: the explicit HOTCELL_AGENT_LISTEN spec if present,
// else the platform default (vsock on Linux; an error elsewhere).
func listen() (net.Listener, error) {
	if spec := agentEnv("AGENT_LISTEN"); spec != "" {
		return listenSpec(spec)
	}
	return listenDefault()
}
