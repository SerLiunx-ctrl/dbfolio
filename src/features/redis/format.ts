export function formatTtl(ttlMs: number): string {
  if (ttlMs === -1) return "永久";
  if (ttlMs < 0) return "已过期";
  if (ttlMs < 1000) return `${ttlMs} 毫秒`;
  const seconds = ttlMs / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} 秒`;
  const minutes = seconds / 60;
  if (minutes < 60) return `${Math.floor(minutes)} 分 ${Math.round(seconds % 60)} 秒`;
  const hours = minutes / 60;
  if (hours < 24) return `${hours.toFixed(1)} 小时`;
  return `${(hours / 24).toFixed(1)} 天`;
}

export function formatBytes(bytes?: number | null): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

export const REDIS_TYPE_OPTIONS = [
  { value: "", label: "全部类型" },
  { value: "string", label: "string" },
  { value: "list", label: "list" },
  { value: "set", label: "set" },
  { value: "zset", label: "zset" },
  { value: "hash", label: "hash" },
  { value: "stream", label: "stream" },
];

export type BadgeColor =
  | "brand"
  | "danger"
  | "important"
  | "informative"
  | "severe"
  | "subtle"
  | "success"
  | "warning";

export function typeBadgeColor(kind: string): BadgeColor {
  switch (kind) {
    case "string":
      return "informative";
    case "list":
      return "success";
    case "set":
      return "brand";
    case "zset":
      return "important";
    case "hash":
      return "warning";
    case "stream":
      return "danger";
    default:
      return "subtle";
  }
}

export type TextFormat = "json" | "xml" | "text";

export function detectTextFormat(value: string): TextFormat {
  const trimmed = value.trim();
  if (!trimmed) return "text";
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      JSON.parse(trimmed);
      return "json";
    } catch {
      return "text";
    }
  }
  if (trimmed.startsWith("<") && typeof DOMParser !== "undefined") {
    try {
      const doc = new DOMParser().parseFromString(trimmed, "application/xml");
      if (!doc.querySelector("parsererror")) return "xml";
    } catch {
      return "text";
    }
  }
  return "text";
}

export function prettifyJson(value: string): string | null {
  try {
    return JSON.stringify(JSON.parse(value), null, 2);
  } catch {
    return null;
  }
}

export function minifyJson(value: string): string | null {
  try {
    return JSON.stringify(JSON.parse(value));
  } catch {
    return null;
  }
}

export function prettifyXml(value: string): string | null {
  if (typeof DOMParser === "undefined") return null;
  try {
    const trimmed = value.trim();
    const doc = new DOMParser().parseFromString(trimmed, "application/xml");
    if (doc.querySelector("parsererror")) return null;

    const serialize = (node: Node, depth: number): string => {
      const indent = "  ".repeat(depth);
      if (node.nodeType === Node.TEXT_NODE) {
        const text = (node.nodeValue ?? "").trim();
        return text ? `${indent}${text}` : "";
      }
      if (node.nodeType === Node.COMMENT_NODE) {
        return `${indent}<!-- ${(node.nodeValue ?? "").trim()} -->`;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) return "";
      const element = node as Element;
      const attrs = [...element.attributes]
        .map((attribute) => `${attribute.name}="${attribute.value}"`)
        .join(" ");
      const open = attrs ? `<${element.tagName} ${attrs}>` : `<${element.tagName}>`;
      const close = `</${element.tagName}>`;
      const children = [...element.childNodes]
        .map((child) => serialize(child, depth + 1))
        .filter((text) => text.length > 0);
      const onlyText =
        element.childNodes.length === 1 &&
        element.firstChild?.nodeType === Node.TEXT_NODE;
      if (onlyText) {
        const text = (element.textContent ?? "").trim();
        return `${indent}${open}${text}${close}`;
      }
      if (children.length === 0) return `${indent}${open}${close}`;
      return `${indent}${open}\n${children.join("\n")}\n${indent}${close}`;
    };

    const declaration = trimmed.startsWith("<?xml")
      ? `<?xml version="1.0" encoding="UTF-8"?>\n`
      : "";
    const root = doc.documentElement ? serialize(doc.documentElement, 0) : "";
    return root ? `${declaration}${root}` : null;
  } catch {
    return null;
  }
}

export function prettifyByFormat(value: string, format: TextFormat): string | null {
  if (format === "json") return prettifyJson(value);
  if (format === "xml") return prettifyXml(value);
  return value;
}

export type EditorLanguage = "json" | "xml" | "javascript" | "plaintext";

/** 编辑器语言：严格 JSON/XML 用对应语言；类 JSON（键未加引号等）用 javascript 高亮 */
export function detectEditorLanguage(value: string): EditorLanguage {
  const format = detectTextFormat(value);
  if (format === "json") return "json";
  if (format === "xml") return "xml";
  const trimmed = value.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) return "javascript";
  return "plaintext";
}
