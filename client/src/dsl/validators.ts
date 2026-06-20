import type { PageDsl, ActionDsl, ModalDsl } from "./types";

type ValidationResult = { valid: boolean; errors: string[] };

export function validatePageDsl(dsl: Partial<PageDsl>): ValidationResult {
  const errors: string[] = [];
  if (!dsl.pageCode) errors.push("pageCode 缺失");
  if (!dsl.layout && !dsl.presentation) errors.push("layout/presentation 缺失");
  return { valid: errors.length === 0, errors };
}

export function validateActionDsl(dsl: Partial<ActionDsl>): ValidationResult {
  const errors: string[] = [];
  if (!dsl.actionCode) errors.push("actionCode 缺失");
  if (!dsl.actionType) errors.push("actionType 缺失");
  return { valid: errors.length === 0, errors };
}

export function validateModalDsl(dsl: Partial<ModalDsl>): ValidationResult {
  const errors: string[] = [];
  if (!dsl.modalCode) errors.push("modalCode 缺失");
  if (!dsl.fields || !Array.isArray(dsl.fields)) errors.push("fields 缺失或非数组");
  return { valid: errors.length === 0, errors };
}