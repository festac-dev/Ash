package api

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type Client struct {
	baseURL string
	token   string
	http    *http.Client
}

type APIError struct {
	Status  int
	Code    string
	Message string
	Hint    string
}

func (e *APIError) Error() string {
	if e.Hint != "" {
		return fmt.Sprintf("%s: %s (%s)", e.Code, e.Message, e.Hint)
	}
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

type CreateTaskInput struct {
	Description     string   `json:"description"`
	Budget          string   `json:"budget"`
	Currency        string   `json:"currency"`
	Deadline        *string  `json:"deadline,omitempty"`
	Quality         *string  `json:"quality_requirements,omitempty"`
	PreferredAgents []string `json:"preferred_agents,omitempty"`
	Strategy        string   `json:"execution_strategy"`
	AllowExternal   bool     `json:"allow_external"`
	DIYFirst        bool     `json:"diy_first"`
	RequireApproval bool     `json:"require_hiring_approval"`
	MaxParallelJobs *int     `json:"max_parallel_jobs,omitempty"`
	AdditionalNotes *string  `json:"additional_instructions,omitempty"`
}

type StreamMessage struct {
	Kind      string
	Connected bool
	Event     Event
	Reason    string
	Message   string
	Error     error
}

func New() (*Client, error) {
	baseURL := strings.TrimRight(os.Getenv("ASH_API_URL"), "/")
	token := strings.TrimSpace(os.Getenv("ASH_API_TOKEN"))
	if baseURL == "" {
		return nil, errors.New("ASH_API_URL is not set (start Ash with `ash` or `ash tui`)")
	}
	if token == "" {
		return nil, errors.New("ASH_API_TOKEN is not set")
	}
	parsed, err := url.ParseRequestURI(baseURL)
	if err != nil || parsed.Hostname() == "" || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.User != nil || parsed.RawQuery != "" || parsed.Fragment != "" {
		return nil, errors.New("ASH_API_URL must be an http(s) URL without credentials, query or fragment")
	}
	return &Client{
		baseURL: baseURL,
		token:   token,
		http:    &http.Client{Timeout: 20 * time.Second},
	}, nil
}

func (c *Client) State(ctx context.Context) (*State, error) {
	var out State
	if err := c.do(ctx, http.MethodGet, "/api/state", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

type FrontendStatus struct {
	Running    bool   `json:"running"`
	NextAction string `json:"next_action"`
	URL        string `json:"url"`
	Code       string `json:"code"`
	ExpiresAt  string `json:"expires_at"`
	Port       int    `json:"port"`
}

func (c *Client) FrontendStatus(ctx context.Context) (*FrontendStatus, error) {
	var out FrontendStatus
	if err := c.do(ctx, http.MethodGet, "/api/frontend", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) CycleFrontend(ctx context.Context) (*FrontendStatus, error) {
	var out FrontendStatus
	// A first frontend build can take longer than ordinary API requests.
	webClient := *c
	httpClient := *c.http
	httpClient.Timeout = 4 * time.Minute
	webClient.http = &httpClient
	if err := webClient.do(ctx, http.MethodPost, "/api/frontend/cycle", map[string]any{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ChatHistory(ctx context.Context, taskID string) (*ChatHistory, error) {
	endpoint := "/api/chat"
	if taskID != "" {
		endpoint += "?task_id=" + url.QueryEscape(taskID)
	}
	var out ChatHistory
	if err := c.do(ctx, http.MethodGet, endpoint, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Chat(ctx context.Context, taskID, requestID, message string) (*ChatHistory, error) {
	var task *string
	if taskID != "" {
		task = &taskID
	}
	body := map[string]any{"task_id": task, "request_id": requestID, "message": message}
	// Chat can include provider retries; keep ordinary API requests on their shorter timeout.
	chatClient := *c
	httpClient := *c.http
	httpClient.Timeout = 2 * time.Minute
	chatClient.http = &httpClient
	var out ChatHistory
	if err := chatClient.do(ctx, http.MethodPost, "/api/chat", body, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Tasks(ctx context.Context) ([]TaskSummary, error) {
	var out struct {
		Tasks []TaskSummary `json:"tasks"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/tasks", nil, &out); err != nil {
		return nil, err
	}
	return out.Tasks, nil
}

func (c *Client) CreateTask(ctx context.Context, input CreateTaskInput) (*Task, error) {
	var out TaskResponse
	if err := c.do(ctx, http.MethodPost, "/api/tasks", input, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) PlanTask(ctx context.Context, taskID string) (*PlanResponse, error) {
	planClient := *c
	httpClient := *c.http
	httpClient.Timeout = 2 * time.Minute
	planClient.http = &httpClient
	var out PlanResponse
	if err := planClient.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/plan", struct{}{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Approve(ctx context.Context, taskID, approvalID, phrase string) (*Task, error) {
	body := map[string]string{"approval_id": approvalID, "phrase": phrase}
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/approve", body, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) Deny(ctx context.Context, taskID, approvalID, phrase string) (*Task, error) {
	body := map[string]string{"approval_id": approvalID, "phrase": phrase}
	var out struct {
		Task Task `json:"task"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/deny", body, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) RequestBudget(ctx context.Context, taskID, amount, currency string) (*Approval, error) {
	body := map[string]string{"amount": amount}
	if currency != "" {
		body["currency"] = currency
	}
	var out struct {
		Approval Approval `json:"approval"`
	}
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/budget", body, &out); err != nil {
		return nil, err
	}
	return &out.Approval, nil
}

func (c *Client) Activate(ctx context.Context, taskID string) (*Task, error) {
	var out TaskResponse
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/activate", struct{}{}, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) Execute(ctx context.Context, taskID string) (*Task, error) {
	var out TaskResponse
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/execute", struct{}{}, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) Pause(ctx context.Context, taskID string) (*Task, error) {
	var out TaskResponse
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/pause", struct{}{}, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) Resume(ctx context.Context, taskID string) (*Task, error) {
	var out TaskResponse
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/resume", struct{}{}, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) Cancel(ctx context.Context, taskID, phrase string) (*Task, error) {
	body := map[string]string{"phrase": phrase}
	var out TaskResponse
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/cancel", body, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) Review(ctx context.Context, taskID, subtaskID, decision, phrase, note string) (*Task, error) {
	body := map[string]string{"subtask_id": subtaskID, "decision": decision, "phrase": phrase, "note": note}
	var out TaskResponse
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/review", body, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) UpdateSetting(ctx context.Context, taskID, key, value string) (*Task, error) {
	body := map[string]string{"key": key, "value": value}
	var out TaskResponse
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/settings", body, &out); err != nil {
		return nil, err
	}
	return &out.Task, nil
}

func (c *Client) Agents(ctx context.Context, query string) ([]Agent, error) {
	var out struct {
		Agents []Agent `json:"agents"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/agents?query="+url.QueryEscape(query), nil, &out); err != nil {
		return nil, err
	}
	return out.Agents, nil
}

func (c *Client) Jobs(ctx context.Context) ([]Job, error) {
	var out struct {
		Jobs []Job `json:"jobs"`
	}
	if err := c.do(ctx, http.MethodGet, "/api/jobs", nil, &out); err != nil {
		return nil, err
	}
	return out.Jobs, nil
}

func (c *Client) Market(ctx context.Context) (*Market, error) {
	var out Market
	if err := c.do(ctx, http.MethodGet, "/api/market", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Transactions(ctx context.Context, limit int) (*Transactions, error) {
	var out Transactions
	path := fmt.Sprintf("/api/transactions?limit=%d", limit)
	if err := c.do(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Security(ctx context.Context) (*Security, error) {
	var out Security
	if err := c.do(ctx, http.MethodGet, "/api/security", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Settings(ctx context.Context) (*Settings, error) {
	var out Settings
	if err := c.do(ctx, http.MethodGet, "/api/settings", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) Receipt(ctx context.Context, file string) (*ReceiptView, error) {
	var out ReceiptView
	if err := c.do(ctx, http.MethodGet, "/api/receipts/"+url.PathEscape(file), nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

// Stream subscribes to SSE with reconnection. It closes only when ctx ends.
func (c *Client) Stream(ctx context.Context) <-chan StreamMessage {
	out := make(chan StreamMessage, 64)
	go func() {
		defer close(out)
		backoff := time.Second
		for ctx.Err() == nil {
			err := c.streamOnce(ctx, out)
			if ctx.Err() != nil {
				return
			}
			send(ctx, out, StreamMessage{Kind: "disconnect", Error: err})
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			if backoff < 10*time.Second {
				backoff *= 2
			}
		}
	}()
	return out
}

func (c *Client) streamOnce(ctx context.Context, out chan<- StreamMessage) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.baseURL+"/api/events", nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "text/event-stream")
	streamClient := *c.http
	streamClient.Timeout = 0
	streamClient.CheckRedirect = rejectRedirect
	resp, err := streamClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return parseResponseError(resp.StatusCode, body)
	}
	if !send(ctx, out, StreamMessage{Kind: "connected", Connected: true}) {
		return ctx.Err()
	}
	scanner := bufio.NewScanner(resp.Body)
	scanner.Buffer(make([]byte, 64*1024), 1024*1024)
	eventType := ""
	var data strings.Builder
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if data.Len() > 0 {
				var stream Stream
				if json.Unmarshal([]byte(data.String()), &stream) == nil {
					if stream.Type == "" {
						stream.Type = eventType
					}
					if !send(ctx, out, StreamMessage{Kind: stream.Type, Event: stream.Event, Reason: stream.Reason, Message: stream.Message, Connected: true}) {
						return ctx.Err()
					}
				}
			}
			eventType = ""
			data.Reset()
			continue
		}
		if strings.HasPrefix(line, "event:") {
			eventType = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
		} else if strings.HasPrefix(line, "data:") {
			if data.Len()+len(line) > 1024*1024 {
				return errors.New("Ash event exceeded 1 MiB")
			}
			if data.Len() > 0 {
				data.WriteByte('\n')
			}
			data.WriteString(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
		}
	}
	return scanner.Err()
}

func send(ctx context.Context, out chan<- StreamMessage, message StreamMessage) bool {
	select {
	case out <- message:
		return true
	case <-ctx.Done():
		return false
	}
}

func (c *Client) do(ctx context.Context, method, path string, body any, out any) error {
	var reader io.Reader
	if body != nil {
		encoded, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(encoded)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, reader)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+c.token)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	httpClient := *c.http
	httpClient.CheckRedirect = rejectRedirect
	resp, err := httpClient.Do(req)
	if err != nil {
		return fmt.Errorf("Ash API request failed: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		data, _ := io.ReadAll(io.LimitReader(resp.Body, 8192))
		return parseResponseError(resp.StatusCode, data)
	}
	if out == nil {
		return nil
	}
	decoder := json.NewDecoder(io.LimitReader(resp.Body, 8*1024*1024))
	if err := decoder.Decode(out); err != nil {
		return fmt.Errorf("Ash API returned invalid JSON: %w", err)
	}
	return nil
}

func rejectRedirect(_ *http.Request, _ []*http.Request) error {
	return http.ErrUseLastResponse
}

func parseResponseError(status int, data []byte) error {
	var envelope struct {
		Error ErrorBody `json:"error"`
	}
	if json.Unmarshal(data, &envelope) == nil && envelope.Error.Message != "" {
		return &APIError{Status: status, Code: envelope.Error.Code, Message: envelope.Error.Message, Hint: envelope.Error.Hint}
	}
	return &APIError{Status: status, Code: "HTTP_ERROR", Message: strings.TrimSpace(string(data))}
}

func (c *Client) Timeline(ctx context.Context, taskID string) (*Timeline, error) {
	var out Timeline
	if err := c.do(ctx, http.MethodGet, "/api/tasks/"+url.PathEscape(taskID)+"/timeline", nil, &out); err != nil {
		return nil, err
	}
	return &out, nil
}

func (c *Client) ExportProof(ctx context.Context, taskID string) (*ProofPaths, error) {
	var out ProofPaths
	if err := c.do(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(taskID)+"/proof", map[string]string{}, &out); err != nil {
		return nil, err
	}
	return &out, nil
}
