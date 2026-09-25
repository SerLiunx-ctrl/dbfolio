import {useEffect,useCallback} from 'react';
import {useMonaco, type BeforeMount} from '@monaco-editor/react';
import {useSettingsStore} from './stores/useSettingsStore';
import {useIsDark} from './theme';
import {surfaceColors,mixColor} from './appearance';
export function useEditorTheme() {
  const dark=useIsDark(), style=useSettingsStore(s=>s.themeMode === "oled" ? "oled" : s.interfaceStyle),accent=useSettingsStore(s=>s.resolvedAccent),monaco=useMonaco();
  const name='dw-'+style+'-'+(dark?'dark':'light')+'-'+accent.slice(1);
  const register=useCallback<BeforeMount>(m=>{const p=surfaceColors(style,dark);m.editor.defineTheme(name,{base:dark?'vs-dark':'vs',inherit:true,rules:[],colors:{
    'editor.background':p.surface,'editor.foreground':p.foreground,'editorGutter.background':p.surface,
    'editorLineNumber.foreground':p.muted,'editorLineNumber.activeForeground':p.foreground,
    'editorCursor.foreground':dark?mixColor(accent,'#ffffff',.5):accent,
    'editor.selectionBackground':mixColor(p.surface,accent,.3),'editor.lineHighlightBackground':mixColor(p.surface,accent,.06),
    'editorWidget.background':p.surface,'editorWidget.border':p.border,
    'menu.background':p.surface,'menu.foreground':p.foreground,'menu.selectionBackground':mixColor(p.surface,accent,.2)
  }});},[name,style,dark,accent]);
  useEffect(()=>{if(monaco){register(monaco);monaco.editor.setTheme(name);}},[monaco,register,name]);
  return {name,beforeMount:register};
}
