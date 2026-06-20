export type FieldDsl = {
  key: string;
  label?: string;
  title?: string;
  type?: string;
  placeholder?: string;
  sortable?: boolean;
  width?: number;
  align?: "left" | "center" | "right";
  badge?: boolean;
  hidden?: boolean;
  displayKey?: string;
  span?: 1 | 2 | 3 | "full";
  rows?: number;
  sortOrder?: number;
  optionSource?: {
    pageCode: string;
    apiCode: string;
    valueField?: string;
    labelField?: string;
    filters?: Record<string, unknown>;
    pageSize?: number;
    includeRow?: boolean;
  };
  fillOnSelect?: Record<string, string>;
  searchable?: boolean;
  editable?: boolean;
  computed?: boolean;
  computeExpr?: string;
  required?: boolean;
  validation?: Record<string, unknown>;
  options?: Array<{ label: string; value: string }>;
};

export type WhereCondition = {
  field: string;
  op: "eq" | "ilike" | "between" | "in" | "gt" | "gte" | "lt" | "lte";
  value?: unknown;
  param?: string;
  source: "constant" | "fixed" | "param";
  ignoreEmpty?: boolean;
};

export type QueryDsl = {
  table: string;
  alias?: string;
  select?: Array<{ field: string; as?: string }>;
  where?: WhereCondition[];
  orderBy?: Array<{ field: string; direction: "asc" | "desc" }>;
  security?: { requireLogin?: boolean; dataPermission?: string };
};

export type ApiDsl = {
  dslType: "api";
  apiCode: string;
  apiType: "query" | "command" | "detail" | "option" | "aggregate" | "auth";
  method?: string;
  gatewayUrl?: string;
  inputSchema?: { fields: Array<{ name: string; type: string; required?: boolean }> };
  outputSchema?: { type?: string; fields: Array<{ name: string; type: string }> };
  queryDsl?: QueryDsl;
  security?: { requireLogin?: boolean; dataPermission?: string };
};

export type ActionDsl = {
  actionCode: string;
  actionName?: string;
  actionType: "open_page" | "execute_api" | "open_modal" | "dropdown" | "input" | "display" | "tab" | "export" | "import";
  label?: string;
  type?: string;
  variant?: "primary" | "default" | "danger";
  confirm?: string | boolean;
  sortOrder?: number;
  apiCode?: string;
  modalCode?: string;
  modalTitle?: string;
  fields?: FieldDsl[];
  defaultValues?: Record<string, unknown>;
  defaultParams?: Record<string, unknown>;
  mapRowToValue?: Record<string, string>;
  modalSize?: "default" | "large" | "fullscreen";
  afterSuccess?: Array<{ type: "toast" | "redirect" | "refreshPage"; message?: string; to?: string }>;
  visibleWhen?: { always?: boolean; permission?: string } & Record<string, string | string[] | boolean | undefined>;
  enabledWhen?: { always?: boolean; permission?: string };
  renderAs?: string;
  styleToken?: string;
  subActions?: Array<{ actionCode: string; label: string }>;
  targetPageCode?: string;
  targetTab?: string;
  importConfig?: Record<string, unknown>;
  exportConfig?: Record<string, unknown>;
  printTemplateCode?: string;
};

export type ModalDsl = {
  modalCode: string;
  modalName?: string;
  size?: "default" | "large" | "fullscreen";
  columns?: 2 | 3;
  labelAlign?: "top" | "left";
  fields: FieldDsl[];
  submitApiCode?: string;
  validateOnSubmit?: boolean;
};

export type ActionResult = {
  actionType: string;
  targetPageCode?: string;
  modalDsl?: ModalDsl;
  disabled?: boolean;
  subActions?: Array<{ actionCode: string; label: string }>;
  data?: unknown;
  afterSuccess?: ActionDsl["afterSuccess"];
  importConfig?: Record<string, unknown>;
};

export type PageTargetDsl = {
  pageCode: string;
  title?: string;
  filters?: Record<string, unknown>;
};

export type PageDsl = {
  pageCode: string;
  pageKind?: "public" | "shell" | "shtml";
  title: string;
  subtitle?: string;
  moduleCode?: string;
  featureCode?: string;
  designToken?: string;
  presentation?: {
    theme?: "flatTech" | "default";
    density?: "compact" | "comfortable";
    header?: {
      subtitle?: string;
      metrics?: Array<{
        label: string;
        source: "total" | "countBy" | "sum";
        field?: string;
        value?: string | number | boolean;
        suffix?: string;
        target?: PageTargetDsl;
      }>;
    };
    table?: {
      rowActionMode?: "inline" | "menu";
      rowActionStyle?: "button" | "linkGroup";
      primaryRowActions?: string[];
      stickyHeader?: boolean;
    };
    modal?: {
      style?: "default" | "bossForm";
      columns?: 2 | 3;
      labelAlign?: "top" | "left";
      size?: "default" | "large" | "fullscreen";
    };
    statusMap?: Record<string, Record<string, "green" | "blue" | "amber" | "red" | "gray">>;
    valueLabels?: Record<string, Record<string, string>>;
    dashboard?: {
      quickActions?: Array<{ label: string; pageCode: string; moduleCode?: string; filters?: Record<string, unknown> }>;
      rightRail?: {
        title: string;
        sections: Array<{
          title: string;
          dataSource?: {
            pageCode: string;
            apiCode: string;
            limit?: number;
            filters?: Record<string, unknown>;
            tag?: string;
            textField: string;
            metaField?: string;
            appendStaticItems?: boolean;
            target?: PageTargetDsl & { filterField?: string; rowField?: string };
          };
          items: Array<{ tag?: string; text: string; meta?: string; target?: PageTargetDsl }>;
        }>;
      };
      panels?: Array<{
        title: string;
        description?: string;
        apiCode?: string;
        columns?: FieldDsl[];
        limit?: number;
      }>;
    };
  };
  layout: "list" | "dashboard" | "enrollment";
  dataApi: string;
  detailApi: string;
  createApi: string;
  updateApi: string;
  deleteApi: string;
  filters: FieldDsl[];
  toolbar: ActionDsl[];
  table: {
    rowKey: string;
    columns: FieldDsl[];
    rowActions: ActionDsl[];
  };
  modal: {
    fields: FieldDsl[];
  };
  permissions?: {
    pageResourceCode?: string;
    dataScope?: string;
    hideWhenNoPermission?: boolean;
  };
  style?: {
    titleClassToken?: string;
    tableClassToken?: string;
  };
};

export type MenuModule = {
  moduleCode: string;
  moduleName: string;
  icon: string;
  groups: Record<string, Array<{ featureCode: string; featureName: string; pageCode: string }>>;
};
