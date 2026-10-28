// PoliceTools local static server. OCR runs entirely inside the browser.
// This program has no upload endpoint and makes no network downloads.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"time"
)

const csp = "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; style-src 'self'; img-src 'self' blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'"

type staticHandler struct {
	root *os.Root
	host string
}

func newHandler(docsPath, host string) (*staticHandler, error) {
	root, err := os.OpenRoot(docsPath)
	if err != nil {
		return nil, fmt.Errorf("cannot open docs folder: %w", err)
	}
	f, err := root.Open("index.html")
	if err != nil {
		root.Close()
		return nil, errors.New("docs/index.html is missing; extract the complete project first")
	}
	info, err := f.Stat()
	f.Close()
	if err != nil || !info.Mode().IsRegular() {
		root.Close()
		return nil, errors.New("docs/index.html must be a regular file")
	}
	return &staticHandler{root: root, host: host}, nil
}

func (h *staticHandler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Security-Policy", csp)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Referrer-Policy", "no-referrer")
	w.Header().Set("Cache-Control", "no-cache")
	// Bind to IPv4 loopback and accept only the exact URL that we display.
	// This also prevents an unrelated hostname from reaching the server by
	// resolving to loopback (DNS rebinding).
	if r.Host != h.host {
		http.Error(w, "Open the displayed http://127.0.0.1 URL.", http.StatusForbidden)
		return
	}
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "This server only provides static files; uploads are not supported.", http.StatusMethodNotAllowed)
		return
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+h.host {
		http.Error(w, "Cross-origin requests are not supported.", http.StatusForbidden)
		return
	}
	// Permit the user to follow a localhost link from the README or chat.
	// Cross-site subresource requests remain blocked.
	if r.Header.Get("Sec-Fetch-Site") == "cross-site" && r.Header.Get("Sec-Fetch-Mode") != "navigate" {
		http.Error(w, "Cross-site requests are not supported.", http.StatusForbidden)
		return
	}
	requestPath := r.URL.Path
	if !strings.HasPrefix(requestPath, "/") || strings.ContainsAny(requestPath, "\\\x00:") {
		http.NotFound(w, r)
		return
	}
	for _, part := range strings.Split(requestPath, "/") {
		if strings.HasPrefix(part, ".") {
			http.NotFound(w, r)
			return
		}
	}
	name := strings.TrimPrefix(path.Clean(requestPath), "/")
	if name == "" || name == "." {
		name = "index.html"
	}
	// os.Root performs traversal-resistant file operations, including symlinks.
	// No file outside docs is exposed, even if a link is added to that folder.
	f, err := h.root.Open(filepath.FromSlash(name))
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.Error(w, "Directory listing is disabled.", http.StatusForbidden)
		return
	}
	if contentType := fileContentType(name); contentType != "" {
		w.Header().Set("Content-Type", contentType)
	}
	http.ServeContent(w, r, name, info.ModTime(), f)
}

func fileContentType(name string) string {
	switch strings.ToLower(filepath.Ext(name)) {
	case ".html":
		return "text/html; charset=utf-8"
	case ".js", ".mjs":
		return "application/javascript"
	case ".wasm":
		return "application/wasm"
	case ".onnx", ".pack":
		return "application/octet-stream"
	case ".json":
		return "application/json"
	case ".css":
		return "text/css; charset=utf-8"
	case ".woff":
		return "font/woff"
	case ".txt":
		return "text/plain; charset=utf-8"
	default:
		return mime.TypeByExtension(filepath.Ext(name))
	}
}

func defaultDocsPath() (string, error) {
	executable, err := os.Executable()
	if err != nil {
		return "", err
	}
	// Shipped binaries reside in local-server/bin/.
	return filepath.Clean(filepath.Join(filepath.Dir(executable), "..", "..", "docs")), nil
}

func openBrowser(url string) error {
	var command *exec.Cmd
	switch runtime.GOOS {
	case "darwin":
		command = exec.Command("/usr/bin/open", url)
	case "windows":
		windowsDirectory := os.Getenv("SystemRoot")
		if windowsDirectory == "" {
			return errors.New("SystemRoot is not set; please open the displayed URL manually")
		}
		command = exec.Command(filepath.Join(windowsDirectory, "System32", "rundll32.exe"), "url.dll,FileProtocolHandler", url)
	default:
		command = exec.Command("xdg-open", url)
	}
	return command.Run()
}

func run() error {
	defaultRoot, err := defaultDocsPath()
	if err != nil {
		return err
	}
	port := flag.Int("port", 8787, "local port; use 8788 if 8787 is occupied")
	docsPath := flag.String("root", defaultRoot, "path to this project's docs folder")
	noBrowser := flag.Bool("no-browser", false, "do not open the default browser")
	flag.Parse()
	if flag.NArg() != 0 {
		return errors.New("unexpected argument; use --port 8788 to change the port")
	}
	if *port < 0 || *port > 65535 {
		return errors.New("port must be between 0 and 65535")
	}
	listener, err := net.Listen("tcp4", net.JoinHostPort("127.0.0.1", strconv.Itoa(*port)))
	if err != nil {
		return fmt.Errorf("cannot start on 127.0.0.1:%d: %w\nClose the other local launcher, or run this launcher with --port 8788.\n無法啟動本機服務。請關閉其他啟動視窗，或加上 --port 8788 重試。", *port, err)
	}
	defer listener.Close()
	host := listener.Addr().String()
	handler, err := newHandler(*docsPath, host)
	if err != nil {
		return err
	}
	defer handler.root.Close()
	server := &http.Server{
		Handler:           handler,
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       30 * time.Second,
		IdleTimeout:       60 * time.Second,
		MaxHeaderBytes:    64 * 1024,
		ErrorLog:          log.New(os.Stderr, "Local server: ", 0),
	}
	url := "http://" + host + "/"
	fmt.Printf("PoliceTools - Prepaid Card Batch OCR\n警政小工具-點數卡批次OCR辨識\n\nOpen / 開啟網址：%s\n\nKeep this window open while using the local tool.\nImages and PDFs stay in your browser; this server only serves website files.\n使用期間請保留這個視窗。圖片與 PDF 只在瀏覽器內處理。\nPress Ctrl+C to stop / 按 Ctrl+C 結束。\n", url)
	if !*noBrowser {
		go func() {
			if err := openBrowser(url); err != nil {
				fmt.Fprintf(os.Stderr, "Please open %s in your browser.\n無法自動開啟瀏覽器，請手動開啟上方網址。\n", url)
			}
		}()
	}
	stop, cancel := signal.NotifyContext(context.Background(), os.Interrupt)
	defer cancel()
	go func() {
		<-stop.Done()
		ctx, done := context.WithTimeout(context.Background(), 3*time.Second)
		defer done()
		server.Shutdown(ctx)
	}()
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintf(os.Stderr, "\nUnable to start / 啟動失敗：\n%v\n", err)
		os.Exit(1)
	}
}
