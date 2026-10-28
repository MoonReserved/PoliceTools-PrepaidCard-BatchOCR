package main

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func fixture(t *testing.T) *staticHandler {
	t.Helper()
	project := t.TempDir()
	docs := filepath.Join(project, "中文 含空格 docs")
	if err := os.MkdirAll(filepath.Join(docs, "runtime"), 0700); err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"index.html":        "<!doctype html><title>PoliceTools</title>",
		"runtime/test.wasm": "\x00asmtest",
		"runtime/test.mjs":  "export const loaded = true;",
		"model.onnx":        "0123456789",
		".private":          "must not be public",
	}
	for name, text := range files {
		if err := os.WriteFile(filepath.Join(docs, filepath.FromSlash(name)), []byte(text), 0600); err != nil {
			t.Fatal(err)
		}
	}
	outside := filepath.Join(project, "private.txt")
	if err := os.WriteFile(outside, []byte("PRIVATE OUTSIDE DOCS"), 0600); err != nil {
		t.Fatal(err)
	}
	// All shipped targets support symlinks. Windows may require privilege for
	// test fixture creation, so the confinement assertion is separate below.
	os.Symlink(outside, filepath.Join(docs, "outside.txt"))
	h, err := newHandler(docs, "127.0.0.1:8787")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { h.root.Close() })
	return h
}

func TestStaticFilesAndModelTransfers(t *testing.T) {
	h := fixture(t)
	for _, test := range []struct{ path, contentType, body string }{
		{"/", "text/html; charset=utf-8", "<!doctype html><title>PoliceTools</title>"},
		{"/runtime/test.wasm", "application/wasm", "\x00asmtest"},
		{"/runtime/test.mjs", "application/javascript", "export const loaded = true;"},
		{"/model.onnx", "application/octet-stream", "0123456789"},
	} {
		t.Run(test.path, func(t *testing.T) {
			r := httptest.NewRequest("GET", "http://127.0.0.1:8787"+test.path, nil)
			w := httptest.NewRecorder()
			h.ServeHTTP(w, r)
			if w.Code != 200 || w.Body.String() != test.body || w.Header().Get("Content-Type") != test.contentType {
				t.Fatalf("unexpected response: code=%d MIME=%q body=%q", w.Code, w.Header().Get("Content-Type"), w.Body.String())
			}
			if w.Header().Get("Content-Security-Policy") != csp || w.Header().Get("X-Content-Type-Options") != "nosniff" {
				t.Fatal("expected response security headers")
			}
		})
	}
	r := httptest.NewRequest("GET", "http://127.0.0.1:8787/model.onnx", nil)
	r.Header.Set("Range", "bytes=2-5")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 206 || w.Body.String() != "2345" {
		t.Fatalf("range transfer failed: %d %q", w.Code, w.Body.String())
	}
	r = httptest.NewRequest("HEAD", "http://127.0.0.1:8787/model.onnx", nil)
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 || w.Body.Len() != 0 || w.Header().Get("Content-Length") != "10" {
		t.Fatal("HEAD response is incorrect")
	}
	r = httptest.NewRequest("GET", "http://127.0.0.1:8787/", nil)
	r.Header.Set("Sec-Fetch-Site", "cross-site")
	r.Header.Set("Sec-Fetch-Mode", "navigate")
	w = httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != 200 {
		t.Fatal("following the localhost link from the README must work")
	}
}

func TestConfinementAndNoUploads(t *testing.T) {
	h := fixture(t)
	for _, name := range []string{"/../private.txt", "/%2e%2e/private.txt", "/outside.txt", "/runtime/", "/.private", "/runtime/%5c..%5cprivate.txt", "/C:/private.txt", "/missing.onnx"} {
		t.Run(name, func(t *testing.T) {
			w := httptest.NewRecorder()
			h.ServeHTTP(w, httptest.NewRequest("GET", "http://127.0.0.1:8787"+name, nil))
			if w.Code != 403 && w.Code != 404 {
				t.Fatalf("unsafe path returned %d", w.Code)
			}
			if strings.Contains(w.Body.String(), "PRIVATE OUTSIDE DOCS") {
				t.Fatal("outside file was exposed")
			}
		})
	}
	for _, method := range []string{"POST", "PUT", "PATCH", "DELETE", "OPTIONS"} {
		w := httptest.NewRecorder()
		r := httptest.NewRequest(method, "http://127.0.0.1:8787/index.html", bytes.NewBufferString("image bytes"))
		h.ServeHTTP(w, r)
		if w.Code != http.StatusMethodNotAllowed || w.Header().Get("Allow") != "GET, HEAD" {
			t.Fatalf("%s must be rejected, got %d", method, w.Code)
		}
	}
	for _, host := range []string{"evil.example:8787", "localhost:8787", "127.0.0.1:9999"} {
		r := httptest.NewRequest("GET", "http://127.0.0.1:8787/", nil)
		r.Host = host
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("unexpected host %q accepted", host)
		}
	}
	for _, header := range []struct{ key, value string }{{"Origin", "https://example.com"}, {"Sec-Fetch-Site", "cross-site"}} {
		r := httptest.NewRequest("GET", "http://127.0.0.1:8787/", nil)
		r.Header.Set(header.key, header.value)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != 403 {
			t.Fatalf("cross-site request accepted: %s", header.key)
		}
	}
}

func TestMissingSiteFails(t *testing.T) {
	if h, err := newHandler(t.TempDir(), "127.0.0.1:8787"); err == nil {
		h.root.Close()
		t.Fatal("missing index.html must fail startup")
	}
}
