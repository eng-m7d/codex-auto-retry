import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import {
  Activity,
  Clock,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  X,
  createIcons,
} from "lucide";
import "./panel.css";

type FailureClass =
  | "transient"
  | "rate_limit"
  | "usage_limit"
  | "server"
  | "auth_transient"
  | "auth_limited"
  | "empty_response"
  | "unknown"
  | "none";

type ManagedRetry = {
  thread_id: string;
  label: string;
  state: "pending" | "starting" | "running" | "stopped";
  class: FailureClass;
  due_at?: string;
  seconds_remaining: number;
  recovery_attempt: number;
  max_recovery_attempts?: number;
  consecutive_retry: number;
  max_consecutive_retries?: number;
  action?: string;
  can_retry_now: boolean;
  can_cancel: boolean;
  can_restart: boolean;
  stop_reason?: string;
};

type ManagementSnapshot = {
  version: string;
  running: boolean;
  heartbeat_stale: boolean;
  paused: boolean;
  shared_app_server_enabled: boolean;
  shared_app_server_requested?: boolean;
  desktop_transport?: "official_stdio" | "shared_websocket" | "stopped" | "unknown";
  recovery_mode?: "shared_websocket" | "safe_launcher_required" | "none";
  automatic_recovery_supported?: boolean;
  recovery_capability_reason?: string;
  startup_approved: "enabled" | "disabled" | "unknown";
  retry_prompt: string;
  max_recovery_attempts: number;
  auth_max_attempts?: number;
  max_consecutive_retries: number;
  initial_delay_seconds: number;
  max_delay_seconds: number;
  delay_increment_seconds: number;
  delay_strategy: "fixed" | "linear" | "exponential";
  show_notifications: boolean;
  memory_limit_mb: number;
  memory_usage_mb?: number;
  memory_guard_triggered?: boolean;
  shared_app_server_memory_usage_mb?: number;
  shared_app_server_memory_limit_mb?: number;
  shared_app_server_memory_guard_triggered?: boolean;
  retry_safety_warning?: string;
  shared_app_server_port: number;
  now: string;
  last_scan_at?: string;
  pending_retries: number;
  active_retries: number;
  stopped_retries: number;
  watched_roots: number;
  controller_state?: string;
  last_error?: string;
  notice?: string;
  retries: ManagedRetry[];
  usage?: CodexUsageSnapshot;
};

type UsageWindow = {
  used_percent: number;
  remaining_percent: number;
  window_minutes?: number;
  resets_at?: string;
};

type CodexUsageSnapshot = {
  available: boolean;
  source?: string;
  fetched_at?: string;
  error?: string;
  five_hour?: UsageWindow;
  weekly?: UsageWindow;
};

type ToolResult = {
  structuredContent?: unknown;
  isError?: boolean;
  content?: Array<{ type: string; text?: string }>;
};

const iconSet = { Activity, Clock, Play, RefreshCw, RotateCcw, Save, X };
const elements = {
  shell: required<HTMLElement>("app-shell"),
  serviceLine: required<HTMLElement>("service-line"),
  serviceStatus: required<HTMLElement>("service-status"),
  version: required<HTMLElement>("version"),
  refreshButton: required<HTMLButtonElement>("refresh-button"),
  notice: required<HTMLElement>("notice"),
  queueCount: required<HTMLElement>("queue-count"),
  usageStatus: required<HTMLElement>("usage-status"),
  usageFiveHourPercent: required<HTMLElement>("usage-five-hour-percent"),
  usageFiveHourRemaining: required<HTMLElement>("usage-five-hour-remaining"),
  usageFiveHourReset: required<HTMLElement>("usage-five-hour-reset"),
  usageFiveHourBar: required<HTMLElement>("usage-five-hour-bar"),
  usageWeeklyPercent: required<HTMLElement>("usage-weekly-percent"),
  usageWeeklyRemaining: required<HTMLElement>("usage-weekly-remaining"),
  usageWeeklyReset: required<HTMLElement>("usage-weekly-reset"),
  usageWeeklyBar: required<HTMLElement>("usage-weekly-bar"),
  nextRetry: required<HTMLElement>("next-retry"),
  queueSummary: required<HTMLElement>("queue-summary"),
  queueList: required<HTMLElement>("queue-list"),
  scanTime: required<HTMLElement>("scan-time"),
  pauseToggle: required<HTMLInputElement>("pause-toggle"),
  sharedAppServerToggle: required<HTMLInputElement>("shared-app-server-toggle"),
  sharedAppServerDescription: required<HTMLElement>("shared-app-server-description"),
  sharedAppServerPort: required<HTMLElement>("shared-app-server-port"),
  startupApprovalStatus: required<HTMLElement>("startup-approval-status"),
  pauseDescription: required<HTMLElement>("pause-description"),
  retryPrompt: required<HTMLTextAreaElement>("retry-prompt"),
  promptCount: required<HTMLElement>("prompt-count"),
  promptError: required<HTMLElement>("prompt-error"),
  savePrompt: required<HTMLButtonElement>("save-prompt"),
  maxRecoveryAttempts: required<HTMLInputElement>("max-recovery-attempts"),
  authMaxAttempts: required<HTMLInputElement>("auth-max-attempts"),
  maxConsecutiveRetries: required<HTMLInputElement>("max-consecutive-retries"),
  memoryLimit: required<HTMLInputElement>("memory-limit-mb"),
  delayStrategies: requiredAll<HTMLInputElement>('input[name="delay-strategy"]'),
  initialDelayLabel: required<HTMLElement>("initial-delay-label"),
  initialDelay: required<HTMLInputElement>("initial-delay"),
  maxDelay: required<HTMLInputElement>("max-delay"),
  delayIncrement: required<HTMLInputElement>("delay-increment"),
  delayPreview: required<HTMLElement>("delay-preview"),
  settingsError: required<HTMLElement>("settings-error"),
  notificationsToggle: required<HTMLInputElement>("notifications-toggle"),
  saveSettings: required<HTMLButtonElement>("save-settings"),
};

let app: App | null = null;
let snapshot: ManagementSnapshot | null = null;
let savedPrompt = "";
let savedSettings = "";
let busyCount = 0;
let noticeTimer = 0;
let statusPollInFlight = false;

const numberFormatter = new Intl.NumberFormat("ar-IQ", { maximumFractionDigits: 0 });
const dateTimeFormatter = new Intl.DateTimeFormat("ar-IQ", {
  weekday: "short",
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});
const timeFormatter = new Intl.DateTimeFormat("ar-IQ", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
});

function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
}

function requiredAll<T extends Element>(selector: string): T[] {
  const values = Array.from(document.querySelectorAll<T>(selector));
  if (values.length === 0) throw new Error(`Missing elements: ${selector}`);
  return values;
}

function refreshIcons(): void {
  createIcons({ icons: iconSet });
}

function handleHostContext(context: McpUiHostContext): void {
  if (context.theme) applyDocumentTheme(context.theme);
  if (context.styles?.variables) applyHostStyleVariables(context.styles.variables);
  if (context.styles?.css?.fonts) applyHostFonts(context.styles.css.fonts);
  if (context.safeAreaInsets) {
    const { top, right, bottom, left } = context.safeAreaInsets;
    elements.shell.style.paddingTop = `${Math.max(14, top)}px`;
    elements.shell.style.paddingRight = `${Math.max(14, right)}px`;
    elements.shell.style.paddingBottom = `${Math.max(14, bottom)}px`;
    elements.shell.style.paddingLeft = `${Math.max(14, left)}px`;
  }
}

function extractSnapshot(result: ToolResult): ManagementSnapshot | null {
  const value = result.structuredContent;
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<ManagementSnapshot>;
  if (!Array.isArray(candidate.retries) || typeof candidate.retry_prompt !== "string") return null;
  return candidate as ManagementSnapshot;
}

function render(next: ManagementSnapshot): void {
  const keepSettingsDraft = snapshot !== null && currentSettings() !== savedSettings;
  snapshot = next;
  savedPrompt = next.retry_prompt;
  elements.version.textContent = next.version ? `v${next.version}` : "";
  elements.retryPrompt.disabled = false;
  elements.pauseToggle.disabled = false;
  elements.sharedAppServerToggle.disabled = false;
  if (!keepSettingsDraft) {
    elements.retryPrompt.value = next.retry_prompt;
    elements.maxRecoveryAttempts.value = String(next.max_recovery_attempts);
    elements.authMaxAttempts.value = String(next.auth_max_attempts ?? 6);
    elements.maxConsecutiveRetries.value = String(next.max_consecutive_retries);
    elements.memoryLimit.value = String(next.memory_limit_mb);
    elements.initialDelay.value = String(next.initial_delay_seconds);
    elements.maxDelay.value = String(next.max_delay_seconds);
    elements.delayIncrement.value = String(next.delay_increment_seconds);
    for (const option of elements.delayStrategies) option.checked = option.value === next.delay_strategy;
    elements.notificationsToggle.checked = next.show_notifications;
  }
  savedSettings = serializedSettings(next);
  elements.pauseToggle.checked = !next.paused;
  elements.sharedAppServerToggle.checked = next.shared_app_server_requested ?? next.shared_app_server_enabled;
  elements.sharedAppServerDescription.textContent = next.shared_app_server_enabled
    ? `يُستخدم الخادم المشترك الذي يملكه الملحق وتم التحقق من سلامته（المنفذ ${next.shared_app_server_port}）`
    : next.shared_app_server_requested ? "الخادم المشترك غير متاح مؤقتاً؛ تم الاحتفاظ بخيار التفعيل وستتم محاولة استعادته عند التشغيل الآمن" : "متوقف افتراضياً ولا يؤثر في خادم Codex الرسمي";
  elements.sharedAppServerPort.textContent = next.shared_app_server_port > 0 ? `المنفذ ${next.shared_app_server_port}` : "";
  const startupApprovalLabels: Record<ManagementSnapshot["startup_approved"], string> = {
    enabled: "التشغيل مع تسجيل الدخول إلى Windows: مفعّل",
    disabled: "التشغيل مع تسجيل الدخول إلى Windows: معطّل",
    unknown: "التشغيل مع تسجيل الدخول إلى Windows: الحالة غير معروفة",
  };
  elements.startupApprovalStatus.textContent = startupApprovalLabels[next.startup_approved] ?? startupApprovalLabels.unknown;
  elements.startupApprovalStatus.dataset.state = next.startup_approved;
  updatePromptState();
  renderService(next);
  renderMetrics(next);
  renderUsage(next);
  renderQueue(next);
  renderScanTime(next);
  if (next.notice) showNotice(next.notice, false);
  refreshIcons();
}

function renderService(next: ManagementSnapshot): void {
  const dot = document.createElement("span");
  dot.className = "status-dot";
  let label = "متوقف";
  let detail = "لم يتم اكتشاف نبضة تشغيل حديثة";
  if (next.controller_state === "memory_limit_exceeded") {
    label = "أوقفت حماية الذاكرة الخدمة";
    detail = `استهلاك ذاكرة الخلفية ${next.memory_usage_mb ?? 0} MB وتجاوز الحد ${next.memory_limit_mb} MB`;
    dot.classList.add("status-dot-danger");
  } else if (next.running && next.controller_state === "codex_restart_required") {
    label = "Codex غير متصل بالخادم المشترك";
    detail = "الخادم المشترك يعمل، لكن Codex الحالي ما زال يستخدم الخادم الرسمي؛ أعد فتحه عبر التشغيل الآمن";
    dot.classList.add("status-dot-warning");
  } else if (next.running && next.controller_state === "official_ipc_ready") {
    label = "Codex متصل بقناة الاستئناف الرسمية";
    detail = "يستخدم Codex قناة IPC الرسمية، وتُرسل طلبات الاستئناف إلى مالك المهمة الحالية";
    dot.classList.add("status-dot-positive");
  } else if (next.running && next.controller_state === "codex_not_running") {
    label = "Codex مغلق";
    detail = "توقفت محاولات الاستئناف لهذه المهام؛ بعد تشغيل Codex يمكن إعادة تشغيلها يدوياً";
    dot.classList.add("status-dot-danger");
  } else if (next.running && next.controller_state === "shared_app_server_disabled") {
    label = next.shared_app_server_requested ? "الخادم المشترك غير متاح مؤقتاً" : "الخادم المشترك متوقف";
    detail = "يواصل Codex استخدام الخادم الرسمي؛ الاستئناف الصامت يحتاج إلى تفعيل الخادم المشترك";
    dot.classList.add("status-dot-warning");
  } else if (next.running && next.controller_state === "shared_app_server_port_reserved") {
    label = "المنفذ محجوز من Windows";
    detail = "لم يبدأ الخادم المشترك وتوقفت المحاولات التلقائية؛ غيّر المنفذ ثم أعد التفعيل";
    dot.classList.add("status-dot-danger");
  } else if (next.running && next.controller_state === "shared_app_server_port_conflict") {
    label = "جارٍ نقل منفذ الخادم المشترك";
    detail = `المنفذ المفضل غير متاح؛ سيتم اختيار منفذ محلي آمن عند تفعيل الخادم المشترك（当前配置 ${next.shared_app_server_port}）`;
    dot.classList.add("status-dot-danger");
  } else if (next.running && next.controller_state === "shared_app_server_migration_deferred") {
    label = "بانتظار إغلاق Codex";
    detail = "تم تأجيل تنظيف أو نقل الخادم المشترك لتجنب قطع جلسة Codex الحالية";
    dot.classList.add("status-dot-warning");
  } else if (next.running && next.controller_state === "shared_app_server_environment_conflict") {
    label = "تعارض في بيئة الخادم المشترك";
    detail = "المتغير CODEX_APP_SERVER_WS_URL يشير إلى عنوان آخر؛ لم يغيّره الملحق. أزل القيمة المتعارضة ثم أعد التفعيل";
    dot.classList.add("status-dot-danger");
  } else if (next.running && next.controller_state === "shared_app_server_ownership_unknown") {
    label = "ملكية الخادم المشترك غير مؤكدة";
    detail = "تعذر التحقق من ملكية عملية الخلفية، لذلك توقف التنظيف التلقائي؛ أغلق Codex وتحقق منها قبل إعادة التفعيل";
    dot.classList.add("status-dot-danger");
  } else if (next.running && next.controller_state === "shared_app_server_config_invalid") {
    label = "إعداد الخادم المشترك غير متوافق";
    detail = "تم الرجوع تلقائياً إلى خادم Codex الرسمي لمنع الإعداد غير المتوافق من التأثير في الجلسة";
    dot.classList.add("status-dot-danger");
  } else if (next.running && next.controller_state === "shared_app_server_memory_limit_exceeded") {
    label = "حماية ذاكرة الخادم المشترك";
    detail = `توقف الخادم المشترك عن التحكم（${next.shared_app_server_memory_usage_mb ?? 0} MB/${next.shared_app_server_memory_limit_mb ?? 0} MB） من دون إجبار Codex على الإغلاق`;
    dot.classList.add("status-dot-warning");
  } else if (next.running && next.controller_state && !["ready", "starting", "official_ipc_ready"].includes(next.controller_state)) {
    label = "خلل في قناة الاستئناف";
    detail = `توقفت المحاولات التلقائية لتجنب التكرار غير المفيد: ${controllerStateLabel(next.controller_state)}`;
    dot.classList.add("status-dot-danger");
  } else if (next.running && next.paused) {
    label = "متوقف مؤقتاً";
    detail = "المراقبة مستمرة، لكن لن تبدأ محاولات جديدة حالياً";
    dot.classList.add("status-dot-warning");
  } else if (next.running) {
    label = "يعمل";
    detail = `تتم مراقبة ${next.watched_roots} مواقع للجلسات`;
    dot.classList.add("status-dot-positive");
  } else {
    dot.classList.add("status-dot-danger");
  }
  elements.serviceStatus.replaceChildren(dot, document.createTextNode(label));
  elements.serviceLine.textContent = detail;
  if (next.running && next.automatic_recovery_supported === false && next.recovery_capability_reason === "official_stdio_not_externally_controllable") {
    elements.serviceLine.textContent = `${detail}؛ الوضع الحالي للمراقبة فقط ولم يُرسل طلب استئناف تلقائي`;
  }
  if (next.memory_guard_triggered) {
    elements.serviceLine.textContent = `${detail}؛ تم تشغيل حماية الذاكرة（${next.memory_usage_mb ?? 0} MB/${next.memory_limit_mb} MB）`;
  }
  if (next.shared_app_server_memory_guard_triggered) {
    elements.serviceLine.textContent = `${elements.serviceLine.textContent}؛ تم تشغيل حماية ذاكرة الخادم المشترك（${next.shared_app_server_memory_usage_mb ?? 0} MB/${next.shared_app_server_memory_limit_mb ?? 0} MB） من دون إجبار Codex على الإغلاق`;
  }
  if (next.retry_safety_warning) {
    elements.serviceLine.textContent = `${elements.serviceLine.textContent}；${next.retry_safety_warning}`;
  }
  elements.pauseDescription.textContent = next.paused ? "المحاولات الجديدة متوقفة مؤقتاً" : "يعمل";
}

function renderMetrics(next: ManagementSnapshot): void {
  const total = next.pending_retries + next.active_retries + next.stopped_retries;
  elements.queueCount.textContent = String(total);
  const pending = next.retries
    .filter((retry) => retry.state === "pending" && retry.due_at)
    .sort((a, b) => Date.parse(a.due_at ?? "") - Date.parse(b.due_at ?? ""));
  if (next.paused && pending.length > 0) {
    elements.nextRetry.textContent = "بانتظار الاستئناف";
  } else if (pending.length > 0) {
    elements.nextRetry.dataset.dueAt = pending[0].due_at ?? "";
    updateCountdownElement(elements.nextRetry);
  } else if (next.active_retries > 0) {
    elements.nextRetry.textContent = "جارٍ الاستئناف";
    delete elements.nextRetry.dataset.dueAt;
  } else {
    elements.nextRetry.textContent = "--";
    delete elements.nextRetry.dataset.dueAt;
  }
  if (total === 0) {
    elements.queueSummary.textContent = "لا توجد مهام بانتظار الاستئناف حالياً";
  } else {
    elements.queueSummary.textContent = `${next.pending_retries} بانتظار التنفيذ، و${next.active_retries} قيد التنفيذ، و${next.stopped_retries} متوقفة`;
  }
}

function renderUsage(next: ManagementSnapshot): void {
  const usage = next.usage;
  if (!usage?.available) {
    elements.usageStatus.textContent = usage?.error ? "تعذر قراءة بيانات الاستخدام" : "بانتظار بيانات الاستخدام";
    renderUsageWindow(undefined, elements.usageFiveHourPercent, elements.usageFiveHourRemaining, elements.usageFiveHourReset, elements.usageFiveHourBar);
    renderUsageWindow(undefined, elements.usageWeeklyPercent, elements.usageWeeklyRemaining, elements.usageWeeklyReset, elements.usageWeeklyBar);
    return;
  }
  elements.usageStatus.textContent = usage.fetched_at
    ? `آخر تحديث: ${timeFormatter.format(new Date(usage.fetched_at))}`
    : "محدّث الآن";
  renderUsageWindow(usage.five_hour, elements.usageFiveHourPercent, elements.usageFiveHourRemaining, elements.usageFiveHourReset, elements.usageFiveHourBar);
  renderUsageWindow(usage.weekly, elements.usageWeeklyPercent, elements.usageWeeklyRemaining, elements.usageWeeklyReset, elements.usageWeeklyBar);
}

function renderUsageWindow(
  value: UsageWindow | undefined,
  percentElement: HTMLElement,
  remainingElement: HTMLElement,
  resetElement: HTMLElement,
  barElement: HTMLElement,
): void {
  const progress = barElement.parentElement;
  if (!value) {
    percentElement.textContent = "--";
    remainingElement.textContent = "المتبقي --";
    resetElement.textContent = "--";
    barElement.style.width = "0%";
    progress?.setAttribute("aria-valuenow", "0");
    delete progress?.dataset.level;
    return;
  }

  const used = Math.min(100, Math.max(0, value.used_percent));
  const remaining = Math.min(100, Math.max(0, value.remaining_percent));
  percentElement.textContent = `${numberFormatter.format(used)}٪`;
  remainingElement.textContent = `المتبقي ${numberFormatter.format(remaining)}٪`;
  barElement.style.width = `${used}%`;
  progress?.setAttribute("aria-valuenow", String(Math.round(used)));
  if (progress) {
    progress.dataset.level = used >= 90 ? "danger" : used >= 70 ? "warning" : "normal";
  }
  resetElement.textContent = value.resets_at
    ? dateTimeFormatter.format(new Date(value.resets_at))
    : "--";
}

function renderQueue(next: ManagementSnapshot): void {
  elements.queueList.replaceChildren();
  if (next.retries.length === 0) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.append(icon("activity"), document.createTextNode("قائمة الانتظار فارغة"));
    elements.queueList.append(empty);
    return;
  }
  for (const retry of next.retries) {
    elements.queueList.append(createQueueItem(retry, next.paused));
  }
}

function createQueueItem(retry: ManagedRetry, paused: boolean): HTMLElement {
  const row = document.createElement("article");
  row.className = "queue-item";
  row.dataset.threadId = retry.thread_id;

  const main = document.createElement("div");
  main.className = "queue-main";
  const queueIcon = document.createElement("span");
  queueIcon.className = `queue-icon${retry.state === "pending" ? "" : retry.state === "stopped" ? " stopped" : " active"}`;
  queueIcon.append(icon(retry.state === "pending" ? "clock" : retry.state === "stopped" ? "x" : "refresh-cw"));
  const copy = document.createElement("div");
  copy.className = "queue-copy";
  const title = document.createElement("div");
  title.className = "queue-title";
  title.textContent = retry.label;
  title.title = retry.thread_id;
  const meta = document.createElement("div");
  meta.className = "queue-meta";
  const recovery = retry.max_recovery_attempts
    ? `محاولات التعافي من العطل ${retry.recovery_attempt}/${retry.max_recovery_attempts}`
    : `محاولات التعافي من العطل ${retry.recovery_attempt}`;
  const consecutive = retry.max_consecutive_retries
    ? `محاولات متتالية دون تقدّم ${retry.consecutive_retry}/${retry.max_consecutive_retries}`
    : `محاولات متتالية دون تقدّم ${retry.consecutive_retry}`;
  const stateLabel = retry.state === "pending"
    ? "بانتظار التنفيذ"
    : retry.state === "stopped"
      ? stoppedStateLabel(retry)
      : actionLabel(retry.action);
  meta.append(
    textSpan(classLabel(retry.class)),
    textSpan(recovery),
    textSpan(consecutive),
    textSpan(stateLabel),
  );
  copy.append(title, meta);
  main.append(queueIcon, copy);

  const state = document.createElement("div");
  state.className = "queue-state";
  const primary = document.createElement("strong");
  const secondary = document.createElement("span");
  if (retry.state === "pending" && retry.due_at) {
    primary.dataset.dueAt = retry.due_at;
    updateCountdownElement(primary);
    secondary.textContent = paused ? "ستُنفذ بعد استئناف الخدمة" : "حتى المحاولة التالية";
  } else if (retry.state === "stopped") {
    primary.textContent = "متوقفة";
    secondary.textContent = stopReasonLabel(retry);
  } else {
    primary.textContent = retry.state === "running" ? "قيد التنفيذ" : "جارٍ البدء";
    secondary.textContent = actionLabel(retry.action);
  }
  state.append(primary, secondary);

  const actions = document.createElement("div");
  actions.className = "queue-actions";
  if (retry.can_retry_now) {
    actions.append(actionButton("play", "حاول الآن", "retry-action", () => runThreadAction("retry_now", retry.thread_id)));
  }
  if (retry.can_cancel) {
    actions.append(actionButton("x", "إلغاء هذه المحاولة", "cancel-action", () => runThreadAction("cancel_retry", retry.thread_id)));
  }
  if (retry.can_restart) {
    actions.append(actionButton("rotate-ccw", "إعادة ضبط العداد والمحاولة", "retry-action", () => runThreadAction("restart_retry", retry.thread_id)));
  }
  row.append(main, state, actions);
  return row;
}

function actionButton(iconName: string, label: string, className: string, action: () => void): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `queue-action ${className}`;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.append(icon(iconName));
  button.addEventListener("click", action);
  return button;
}

function icon(name: string): HTMLElement {
  const element = document.createElement("i");
  element.dataset.lucide = name;
  element.setAttribute("aria-hidden", "true");
  return element;
}

function textSpan(value: string): HTMLElement {
  const span = document.createElement("span");
  span.textContent = value;
  return span;
}

function renderScanTime(next: ManagementSnapshot): void {
  if (!next.last_scan_at) {
    elements.scanTime.textContent = "";
    return;
  }
  const date = new Date(next.last_scan_at);
  elements.scanTime.textContent = `آخر فحص: ${timeFormatter.format(date)}`;
}

function updateCountdowns(): void {
  document.querySelectorAll<HTMLElement>("[data-due-at]").forEach(updateCountdownElement);
}

function updateCountdownElement(element: HTMLElement): void {
  const dueAt = Date.parse(element.dataset.dueAt ?? "");
  if (!Number.isFinite(dueAt)) {
    element.textContent = "--";
    return;
  }
  element.textContent = formatDuration(Math.max(0, Math.ceil((dueAt - Date.now()) / 1000)));
}

function formatDuration(totalSeconds: number): string {
  if (totalSeconds < 60) return `${numberFormatter.format(totalSeconds)} ث`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return `${numberFormatter.format(minutes)} د ${numberFormatter.format(seconds)} ث`;
  }
  const hours = Math.floor(minutes / 60);
  return `${numberFormatter.format(hours)} س ${numberFormatter.format(minutes % 60)} د`;
}

function classLabel(value: FailureClass): string {
  const labels: Record<FailureClass, string> = {
    transient: "انقطاع في الاتصال",
    rate_limit: "تقييد مؤقت للطلبات",
    usage_limit: "تم بلوغ حد استخدام Codex",
    server: "عطل لدى مزود الخدمة",
    auth_transient: "خدمة تسجيل الدخول غير متاحة مؤقتاً",
    auth_limited: "خطأ في تسجيل الدخول",
    empty_response: "استجابة فارغة من النموذج",
    unknown: "عطل غير معروف",
    none: "غير مصنّف",
  };
  return labels[value] ?? "عطل غير معروف";
}

function actionLabel(value?: string): string {
  const labels: Record<string, string> = {
    dispatching: "جارٍ تجهيز الاستئناف",
    goal_resume: "استئناف الهدف",
    goal_active: "الهدف قيد التشغيل",
    conversation_continue: "متابعة المحادثة",
    subagent_continue: "استئناف الوكيل الفرعي",
    goal_block: "إيقاف الهدف",
  };
  return value ? (labels[value] ?? "جارٍ المعالجة") : "جارٍ المعالجة";
}

function stopReasonLabel(retry: ManagedRetry): string {
  if (retry.stop_reason === "auth_attempt_limit") {
    return "تم بلوغ حد محاولات أخطاء تسجيل الدخول";
  }
  if (retry.stop_reason === "codex_not_running") {
    return "Codex مغلق؛ توقفت المحاولات التلقائية";
  }
  if (retry.stop_reason === "shared_app_server_disabled") {
    return "الخادم المشترك متوقف وCodex يستخدم الخادم الرسمي";
  }
  if (retry.stop_reason === "codex_restart_required") {
    return "أعد فتح Codex عبر التشغيل الآمن للاتصال بالخادم المشترك";
  }
  if (retry.stop_reason === "codex_home_not_shared") {
    return "هذه المهمة ليست ضمن مجلد الجلسات المشترك الحالي في Codex";
  }
  if (retry.stop_reason === "shared_app_server_port_conflict") {
    return "منفذ الاستئناف المفضل غير متاح؛ بانتظار النقل الآمن";
  }
  if (retry.stop_reason === "shared_app_server_port_reserved") {
    return "منفذ الاستئناف الخلفي محجوز من Windows";
  }
  if (retry.stop_reason === "shared_app_server_environment_conflict") {
    return "متغير بيئة الخادم المشترك مستخدم بقيمة أخرى";
  }
  if (retry.stop_reason === "shared_app_server_ownership_unknown") {
    return "تعذر تأكيد ملكية الخادم المشترك ويحتاج إلى تحقق يدوي";
  }
  if (retry.stop_reason === "shared_app_server_config_invalid") {
    return "إعداد الخادم المشترك غير متوافق مع Codex الحالي؛ تم الرجوع إلى الخادم الرسمي";
  }
  if (retry.stop_reason === "shared_app_server_migration_deferred") {
    return "بانتظار إغلاق Codex لإكمال نقل الخادم الخلفي";
  }
  if (retry.stop_reason?.startsWith("controller_") || retry.stop_reason?.startsWith("codex_background_") || retry.stop_reason === "app_server_request_failed") {
    return "فشلت قناة الاستئناف عدة مرات؛ تم إيقاف التكرار غير المفيد";
  }
  if (retry.stop_reason === "goal_empty_response_limit_block_failed") {
    return `بلغ الهدف حد الاستجابات الفارغة؛ توقف الاستئناف وتم وضع الهدف في حالة محظورة`;
  }
  if (retry.stop_reason === "goal_empty_response_limit") {
    return `بلغ الهدف حد الاستجابات الفارغة؛ توقف استئناف الهدف`;
  }
  if (retry.stop_reason === "consecutive_retry_limit") {
    return `دون تقدّم ${retry.consecutive_retry}/${retry.max_consecutive_retries ?? retry.consecutive_retry} بلغ الحد`;
  }
  if (retry.stop_reason === "recovery_time_limit") {
    return "بلغ الاستئناف التلقائي حد التشغيل البالغ 30 دقيقة";
  }
  return `التعافي الحالي ${retry.recovery_attempt}/${retry.max_recovery_attempts ?? retry.recovery_attempt} بلغ الحد`;
}

function stoppedStateLabel(retry: ManagedRetry): string {
  switch (retry.stop_reason) {
    case "auth_attempt_limit":
      return "حد أخطاء تسجيل الدخول";
    case "shared_app_server_disabled":
      return "الخادم المشترك متوقف";
    case "codex_not_running":
      return "Codex مغلق";
    case "codex_restart_required":
      return "بانتظار تشغيل Codex بالطريقة الآمنة";
    case "codex_ipc_goal_control_unsupported":
      return "قناة IPC الرسمية لا تدعم إيقاف الهدف حالياً";
    case "subagent_recovery_event_unavailable":
      return "حدث استئناف الوكيل الفرعي غير متاح";
    case "subagent_parent_owner_unavailable":
      return "مالك المهمة الأب غير متاح";
    case "subagent_parent_recovery_failed":
      return "فشل إرسال حدث استئناف المهمة الأب";
    case "codex_home_not_shared":
      return "مجلد المهمة غير متصل";
    case "shared_app_server_port_conflict":
      return "تعارض في منفذ الاستئناف";
    case "shared_app_server_port_reserved":
      return "المنفذ محجوز من Windows";
    case "shared_app_server_environment_conflict":
      return "تعارض في بيئة الخادم المشترك";
    case "shared_app_server_ownership_unknown":
      return "ملكية الخادم المشترك غير مؤكدة";
    case "shared_app_server_migration_deferred":
      return "بانتظار إغلاق Codex";
    default:
      return "تم بلوغ الحد";
  }
}

function controllerStateLabel(value: string): string {
  const labels: Record<string, string> = {
    codex_restart_required: "يلزم تشغيل Codex بالطريقة الآمنة",
    official_ipc_ready: "تم الاتصال بقناة IPC الرسمية في Codex",
    codex_ipc_goal_control_unsupported: "قناة IPC الرسمية لا تدعم إيقاف الهدف حالياً؛ توقف الاستئناف",
    subagent_recovery_event_unavailable: "تعذر التحقق من حدث استئناف الوكيل الفرعي",
    subagent_parent_owner_unavailable: "تعذر تحديد مالك المهمة الأب",
    subagent_parent_recovery_failed: "فشل إرسال حدث استئناف المهمة الأب",
    codex_not_running: "Codex مغلق؛ توقفت المحاولات التلقائية",
    shared_app_server_disabled: "الخادم المشترك متوقف وCodex يستخدم الخادم الرسمي",
    codex_home_not_shared: "مجلد المهمة غير متصل بالقناة المشتركة",
    shared_app_server_port_conflict: "المنفذ المشترك مستخدم",
    shared_app_server_port_reserved: "المنفذ المشترك محجوز من Windows",
    shared_app_server_environment_conflict: "المتغير CODEX_APP_SERVER_WS_URL مستخدم بقيمة أخرى",
    shared_app_server_ownership_unknown: "تعذر تأكيد ملكية الخادم المشترك ويحتاج إلى تحقق يدوي",
    shared_app_server_migration_deferred: "بانتظار إغلاق Codex لإكمال نقل الخادم الخلفي",
    shared_app_server_config_invalid: "إعداد الخادم المشترك غير متوافق مع Codex الحالي؛ تم الرجوع إلى الخادم الرسمي",
    codex_background_channel_unavailable: "القناة المشتركة غير متاحة",
    codex_background_dispatch_failed: "فشل طلب الاستئناف",
    controller_timeout: "انتهت مهلة طلب الاستئناف",
    controller_unavailable: "وحدة التحكم غير متاحة",
  };
  return labels[value] ?? value;
}

function updatePromptState(): void {
  const value = elements.retryPrompt.value;
  const count = Array.from(value).length;
  elements.promptCount.textContent = String(count);
  let error = "";
  if (!value.trim()) error = "نص المتابعة الاحتياطي لا يمكن أن يكون فارغاً";
  else if (count > 500) error = "الحد الأقصى 500 حرف";
  elements.promptError.textContent = error;
  elements.savePrompt.disabled = Boolean(error) || value === savedPrompt || busyCount > 0;
  const strategy = selectedDelayStrategy();
  const initialDelay = Number(elements.initialDelay.value);
  const maxDelay = Number(elements.maxDelay.value);
  const delayIncrement = Number(elements.delayIncrement.value);
  const recoveryAttempts = Number(elements.maxRecoveryAttempts.value);
  const authAttempts = Number(elements.authMaxAttempts.value);
  const consecutiveRetries = Number(elements.maxConsecutiveRetries.value);
  const memoryLimit = Number(elements.memoryLimit.value);
  let settingsError = "";
  if (!Number.isInteger(recoveryAttempts) || recoveryAttempts < 1 || recoveryAttempts > 1000) {
    settingsError = "حد محاولات التعافي من العطل يجب أن يكون بين 1 و1000";
  } else if (!Number.isInteger(authAttempts) || authAttempts < 1 || authAttempts > 1000) {
    settingsError = "حد محاولات أخطاء تسجيل الدخول يجب أن يكون بين 1 و1000";
  } else if (!Number.isInteger(consecutiveRetries) || consecutiveRetries < 1 || consecutiveRetries > 100) {
    settingsError = "حد المحاولات المتتالية دون تقدّم يجب أن يكون بين 1 و100";
  } else if (!Number.isInteger(memoryLimit) || memoryLimit < 128 || memoryLimit > 65536) {
    settingsError = "حد الذاكرة يجب أن يكون بين 128 و65536 MB";
  } else if ((strategy !== "fixed" && strategy !== "linear" && strategy !== "exponential")
    || !Number.isInteger(initialDelay) || initialDelay < 1 || initialDelay > 3600
    || !Number.isInteger(maxDelay) || maxDelay < 1 || maxDelay > 86400
    || !Number.isInteger(delayIncrement) || delayIncrement < 1 || delayIncrement > 3600) {
    settingsError = "إعداد مدة الانتظار خارج النطاق المسموح";
  } else if (strategy !== "fixed" && maxDelay < initialDelay) {
    settingsError = "عند استخدام انتظار متزايد يجب ألا تكون المدة القصوى أقل من المدة الأولية";
  }
  elements.maxDelay.disabled = strategy === "fixed";
  elements.delayIncrement.disabled = strategy !== "linear";
  elements.initialDelayLabel.textContent = strategy === "fixed" ? "الفاصل الثابت (ثانية)" : "الانتظار الأولي (ثانية)";
  elements.settingsError.textContent = settingsError;
  updateDelayPreview(strategy, initialDelay, maxDelay, delayIncrement, consecutiveRetries);
  elements.saveSettings.disabled = Boolean(error) || Boolean(settingsError)
    || currentSettings() === savedSettings || busyCount > 0;
}

function currentSettings(): string {
  return JSON.stringify({
    retry_prompt: elements.retryPrompt.value,
    max_recovery_attempts: Number(elements.maxRecoveryAttempts.value),
    auth_max_attempts: Number(elements.authMaxAttempts.value),
    max_consecutive_retries: Number(elements.maxConsecutiveRetries.value),
    memory_limit_mb: Number(elements.memoryLimit.value),
    initial_delay_seconds: Number(elements.initialDelay.value),
    max_delay_seconds: Number(elements.maxDelay.value),
    delay_increment_seconds: Number(elements.delayIncrement.value),
    delay_strategy: selectedDelayStrategy(),
    show_notifications: elements.notificationsToggle.checked,
  });
}

function serializedSettings(value: ManagementSnapshot): string {
  return JSON.stringify({
    retry_prompt: value.retry_prompt,
    max_recovery_attempts: value.max_recovery_attempts,
    auth_max_attempts: value.auth_max_attempts ?? 6,
    max_consecutive_retries: value.max_consecutive_retries,
    memory_limit_mb: value.memory_limit_mb,
    initial_delay_seconds: value.initial_delay_seconds,
    max_delay_seconds: value.max_delay_seconds,
    delay_increment_seconds: value.delay_increment_seconds,
    delay_strategy: value.delay_strategy,
    show_notifications: value.show_notifications,
  });
}

function selectedDelayStrategy(): "fixed" | "linear" | "exponential" {
  const selected = elements.delayStrategies.find((option) => option.checked)?.value;
  if (selected === "fixed" || selected === "linear") return selected;
  return "exponential";
}

function updateDelayPreview(
  strategy: "fixed" | "linear" | "exponential",
  initialDelay: number,
  maxDelay: number,
  delayIncrement: number,
  consecutiveRetries: number,
): void {
  if (!Number.isInteger(initialDelay) || initialDelay < 1 || !Number.isInteger(maxDelay) || maxDelay < 1
    || !Number.isInteger(delayIncrement) || delayIncrement < 1
    || !Number.isInteger(consecutiveRetries) || consecutiveRetries < 1) {
    elements.delayPreview.textContent = "";
    return;
  }
  const visibleCount = Math.min(consecutiveRetries, 8);
  const delays: number[] = [];
  let delay = initialDelay;
  for (let index = 0; index < visibleCount; index += 1) {
    delays.push(strategy === "fixed" ? initialDelay : Math.min(delay, maxDelay));
    if (strategy === "exponential") delay = Math.min(delay * 2, maxDelay);
    if (strategy === "linear") delay = Math.min(delay + delayIncrement, maxDelay);
  }
  const suffix = consecutiveRetries > visibleCount ? "，…" : "";
  elements.delayPreview.textContent = `تسلسل الانتظار: ${delays.map(formatPreviewDelay).join("，")}${suffix}`;
}

function formatPreviewDelay(seconds: number): string {
  if (seconds < 60) return `${seconds} ث`;
  if (seconds % 3600 === 0) return `${seconds / 3600} ساعة`;
  if (seconds % 60 === 0) return `${seconds / 60} دقيقة`;
  return `${seconds} ث`;
}

function setBusy(active: boolean): void {
  busyCount = Math.max(0, busyCount + (active ? 1 : -1));
  const busy = busyCount > 0;
  elements.refreshButton.disabled = busy;
  elements.refreshButton.classList.toggle("is-spinning", busy);
  elements.pauseToggle.disabled = busy || !snapshot;
  elements.sharedAppServerToggle.disabled = busy || !snapshot;
  document.querySelectorAll<HTMLButtonElement>(".queue-action").forEach((button) => {
    button.disabled = busy;
  });
  updatePromptState();
}

async function callTool(name: string, args: Record<string, unknown> = {}, quiet = false): Promise<void> {
  if (!app) {
    showNotice("لوحة الإدارة غير متصلة بعد", true);
    return;
  }
  if (quiet) {
    if (statusPollInFlight) return;
    statusPollInFlight = true;
  } else {
    setBusy(true);
  }
  try {
    const result = (await app.callServerTool({ name, arguments: args })) as ToolResult;
    const next = extractSnapshot(result);
    if (next) render(next);
    else if (result.isError) throw new Error(result.content?.find((item) => item.text)?.text ?? "فشلت العملية");
  } catch (error) {
    if (name === "set_shared_app_server_enabled") {
      // A failed health check may still have persisted the user's preference.
      try {
        const latest = extractSnapshot((await app.callServerTool({ name: "get_auto_retry_status", arguments: {} })) as ToolResult);
        if (latest) render(latest);
      } catch { /* Retain the last known status when the status read also fails. */ }
    }
    if (name === "set_shared_app_server_enabled" && snapshot) {
      elements.sharedAppServerToggle.checked = snapshot.shared_app_server_requested ?? snapshot.shared_app_server_enabled;
    }
    if (!quiet) showNotice(error instanceof Error ? error.message : "فشلت العملية", true);
  } finally {
    if (quiet) {
      statusPollInFlight = false;
    } else {
      setBusy(false);
    }
  }
}

async function runThreadAction(name: "retry_now" | "cancel_retry" | "restart_retry", threadId: string): Promise<void> {
  await callTool(name, { thread_id: threadId });
  window.setTimeout(() => void callTool("get_auto_retry_status"), 1200);
}

function showNotice(message: string, isError: boolean): void {
  window.clearTimeout(noticeTimer);
  elements.notice.textContent = message;
  elements.notice.classList.toggle("is-error", isError);
  elements.notice.hidden = false;
  noticeTimer = window.setTimeout(() => {
    elements.notice.hidden = true;
  }, isError ? 7000 : 4200);
}

elements.refreshButton.addEventListener("click", () => void callTool("get_auto_retry_status"));
elements.pauseToggle.addEventListener("change", () => void callTool("set_auto_retry_paused", { paused: !elements.pauseToggle.checked }));
  elements.sharedAppServerToggle.addEventListener("change", () => {
  const enabled = elements.sharedAppServerToggle.checked;
  elements.sharedAppServerDescription.textContent = enabled
    ? `يُستخدم الخادم المشترك الذي يملكه الملحق وتم التحقق من سلامته（المنفذ ${snapshot?.shared_app_server_port ?? ""}）`
    : "متوقف افتراضياً ولا يؤثر في خادم Codex الرسمي";
  void callTool("set_shared_app_server_enabled", { enabled });
});
elements.retryPrompt.addEventListener("input", updatePromptState);
elements.maxRecoveryAttempts.addEventListener("input", updatePromptState);
elements.authMaxAttempts.addEventListener("input", updatePromptState);
elements.maxConsecutiveRetries.addEventListener("input", updatePromptState);
elements.memoryLimit.addEventListener("input", updatePromptState);
for (const option of elements.delayStrategies) option.addEventListener("change", updatePromptState);
elements.initialDelay.addEventListener("input", updatePromptState);
elements.maxDelay.addEventListener("input", updatePromptState);
elements.delayIncrement.addEventListener("input", updatePromptState);
elements.notificationsToggle.addEventListener("change", updatePromptState);
elements.savePrompt.addEventListener("click", () => void callTool("set_retry_prompt", { prompt: elements.retryPrompt.value }));
elements.saveSettings.addEventListener("click", () => void callTool("set_retry_settings", JSON.parse(currentSettings()) as Record<string, unknown>));

refreshIcons();
window.setInterval(updateCountdowns, 1000);
window.setInterval(() => {
  if (app && busyCount === 0) void callTool("get_auto_retry_status", {}, true);
}, 5000);

if (new URLSearchParams(window.location.search).has("preview")) {
  render(previewSnapshot());
} else {
  app = new App({ name: "Codex Auto Retry", version: "0.7.12" });
  app.onerror = (error) => showNotice(error instanceof Error ? error.message : "فشل الاتصال", true);
  app.onhostcontextchanged = handleHostContext;
  app.ontoolresult = (result) => {
    const next = extractSnapshot(result as ToolResult);
    if (next) render(next);
  };
  app.connect()
    .then(() => {
      const context = app?.getHostContext();
      if (context) handleHostContext(context);
      return callTool("get_auto_retry_status");
    })
    .catch((error) => showNotice(error instanceof Error ? error.message : "فشل الاتصال", true));
}

function previewSnapshot(): ManagementSnapshot {
  const now = Date.now();
  return {
    version: "0.7.12",
    running: true,
    heartbeat_stale: false,
    paused: false,
    shared_app_server_enabled: false,
    startup_approved: "enabled",
    shared_app_server_port: 49621,
    retry_prompt: "تابع",
    max_recovery_attempts: 15,
    max_consecutive_retries: 5,
    memory_limit_mb: 1024,
    shared_app_server_memory_usage_mb: 0,
    shared_app_server_memory_limit_mb: 4096,
    shared_app_server_memory_guard_triggered: false,
    retry_safety_warning: "",
    initial_delay_seconds: 5,
    max_delay_seconds: 300,
    delay_increment_seconds: 2,
    delay_strategy: "exponential",
    controller_state: "ready",
    show_notifications: true,
    now: new Date(now).toISOString(),
    last_scan_at: new Date(now - 1300).toISOString(),
    pending_retries: 2,
    active_retries: 1,
    stopped_retries: 1,
    watched_roots: 3,
    retries: [
      {
        thread_id: "019f9d5d-9c82-75b1-b7c0-20a658af0423",
        label: "مهمة 019f9d5d",
        state: "running",
        class: "server",
        seconds_remaining: 0,
        recovery_attempt: 1,
        max_recovery_attempts: 15,
        consecutive_retry: 1,
        max_consecutive_retries: 5,
        action: "goal_resume",
        can_retry_now: false,
        can_cancel: false,
        can_restart: false,
      },
      {
        thread_id: "019f9d5d-9c82-75b1-b7c0-20a658af0424",
        label: "مهمة 019f9d5e",
        state: "pending",
        class: "rate_limit",
        due_at: new Date(now + 42_000).toISOString(),
        seconds_remaining: 42,
        recovery_attempt: 4,
        max_recovery_attempts: 15,
        consecutive_retry: 1,
        max_consecutive_retries: 5,
        can_retry_now: true,
        can_cancel: true,
        can_restart: false,
      },
      {
        thread_id: "019f9d5d-9c82-75b1-b7c0-20a658af0425",
        label: "مهمة 019f9d5f",
        state: "pending",
        class: "transient",
        due_at: new Date(now + 126_000).toISOString(),
        seconds_remaining: 126,
        recovery_attempt: 3,
        max_recovery_attempts: 15,
        consecutive_retry: 2,
        max_consecutive_retries: 5,
        can_retry_now: true,
        can_cancel: true,
        can_restart: false,
      },
      {
        thread_id: "019f9d5d-9c82-75b1-b7c0-20a658af0426",
        label: "مهمة 019f9d60",
        state: "stopped",
        class: "server",
        seconds_remaining: 0,
        recovery_attempt: 15,
        max_recovery_attempts: 15,
        consecutive_retry: 5,
        max_consecutive_retries: 5,
        can_retry_now: false,
        can_cancel: false,
        can_restart: true,
      },
    ],
  };
}
