import { create } from "zustand";
export const useObjectNavigation = create<{ request: {tabId: string; key: string} | null }>(() => ({ request: null }));
