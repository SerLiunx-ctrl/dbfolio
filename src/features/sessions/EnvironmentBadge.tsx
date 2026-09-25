import { Badge } from "@fluentui/react-components";
import { environmentLabels, useObjectPreferences } from "../../stores/useObjectPreferences";

export function EnvironmentBadge({ sessionId, compact = false }: { sessionId?: string | null; compact?: boolean }) {
  const value = useObjectPreferences(state => sessionId ? state.environments[sessionId] : undefined);
  if (!value || value === "none") return null;
  return <Badge size="small" appearance="tint" color={value === "production" ? "danger" : value === "testing" ? "warning" : "success"} style={{ marginLeft: compact ? 4 : 6, flexShrink: 0, ...(compact ? {fontSize: "10px", minWidth: 0, height: "14px", lineHeight: "12px", paddingInline: "3px"} : {}) }}>{environmentLabels[value]}</Badge>;
}
