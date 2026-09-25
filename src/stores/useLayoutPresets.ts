import { create } from "zustand";
import { api } from "../ipc";
import { DEFAULT_DOCK, normalizeDock, useDockStore, type DockState } from "./useDockStore";
import { useSettingsStore } from "./useSettingsStore";
import { useFocusMode } from "./useFocusMode";
import { rememberUndo } from "./useLocalUndo";

export interface LayoutSnapshot { dock: DockState; sidebarWidth: number; rightSidebarWidth: number; sidebarSplit: number; sidebarCollapsed: boolean }
export interface LayoutPreset { name: string; layout: LayoutSnapshot }
const KEY = "workspace_layout_presets_v1";
export const useLayoutPresets = create<{ presets: LayoutPreset[] }>(() => ({ presets: [] }));
const clamp = (v: unknown, min: number, max: number, fallback: number) => typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : fallback;
export function normalizeLayout(raw: Partial<LayoutSnapshot> | null): LayoutSnapshot {
  return { dock: normalizeDock(raw?.dock), sidebarWidth: clamp(raw?.sidebarWidth, 200, 460, 300), rightSidebarWidth: clamp(raw?.rightSidebarWidth, 200, 460, 300), sidebarSplit: clamp(raw?.sidebarSplit, .2, .8, .38), sidebarCollapsed: raw?.sidebarCollapsed === true };
}
export function captureLayout(): LayoutSnapshot {
  const s = useSettingsStore.getState();
  return { dock: { ...useDockStore.getState().layout }, sidebarWidth: s.sidebarWidth, rightSidebarWidth: s.rightSidebarWidth, sidebarSplit: s.sidebarSplit, sidebarCollapsed: s.sidebarCollapsed };
}
export const BUILTIN_LAYOUTS: LayoutPreset[] = [
  { name: "经典左栏", layout: normalizeLayout({ dock: DEFAULT_DOCK }) },
  { name: "左右分栏", layout: normalizeLayout({ dock: { sessions: "left", explorer: "right", first: "sessions" } }) },
  { name: "右侧工具栏", layout: normalizeLayout({ dock: { sessions: "right", explorer: "right", first: "sessions" } }) },
];
async function restore(layout: LayoutSnapshot) {
  const next = normalizeLayout(layout);
  await useDockStore.getState().apply(next.dock, {
    ui_sidebar_width: String(next.sidebarWidth), ui_right_sidebar_width: String(next.rightSidebarWidth),
    ui_sidebar_split: String(next.sidebarSplit), ui_sidebar_collapsed: next.sidebarCollapsed ? "1" : "0",
  });
  const { dock: _, ...sizes } = next;
  useSettingsStore.setState(sizes);
  useFocusMode.setState({ active: false });
}
let applying = Promise.resolve();
export function applyLayout(layout: LayoutSnapshot) {
  const job = applying.catch(() => {}).then(async () => {
    const previous = captureLayout();
    await restore(layout);
    rememberUndo("切换工作区布局", () => restore(previous));
  });
  applying = job; return job;
}
let loading: Promise<void> | undefined, queue = Promise.resolve();
export const flushLayoutPresets = async () => { await applying.catch(() => {}); await queue.catch(() => {}); };
export function loadLayoutPresets() {
  return loading ??= (async () => {
    const raw = await api.settingsGet(KEY), values = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(values)) throw Error("布局预设格式无效");
    useLayoutPresets.setState({ presets: values.filter(v => v && typeof v.name === "string" && v.name.trim()).slice(0, 12).map(v => ({ name: v.name.slice(0, 40), layout: normalizeLayout(v.layout) })) });
  })().catch(e => { loading = undefined; throw e; });
}
function update(change: (values: LayoutPreset[]) => LayoutPreset[]) {
  const job = queue.catch(() => {}).then(async () => {
    await loadLayoutPresets();
    const presets = change(useLayoutPresets.getState().presets);
    await api.settingsSet(KEY, JSON.stringify(presets));
    useLayoutPresets.setState({ presets });
  });
  queue = job; return job;
}
export function saveLayoutPreset(name: string) {
  const title = name.trim();
  if (!title || title.length > 40) return Promise.reject(Error("请输入 1–40 字的布局名称"));
  const layout = captureLayout();
  return update(values => {
    if (values.some(v => v.name === title)) throw Error("已有同名布局，请换一个名称");
    if (values.length >= 12) throw Error("最多保存 12 个布局，请先删除不需要的布局");
    return [...values, { name: title, layout }];
  });
}
export async function deleteLayoutPreset(name: string) {
  let removed: LayoutPreset | undefined;
  await update(values => { removed = values.find(v => v.name === name); return values.filter(v => v.name !== name); });
  if (removed) rememberUndo("删除布局：" + name, () => update(values => {
    if (values.some(v => v.name === name)) throw Error("已有同名布局，请先重命名或删除后再撤销");
    if (values.length >= 12) throw Error("布局数量已达上限，请删除一个布局后再撤销");
    return [...values, removed!];
  }));
}
