package api

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func testClient(server *httptest.Server) *Client {
	return &Client{baseURL: server.URL, token: "test-session-token", http: server.Client()}
}

func TestStateSendsBearerTokenAndDecodes(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/state" {
			t.Fatalf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("Authorization") != "Bearer test-session-token" {
			t.Fatalf("missing bearer token")
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"mode":"SIMULATION","engine_running":false,"tasks":[],"market":{"connected":true,"mode":"simulated"}}`))
	}))
	defer server.Close()
	state, err := testClient(server).State(context.Background())
	if err != nil {
		t.Fatalf("State returned error: %v", err)
	}
	if state.Mode != "SIMULATION" || !state.Market.Connected {
		t.Fatalf("unexpected state: %+v", state)
	}
}

func TestUnauthorizedResponseIsAnAPIError(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusUnauthorized)
		_, _ = w.Write([]byte(`{"error":{"code":"MARKET_AUTH_REQUIRED","message":"Missing or invalid Ash session token."}}`))
	}))
	defer server.Close()
	_, err := testClient(server).State(context.Background())
	apiErr, ok := err.(*APIError)
	if !ok {
		t.Fatalf("expected APIError, got %T", err)
	}
	if apiErr.Status != http.StatusUnauthorized || apiErr.Code != "MARKET_AUTH_REQUIRED" {
		t.Fatalf("unexpected API error: %+v", apiErr)
	}
}

func TestCreateTaskPostsJSONAndReturnsTask(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodPost || r.URL.Path != "/api/tasks" {
			t.Fatalf("unexpected request %s %s", r.Method, r.URL.Path)
		}
		var body CreateTaskInput
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Fatalf("invalid request body: %v", err)
		}
		if body.Description != "Build a checklist" || body.Currency != "USDC" {
			t.Fatalf("unexpected body: %+v", body)
		}
		w.WriteHeader(http.StatusCreated)
		_, _ = w.Write([]byte(`{"task":{"id":"task_1","description":"Build a checklist","authorized_budget":"10.00","currency":"USDC"}}`))
	}))
	defer server.Close()
	task, err := testClient(server).CreateTask(context.Background(), CreateTaskInput{
		Description: "Build a checklist",
		Budget:      "10.00",
		Currency:    "USDC",
		Strategy:    "plan_then_approve",
	})
	if err != nil {
		t.Fatalf("CreateTask returned error: %v", err)
	}
	if task.ID != "task_1" || task.Budget != "10.00" {
		t.Fatalf("unexpected task: %+v", task)
	}
}

func TestStreamReconnectsAndDeliversSSE(t *testing.T) {
	var calls int
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		if r.Header.Get("Accept") != "text/event-stream" {
			t.Fatalf("missing SSE accept header")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		flusher, _ := w.(http.Flusher)
		_, _ = w.Write([]byte("event: ready\ndata: {\"type\":\"ready\",\"ok\":true}\n\n"))
		flusher.Flush()
		_, _ = w.Write([]byte("event: refresh\ndata: {\"type\":\"refresh\",\"reason\":\"test\"}\n\n"))
		flusher.Flush()
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 500*time.Millisecond)
	defer cancel()
	stream := testClient(server).Stream(ctx)
	var kinds []string
	for message := range stream {
		kinds = append(kinds, message.Kind)
		if strings.Contains(strings.Join(kinds, ","), "refresh") {
			cancel()
		}
	}
	if !strings.Contains(strings.Join(kinds, ","), "connected") || !strings.Contains(strings.Join(kinds, ","), "refresh") {
		t.Fatalf("unexpected stream kinds: %v", kinds)
	}
	if calls == 0 {
		t.Fatal("SSE endpoint was never called")
	}
}

func TestAPIRefusesRedirects(t *testing.T) {
	redirected := make(chan bool, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected <- true }))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer server.Close()
	if _, err := testClient(server).State(context.Background()); err == nil {
		t.Fatal("redirect was accepted")
	}
	select {
	case <-redirected:
		t.Fatal("API followed redirect")
	default:
	}
}

func TestSSEUsesConfiguredTLSTransportAndBoundsWholeEvent(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 18; i++ {
			_, _ = w.Write([]byte("data: " + strings.Repeat("x", 64*1024) + "\n"))
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	out := make(chan StreamMessage, 4)
	err := testClient(server).streamOnce(ctx, out)
	if err == nil || !strings.Contains(err.Error(), "exceeded 1 MiB") {
		t.Fatalf("unexpected SSE error: %v", err)
	}
	if message := <-out; message.Kind != "connected" {
		t.Fatal("custom TLS transport was not used")
	}
}
