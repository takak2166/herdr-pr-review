// gopls-lsp keeps gopls sessions open, so that asking where a Go name is defined or used takes a
// fraction of a second instead of the seconds a fresh `gopls definition` / `gopls references` takes:
// each of those starts a new session, which loads and type-checks the whole module again.
//
//	gopls-lsp ask <sock> <gopls-sock> <root> <def|refs> <file:line:col>
//	gopls-lsp serve <sock> <gopls-sock>
//
// `ask` prints the answer as gopls' own commands do, one "<file>:<line>:<col>" per place (paths
// absolute; line and column from 1, the column in bytes). It starts the server (`serve`, on the unix
// socket <sock>, detached) when none answers. The server keeps one LSP session per <root> -- a
// checkout of one commit -- through `gopls -remote` to the shared gopls daemon at <gopls-sock>; the
// three most recently used stay open, and the server exits after 30 minutes without a question.
//
// Only the standard library is used, so `go build` needs nothing else.
package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	maxSessions = 3
	idleExit    = 30 * time.Minute
	askTimeout  = 170 * time.Second
)

func main() {
	if len(os.Args) >= 4 && os.Args[1] == "serve" {
		serve(os.Args[2], os.Args[3])
		return
	}
	if len(os.Args) != 7 || os.Args[1] != "ask" {
		fmt.Fprintln(os.Stderr, "usage: gopls-lsp ask <sock> <gopls-sock> <root> <def|refs> <file:line:col> | serve <sock> <gopls-sock>")
		os.Exit(2)
	}
	lines, err := ask(os.Args[2], os.Args[3], request{Root: os.Args[4], Mode: os.Args[5], At: os.Args[6]})
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	for _, l := range lines {
		fmt.Println(l)
	}
}

type request struct {
	Root string `json:"root"`
	Mode string `json:"mode"`
	At   string `json:"at"`
}

type reply struct {
	Lines []string `json:"lines"`
	Error string   `json:"error,omitempty"`
}

// ask sends one question to the server, starting it first when no server answers.
func ask(sock, goplsSock string, req request) ([]string, error) {
	conn, err := net.Dial("unix", sock)
	if err != nil {
		if err := start(sock, goplsSock); err != nil {
			return nil, err
		}
		if conn, err = net.Dial("unix", sock); err != nil {
			return nil, fmt.Errorf("gopls-lsp: no server at %s: %w", sock, err)
		}
	}
	defer conn.Close()
	conn.SetDeadline(time.Now().Add(askTimeout + 10*time.Second))
	if err := json.NewEncoder(conn).Encode(req); err != nil {
		return nil, err
	}
	var r reply
	if err := json.NewDecoder(conn).Decode(&r); err != nil {
		return nil, fmt.Errorf("gopls-lsp: no answer: %w", err)
	}
	if r.Error != "" {
		return nil, errors.New(r.Error)
	}
	return r.Lines, nil
}

// start runs `serve` in the background, out of this process' session, and waits for its socket.
func start(sock, goplsSock string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	os.Remove(sock)
	// What the server says when it fails goes to <sock>.log, read back here when it doesn't start.
	logPath := sock + ".log"
	logFile, err := os.Create(logPath)
	if err != nil {
		return err
	}
	defer logFile.Close()
	cmd := exec.Command(self, "serve", sock, goplsSock)
	cmd.Stderr = logFile
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
	if err := cmd.Start(); err != nil {
		return err
	}
	cmd.Process.Release()
	for i := 0; i < 50; i++ {
		if c, err := net.Dial("unix", sock); err == nil {
			c.Close()
			return nil
		}
		time.Sleep(100 * time.Millisecond)
	}
	why, _ := os.ReadFile(logPath)
	return fmt.Errorf("gopls-lsp: the server did not start at %s: %s", sock, strings.TrimSpace(string(why)))
}

// ---- the server

type server struct {
	goplsSock string
	mu        sync.Mutex
	sessions  map[string]*session
	last      time.Time
}

func serve(sock, goplsSock string) {
	os.Remove(sock)
	ln, err := net.Listen("unix", sock)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	s := &server{goplsSock: goplsSock, sessions: map[string]*session{}, last: time.Now()}
	go func() {
		for range time.Tick(time.Minute) {
			s.mu.Lock()
			idle := time.Since(s.last) > idleExit
			if idle {
				for _, ss := range s.sessions {
					ss.close()
				}
			}
			s.mu.Unlock()
			if idle {
				ln.Close()
				os.Remove(sock)
				os.Exit(0)
			}
		}
	}()
	for {
		conn, err := ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *server) handle(conn net.Conn) {
	defer conn.Close()
	var req request
	if err := json.NewDecoder(bufio.NewReader(conn)).Decode(&req); err != nil {
		return
	}
	lines, err := s.answer(req)
	r := reply{Lines: lines}
	if err != nil {
		r.Error = err.Error()
	}
	json.NewEncoder(conn).Encode(r)
}

// answer asks the root's session; a session whose gopls has gone (the daemon restarted) is
// replaced and asked once more.
func (s *server) answer(req request) ([]string, error) {
	if req.Mode != "def" && req.Mode != "refs" {
		return nil, fmt.Errorf("gopls-lsp: unknown mode %q", req.Mode)
	}
	for try := 0; ; try++ {
		ss, err := s.session(req.Root)
		if err != nil {
			return nil, err
		}
		lines, err := ss.ask(req)
		if errors.Is(err, errGone) && try == 0 {
			s.drop(req.Root, ss)
			continue
		}
		return lines, err
	}
}

func (s *server) session(root string) (*session, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.last = time.Now()
	if ss, ok := s.sessions[root]; ok {
		ss.used = time.Now()
		return ss, nil
	}
	if len(s.sessions) >= maxSessions {
		var oldest *session
		for _, ss := range s.sessions {
			if oldest == nil || ss.used.Before(oldest.used) {
				oldest = ss
			}
		}
		oldest.close()
		delete(s.sessions, oldest.root)
	}
	ss, err := open(root, s.goplsSock)
	if err != nil {
		return nil, err
	}
	s.sessions[root] = ss
	return ss, nil
}

func (s *server) drop(root string, ss *session) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.sessions[root] == ss {
		ss.close()
		delete(s.sessions, root)
	}
}

// ---- one LSP session

var errGone = errors.New("gopls-lsp: the gopls session ended")

type session struct {
	root string
	used time.Time
	cmd  *exec.Cmd
	in   io.WriteCloser

	wmu     sync.Mutex // one message written at a time
	mu      sync.Mutex
	next    int
	waiting map[int]chan response
	done    chan struct{}
}

type response struct {
	Result json.RawMessage `json:"result"`
	Error  *struct {
		Message string `json:"message"`
	} `json:"error"`
}

type message struct {
	ID     *json.RawMessage `json:"id"`
	Method string           `json:"method"`
	Params json.RawMessage  `json:"params"`
	response
}

func open(root, goplsSock string) (*session, error) {
	cmd := exec.Command("gopls", "-remote=unix;"+goplsSock)
	cmd.Dir = root
	in, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	ss := &session{root: root, used: time.Now(), cmd: cmd, in: in, waiting: map[int]chan response{}, done: make(chan struct{})}
	go ss.read(bufio.NewReader(out))
	uri := fileURI(root)
	if _, err := ss.call("initialize", map[string]any{
		"processId":        os.Getpid(),
		"rootUri":          uri,
		"workspaceFolders": []any{map[string]string{"uri": uri, "name": filepath.Base(root)}},
		"capabilities":     map[string]any{},
	}); err != nil {
		ss.close()
		return nil, err
	}
	ss.write(map[string]any{"jsonrpc": "2.0", "method": "initialized", "params": map[string]any{}})
	return ss, nil
}

func (ss *session) close() {
	ss.in.Close()
	ss.cmd.Process.Kill()
	ss.cmd.Wait()
}

// read hands each response to its caller and answers gopls' own requests (configuration,
// progress, registrations) with nothing.
func (ss *session) read(r *bufio.Reader) {
	defer close(ss.done)
	for {
		body, err := readMessage(r)
		if err != nil {
			return
		}
		var m message
		if json.Unmarshal(body, &m) != nil || m.ID == nil {
			continue
		}
		if m.Method != "" {
			var result any
			if m.Method == "workspace/configuration" {
				var p struct{ Items []any }
				json.Unmarshal(m.Params, &p)
				result = make([]any, len(p.Items))
			}
			ss.write(map[string]any{"jsonrpc": "2.0", "id": m.ID, "result": result})
			continue
		}
		id, err := strconv.Atoi(string(*m.ID))
		if err != nil {
			continue
		}
		ss.mu.Lock()
		ch := ss.waiting[id]
		delete(ss.waiting, id)
		ss.mu.Unlock()
		if ch != nil {
			ch <- m.response
		}
	}
}

func readMessage(r *bufio.Reader) ([]byte, error) {
	n := -1
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return nil, err
		}
		line = strings.TrimSpace(line)
		if line == "" {
			break
		}
		if k, v, ok := strings.Cut(line, ":"); ok && strings.EqualFold(k, "Content-Length") {
			n, _ = strconv.Atoi(strings.TrimSpace(v))
		}
	}
	if n < 0 {
		return nil, errors.New("no Content-Length")
	}
	body := make([]byte, n)
	_, err := io.ReadFull(r, body)
	return body, err
}

func (ss *session) write(msg any) error {
	b, err := json.Marshal(msg)
	if err != nil {
		return err
	}
	ss.wmu.Lock()
	defer ss.wmu.Unlock()
	_, err = fmt.Fprintf(ss.in, "Content-Length: %d\r\n\r\n%s", len(b), b)
	return err
}

func (ss *session) call(method string, params any) (json.RawMessage, error) {
	ch := make(chan response, 1)
	ss.mu.Lock()
	ss.next++
	id := ss.next
	ss.waiting[id] = ch
	ss.mu.Unlock()
	if err := ss.write(map[string]any{"jsonrpc": "2.0", "id": id, "method": method, "params": params}); err != nil {
		return nil, errGone
	}
	select {
	case r := <-ch:
		if r.Error != nil {
			return nil, fmt.Errorf("gopls: %s", r.Error.Message)
		}
		return r.Result, nil
	case <-ss.done:
		return nil, errGone
	case <-time.After(askTimeout):
		return nil, fmt.Errorf("gopls: no answer in %s", askTimeout)
	}
}

// ---- questions and answers

type position struct {
	Line      int `json:"line"`
	Character int `json:"character"`
}

type location struct {
	URI   string `json:"uri"`
	Range struct {
		Start position `json:"start"`
	} `json:"range"`
	// A LocationLink, which gopls may send for a definition instead.
	TargetURI            string `json:"targetUri"`
	TargetSelectionRange struct {
		Start position `json:"start"`
	} `json:"targetSelectionRange"`
}

func (ss *session) ask(req request) ([]string, error) {
	file, line, col, err := splitAt(req.At)
	if err != nil {
		return nil, err
	}
	if !filepath.IsAbs(file) {
		file = filepath.Join(ss.root, file)
	}
	text, err := lineOf(file, line)
	if err != nil {
		return nil, err
	}
	params := map[string]any{
		"textDocument": map[string]string{"uri": fileURI(file)},
		"position":     position{Line: line - 1, Character: utf16Col(text, col-1)},
	}
	method := "textDocument/definition"
	if req.Mode == "refs" {
		method = "textDocument/references"
		params["context"] = map[string]bool{"includeDeclaration": false}
	}
	raw, err := ss.call(method, params)
	if err != nil {
		return nil, err
	}
	var locs []location
	if len(raw) > 0 && raw[0] == '{' {
		var one location
		if err := json.Unmarshal(raw, &one); err != nil {
			return nil, err
		}
		locs = []location{one}
	} else if err := json.Unmarshal(raw, &locs); err != nil && string(raw) != "null" {
		return nil, err
	}
	var out []string
	for _, l := range locs {
		uri, at := l.URI, l.Range.Start
		if l.TargetURI != "" {
			uri, at = l.TargetURI, l.TargetSelectionRange.Start
		}
		path := pathOf(uri)
		byteCol := at.Character + 1
		if t, err := lineOf(path, at.Line+1); err == nil {
			byteCol = byteColOf(t, at.Character) + 1
		}
		out = append(out, fmt.Sprintf("%s:%d:%d", path, at.Line+1, byteCol))
	}
	return out, nil
}

// splitAt reads "<file>:<line>:<col>".
func splitAt(at string) (string, int, int, error) {
	i := strings.LastIndex(at, ":")
	j := strings.LastIndex(at[:max(i, 0)], ":")
	if i < 0 || j < 0 {
		return "", 0, 0, fmt.Errorf("gopls-lsp: %q is not file:line:col", at)
	}
	line, err1 := strconv.Atoi(at[j+1 : i])
	col, err2 := strconv.Atoi(at[i+1:])
	if err1 != nil || err2 != nil || line < 1 || col < 1 {
		return "", 0, 0, fmt.Errorf("gopls-lsp: %q is not file:line:col", at)
	}
	return at[:j], line, col, nil
}

// lineOf is line n (from 1) of the file, without its newline.
func lineOf(path string, n int) (string, error) {
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	sc := bufio.NewScanner(f)
	sc.Buffer(make([]byte, 1<<20), 1<<24)
	for i := 1; sc.Scan(); i++ {
		if i == n {
			return sc.Text(), nil
		}
	}
	return "", fmt.Errorf("gopls-lsp: %s has no line %d", path, n)
}

// utf16Col turns a byte offset into the line into LSP's count of UTF-16 units.
func utf16Col(text string, b int) int {
	if b > len(text) {
		b = len(text)
	}
	n := 0
	for _, r := range text[:b] {
		n += len(utf16.Encode([]rune{r}))
	}
	return n
}

// byteColOf turns LSP's count of UTF-16 units into a byte offset into the line.
func byteColOf(text string, units int) int {
	n := 0
	for i, r := range text {
		if n >= units {
			return i
		}
		if r == utf8.RuneError {
			n++
		} else {
			n += len(utf16.Encode([]rune{r}))
		}
	}
	return len(text)
}

// fileURI and pathOf turn a path into a file: URI and back (escaping spaces and the like).
func fileURI(path string) string {
	return (&url.URL{Scheme: "file", Path: path}).String()
}

func pathOf(uri string) string {
	if u, err := url.Parse(uri); err == nil && u.Scheme == "file" {
		return u.Path
	}
	return strings.TrimPrefix(uri, "file://")
}
