export type OpType =
  | "create_table"
  | "add_field"
  | "create_import"
  | "create_report"
  | "create_feature"
  | "create_approval_flow"
  | "create_print_template"
  | "create_business_rule"
  | "create_business_event_listener"
  | "add_column"
  | "remove_column"
  | "reorder_columns"
  | "change_column"
  | "add_filter"
  | "remove_filter"
  | "add_toolbar"
  | "add_row_action"
  | "add_modal_field"
  | "remove_modal_field"
  | "add_select_field"
  | "remove_select_field"
  | "add_allowed_field"
  | "add_join"
  | "add_where"
  | "add_sort"
  | "add_action"
  | "modify_permission"
  | "modify";

export type TargetType =
  | "page_dsl"
  | "api_dsl"
  | "action_dsl"
  | "skill_registry"
  | "db_schema"
  | "import_dsl"
  | "report_dsl"
  | "permission_policy"
  | "approval_flow"
  | "print_template"
  | "business_rule"
  | "feature_registry";

export const VALID_OPS: ReadonlySet<string> = new Set<OpType>([
  "create_table", "add_field", "create_import", "create_report", "create_feature",
  "create_approval_flow", "create_print_template", "create_business_rule", "create_business_event_listener",
  "add_column", "remove_column", "reorder_columns", "change_column",
  "add_filter", "remove_filter", "add_toolbar", "add_row_action", "add_modal_field", "remove_modal_field",
  "add_select_field", "remove_select_field", "add_allowed_field", "add_join", "add_where", "add_sort",
  "add_action", "modify_permission", "modify",
]);

export const VALID_TARGET_TYPES: ReadonlySet<string> = new Set<TargetType>([
  "page_dsl", "api_dsl", "action_dsl", "skill_registry", "db_schema", "import_dsl", "report_dsl", "feature_registry",
  "permission_policy", "approval_flow", "print_template", "business_rule",
]);

export const OPS_REQUIRE_FIELD_DEF: ReadonlySet<string> = new Set([
  "add_column", "change_column", "add_filter", "add_toolbar", "add_row_action",
  "add_modal_field", "add_select_field", "add_allowed_field", "add_join", "add_where",
  "add_sort", "add_action", "reorder_columns",
]);

export type DslDiff = {
  targetType: TargetType;
  targetCode: string;
  op: OpType;
  field?: string;
  fieldDef?: Record<string, unknown>;
  resourceDef?: Record<string, unknown>;
  modifiedDslJson?: unknown;
  sortOrder?: number;
};

export type IntentResult = {
  featureCode: string;
  action: "modify" | "create";
  reason: string;
  moduleCode?: string;
  relatedFeatureCodes?: string[];
};

export type ContextResult = {
  skillMdContent: string;
  tableColumns: Record<string, Array<{ column_name: string; data_type: string }>>;
  relevantDslCodes: string[];
  dslSummary: DslContextSummary;
  tokenEstimate: number;
};

export type DslContextSummary = {
  pages: DslPageSummary[];
  apis: DslApiSummary[];
  actions: DslActionSummary[];
};

export type DslPageSummary = {
  pageCode: string;
  pageName?: string;
  title?: string;
  filters: string[];
  columns: string[];
  toolbarActions: string[];
  rowActions: string[];
};

export type DslApiSummary = {
  apiCode: string;
  operation?: string;
  table?: string;
  selectFields: string[];
  allowedFields: string[];
  filters: string[];
  joins: string[];
  sorts: string[];
};

export type DslActionSummary = {
  actionCode: string;
  actionName?: string;
  actionType?: string;
  pageCode?: string;
  apiCode?: string;
  modalCode?: string;
  fields: string[];
};

export type ChangeCapabilityType =
  | "add_field"
  | "modify_field"
  | "remove_field"
  | "create_table"
  | "add_import"
  | "add_report"
  | "add_filter"
  | "add_permission"
  | "add_data_permission"
  | "add_approval_flow"
  | "add_export"
  | "add_print_template"
  | "add_business_rule"
  | "add_workflow_action"
  | "modify_layout";

export type ChangeCapability = {
  type: ChangeCapabilityType;
  label: string;
  risk: "low" | "medium" | "high";
  requiresConfirmation: boolean;
  params: Record<string, unknown>;
};

export type ChangePlan = {
  targetModule?: string;
  targetFeature?: string;
  targetPage?: string;
  summary: string;
  capabilities: ChangeCapability[];
  questions: string[];
  canProceed: boolean;
};

export type TenantAgentPolicy = {
  allowedTools: string[];
  allowedTargetTypes: TargetType[];
  riskPolicy: "auto";
  moduleScope: string[];
  fieldPolicy: {
    storageStrategy: "ext_json_first" | "physical_first";
    maxPhysicalFieldsPerRequest: number;
    sensitiveFieldBlocklist: string[];
  };
  publishPolicy: {
    requirePreview: boolean;
    requireAdminReview: boolean;
  };
  dataPolicy: {
    allowImport: boolean;
    allowOverwrite: boolean;
  };
};

export type HarnessStepResult<T> = {
  stepName: string;
  input_summary: string;
  output_summary: string;
  duration_ms: number;
  llm_tokens_used?: number;
  data: T;
  error?: string;
};

export type HarnessResult = {
  intent: HarnessStepResult<IntentResult>;
  context: HarnessStepResult<ContextResult>;
  requirement: HarnessStepResult<ChangePlan>;
  planning: HarnessStepResult<DslDiff[]>;
  validation: HarnessStepResult<DslDiff[]>;
  execution: HarnessStepResult<Array<{ versionId: string; versionNo: number }>>;
  totalDuration_ms: number;
};

export type AgentRunStage =
  | "understanding"
  | "scope_detected"
  | "context_loading"
  | "planning"
  | "dsl_generating"
  | "tool_start"
  | "tool_result"
  | "validating"
  | "preview_preparing"
  | "preview_ready"
  | "need_confirm"
  | "failed";

export type AgentRunEvent = {
  stage: AgentRunStage;
  title: string;
  message: string;
  detail?: unknown;
  toolName?: string;
  status?: "running" | "success" | "failed" | "skipped";
  visibleToTenant: boolean;
  createdAt: string;
};

export type AgentProgressCallback = (event: AgentRunEvent) => void | Promise<void>;

export type LlmToolCall = { id: string; name: string; arguments: string };

export type LlmMessage = {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string; type: "function"; function: { name: string; arguments: string } }>;
  tool_call_id?: string;
};

export type LlmCallResult = {
  type: "tool_call" | "text";
  functionCall?: { name: string; arguments: string };
  // 全部工具调用（支持模型一次返回多个并行 tool_calls）；functionCall 为其中第一个，保持向后兼容
  functionCalls?: LlmToolCall[];
  content?: string;
  tokensUsed?: number;
};

export type LlmConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  maxContextTokens: number;
  supportsToolCalling: boolean;
};

export type SkillSummary = {
  skill_code: string;
  skill_name: string;
  skill_summary: string;
};

export type LlmCallInput = {
  schemaName: string;
  messages: Array<{ role: string; content: string | null; tool_calls?: LlmMessage["tool_calls"]; tool_call_id?: string }>;
  tools?: Array<Record<string, unknown>>;
  fallbackPrompt?: string;
  // 提供时启用流式：纯文本增量通过 onDelta 实时回调（工具调用轮不产生增量）
  onDelta?: (text: string) => void;
};
