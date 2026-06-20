import { useEffect, useState } from "react";
import { token } from "../styles/designTokens";

function pretty(value: unknown) {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value ?? {}, null, 2);
  } catch {
    return "{}";
  }
}

export function JsonTextarea({
  value,
  rows = 12,
  onChange
}: {
  value: unknown;
  rows?: number;
  onChange: (next: unknown) => void;
}) {
  const [text, setText] = useState(pretty(value));
  const [error, setError] = useState("");

  useEffect(() => {
    setText(pretty(value));
    setError("");
  }, [JSON.stringify(value ?? {})]);

  return (
    <div>
      <textarea
        className={`${token.input} min-h-[240px] w-full resize-y py-3 font-mono text-xs leading-5`}
        rows={rows}
        value={text}
        onChange={(event) => {
          const nextText = event.target.value;
          setText(nextText);
          try {
            onChange(JSON.parse(nextText || "{}"));
            setError("");
          } catch {
            onChange(nextText);
            setError("JSON 格式未通过校验，修正后再保存");
          }
        }}
      />
      {error && <div className="mt-2 text-xs text-[#b42332]">{error}</div>}
    </div>
  );
}
