export const SHORTCUTS = [
 {id:'save',label:'保存当前编辑内容',scope:'编辑工作区',key:'Ctrl+S'},
 {id:'execute',label:'执行 SQL / 查询 / 命令',scope:'对应的查询输入区',key:'Ctrl+Enter'},
 {id:'formatSql',label:'格式化 SQL',scope:'SQL 编辑器',key:'Ctrl+Shift+F'},
 {id:'findData',label:'查找已加载数据',scope:'数据浏览网格',key:'Ctrl+F'},
 {id:'quickOpen',label:'快速打开',scope:'应用窗口',key:'Ctrl+P'},
 {id:'focus',label:'切换专注模式',scope:'应用窗口',key:'Ctrl+Shift+J'},
 {id:'reopen',label:'重新打开关闭的页签',scope:'应用窗口',key:'Ctrl+Shift+T'},
 {id:'undoLocal',label:'撤销本地收藏、分组和布局操作',scope:'应用窗口',key:'Ctrl+Alt+Z'},
 {id:'settings',label:'打开首选项',scope:'应用窗口',key:'Ctrl+,'},
 {id:'sidebar',label:'展开 / 收起侧栏',scope:'应用窗口',key:'Ctrl+B'},
 {id:'zoomIn',label:'放大',scope:'ER 画布优先，其余为界面',key:'Ctrl+='},
 {id:'zoomOut',label:'缩小',scope:'ER 画布优先，其余为界面',key:'Ctrl+-'},
 {id:'zoomReset',label:'恢复 100%',scope:'ER 画布优先，其余为界面',key:'Ctrl+0'},
] as const;
export type ShortcutId=typeof SHORTCUTS[number]['id'];
export type Bindings=Record<ShortcutId,string>;
export const defaultBindings=()=>Object.fromEntries(SHORTCUTS.map(s=>[s.id,s.key])) as Bindings;
export const displayShortcut=(key:string)=>key?key.replace(/=$/,'+'):'未设置';
export function eventShortcut(e:Pick<KeyboardEvent,'key'|'ctrlKey'|'altKey'|'shiftKey'|'metaKey'>):string|null{
 if(e.metaKey)return null;let key=e.key;if(['Control','Alt','Shift','Meta','Dead','Process','Unidentified'].includes(key))return null;
 if(key===' ')key='Space';const plus=key==='+';if(plus)key='=';if(key.length===1)key=key.toUpperCase();
 return [e.ctrlKey?'Ctrl':'',e.altKey?'Alt':'',e.shiftKey&&!plus?'Shift':'',key].filter(Boolean).join('+');
}
export function bindingError(key:string,id:ShortcutId):string{
 if(!key)return '';const parts=key.split('+'),base=parts[parts.length-1]??'';
 const mods=parts.slice(0,-1);if(mods.join('+')!==['Ctrl','Alt','Shift'].filter(m=>mods.includes(m)).join('+')||new Set(mods).size!==mods.length||!base||(!mods.includes('Ctrl')&&!mods.includes('Alt')&&!/^F([1-9]|1[0-2])$/.test(base)))return '请使用 Ctrl / Alt 组合或 F1～F12 功能键';
 if(!/^(?:[A-Z0-9]|F(?:[1-9]|1[0-2])|Enter|Tab|Space|Arrow(?:Up|Down|Left|Right)|Home|End|PageUp|PageDown|Insert|Delete|Backspace|Escape|[=,./;\[\]\\-])$/.test(base))return '不支持此按键，请重新录入';
 if(['Alt+F4','Alt+Escape','Alt+Shift+Escape','Alt+Tab','Alt+Shift+Tab','Alt+Space','Ctrl+Escape','Ctrl+Shift+Escape','Ctrl+Alt+Delete','Ctrl+Alt+Tab'].includes(key))return '此组合由 Windows 保留，请选择其它按键';
 if(['Ctrl+C','Ctrl+V','Ctrl+X','Ctrl+Z','Ctrl+Y','Ctrl+A','Ctrl+H','Ctrl+K','Ctrl+D','Ctrl+L','Ctrl+Space','Ctrl+Shift+Space','Ctrl+Shift+Z','Ctrl+Insert','Ctrl+Backspace','Ctrl+Delete','Ctrl+ArrowLeft','Ctrl+ArrowRight','Ctrl+Shift+ArrowLeft','Ctrl+Shift+ArrowRight'].includes(key)||(key==='Ctrl+F'&&id!=='findData'))return '此组合保留给编辑器的文本操作';
 return '';
}
export function bindingsErrors(bindings:Bindings):string[]{const used=new Map<string,string>(),errors:string[]=[];for(const s of SHORTCUTS){const key=bindings[s.id],error=bindingError(key,s.id);if(error)errors.push(`${s.label}：${error}`);if(key){if(used.has(key))errors.push(`${s.label}与${used.get(key)}使用相同按键 ${displayShortcut(key)}`);used.set(key,s.label);}}return errors;}
export function parseBindings(raw:string|null):Bindings{const defaults=defaultBindings();if(!raw)return defaults;try{const value=JSON.parse(raw);if(!value||typeof value!=='object'||Array.isArray(value))return defaults;const next={...defaults};for(const s of SHORTCUTS)if(typeof value[s.id]==='string')next[s.id]=value[s.id];return bindingsErrors(next).length?defaults:next;}catch{return defaults;}}
