import type { ActionDsl } from "../dsl/types";
import { token } from "../styles/designTokens";

export function ActionRenderer({ action, onClick }: { action: ActionDsl; onClick: (action: ActionDsl) => void }) {
  const variant =
    action.variant === "primary"
      ? token.primaryButton
      : action.variant === "danger" || action.actionCode.endsWith(".delete")
        ? token.dangerButton
        : token.defaultButton;
  return (
    <button className={`${token.button} ${variant}`} onClick={() => onClick(action)}>
      {action.label}
    </button>
  );
}
