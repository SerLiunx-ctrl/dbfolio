const fs=require('node:fs'),ts=require('typescript'),assert=require('node:assert/strict');
const data=new Map(),api={settingsGet:async key=>data.get(key)??null,settingsSet:async(key,value)=>{data.set(key,value);}};
function load(file,mocks={}){const m={exports:{}};new Function('require','module','exports',ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText)(name=>mocks[name]??require(name),m,m.exports);return m.exports;}
(async()=>{
 const {useTabStore:tabs}=load('src/stores/useTabStore.ts',{'../ipc':{api},'./useEditGuard':{confirmEdits:async()=>true,useEditGuard:{getState:()=>({entries:{}})}}});
 tabs.getState().openMongo('a','db','docs');tabs.getState().openMongo('a','db','docs');assert.equal(tabs.getState().tabs.length,1);
 tabs.getState().openMongo('b','db','docs');tabs.getState().openMongo('a','other','docs');assert.equal(tabs.getState().tabs.length,3);
 const h=load('src/features/mongo/history.ts',{'../../ipc':{api}}),query={filter:'{}',projection:'{}',sort:'{}',limit:100};
 await Promise.all(['a','b'].map(sessionId=>h.addMongoHistory({sessionId,database:'db',collection:'docs',query})));
 assert.equal(h.useMongoHistory.getState().items.length,2,'并发历史记录不能互相覆盖');
 const id=h.useMongoHistory.getState().items[0].id;await h.starMongoHistory(id);
 await h.addMongoHistory({sessionId:'c',database:'db',collection:'docs',query});assert.ok(h.useMongoHistory.getState().items.find(i=>i.id===id).favorite);
 const old=data.get('mongo_history_v1');api.settingsSet=async()=>{throw Error('磁盘失败');};await assert.rejects(h.starMongoHistory(id));assert.equal(data.get('mongo_history_v1'),old);assert.ok(h.useMongoHistory.getState().items.find(i=>i.id===id).favorite);
 console.log('通过：MongoDB 页签去重与会话/数据库隔离，历史并发写入、收藏保留及保存失败保护。');
})().catch(e=>{console.error(e);process.exitCode=1;});
