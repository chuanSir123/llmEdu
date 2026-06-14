import * as Icons from "lucide-react";

export function Icon({ name, size = 18 }: { name?: string; size?: number }) {
  const Cmp = (name && (Icons as unknown as Record<string, React.ComponentType<{ size?: number }>>)[name]) || Icons.Circle;
  return <Cmp size={size} />;
}
