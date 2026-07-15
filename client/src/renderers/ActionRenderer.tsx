import type { ActionDsl } from "../dsl/types";
import { token } from "../styles/designTokens";
import { resolveActionVariant } from "../dsl/actionVariant";

export function ActionRenderer({
  action,
  onClick,
  disabled,
  disabledTitle
}: {
  action: ActionDsl;
  onClick: (action: ActionDsl) => void;
  disabled?: boolean;
  disabledTitle?: string;
}) {
  const resolved = resolveActionVariant(action);
  const variant =
    resolved === "primary" ? token.primaryButton : resolved === "danger" ? token.dangerButton : token.defaultButton;
  return (
    <button
      className={`${token.button} ${variant} ${disabled ? "cursor-not-allowed opacity-50" : ""}`}
      disabled={disabled}
      title={disabled ? disabledTitle ?? "当前条件下不可操作" : undefined}
      onClick={() => onClick(action)}
    >
      {action.label}
    </button>
  );
}
