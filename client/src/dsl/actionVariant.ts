import type { ActionDsl } from "./types";

/**
 * 动作语义（危险/主要/默认）的统一判定：
 * 显式 DSL 配置 action.variant 优先；未配置时才按 ".delete" 后缀约定兜底。
 * 之前 ActionRenderer / GenericTableRenderer 各自写死后缀判断，
 * 租户 AI 定制的 contract.void、student.archive 等危险动作无法标红，
 * 现在 DSL 里配 variant:"danger" 即可生效。
 */
export function resolveActionVariant(action: ActionDsl): "primary" | "danger" | "default" {
  if (action.variant === "primary" || action.variant === "danger" || action.variant === "default") {
    return action.variant;
  }
  return action.actionCode.endsWith(".delete") ? "danger" : "default";
}

export function isDangerAction(action: ActionDsl): boolean {
  return resolveActionVariant(action) === "danger";
}
