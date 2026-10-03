package main

import (
	"context"
	_ "embed"
	"errors"
	"path/filepath"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	managementResourceURI  = "ui://codex-auto-retry/management-panel"
	managementResourceMIME = "text/html;profile=mcp-app"
)

//go:embed ui/dist/panel.html
var managementPanelHTML string

type emptyToolInput struct{}

type setRetryPromptInput struct {
	Prompt string `json:"prompt" jsonschema:"fallback text used only when silent continuation is unsupported, from 1 to 500 characters"`
}

type setRetrySettingsInput struct {
	RetryPrompt           string `json:"retry_prompt" jsonschema:"fallback text used only when silent continuation is unsupported, from 1 to 500 characters"`
	MaxConsecutiveRetries int    `json:"max_consecutive_retries" jsonschema:"maximum retries without visible assistant progress, from 1 to 100"`
	MaxRecoveryAttempts   int    `json:"max_recovery_attempts" jsonschema:"maximum attempts in one fault recovery cycle, from 1 to 1000"`
	AuthMaxAttempts       *int   `json:"auth_max_attempts,omitempty" jsonschema:"additional ceiling for authentication errors, from 1 to 1000; omit to preserve the current value; both global limits still apply"`
	InitialDelaySeconds   int    `json:"initial_delay_seconds" jsonschema:"fixed delay or first increasing delay, from 1 to 3600 seconds"`
	MaxDelaySeconds       int    `json:"max_delay_seconds" jsonschema:"maximum increasing delay, from 1 to 86400 seconds"`
	DelayIncrementSeconds int    `json:"delay_increment_seconds" jsonschema:"seconds added after each linear retry, from 1 to 3600 seconds"`
	DelayStrategy         string `json:"delay_strategy" jsonschema:"fixed for a constant delay, exponential for doubling delays, or linear for a fixed increase each retry"`
	ShowNotifications     bool   `json:"show_notifications" jsonschema:"whether Windows retry notifications are enabled"`
	MemoryLimitMB         *int   `json:"memory_limit_mb,omitempty" jsonschema:"private memory limit for the watchdog process, from 128 to 65536 MB; omit to keep the current value"`
}

type setPausedInput struct {
	Paused bool `json:"paused" jsonschema:"true to pause new retry dispatches, false to resume them"`
}

type setSharedAppServerInput struct {
	Enabled bool `json:"enabled" jsonschema:"true only after the optional shared Codex app-server passes its ownership and health checks"`
}

type threadControlInput struct {
	ThreadID string `json:"thread_id" jsonschema:"Codex task identifier from the current retry queue"`
}

func runManagementMCP(dataDir string) error {
	service := newManagementService(dataDir)
	server := newManagementMCPServer(service)
	config, err := loadOrCreateConfig(filepath.Join(dataDir, "config.json"))
	if err != nil {
		config = defaultConfig()
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	memoryTriggered := make(chan memorySample, 1)
	guard := newProcessMemoryGuard(config.MemoryLimitMB, memoryCheckInterval, nil, nil, func(sample memorySample) {
		appendMemoryGuardLog(dataDir, "mcp", sample, config.MemoryLimitMB)
		select {
		case memoryTriggered <- sample:
		default:
		}
		cancel()
	})
	go guard.Run(ctx)
	err = server.Run(ctx, &mcp.StdioTransport{})
	select {
	case sample := <-memoryTriggered:
		showMemoryLimitAlert(sample, config.MemoryLimitMB)
	default:
	}
	if err != nil && !errors.Is(err, context.Canceled) {
		return err
	}
	return nil
}

func newManagementMCPServer(service *managementService) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{
		Name:    "codex-auto-retry",
		Title:   "Codex Auto Retry",
		Version: appVersion,
	}, nil)

	server.AddResource(&mcp.Resource{
		Meta:        managementResourceMeta(),
		URI:         managementResourceURI,
		Name:        "codex_auto_retry_panel",
		Title:       "Codex Auto Retry",
		Description: "Interactive local retry status and controls.",
		MIMEType:    managementResourceMIME,
	}, func(_ context.Context, _ *mcp.ReadResourceRequest) (*mcp.ReadResourceResult, error) {
		return &mcp.ReadResourceResult{Contents: []*mcp.ResourceContents{{
			URI:      managementResourceURI,
			MIMEType: managementResourceMIME,
			Text:     managementPanelHTML,
			Meta:     managementResourceMeta(),
		}}}, nil
	})

	mcp.AddTool(server, &mcp.Tool{
		Meta:        managementToolMeta(),
		Name:        "get_auto_retry_status",
		Title:       "عرض حالة الاستئناف التلقائي",
		Description: "عرض خدمة الاستئناف التلقائي في Codex والعد التنازلي وقائمة الانتظار والإعدادات الحالية.",
		Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true, OpenWorldHint: boolPointer(false), Title: "عرض حالة الاستئناف التلقائي"},
	}, func(_ context.Context, _ *mcp.CallToolRequest, _ emptyToolInput) (*mcp.CallToolResult, ManagementSnapshot, error) {
		snapshot, err := service.snapshot(time.Now().UTC())
		return nil, snapshot, err
	})

	mcp.AddTool(server, &mcp.Tool{
		Meta:        managementToolMeta(),
		Name:        "set_retry_prompt",
		Title:       "تعديل نص المتابعة الاحتياطي",
		Description: "تعديل النص الاحتياطي المستخدم عندما لا يكون الاستئناف الصامت مدعوماً؛ في الوضع الطبيعي لا تتم إضافة رسالة ظاهرة جديدة.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: boolPointer(false), IdempotentHint: true, OpenWorldHint: boolPointer(false), Title: "تعديل نص المتابعة"},
	}, func(_ context.Context, _ *mcp.CallToolRequest, input setRetryPromptInput) (*mcp.CallToolResult, ManagementSnapshot, error) {
		snapshot, err := service.setRetryPrompt(input.Prompt, time.Now().UTC())
		return nil, snapshot, err
	})

	mcp.AddTool(server, &mcp.Tool{
		Meta:        managementToolMeta(),
		Name:        "set_retry_settings",
		Title:       "تعديل إعدادات الاستئناف التلقائي",
		Description: "同时تعديل نص المتابعة الاحتياطي、连续无进展重试上限、单次故障恢复上限、固定、翻倍或线性等待策略，以及插件达到上限时的通知设置。",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: boolPointer(false), IdempotentHint: true, OpenWorldHint: boolPointer(false), Title: "تعديل إعدادات الاستئناف التلقائي"},
	}, func(_ context.Context, _ *mcp.CallToolRequest, input setRetrySettingsInput) (*mcp.CallToolResult, ManagementSnapshot, error) {
		settings := RetrySettings{
			RetryPrompt:           input.RetryPrompt,
			MaxConsecutiveRetries: input.MaxConsecutiveRetries,
			MaxRecoveryAttempts:   input.MaxRecoveryAttempts,
			AuthMaxAttempts:       input.AuthMaxAttempts,
			InitialDelaySeconds:   input.InitialDelaySeconds,
			MaxDelaySeconds:       input.MaxDelaySeconds,
			DelayIncrementSeconds: input.DelayIncrementSeconds,
			DelayStrategy:         input.DelayStrategy,
			ShowNotifications:     input.ShowNotifications,
		}
		if input.MemoryLimitMB != nil {
			settings.MemoryLimitMB = *input.MemoryLimitMB
		}
		snapshot, err := service.setRetrySettings(settings, time.Now().UTC())
		return nil, snapshot, err
	})

	mcp.AddTool(server, &mcp.Tool{
		Meta:        managementToolMeta(),
		Name:        "set_auto_retry_paused",
		Title:       "إيقاف الاستئناف التلقائي مؤقتاً أو تشغيله",
		Description: "إيقاف المحاولات الجديدة مؤقتاً أو استئنافها؛ لن يتم إنهاء مهام Codex التي بدأت بالفعل.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: boolPointer(false), IdempotentHint: true, OpenWorldHint: boolPointer(false), Title: "إيقاف الاستئناف التلقائي مؤقتاً أو تشغيله"},
	}, func(_ context.Context, _ *mcp.CallToolRequest, input setPausedInput) (*mcp.CallToolResult, ManagementSnapshot, error) {
		snapshot, err := service.setPaused(input.Paused, time.Now().UTC())
		return nil, snapshot, err
	})

	mcp.AddTool(server, &mcp.Tool{
		Meta:        managementToolMeta(),
		Name:        "set_shared_app_server_enabled",
		Title:       "تشغيل أو إيقاف خادم Codex المشترك",
		Description: "تشغيل أو إيقاف خادم Codex المشترك الاختياري. يتم التحقق من المنفذ واتصال WebSocket والملف التنفيذي وملكية العملية قبل التفعيل.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: boolPointer(false), IdempotentHint: true, OpenWorldHint: boolPointer(false), Title: "الخادم المشترك"},
	}, func(_ context.Context, _ *mcp.CallToolRequest, input setSharedAppServerInput) (*mcp.CallToolResult, ManagementSnapshot, error) {
		snapshot, err := service.setSharedAppServerEnabled(input.Enabled, time.Now().UTC())
		return nil, snapshot, err
	})

	mcp.AddTool(server, &mcp.Tool{
		Meta:        managementToolMeta(),
		Name:        "retry_now",
		Title:       "المحاولة الآن",
		Description: "محاولة استئناف مهمة Codex المحددة فوراً؛ إذا كانت الخدمة متوقفة مؤقتاً فستبقى المهمة معلقة حتى الاستئناف.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: boolPointer(false), OpenWorldHint: boolPointer(false), Title: "المحاولة الآن"},
	}, func(_ context.Context, _ *mcp.CallToolRequest, input threadControlInput) (*mcp.CallToolResult, ManagementSnapshot, error) {
		snapshot, err := service.retryNow(input.ThreadID, time.Now().UTC())
		return nil, snapshot, err
	})

	mcp.AddTool(server, &mcp.Tool{
		Meta:        managementToolMeta(),
		Name:        "cancel_retry",
		Title:       "إلغاء المحاولة المعلّقة",
		Description: "إلغاء محاولة لم تبدأ بعد؛ لن يتم إيقاف مهمة Codex بدأت بالفعل.",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: boolPointer(false), IdempotentHint: true, OpenWorldHint: boolPointer(false), Title: "إلغاء المحاولة المعلّقة"},
	}, func(_ context.Context, _ *mcp.CallToolRequest, input threadControlInput) (*mcp.CallToolResult, ManagementSnapshot, error) {
		snapshot, err := service.cancelRetry(input.ThreadID, time.Now().UTC())
		return nil, snapshot, err
	})

	mcp.AddTool(server, &mcp.Tool{
		Meta:        managementToolMeta(),
		Name:        "restart_retry",
		Title:       "إعادة تشغيل المحاولات",
		Description: "为已经达到任一重试上限的任务重新开始两个计数并المحاولة الآن。",
		Annotations: &mcp.ToolAnnotations{DestructiveHint: boolPointer(false), OpenWorldHint: boolPointer(false), Title: "إعادة تشغيل المحاولات"},
	}, func(_ context.Context, _ *mcp.CallToolRequest, input threadControlInput) (*mcp.CallToolResult, ManagementSnapshot, error) {
		snapshot, err := service.restartRetry(input.ThreadID, time.Now().UTC())
		return nil, snapshot, err
	})

	return server
}

func managementToolMeta() mcp.Meta {
	return mcp.Meta{
		"ui": map[string]any{
			"resourceUri": managementResourceURI,
			"visibility":  []string{"model", "app"},
		},
		"ui/resourceUri":          managementResourceURI,
		"openai/outputTemplate":   managementResourceURI,
		"openai/widgetAccessible": true,
	}
}

func managementResourceMeta() mcp.Meta {
	return mcp.Meta{
		"ui": map[string]any{
			"prefersBorder": true,
			"csp": map[string]any{
				"connectDomains":  []string{},
				"resourceDomains": []string{},
				"frameDomains":    []string{},
			},
		},
		"openai/widgetPrefersBorder": true,
		"openai/widgetCSP": map[string]any{
			"connect_domains":  []string{},
			"resource_domains": []string{},
		},
	}
}

func boolPointer(value bool) *bool {
	return &value
}
