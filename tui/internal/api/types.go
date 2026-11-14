package api

type ChatMessage struct {
	RequestID string `json:"request_id"`
	Role      string `json:"role"`
	Content   string `json:"content"`
	At        string `json:"at"`
}

type ChatHistory struct {
	TaskID    *string       `json:"task_id"`
	Messages  []ChatMessage `json:"messages"`
	Truncated bool          `json:"truncated"`
}

// The JSON types below mirror the Node API deliberately. They are a client
// contract, not a second source of business rules.

type State struct {
	Server        ServerInfo    `json:"server"`
	Mode          string        `json:"mode"`
	EngineRunning bool          `json:"engine_running"`
	ActiveTaskID  *string       `json:"active_task_id"`
	Task          *Task         `json:"task"`
	Tasks         []TaskSummary `json:"tasks"`
	Ledger        *Ledger       `json:"ledger"`
	Market        Market        `json:"market"`
	Approvals     []Approval    `json:"approvals"`
	Events        []Event       `json:"events"`
	Receipts      []ReceiptView `json:"receipts"`
	Integrity     *Integrity    `json:"integrity"`
	Config        PublicConfig  `json:"config"`
}

type ServerInfo struct {
	PID       int    `json:"pid"`
	StartedAt string `json:"started_at"`
	Version   string `json:"version"`
}

type TaskSummary struct {
	ID                string `json:"id"`
	Description       string `json:"description"`
	Status            string `json:"status"`
	StatusDetail      string `json:"status_detail"`
	Budget            string `json:"budget"`
	Currency          string `json:"currency"`
	CreatedAt         string `json:"created_at"`
	UpdatedAt         string `json:"updated_at"`
	Project           string `json:"project"`
	PlanSubtasks      int    `json:"plan_subtasks"`
	CompletedSubtasks int    `json:"completed_subtasks"`
}

type Task struct {
	ID                     string          `json:"id"`
	Description            string          `json:"description"`
	QualityRequirements    *string         `json:"quality_requirements"`
	AdditionalInstructions *string         `json:"additional_instructions"`
	TrackID                *string         `json:"track_id"`
	ProjectScopes          []string        `json:"project_scopes"`
	Deadline               *string         `json:"deadline"`
	PreferredAgents        []string        `json:"preferred_agents"`
	ExecutionStrategy      string          `json:"execution_strategy"`
	AllowExternal          bool            `json:"allow_external"`
	DIYFirst               bool            `json:"diy_first"`
	RequireHiringApproval  bool            `json:"require_hiring_approval"`
	MaxParallelJobs        int             `json:"max_parallel_jobs"`
	Budget                 string          `json:"authorized_budget"`
	Currency               string          `json:"currency"`
	Status                 string          `json:"status"`
	StatusDetail           *string         `json:"status_detail"`
	Plan                   *Plan           `json:"plan"`
	PlanApprovedAt         *string         `json:"plan_approved_at"`
	PlanApprovalRef        *string         `json:"plan_approval_ref"`
	Subtasks               []SubtaskState  `json:"subtasks"`
	MarketSnapshot         *MarketSnapshot `json:"market_snapshot"`
	LastReceiptHash        *string         `json:"last_receipt_hash"`
	LastReceiptFile        *string         `json:"last_receipt_file"`
	CancelReason           *string         `json:"cancel_reason"`
}

type Plan struct {
	Summary          string    `json:"summary"`
	FinalOutcome     string    `json:"final_outcome"`
	Assumptions      []string  `json:"assumptions"`
	Risks            []string  `json:"risks"`
	Currency         string    `json:"currency"`
	AuthorizedBudget string    `json:"authorized_budget"`
	Contingency      string    `json:"contingency"`
	ExternalPlanned  string    `json:"external_planned"`
	Subtasks         []Subtask `json:"subtasks"`
}

type Subtask struct {
	ID                 string      `json:"id"`
	Title              string      `json:"title"`
	Description        string      `json:"description"`
	Execution          string      `json:"execution"`
	Dependencies       []string    `json:"dependencies"`
	Complexity         string      `json:"complexity"`
	Skills             []string    `json:"skills"`
	Deliverable        string      `json:"deliverable"`
	AcceptanceCriteria []Criterion `json:"acceptance_criteria"`
	PlannedMax         string      `json:"planned_max"`
	EstimatedCost      string      `json:"estimated_cost"`
	Rationale          string      `json:"rationale"`
}

type Criterion struct {
	Kind             string   `json:"kind"`
	Description      string   `json:"description"`
	MinChars         int      `json:"min_chars"`
	All              []string `json:"all"`
	Rubric           string   `json:"rubric"`
	Path             string   `json:"path"`
	MinBytes         int      `json:"min_bytes"`
	Command          string   `json:"command"`
	TimeoutMS        int      `json:"timeout_ms"`
	ExpectedExitCode int      `json:"expected_exit_code"`
}

type SubtaskState struct {
	ID            string    `json:"id"`
	Phase         string    `json:"phase"`
	Attempts      []Attempt `json:"attempts"`
	ActiveAttempt int       `json:"active_attempt"`
	ReceiptID     *string   `json:"receipt_id"`
	LastError     *string   `json:"last_error"`
	BlockedReason *string   `json:"blocked_reason"`
	StartedAt     *string   `json:"started_at"`
	CompletedAt   *string   `json:"completed_at"`
	NextCheckAt   *string   `json:"next_check_at"`
}

type Attempt struct {
	Attempt           int           `json:"attempt"`
	Kind              string        `json:"kind"`
	Status            string        `json:"status"`
	StartedAt         string        `json:"started_at"`
	CompletedAt       *string       `json:"completed_at"`
	Vendor            *Vendor       `json:"vendor"`
	JobID             *string       `json:"job_id"`
	ApprovalURL       *string       `json:"approval_url"`
	AgreedPrice       *string       `json:"agreed_price"`
	Currency          string        `json:"currency"`
	NegotiationLog    []Negotiation `json:"negotiation_log"`
	Delivery          *Delivery     `json:"delivery"`
	Verification      *Verification `json:"verification"`
	RevisionRequested bool          `json:"revision_requested"`
	MarketState       *string       `json:"market_state"`
	PaymentStatus     *string       `json:"payment_status"`
	LastError         *string       `json:"last_error"`
}

type Vendor struct {
	ID     string  `json:"id"`
	Name   string  `json:"name"`
	Handle *string `json:"handle"`
}

type Negotiation struct {
	At         string  `json:"at"`
	Direction  string  `json:"direction"`
	VendorName *string `json:"vendor_name"`
	Amount     *string `json:"amount"`
	Currency   string  `json:"currency"`
	Reason     string  `json:"reason"`
}

type Delivery struct {
	TextPath       *string        `json:"text_path"`
	Files          []DeliveryFile `json:"files"`
	ExternalURL    *string        `json:"external_url"`
	Source         string         `json:"source"`
	SHA256         string         `json:"sha256"`
	Suspicious     bool           `json:"suspicious"`
	InjectionFlags []string       `json:"injection_signals"`
	Truncated      bool           `json:"truncated"`
}

type DeliveryFile struct {
	Path     string  `json:"path"`
	Filename string  `json:"filename"`
	Bytes    int     `json:"bytes"`
	SHA256   *string `json:"sha256"`
}

type Verification struct {
	Passed         bool     `json:"passed"`
	Status         string   `json:"status"`
	CheckedAt      string   `json:"checked_at"`
	Details        string   `json:"details"`
	InjectionFlags []string `json:"injection_flags"`
	ReviewedBy     string   `json:"reviewed_by"`
}

type MarketSnapshot struct {
	At        string            `json:"at"`
	Source    string            `json:"source"`
	AccountID *string           `json:"account_id"`
	Handle    *string           `json:"handle"`
	Balances  map[string]string `json:"balances"`
	CreditUSD *string           `json:"credit_usd"`
	Note      *string           `json:"note"`
}

type Ledger struct {
	Authorized string `json:"authorized"`
	Committed  string `json:"committed"`
	Paid       string `json:"paid"`
	Refunded   string `json:"refunded"`
	Available  string `json:"available"`
	Currency   string `json:"currency"`
}

type Market struct {
	Mode      string            `json:"mode"`
	Connected bool              `json:"connected"`
	Endpoint  string            `json:"endpoint"`
	Error     *string           `json:"error"`
	Balance   map[string]string `json:"balance"`
	Tools     []string          `json:"tools"`
}

type Approval struct {
	ID        string            `json:"id"`
	TaskID    string            `json:"task_id"`
	Kind      string            `json:"kind"`
	Summary   string            `json:"summary"`
	Amount    *string           `json:"amount"`
	Currency  string            `json:"currency"`
	Scope     map[string]string `json:"scope"`
	Status    string            `json:"status"`
	ExpiresAt string            `json:"expires_at"`
	DecidedAt *string           `json:"decided_at"`
}

type Event struct {
	At        string  `json:"at"`
	TaskID    string  `json:"task_id"`
	SubtaskID *string `json:"subtask_id"`
	Level     string  `json:"level"`
	Code      string  `json:"code"`
	Message   string  `json:"message"`
}

type Integrity struct {
	OK           bool             `json:"ok"`
	Exists       bool             `json:"exists"`
	ReceiptCount int              `json:"receipt_count"`
	LastHash     *string          `json:"last_hash"`
	LastFile     *string          `json:"last_file"`
	ChainHead    *ChainHead       `json:"chain_head"`
	Errors       []IntegrityIssue `json:"errors"`
	Warnings     []IntegrityIssue `json:"warnings"`
}

type ChainHead struct {
	Count    int    `json:"count"`
	LastHash string `json:"last_hash"`
	LastFile string `json:"last_file"`
}

type IntegrityIssue struct {
	File    string `json:"file"`
	Code    string `json:"code"`
	Message string `json:"message"`
}

type ReceiptView struct {
	Receipt Receipt `json:"receipt"`
	File    string  `json:"file"`
}

type Receipt struct {
	SchemaVersion      string            `json:"schema_version"`
	TransactionID      string            `json:"transaction_id"`
	Sequence           int               `json:"sequence"`
	TaskID             string            `json:"task_id"`
	SubtaskID          string            `json:"subtask_id"`
	TaskDescription    string            `json:"task_description"`
	Item               string            `json:"item"`
	SubtaskDescription string            `json:"subtask_description"`
	Status             string            `json:"status"`
	Vendor             *Vendor           `json:"vendor"`
	PlannedMax         string            `json:"planned_max"`
	QuotedPrice        *string           `json:"quoted_price"`
	NegotiatedPrice    *string           `json:"negotiated_price"`
	AgreedPrice        *string           `json:"agreed_price"`
	Currency           string            `json:"currency"`
	MarketplaceJobID   *string           `json:"marketplace_job_id"`
	PaymentStatus      string            `json:"payment_status"`
	CheckResult        CheckResult       `json:"check_result"`
	NegotiationLog     []Negotiation     `json:"negotiation_log"`
	ApprovalRef        *string           `json:"approval_ref"`
	Timestamp          string            `json:"timestamp"`
	PreviousHash       string            `json:"previous_hash"`
	HashAlgorithm      string            `json:"hash_algorithm"`
	Hash               string            `json:"hash"`
	Mode               string            `json:"mode"`
	Attempt            int               `json:"attempt"`
	Metadata           map[string]string `json:"metadata"`
}

type CheckResult struct {
	Passed         bool              `json:"passed"`
	Status         string            `json:"status"`
	Details        string            `json:"details"`
	Criteria       []CriterionResult `json:"criteria"`
	InjectionFlags []string          `json:"injection_flags"`
}

type CriterionResult struct {
	Criterion string `json:"criterion"`
	Kind      string `json:"kind"`
	Passed    bool   `json:"passed"`
	Details   string `json:"details"`
}

type PublicConfig struct {
	Mode                  string  `json:"mode"`
	DataDir               string  `json:"data_dir"`
	ModelProvider         string  `json:"model_provider"`
	ModelName             *string `json:"model_name"`
	ModelKeyConfigured    bool    `json:"model_key_configured"`
	MarketURL             string  `json:"market_url"`
	MarketTokenConfigured bool    `json:"market_token_configured"`
	MarketMode            string  `json:"market_mode"`
	InCallSpend           bool    `json:"in_call_spend"`
	HiringMode            string  `json:"hiring_mode"`
	MaxParallelJobs       int     `json:"max_parallel_jobs"`
	ApprovalTTLMinutes    int     `json:"approval_ttl_minutes"`
	ContingencyRatio      float64 `json:"contingency_ratio"`
	TelegramConfigured    bool    `json:"telegram_configured"`
}

type Agent struct {
	ID              string   `json:"id"`
	Handle          *string  `json:"handle"`
	Name            string   `json:"name"`
	Description     string   `json:"description"`
	Category        *string  `json:"category"`
	Runtime         *string  `json:"runtime"`
	Price           *string  `json:"price"`
	Currency        string   `json:"currency"`
	PayableWith     []string `json:"payable_with"`
	DeliveredJobs   int      `json:"delivered_jobs"`
	SuccessRate     *float64 `json:"success_rate"`
	ResponseSeconds *float64 `json:"response_time_seconds_median"`
	SLASeconds      *float64 `json:"sla_seconds"`
	AcceptingWork   *bool    `json:"accepting_work"`
}

type Job struct {
	JobID            string  `json:"job_id"`
	Title            *string `json:"title"`
	Status           *string `json:"status"`
	Amount           *string `json:"amount"`
	Currency         *string `json:"currency"`
	AssignmentStatus *string `json:"assignment_status"`
	Worker           *string `json:"worker"`
}

type Transactions struct {
	Integrity Integrity     `json:"integrity"`
	Receipts  []ReceiptView `json:"receipts"`
	Report    []string      `json:"report"`
}

type Security struct {
	Integrity     Integrity  `json:"integrity"`
	EngineRunning bool       `json:"engine_running"`
	Approvals     []Approval `json:"approvals"`
	Events        []Event    `json:"events"`
	Mode          string     `json:"mode"`
	Limits        Limits     `json:"limits"`
}

type Limits struct {
	MaxParallelJobs    int     `json:"max_parallel_jobs"`
	ApprovalTTLMinutes int     `json:"approval_ttl_minutes"`
	ContingencyRatio   float64 `json:"contingency_ratio"`
	InCallSpend        bool    `json:"in_call_spend"`
	MarketMode         string  `json:"market_mode"`
}

type Settings struct {
	Config PublicConfig `json:"config"`
	Task   *Task        `json:"task"`
}

type PlanResponse struct {
	Task        Task      `json:"task"`
	Approval    *Approval `json:"approval"`
	PlanSummary string    `json:"plan_summary"`
}

type TaskResponse struct {
	Task Task `json:"task"`
}

type ErrorBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Hint    string `json:"hint"`
}

type Stream struct {
	Type    string `json:"type"`
	Event   Event  `json:"event"`
	Reason  string `json:"reason"`
	Message string `json:"message"`
}

type LedgerEntry struct {
	ID          string            `json:"id"`
	At          string            `json:"at"`
	Kind        string            `json:"kind"`
	Amount      string            `json:"amount"`
	Currency    string            `json:"currency"`
	Reference   string            `json:"reference"`
	Description string            `json:"description"`
	Metadata    map[string]string `json:"metadata"`
}

type Timeline struct {
	TaskID          string        `json:"task_id"`
	Currency        string        `json:"currency"`
	Entries         []LedgerEntry `json:"entries"`
	Events          []Event       `json:"events"`
	EventsTruncated bool          `json:"events_truncated"`
}

type ProofPaths struct {
	MarkdownPath string `json:"markdownPath"`
	JSONPath     string `json:"jsonPath"`
	HTMLPath     string `json:"htmlPath"`
}
