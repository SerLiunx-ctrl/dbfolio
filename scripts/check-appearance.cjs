const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const data=new Map([['ui_sidebar_width','350']]);
const api={settingsGet:async key=>data.get(key)??null,settingsSet:async(key,value)=>{data.set(key,value);},systemAccentColor:async()=>'#0f6cbd'};
function load(file,mocks={}){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(name=>mocks[name]??require(name),m,m.exports);return m.exports;}
(async()=>{
 const {useSettingsStore:store,INTERFACE_STYLES}=load('src/stores/useSettingsStore.ts',{'../ipc':{api}});
 await store.getState().load();assert.equal(store.getState().rightSidebarWidth,350);
 assert.equal(store.getState().density,'compact','旧设置默认使用紧凑密度');
 await store.getState().setDensity('comfortable');await store.getState().load();assert.equal(store.getState().density,'comfortable','密度重启恢复');
 const save=api.settingsSet;api.settingsSet=async()=>{throw Error('模拟保存失败');};
 await assert.rejects(store.getState().setDensity('compact'));assert.equal(store.getState().density,'comfortable','保存失败保持当前密度');
 api.settingsSet=save;data.set('ui_density','invalid');await store.getState().load();assert.equal(store.getState().density,'compact');
 store.getState().setSidebarWidth(260);assert.equal(store.getState().rightSidebarWidth,350);
 await store.getState().load();assert.equal(store.getState().sidebarWidth,260);assert.equal(store.getState().rightSidebarWidth,350,'重启迁移后右侧不跟随左侧');
 store.getState().setRightSidebarWidth(420);assert.equal(store.getState().sidebarWidth,260);
 await store.getState().load();assert.equal(store.getState().rightSidebarWidth,420);
 for(const item of INTERFACE_STYLES){await store.getState().setInterfaceStyle(item.value);await store.getState().load();assert.equal(store.getState().interfaceStyle,item.value);}
 assert.equal(INTERFACE_STYLES.length,9);data.set('ui_interface_style','invalid');await store.getState().load();assert.equal(store.getState().interfaceStyle,'aurora');
 const {surfaceColors,SURFACE_PALETTES}=load('src/appearance.ts');assert.equal(Object.keys(SURFACE_PALETTES).length,6);
 function lum(hex){const c=[1,3,5].map(i=>parseInt(hex.slice(i,i+2),16)/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4);return c[0]*.2126+c[1]*.7152+c[2]*.0722;}
 for(const style of Object.keys(SURFACE_PALETTES))for(const dark of [false,true]){const p=surfaceColors(style,dark);for(const ink of [p.foreground,p.muted]){const a=lum(ink),b=lum(p.surface);assert.ok((Math.max(a,b)+.05)/(Math.min(a,b)+.05)>=4.5,style+'文字对比度');}}
 console.log('通过：左右宽度独立修改/迁移/恢复，9种风格持久化，6套亮暗配色文字对比度。');
})().catch(e=>{console.error(e);process.exitCode=1;});
