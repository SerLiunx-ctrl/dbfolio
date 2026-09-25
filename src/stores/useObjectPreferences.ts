import { create } from "zustand";
import { api } from "../ipc";
import { rememberUndo } from "./useLocalUndo";

export type Environment = "none" | "development" | "testing" | "production";
export const environmentLabels: Record<Environment, string> = { none: "未标记", development: "开发", testing: "测试", production: "生产" };
export interface FavoriteObject {
  sessionId: string;
  database: string;
  schema?: string | null;
  name: string;
  kind: "table" | "redis" | "mongo";
}
interface Preferences { environments: Record<string, Environment>; favorites: FavoriteObject[] }
export const useObjectPreferences = create<Preferences>(() => ({ environments: {}, favorites: [] }));
export const favoriteId = (item: FavoriteObject) => JSON.stringify([item.sessionId, item.database, item.schema ?? null, item.kind, item.name]);
let loading: Promise<void> | undefined;
let queue = Promise.resolve();
export function loadObjectPreferences(): Promise<void> {
  if (!loading) loading = (async () => {
    const raw = await api.settingsGet("object_preferences_v1");
    if (!raw) return;
    const data = JSON.parse(raw);
    const environments = Object.fromEntries(Object.entries(data.environments ?? {}).filter(([, value]) => typeof value === "string" && Object.prototype.hasOwnProperty.call(environmentLabels, value))) as Record<string, Environment>;
    const favorites = (Array.isArray(data.favorites) ? data.favorites : []).filter((item: FavoriteObject) => item && typeof item.sessionId === "string" && typeof item.database === "string" && typeof item.name === "string" && (item.schema == null || typeof item.schema === "string") && ["table", "redis", "mongo"].includes(item.kind));
    useObjectPreferences.setState({ environments, favorites });
  })().catch(error => { loading = undefined; throw error; });
  return loading;
}
function update(mutator: (state: Preferences) => Preferences) {
  const job = queue.catch(() => {}).then(async () => {
    await loadObjectPreferences();
    const next = mutator(useObjectPreferences.getState());
    await api.settingsSet("object_preferences_v1", JSON.stringify(next));
    useObjectPreferences.setState(next);
  });
  queue = job;
  return job;
}
export const setSessionEnvironment = (sessionId: string, value: Environment) => update(state => ({ ...state, environments: { ...state.environments, [sessionId]: value } }));
export const toggleFavorite = async (item: FavoriteObject) => {
 let wasPresent=false;
 await update(state => {
  const id = favoriteId(item);
  const exists = state.favorites.some(value => favoriteId(value) === id);
  wasPresent=exists;
  return { ...state, favorites: exists ? state.favorites.filter(value => favoriteId(value) !== id) : [...state.favorites, item] };
 });
 rememberUndo((wasPresent?"取消收藏：":"收藏：")+item.name,()=>update(state=>{
   const rest=state.favorites.filter(v=>favoriteId(v)!==favoriteId(item));
   return {...state,favorites:wasPresent?[...rest,item]:rest};
 }));
};
