import {create} from 'zustand';
import {api} from '../ipc';
import {bindingsErrors,defaultBindings,parseBindings,type Bindings} from '../app/shortcutModel';
let loading:Promise<void>|null=null;
export const useShortcutStore=create<{bindings:Bindings;loaded:boolean;load:()=>Promise<void>;save:(value:Bindings)=>Promise<void>}>((set,get)=>({
 bindings:defaultBindings(),loaded:false,
 load:()=>{if(get().loaded)return Promise.resolve();return loading??=(async()=>{try{const raw=await api.settingsGet('ui_shortcuts_v1');if(!get().loaded)set({bindings:parseBindings(raw),loaded:true});}finally{loading=null;}})();},
 save:async value=>{const errors=bindingsErrors(value);if(errors.length)throw Error(errors[0]);await api.settingsSet('ui_shortcuts_v1',JSON.stringify(value));set({bindings:{...value},loaded:true});},
}));
