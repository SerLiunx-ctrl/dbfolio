import type { RedisKeyPreview } from "../../ipc/types";
export function mergePreview(previous: RedisKeyPreview, next: RedisKeyPreview): RedisKeyPreview {
  if (previous.key !== next.key || previous.kind !== next.kind) throw new Error("键类型已变化，请刷新后重试");
  if (next.kind === "list") return {...next, entries:[...previous.entries,...next.entries], binary:previous.binary||next.binary};
  const entries = new Map(previous.entries.map(entry => [entry.field ?? entry.value, entry]));
  next.entries.forEach(entry => entries.set(entry.field ?? entry.value, entry));
  return {...next, entries:[...entries.values()], binary:previous.binary||next.binary};
}
