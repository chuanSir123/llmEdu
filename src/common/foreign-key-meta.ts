export type ForeignKeyMeta = {
  key: string;
  table: string;
  pageCode: string;
  apiCode: string;
  valueField: string;
  labelField: string;
  displayKey: string;
};

const explicitForeignKeys: Record<string, Omit<ForeignKeyMeta, "key" | "displayKey"> & { displayKey?: string }> = {
  organization_id: { table: "organization", pageCode: "organization_list", apiCode: "organization_list.query", valueField: "id", labelField: "name", displayKey: "organization_name" },
  student_id: { table: "student", pageCode: "student_list", apiCode: "student_list.query", valueField: "id", labelField: "name", displayKey: "student_name" },
  contract_id: { table: "contract", pageCode: "contract_list", apiCode: "contract_list.query", valueField: "id", labelField: "contract_no", displayKey: "contract_no" },
  contract_product_id: { table: "contract_product", pageCode: "contract_product_list", apiCode: "contract_product_list.query", valueField: "id", labelField: "product_name", displayKey: "contract_product_name" },
  product_id: { table: "product", pageCode: "product_list", apiCode: "product_list.query", valueField: "id", labelField: "name", displayKey: "product_name" },
  promotion_id: { table: "promotion", pageCode: "promotion_list", apiCode: "promotion_list.query", valueField: "id", labelField: "name", displayKey: "promotion_name" },
  pay_way_config_id: { table: "pay_way_config", pageCode: "pay_way_list", apiCode: "pay_way_list.query", valueField: "id", labelField: "name", displayKey: "pay_way_name" },
  refund_way_config_id: { table: "pay_way_config", pageCode: "pay_way_list", apiCode: "pay_way_list.query", valueField: "id", labelField: "name", displayKey: "refund_way_name" },
  mini_class_id: { table: "mini_class", pageCode: "mini_class_list", apiCode: "mini_class_list.query", valueField: "id", labelField: "name", displayKey: "mini_class_name" },
  one_on_n_group_id: { table: "one_on_n_group", pageCode: "one_on_n_group_list", apiCode: "one_on_n_group_list.query", valueField: "id", labelField: "name", displayKey: "one_on_n_group_name" },
  class_id: { table: "mini_class", pageCode: "mini_class_list", apiCode: "mini_class_list.query", valueField: "id", labelField: "name", displayKey: "class_name" },
  course_id: { table: "generic_course", pageCode: "course_list", apiCode: "course_list.query", valueField: "id", labelField: "course_title", displayKey: "course_title" },
  classroom_id: { table: "classroom", pageCode: "classroom_list", apiCode: "classroom_list.query", valueField: "id", labelField: "name", displayKey: "classroom_name" },
  lesson_id: { table: "lesson", pageCode: "lesson_list", apiCode: "lesson_list.query", valueField: "id", labelField: "name", displayKey: "lesson_name" },
};

export function inferForeignKeyMeta(key: string): ForeignKeyMeta | undefined {
  const explicit = explicitForeignKeys[key];
  if (explicit) {
    return {
      key,
      displayKey: explicit.displayKey ?? key.replace(/_id$/, "_name"),
      ...explicit,
    };
  }
  if (key.endsWith("staff_id") || key.endsWith("teacher_id") || key.endsWith("user_id")) {
    return {
      key,
      table: "user",
      pageCode: "user_list",
      apiCode: "user_list.query",
      valueField: "id",
      labelField: "name",
      displayKey: key.replace(/_id$/, "_name"),
    };
  }
  if (key.endsWith("organization_id")) {
    return {
      key,
      table: "organization",
      pageCode: "organization_list",
      apiCode: "organization_list.query",
      valueField: "id",
      labelField: "name",
      displayKey: key.replace(/_id$/, "_name"),
    };
  }
  if (key === "operator_id" || key.endsWith("manager_id")) {
    return {
      key,
      table: "user",
      pageCode: "user_list",
      apiCode: "user_list.query",
      valueField: "id",
      labelField: "name",
      displayKey: key.replace(/_id$/, "_name"),
    };
  }
  return undefined;
}
