import { env } from "../config/env.js";

/**
 * 平台模板机构 schema（DSL/规则/字典等资源的继承基线）。
 * 通过 TEMPLATE_SCHEMA 环境变量可配置，默认 demo_school。
 * 所有需要"回退到模板机构资源"的查询都应引用本常量，不要写死字面量。
 */
export const TEMPLATE_SCHEMA = env.templateSchema;

/** 模板机构在界面上的来源标签。 */
export function isTemplateSchema(schemaName: string | null | undefined): boolean {
  return schemaName === TEMPLATE_SCHEMA;
}
