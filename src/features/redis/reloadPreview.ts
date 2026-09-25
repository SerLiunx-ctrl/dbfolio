import type { RedisKeyPreview } from "../../ipc/types";
import { mergePreview } from "./mergePreview";

/** 重新遍历而非合并旧缓存，确保删除、改分值和 List 位移都反映服务端状态。 */
export async function reloadPreview(fetchPage: (cursor?: string) => Promise<RedisKeyPreview>, count: number, current: () => boolean) {
  let data = await fetchPage();
  const kind = data.kind;
  const seen = new Set<string>();
  const target = Math.min(Math.max(count,100),5000);
  while (current() && data.kind !== "string" && data.nextCursor && data.entries.length < target) {
    const cursor = data.nextCursor;
    if (seen.has(cursor) || seen.size >= 100) throw new Error("集合游标未能完成遍历，请刷新后重试");
    seen.add(cursor);
    const next = await fetchPage(cursor);
    if (!current()) return data;
    if(next.kind !== kind) throw new Error("键类型已改变，请重新打开");
    data = mergePreview(data,next);
  }
  return data;
}
