import { create } from "zustand";
/** 临时专注模式不改写用户已保存的布局。 */
export const useFocusMode = create<{ active: boolean }>(() => ({ active: false }));
export const toggleFocusMode = () => useFocusMode.setState(s => ({ active: !s.active }));
