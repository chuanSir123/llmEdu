import type { ActionDsl } from "../dsl/types";
import { token } from "../styles/designTokens";
import { resolveActionVariant } from "../dsl/actionVariant";

export function ActionRenderer({ action, onClick }: { action: ActionDsl; onClick: (action: ActionDsl) => void }) {
  const resolved = resolveActionVariant(action);
  const variant =
    resolved === "primary" ? token.primaryButton : resolved === "danger" ? token.dangerButton : token.defaultButton;
  return (
    <button className={`${token.button} ${variant}`} onClick={() => onClick(action)}>
      {action.label}
    </button>
  );
}
