package main

import (
	"bufio"
	"crypto/subtle"
	"errors"
	"io"
	"net"
	"time"
)

const (
	agentAuthPrefix   = "HOTCELL/1 "
	agentAuthAccepted = "HOTCELL/1 OK\n"
	agentAuthRejected = "HOTCELL/1 DENIED\n"
)

// authenticate protects host-published TCP transports. Unix sockets and vsock
// remain isolated by their transport and pass an empty token.
func authenticate(conn net.Conn, token string) error {
	if token == "" {
		return nil
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	reader := bufio.NewReaderSize(conn, 256)
	line, err := reader.ReadSlice('\n')
	if err != nil {
		_, _ = io.WriteString(conn, agentAuthRejected)
		return errors.New("invalid or missing agent authentication handshake")
	}
	expected := []byte(agentAuthPrefix + token + "\n")
	if subtle.ConstantTimeCompare(line, expected) != 1 {
		_, _ = io.WriteString(conn, agentAuthRejected)
		return errors.New("invalid agent authentication token")
	}
	if _, err := io.WriteString(conn, agentAuthAccepted); err != nil {
		return err
	}
	return conn.SetDeadline(time.Time{})
}
