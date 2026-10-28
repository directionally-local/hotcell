package server

import (
	"io"
	"net"
	"strconv"
	"sync"

	"github.com/directionally-local/hotcell/agent/proto"
)

// Egress-over-vsock: how a NIC-less microVM reaches the daemon's egress gateway
// — and nothing else. The agent listens on a loopback TCP port inside the guest
// and forwards each accepted connection out over a fresh vsock connection to
// the host (via the platform EgressDial); the host driver relays those to the
// gateway. The guest has no other route out of the VM, so default-deny holds by
// construction — no NIC, no firewall rules, nothing to misconfigure.

// egressState tracks the ports already being served, so egressListen is
// idempotent (the driver re-sends it on every cold boot; after a snapshot
// resume the listener is already alive in restored RAM).
type egressState struct {
	mu    sync.Mutex
	ports map[int]bool
}

func (a *Agent) handleEgressListen(w *proto.FrameWriter, id uint32, req proto.Request) {
	if req.Port <= 0 {
		writeError(w, id, "egressListen: port required")
		return
	}
	vsockPort := uint32(req.VsockPort)
	if vsockPort == 0 {
		vsockPort = uint32(req.Port)
	}
	dial := a.EgressDial
	if dial == nil {
		writeError(w, id, "egressListen: no egress dialer on this platform")
		return
	}

	a.egress.mu.Lock()
	if a.egress.ports == nil {
		a.egress.ports = map[int]bool{}
	}
	if a.egress.ports[req.Port] {
		a.egress.mu.Unlock()
		writeResult(w, id, proto.Result{OK: true, Value: "already-listening"})
		return
	}
	ln, err := net.Listen("tcp4", "127.0.0.1:"+strconv.Itoa(req.Port))
	if err != nil {
		a.egress.mu.Unlock()
		writeError(w, id, "egressListen: "+err.Error())
		return
	}
	a.egress.ports[req.Port] = true
	a.egress.mu.Unlock()

	go func() {
		for {
			c, err := ln.Accept()
			if err != nil {
				return // listener closed (agent shutdown)
			}
			go relayEgressConn(c, dial, vsockPort)
		}
	}()
	writeResult(w, id, proto.Result{OK: true, Value: "listening"})
}

// relayEgressConn splices one guest client connection with one fresh vsock
// connection to the host. Either side finishing tears both down — HTTP clients
// close when done, and CONNECT tunnels end together, so lingering half-open
// pairs would only leak goroutines.
func relayEgressConn(c net.Conn, dial func(port uint32) (net.Conn, error), vsockPort uint32) {
	defer c.Close()
	up, err := dial(vsockPort)
	if err != nil {
		return
	}
	defer up.Close()
	done := make(chan struct{}, 2)
	go func() { io.Copy(up, c); done <- struct{}{} }()
	go func() { io.Copy(c, up); done <- struct{}{} }()
	<-done
	c.Close()
	up.Close()
	<-done
}
