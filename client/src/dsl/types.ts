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
  span?: 1 | 2 | 3 | "full";
  rows?: number;
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
};

export type ActionDsl = {
  actionCode: string;
  label: string;
  type: string;
  variant?: "primary" | "default" | "danger";
  confirm?: string;
  apiCode?: string;
  modalTitle?: string;
  fields?: FieldDsl[];
  defaultValues?: Record<string, unknown>;
  mapRowToValue?: Record<string, string>;
  modalSize?: "default" | "large" | "fullscreen";
};

export type PageTargetDsl = {
  pageCode: string;
  title?: string;
  filters?: Record<string, unknown>;
};

export type PageDsl = {
  pageCode: string;
  title: string;
  subtitle?: string;
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
};

export type MenuModule = {
  moduleCode: string;
  moduleName: string;
  icon: string;
  groups: Record<string, Array<{ featureCode: string; featureName: string; pageCode: string }>>;
};
