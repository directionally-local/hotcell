package server

import (
	"bytes"
	"encoding/json"
	"io"
	"net"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/sinameraji/hotcell/agent/proto"
)

// testClient is a minimal host-side driver: it speaks proto over a pipe to a
// served Agent, exactly as the future FirecrackerDriver/AppleVzDriver will over
// vsock. It collects frames per streamId.
type testClient struct {
	t   *testing.T
	w   *proto.FrameWriter
	r   io.Reader
	seq uint32
}

func newTestClient(t *testing.T) (*testClient, *Agent, func()) {
	c1, c2 := net.Pipe()
	a := New()
	go a.Serve(c2)
	tc := &testClient{t: t, w: proto.NewFrameWriter(c1), r: c1}
	// First frame must be the Hello greeting on stream 0.
	f := tc.read()
	if f.Type != proto.Control || f.StreamID != 0 {
		t.Fatalf("expected hello control on stream 0, got %v/%d", f.Type, f.StreamID)
	}
	var hello proto.Hello
	if err := json.Unmarshal(f.Payload, &hello); err != nil || hello.Event != "hello" {
		t.Fatalf("bad hello: %q (%v)", f.Payload, err)
	}
	return tc, a, func() { c1.Close() }
}

func (tc *testClient) read() proto.Frame {
	tc.t.Helper()
	f, err := proto.ReadFrame(tc.r)
	if err != nil {
		tc.t.Fatalf("read frame: %v", err)
	}
	return f
}

func (tc *testClient) call(req proto.Request) uint32 {
	tc.t.Helper()
	tc.seq++
	id := tc.seq
	b, _ := json.Marshal(req)
	if err := tc.w.Write(proto.Control, id, b); err != nil {
		tc.t.Fatalf("write control: %v", err)
	}
	return id
}

// collect reads frames for stream id until its Result, returning stdout, stderr
// and the parsed Result.
func (tc *testClient) collect(id uint32) (stdout, stderr []byte, res proto.Result) {
	tc.t.Helper()
	for {
		f := tc.read()
		if f.StreamID != id {
			continue
		}
		switch f.Type {
		case proto.Stdout:
			stdout = append(stdout, f.Payload...)
		case proto.Stderr:
			stderr = append(stderr, f.Payload...)
		case proto.ResultFrame:
			if err := json.Unmarshal(f.Payload, &res); err != nil {
				tc.t.Fatalf("bad result json: %v", err)
			}
			return stdout, stderr, res
		}
	}
}

func TestExecStdoutStderrExit(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()

	id := tc.call(proto.Request{Method: "exec", Command: "echo out; echo err 1>&2; exit 3", Cwd: "/tmp"})
	stdout, stderr, res := tc.collect(id)

	if string(stdout) != "out\n" {
		t.Fatalf("stdout = %q, want %q", stdout, "out\n")
	}
	if string(stderr) != "err\n" {
		t.Fatalf("stderr = %q, want %q", stderr, "err\n")
	}
	if !res.OK || res.ExitCode == nil || *res.ExitCode != 3 {
		t.Fatalf("result = %+v, want ok with exit 3", res)
	}
}

func TestExecInheritsSetEnv(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()

	// setEnv establishes a sandbox-level var; a later exec must see it.
	if _, _, res := tc.collect(tc.call(proto.Request{
		Method: "setEnv", Env: map[string]string{"SBX_TEST_VAR": "sandbox"},
	})); !res.OK {
		t.Fatalf("setEnv failed: %+v", res)
	}
	// Per-request env overrides the sandbox env.
	stdout, _, res := tc.collect(tc.call(proto.Request{
		Method:  "exec",
		Command: "printf '%s' \"$SBX_TEST_VAR-$REQ_VAR\"",
		Cwd:     "/tmp",
		Env:     map[string]string{"REQ_VAR": "req"},
	}))
	if !res.OK {
		t.Fatalf("exec failed: %+v", res)
	}
	if string(stdout) != "sandbox-req" {
		t.Fatalf("env merge = %q, want %q", stdout, "sandbox-req")
	}
}

func TestFileRoundTrip(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()
	dir := t.TempDir()

	sub := filepath.Join(dir, "a", "b")
	if _, _, res := tc.collect(tc.call(proto.Request{Method: "mkdir", Path: sub, Parents: true})); !res.OK {
		t.Fatalf("mkdir: %+v", res)
	}
	file := filepath.Join(sub, "hello.txt")
	if _, _, res := tc.collect(tc.call(proto.Request{Method: "writeFile", Path: file, Content: "hello agent"})); !res.OK {
		t.Fatalf("writeFile: %+v", res)
	}
	badFile := filepath.Join(sub, "bad-mode.txt")
	_, _, badMode := tc.collect(tc.call(proto.Request{
		Method: "writeFile", Path: badFile, Content: "must not be written", Mode: "777; touch /tmp/PWNED #",
	}))
	if badMode.OK {
		t.Fatal("writeFile accepted a non-octal mode")
	}
	if _, err := os.Stat(badFile); !os.IsNotExist(err) {
		t.Fatalf("invalid-mode write created file: stat err = %v", err)
	}
	_, _, res := tc.collect(tc.call(proto.Request{Method: "readFile", Path: file}))
	if !res.OK || res.Value.(string) != "hello agent" {
		t.Fatalf("readFile = %+v, want 'hello agent'", res)
	}

	// listFiles on the subdir should show exactly hello.txt.
	_, _, res = tc.collect(tc.call(proto.Request{Method: "listFiles", Path: sub}))
	if !res.OK {
		t.Fatalf("listFiles: %+v", res)
	}
	entries := res.Value.([]any)
	if len(entries) != 1 {
		t.Fatalf("listFiles returned %d entries, want 1", len(entries))
	}
	fi := entries[0].(map[string]any)
	if fi["name"] != "hello.txt" || fi["isDirectory"] != false {
		t.Fatalf("listFiles entry = %+v", fi)
	}
}

func TestWaitForPort(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()

	// Listen on an ephemeral port, then assert waitForPort sees it.
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close()
	port := ln.Addr().(*net.TCPAddr).Port

	_, _, res := tc.collect(tc.call(proto.Request{
		Method: "waitForPort", Port: port, Host: "127.0.0.1", TimeoutMs: 2000, IntervalMs: 50,
	}))
	if !res.OK || res.Value.(bool) != true {
		t.Fatalf("waitForPort(open) = %+v, want true", res)
	}

	// A closed port should time out to false quickly.
	_, _, res = tc.collect(tc.call(proto.Request{
		Method: "waitForPort", Port: closedPort(t), Host: "127.0.0.1", TimeoutMs: 200, IntervalMs: 50,
	}))
	if !res.OK || res.Value.(bool) != false {
		t.Fatalf("waitForPort(closed) = %+v, want false", res)
	}
}

func TestStats(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()
	_, _, res := tc.collect(tc.call(proto.Request{Method: "stats"}))
	if !res.OK {
		t.Fatalf("stats: %+v", res)
	}
	m := res.Value.(map[string]any)
	if _, ok := m["sampledAt"]; !ok {
		t.Fatalf("stats missing sampledAt: %+v", m)
	}
	if m["onlineCpus"].(float64) < 1 {
		t.Fatalf("stats onlineCpus = %v, want >= 1", m["onlineCpus"])
	}
}

// TestTarRoundTrip exercises the binary-safe backup path with no VM: tar a
// populated dir (tarWorkspace → Stdout frames), then untar the captured bytes
// into a fresh dir (untarWorkspace ← Stdin frames + EOF) and assert the tree and
// file contents round-trip exactly. Also proves the stdin-attach buffering, since
// the payload frames are written immediately after the request.
func TestTarRoundTrip(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()

	src := t.TempDir()
	if err := os.WriteFile(filepath.Join(src, "a.txt"), []byte("alpha"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(src, "sub"), 0o755); err != nil {
		t.Fatal(err)
	}
	// A byte sequence that is invalid UTF-8, to prove the transfer is binary-safe.
	binBytes := []byte{0x00, 0xff, 0xfe, 0x10, 'h', 'i'}
	if err := os.WriteFile(filepath.Join(src, "sub", "bin.dat"), binBytes, 0o644); err != nil {
		t.Fatal(err)
	}

	// tarWorkspace: collect the streamed tar bytes.
	tarBytes, _, res := tc.collect(tc.call(proto.Request{Method: "tarWorkspace", Path: src}))
	if !res.OK {
		t.Fatalf("tarWorkspace: %+v", res)
	}
	if len(tarBytes) == 0 {
		t.Fatal("tarWorkspace produced no bytes")
	}

	// untarWorkspace into a fresh dir: send the request, then stream the payload
	// as Stdin frames followed by EOF (before the handler attaches stdin — the
	// buffering must catch them).
	dst := t.TempDir()
	tc.seq++
	id := tc.seq
	reqBody, _ := json.Marshal(proto.Request{Method: "untarWorkspace", Path: dst})
	if err := tc.w.Write(proto.Control, id, reqBody); err != nil {
		t.Fatalf("write untar control: %v", err)
	}
	if err := tc.w.Write(proto.Stdin, id, tarBytes); err != nil {
		t.Fatalf("write untar stdin: %v", err)
	}
	if err := tc.w.Write(proto.EOF, id, nil); err != nil {
		t.Fatalf("write untar eof: %v", err)
	}
	if _, _, res := tc.collect(id); !res.OK {
		t.Fatalf("untarWorkspace: %+v", res)
	}

	if got, err := os.ReadFile(filepath.Join(dst, "a.txt")); err != nil || string(got) != "alpha" {
		t.Fatalf("a.txt = %q (%v), want alpha", got, err)
	}
	got, err := os.ReadFile(filepath.Join(dst, "sub", "bin.dat"))
	if err != nil || !bytes.Equal(got, binBytes) {
		t.Fatalf("bin.dat = %v (%v), want %v", got, err, binBytes)
	}
}

func TestUnknownMethod(t *testing.T) {
	tc, _, done := newTestClient(t)
	defer done()
	_, _, res := tc.collect(tc.call(proto.Request{Method: "teleport"}))
	if res.OK || res.Error == "" {
		t.Fatalf("unknown method should error, got %+v", res)
	}
}

func closedPort(t *testing.T) int {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	port := ln.Addr().(*net.TCPAddr).Port
	ln.Close() // free it so nothing is listening
	return port
}

// Guard against a wedged test hanging CI forever.
func TestMain(m *testing.M) {
	done := make(chan int, 1)
	go func() { done <- m.Run() }()
	select {
	case code := <-done:
		os.Exit(code)
	case <-time.After(60 * time.Second):
		os.Stderr.WriteString("server tests timed out\n")
		os.Exit(1)
	}
}
