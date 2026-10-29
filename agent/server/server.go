// Package server implements the in-sandbox hotcell-agent: it serves the proto
// protocol over a single connection (vsock in production, a unix/tcp socket in
// dev/tests) and turns each request into a local OS action — exactly the work
// `docker exec` does for the container driver, but from inside a microVM where
// there is no docker.
//
// The server is transport-agnostic: Serve takes any io.ReadWriteCloser, so the
// protocol and every handler are unit-testable on any OS over net.Pipe, with no
// vsock and no guest. Only stats is platform-specific (real /proc reads on
// Linux; a stub elsewhere), kept behind build tags.
package server

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/directionally-local/hotcell/agent/proto"
)

// Version is the agent build version, surfaced in the Hello greeting.
const Version = "0.1.0"

// Agent serves the protocol for one sandbox guest. A single Agent instance is
// reused across connections; its env overlay (seeded from the process
// environment, mutated by setEnv) is the sandbox-level env every exec inherits,
// mirroring how the container driver bakes sandbox env into the container.
type Agent struct {
	mu  sync.RWMutex
	env map[string]string

	// EgressDial opens a fresh guest→host connection for the egress relay
	// (AF_VSOCK to CID 2 in production; a test override via HOTCELL_EGRESS_DIAL).
	// Set by main at startup; nil means egressListen is unsupported.
	EgressDial func(vsockPort uint32) (net.Conn, error)
	egress     egressState
}

// New returns an Agent seeded with the current process environment as its
// sandbox-level env base.
func New() *Agent {
	env := map[string]string{}
	for _, kv := range os.Environ() {
		if i := indexByte(kv, '='); i >= 0 {
			env[kv[:i]] = kv[i+1:]
		}
	}
	return &Agent{env: env}
}

func indexByte(s string, b byte) int {
	for i := 0; i < len(s); i++ {
		if s[i] == b {
			return i
		}
	}
	return -1
}

// stream is an in-flight request that accepts further input frames (exec/pty
// stdin, untar bytes). Request/response methods (files, stats) need none.
//
// A handler attaches its stdin sink (process stdin, pty master, dialed conn,
// tar -x stdin) only after it has started the underlying process — but the host
// may already be sending Stdin/EOF frames by then (untar in particular streams
// the payload immediately after the request). pendingInput buffers those frames
// and eofPending records an early EOF, both flushed by attachStdin once the sink
// exists, so no input is dropped. All three fields are guarded by Serve's mu.
type stream struct {
	cancel       context.CancelFunc
	stdin        io.WriteCloser       // process stdin / pty master / dialed conn / untar stdin; nil until attached
	control      func(payload []byte) // in-stream control (e.g. pty resize); nil if none
	pendingInput [][]byte             // Stdin frames received before stdin was attached
	eofPending   bool                 // an EOF received before stdin was attached
}

// attachStdin sets the stream's stdin sink and flushes any input buffered before
// the handler was ready (see stream doc). mu is Serve's stream mutex; it is held
// only while swapping fields, never across the writes.
func attachStdin(mu *sync.Mutex, st *stream, w io.WriteCloser) {
	mu.Lock()
	st.stdin = w
	pending := st.pendingInput
	st.pendingInput = nil
	eof := st.eofPending
	mu.Unlock()
	for _, b := range pending {
		w.Write(b)
	}
	if eof {
		w.Close()
	}
}

// Serve runs the protocol loop on conn until it closes or errors. It sends the
// Hello greeting first, then dispatches each Control frame to a handler
// goroutine and routes Stdin/EOF/Close frames to the addressed stream.
func (a *Agent) Serve(conn io.ReadWriteCloser) error {
	defer conn.Close()
	w := proto.NewFrameWriter(conn)

	hello, _ := json.Marshal(proto.Hello{
		Event:   "hello",
		Agent:   "hotcell-agent",
		Version: Version,
		Proto:   proto.ProtoVersion,
	})
	if err := w.Write(proto.Control, 0, hello); err != nil {
		return err
	}

	var mu sync.Mutex
	streams := map[uint32]*stream{}
	var wg sync.WaitGroup
	defer wg.Wait()

	br := bufio.NewReader(conn)
	for {
		f, err := proto.ReadFrame(br)
		if err != nil {
			if errors.Is(err, io.EOF) {
				return nil
			}
			return err
		}
		switch f.Type {
		case proto.Control:
			// A Control on an already-open stream is an in-stream control message
			// (e.g. pty resize), not a new request.
			mu.Lock()
			if existing := streams[f.StreamID]; existing != nil {
				mu.Unlock()
				if existing.control != nil {
					existing.control(f.Payload)
				}
				continue
			}
			mu.Unlock()
			var req proto.Request
			if err := json.Unmarshal(f.Payload, &req); err != nil {
				writeError(w, f.StreamID, "bad request json: "+err.Error())
				continue
			}
			ctx, cancel := context.WithCancel(context.Background())
			st := &stream{cancel: cancel}
			mu.Lock()
			streams[f.StreamID] = st
			mu.Unlock()
			wg.Add(1)
			go func(id uint32, req proto.Request) {
				defer wg.Done()
				defer func() {
					mu.Lock()
					delete(streams, id)
					mu.Unlock()
					cancel()
				}()
				a.dispatch(ctx, w, id, req, st, &mu)
			}(f.StreamID, req)
		case proto.Stdin:
			mu.Lock()
			if st := streams[f.StreamID]; st != nil {
				if st.stdin != nil {
					st.stdin.Write(f.Payload)
				} else {
					// Buffer until the handler attaches stdin. ReadFrame allocated
					// f.Payload fresh, so it's safe to retain without copying.
					st.pendingInput = append(st.pendingInput, f.Payload)
				}
			}
			mu.Unlock()
		case proto.EOF:
			mu.Lock()
			if st := streams[f.StreamID]; st != nil {
				if st.stdin != nil {
					st.stdin.Close()
				} else {
					st.eofPending = true
				}
			}
			mu.Unlock()
		case proto.Close:
			mu.Lock()
			st := streams[f.StreamID]
			mu.Unlock()
			if st != nil {
				st.cancel()
			}
		}
	}
}

// dispatch routes one request to its handler. Handlers stream output as
// Stdout/Stderr frames and end with a Result frame on the same streamId.
func (a *Agent) dispatch(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request, st *stream, mu *sync.Mutex) {
	switch req.Method {
	case "exec":
		a.handleExec(ctx, w, id, req, st, mu)
	case "writeFile":
		a.handleWriteFile(w, id, req)
	case "readFile":
		a.handleReadFile(w, id, req)
	case "mkdir":
		a.handleMkdir(w, id, req)
	case "listFiles":
		a.handleListFiles(w, id, req)
	case "waitForPort":
		a.handleWaitForPort(ctx, w, id, req)
	case "watch":
		a.handleWatch(ctx, w, id, req)
	case "tcpConnect":
		a.handleTcpConnect(ctx, w, id, req, st, mu)
	case "tarWorkspace":
		a.handleTarWorkspace(ctx, w, id, req)
	case "untarWorkspace":
		a.handleUntarWorkspace(ctx, w, id, req, st, mu)
	case "openPty":
		a.handleOpenPty(ctx, w, id, req, st, mu)
	case "setEnv":
		a.handleSetEnv(w, id, req)
	case "egressListen":
		a.handleEgressListen(w, id, req)
	case "stats":
		a.handleStats(w, id)
	case "reseed":
		a.handleReseed(w, id, req)
	default:
		writeError(w, id, "unknown method: "+req.Method)
	}
}

// mergedEnv returns the process environment overlaid with the sandbox env and
// then the per-request env (request wins), as a KEY=VALUE slice for exec.
func (a *Agent) mergedEnv(reqEnv map[string]string) []string {
	a.mu.RLock()
	merged := make(map[string]string, len(a.env)+len(reqEnv))
	for k, v := range a.env {
		merged[k] = v
	}
	a.mu.RUnlock()
	for k, v := range reqEnv {
		merged[k] = v
	}
	out := make([]string, 0, len(merged))
	for k, v := range merged {
		out = append(out, k+"="+v)
	}
	return out
}

// shellInvocation picks the closest match to the container driver's
// `/bin/bash -lc <command>`, falling back to `/bin/sh -c` when bash is absent
// (slim guest rootfs).
func shellInvocation(command string) (string, []string) {
	if path, err := exec.LookPath("bash"); err == nil {
		return path, []string{"-lc", command}
	}
	return "/bin/sh", []string{"-c", command}
}

// shellQuote single-quotes s for safe interpolation into a shell command line.
func shellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

func (a *Agent) handleExec(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request, st *stream, mu *sync.Mutex) {
	shell, args := shellInvocation(req.Command)
	cmd := exec.CommandContext(ctx, shell, args...)
	cmd.Dir = req.Cwd
	if cmd.Dir == "" {
		cmd.Dir = "/workspace"
	}
	cmd.Env = a.mergedEnv(req.Env)

	stdin, err := cmd.StdinPipe()
	if err != nil {
		writeError(w, id, "stdin pipe: "+err.Error())
		return
	}
	attachStdin(mu, st, stdin)

	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, id, "stdout pipe: "+err.Error())
		return
	}
	stderr, err := cmd.StderrPipe()
	if err != nil {
		writeError(w, id, "stderr pipe: "+err.Error())
		return
	}
	if err := cmd.Start(); err != nil {
		writeError(w, id, "start: "+err.Error())
		return
	}

	var pump sync.WaitGroup
	pump.Add(2)
	go func() { defer pump.Done(); copyToFrames(w, proto.Stdout, id, stdout) }()
	go func() { defer pump.Done(); copyToFrames(w, proto.Stderr, id, stderr) }()
	pump.Wait()

	exitCode := 0
	if err := cmd.Wait(); err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
		}
	}
	writeResult(w, id, proto.Result{OK: true, ExitCode: &exitCode})
}

// copyToFrames streams r as a sequence of typed frames on streamId until EOF.
func copyToFrames(w *proto.FrameWriter, t proto.FrameType, id uint32, r io.Reader) {
	buf := make([]byte, 32*1024)
	for {
		n, err := r.Read(buf)
		if n > 0 {
			if werr := w.Write(t, id, buf[:n]); werr != nil {
				return
			}
		}
		if err != nil {
			return
		}
	}
}

func (a *Agent) handleWriteFile(w *proto.FrameWriter, id uint32, req proto.Request) {
	mode, ok := parseMode(req.Mode, 0o644)
	if !ok {
		writeError(w, id, "mode must be a 3- or 4-digit octal permission string")
		return
	}
	if err := os.WriteFile(req.Path, []byte(req.Content), mode); err != nil {
		writeError(w, id, err.Error())
		return
	}
	writeResult(w, id, proto.Result{OK: true})
}

func (a *Agent) handleReadFile(w *proto.FrameWriter, id uint32, req proto.Request) {
	data, err := os.ReadFile(req.Path)
	if err != nil {
		writeError(w, id, err.Error())
		return
	}
	writeResult(w, id, proto.Result{OK: true, Value: string(data)})
}

func (a *Agent) handleMkdir(w *proto.FrameWriter, id uint32, req proto.Request) {
	var err error
	if req.Parents {
		err = os.MkdirAll(req.Path, 0o755)
	} else {
		err = os.Mkdir(req.Path, 0o755)
	}
	if err != nil {
		writeError(w, id, err.Error())
		return
	}
	writeResult(w, id, proto.Result{OK: true})
}

func (a *Agent) handleListFiles(w *proto.FrameWriter, id uint32, req proto.Request) {
	entries, err := os.ReadDir(req.Path)
	if err != nil {
		writeError(w, id, err.Error())
		return
	}
	out := make([]proto.FileInfo, 0, len(entries))
	for _, e := range entries {
		info, err := e.Info()
		if err != nil {
			continue // entry vanished between ReadDir and Info; skip
		}
		out = append(out, proto.FileInfo{
			Path:        filepath.Join(req.Path, e.Name()),
			Name:        e.Name(),
			IsDirectory: e.IsDir(),
			Size:        info.Size(),
			ModifiedAt:  info.ModTime().UTC().Format(time.RFC3339),
		})
	}
	writeResult(w, id, proto.Result{OK: true, Value: out})
}

func (a *Agent) handleWaitForPort(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request) {
	host := req.Host
	if host == "" {
		host = "127.0.0.1"
	}
	timeout := durOrDefault(req.TimeoutMs, 30*time.Second)
	interval := durOrDefault(req.IntervalMs, 250*time.Millisecond)
	deadline := time.Now().Add(timeout)
	addr := net.JoinHostPort(host, strconv.Itoa(req.Port))
	for {
		if ctx.Err() != nil {
			writeResult(w, id, proto.Result{OK: true, Value: false})
			return
		}
		conn, err := net.DialTimeout("tcp", addr, interval)
		if err == nil {
			conn.Close()
			writeResult(w, id, proto.Result{OK: true, Value: true})
			return
		}
		if time.Now().After(deadline) {
			writeResult(w, id, proto.Result{OK: true, Value: false})
			return
		}
		select {
		case <-ctx.Done():
		case <-time.After(interval):
		}
	}
}

// handleTcpConnect dials host:port inside the guest and bridges it to the stream:
// Stdin frames are written to the connection (host→service), the connection's
// output is streamed back as Stdout frames (service→host). Backs the preview-URL
// proxy. The stream's stdin is the dialed conn; a Close/cancel from the host shuts
// the connection so the read loop unblocks.
func (a *Agent) handleTcpConnect(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request, st *stream, mu *sync.Mutex) {
	host := req.Host
	if host == "" {
		host = "127.0.0.1"
	}
	conn, err := net.DialTimeout("tcp", net.JoinHostPort(host, strconv.Itoa(req.Port)), 10*time.Second)
	if err != nil {
		writeError(w, id, "tcpConnect: "+err.Error())
		return
	}
	defer conn.Close()
	attachStdin(mu, st, conn) // host Stdin frames → the dialed connection
	go func() {
		<-ctx.Done()
		conn.Close() // unblock the read loop when the host closes the stream
	}()
	copyToFrames(w, proto.Stdout, id, conn) // connection output → Stdout frames
	writeResult(w, id, proto.Result{OK: true})
}

// handleWatch polls `path` (default /workspace) recursively and streams change
// events to the host as `<type>\t<path>\n` Stdout lines (created/modified/
// deleted) until the host cancels the stream (Close → ctx). Poll-based mtime
// diff, mirroring the container driver's python watcher — portable, no inotify
// dependency, and the guest may lack python3. Backs watchFiles (M3).
func (a *Agent) handleWatch(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request) {
	root := req.Path
	if root == "" {
		root = "/workspace"
	}
	interval := durOrDefault(req.IntervalMs, time.Second)
	prev := snapshotTree(root)
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			writeResult(w, id, proto.Result{OK: true})
			return
		case <-ticker.C:
		}
		cur := snapshotTree(root)
		for p, mt := range prev {
			if cmt, ok := cur[p]; !ok {
				emitChange(w, id, "deleted", p)
			} else if cmt != mt {
				emitChange(w, id, "modified", p)
			}
		}
		for p := range cur {
			if _, ok := prev[p]; !ok {
				emitChange(w, id, "created", p)
			}
		}
		prev = cur
	}
}

// snapshotTree maps every path under root (excluding root itself) to its
// modification time in unix-nanos, for the watch mtime diff.
func snapshotTree(root string) map[string]int64 {
	m := map[string]int64{}
	filepath.WalkDir(root, func(p string, d os.DirEntry, err error) error {
		if err != nil || p == root {
			return nil // unreadable entry or the root itself; skip
		}
		if info, ierr := d.Info(); ierr == nil {
			m[p] = info.ModTime().UnixNano()
		}
		return nil
	})
	return m
}

func emitChange(w *proto.FrameWriter, id uint32, kind, path string) {
	w.Write(proto.Stdout, id, []byte(kind+"\t"+path+"\n"))
}

// handleTarWorkspace streams a tar of `path` (default /workspace) to the host as
// Stdout frames, ending with a Result. Binary-safe: the bytes flow through raw
// Stdout frames, not the lossy UTF-8 exec path. Backs createBackup. The tar is
// rooted at "." so it restores into any target dir.
func (a *Agent) handleTarWorkspace(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request) {
	path := req.Path
	if path == "" {
		path = "/workspace"
	}
	// Route through the shell (not exec.Command("tar")) so busybox's standalone
	// shell resolves the applet — the agent runs as PID 1 with no PATH, so a
	// direct LookPath("tar") fails, exactly as it would for nc/echo.
	shell, args := shellInvocation("exec tar -cf - -C " + shellQuote(path) + " .")
	cmd := exec.CommandContext(ctx, shell, args...)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		writeError(w, id, "tar stdout: "+err.Error())
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		writeError(w, id, "tar start: "+err.Error())
		return
	}
	copyToFrames(w, proto.Stdout, id, stdout)
	if err := cmd.Wait(); err != nil {
		writeError(w, id, "tar: "+err.Error()+": "+stderr.String())
		return
	}
	writeResult(w, id, proto.Result{OK: true})
}

// handleUntarWorkspace replaces `path` (default /workspace) with the tar streamed
// in as Stdin frames: the existing contents are cleared first (restore is a
// replacement, mirroring the container driver), then `tar -x` consumes stdin
// until the host's EOF frame. Backs restoreBackup.
func (a *Agent) handleUntarWorkspace(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request, st *stream, mu *sync.Mutex) {
	path := req.Path
	if path == "" {
		path = "/workspace"
	}
	if entries, err := os.ReadDir(path); err == nil {
		for _, e := range entries {
			os.RemoveAll(filepath.Join(path, e.Name()))
		}
	}
	shell, args := shellInvocation("exec tar -xf - -C " + shellQuote(path))
	cmd := exec.CommandContext(ctx, shell, args...)
	stdin, err := cmd.StdinPipe()
	if err != nil {
		writeError(w, id, "tar stdin: "+err.Error())
		return
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		writeError(w, id, "untar start: "+err.Error())
		return
	}
	attachStdin(mu, st, stdin) // flush any payload buffered before we were ready, incl. EOF
	if err := cmd.Wait(); err != nil {
		writeError(w, id, "untar: "+err.Error()+": "+stderr.String())
		return
	}
	writeResult(w, id, proto.Result{OK: true})
}

// handleOpenPty allocates a PTY, runs an interactive shell on it, and bridges it
// to the stream: Stdin frames are the shell's keyboard input, the pty output is
// streamed back as Stdout frames, and a `resize` Control message on the stream
// resizes the pty. Backs the dashboard/CLI terminal. Requires /dev/pts in the
// guest (mounted by the rootfs init).
func (a *Agent) handleOpenPty(ctx context.Context, w *proto.FrameWriter, id uint32, req proto.Request, st *stream, mu *sync.Mutex) {
	shell, _ := shellInvocation("")
	cmd := exec.Command(shell, "-i")
	cmd.Dir = req.Cwd
	if cmd.Dir == "" {
		cmd.Dir = "/workspace"
	}
	cmd.Env = append(a.mergedEnv(req.Env), "TERM=xterm-256color")

	ptmx, err := pty.Start(cmd)
	if err != nil {
		writeError(w, id, "openPty: "+err.Error())
		return
	}
	defer func() { _ = ptmx.Close() }()
	if req.Cols > 0 && req.Rows > 0 {
		_ = pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(req.Cols), Rows: uint16(req.Rows)})
	}

	mu.Lock()
	st.control = func(payload []byte) {
		var m struct {
			Method string `json:"method"`
			Cols   int    `json:"cols"`
			Rows   int    `json:"rows"`
		}
		if json.Unmarshal(payload, &m) == nil && m.Method == "resize" {
			_ = pty.Setsize(ptmx, &pty.Winsize{Cols: uint16(m.Cols), Rows: uint16(m.Rows)})
		}
	}
	mu.Unlock()
	attachStdin(mu, st, ptmx) // host Stdin frames → pty master (keyboard input)

	go func() {
		<-ctx.Done()
		_ = ptmx.Close()
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	copyToFrames(w, proto.Stdout, id, ptmx) // pty output → Stdout frames
	_ = cmd.Wait()
	writeResult(w, id, proto.Result{OK: true})
}

func (a *Agent) handleSetEnv(w *proto.FrameWriter, id uint32, req proto.Request) {
	a.mu.Lock()
	for k, v := range req.Env {
		a.env[k] = v
	}
	a.mu.Unlock()
	writeResult(w, id, proto.Result{OK: true})
}

func (a *Agent) handleStats(w *proto.FrameWriter, id uint32) {
	s := readStats() // platform-specific (stats_linux.go / stats_other.go)
	s.SampledAt = time.Now().UTC().Format(time.RFC3339)
	writeResult(w, id, proto.Result{OK: true, Value: s})
}

func writeResult(w *proto.FrameWriter, id uint32, r proto.Result) {
	b, _ := json.Marshal(r)
	w.Write(proto.ResultFrame, id, b)
}

func writeError(w *proto.FrameWriter, id uint32, msg string) {
	writeResult(w, id, proto.Result{OK: false, Error: msg})
}

func parseMode(s string, def os.FileMode) (os.FileMode, bool) {
	if s == "" {
		return def, true
	}
	if len(s) < 3 || len(s) > 4 {
		return 0, false
	}
	for _, digit := range s {
		if digit < '0' || digit > '7' {
			return 0, false
		}
	}
	v, err := strconv.ParseUint(s, 8, 12)
	if err != nil {
		return 0, false
	}
	return os.FileMode(v), true
}

func durOrDefault(ms int, def time.Duration) time.Duration {
	if ms <= 0 {
		return def
	}
	return time.Duration(ms) * time.Millisecond
}
