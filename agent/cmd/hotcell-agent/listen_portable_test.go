package main

import (
	"encoding/json"
	"net"
	"path/filepath"
	"testing"
	"time"

	"github.com/directionally-local/hotcell/agent/proto"
	"github.com/directionally-local/hotcell/agent/server"
)

// TestUnixTransportEndToEnd drives the real listenSpec transport (not net.Pipe):
// it listens on a unix socket, serves an Agent, then connects as the host driver
// would and round-trips Hello + an exec. This covers main's transport wiring.
func TestUnixTransportEndToEnd(t *testing.T) {
	sock := filepath.Join(t.TempDir(), "agent.sock")
	ln, err := listenSpec("unix://" + sock)
	if err != nil {
		t.Fatalf("listenSpec: %v", err)
	}
	defer ln.Close()

	ag := server.New()
	go func() {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		ag.Serve(conn)
	}()

	conn, err := net.DialTimeout("unix", sock, 2*time.Second)
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	defer conn.Close()

	// First frame is the Hello greeting on stream 0.
	f, err := proto.ReadFrame(conn)
	if err != nil || f.Type != proto.Control || f.StreamID != 0 {
		t.Fatalf("expected hello, got frame %+v err %v", f, err)
	}
	var hello proto.Hello
	if json.Unmarshal(f.Payload, &hello); hello.Event != "hello" {
		t.Fatalf("bad hello payload: %q", f.Payload)
	}

	// Run an exec and read its stdout + result.
	req, _ := json.Marshal(proto.Request{Method: "exec", Command: "echo transport_ok", Cwd: "/tmp"})
	w := proto.NewFrameWriter(conn)
	if err := w.Write(proto.Control, 1, req); err != nil {
		t.Fatalf("write control: %v", err)
	}
	var stdout []byte
	for {
		f, err := proto.ReadFrame(conn)
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		if f.StreamID != 1 {
			continue
		}
		if f.Type == proto.Stdout {
			stdout = append(stdout, f.Payload...)
		}
		if f.Type == proto.ResultFrame {
			break
		}
	}
	if string(stdout) != "transport_ok\n" {
		t.Fatalf("stdout = %q, want %q", stdout, "transport_ok\n")
	}
}
