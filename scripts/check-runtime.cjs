const fs = require('node:fs'), path = require('node:path'), ts = require('typescript'), assert = require('node:assert/strict');
global.window = { setInterval, clearInterval };
const cache = new Map(), api = {}, backend = new Map();
let execute;
async function invoke(command, args) {
  if (command === 'task_begin') { backend.set(args.id, { processed: 0, total: null, message: '', cancelRequested: false }); return; }
  if (command === 'task_cancel') { backend.get(args.id).cancelRequested = true; return; }
  if (command === 'task_progress') return backend.get(args.id);
  if (command === 'task_release') { backend.delete(args.id); return; }
  return execute(command, args);
}
function load(file) {
  file = path.resolve(file);
  if (file.endsWith(path.join('src','ipc.ts'))) return { api };
  if (cache.has(file)) return cache.get(file).exports;
  const mod={exports:{}};cache.set(file,mod);
  const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  new Function('require','module','exports',code)(name => name === '@tauri-apps/api/core' ? { invoke } : name.startsWith('.') ? load(path.resolve(path.dirname(file),name)+'.ts') : require(name),mod,mod.exports);
  return mod.exports;
}
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
(async()=>{
  const {progressDisplay}=load('src/app/taskProgress.ts');
  assert.equal(progressDisplay(40,100).value,0.4);assert.equal(progressDisplay(40,100).percent,40);
  assert.equal(progressDisplay(3,null).value,undefined);assert.equal(progressDisplay(0,0).percent,undefined);
  assert.equal(progressDisplay(-10,100).value,0);assert.equal(progressDisplay(120,100).value,1);
  assert.equal(progressDisplay(NaN,100).value,0);assert.equal(progressDisplay(1,Infinity).value,undefined);
  console.log('通过：任务进度百分比、未知总量和越界值处理。');
  const {useSessionStore: store}=load('src/stores/useSessionStore.ts');
  const {useTaskStore, cancelTask}=load('src/stores/useTaskStore.ts');
  let connection=deferred(), connects=0;
  api.connectSession=()=>{connects++;return connection.promise;};
  let reentered;const unsubscribe=store.subscribe(state=>{if(state.phases.s?.state==='connecting')reentered=state.connect('s');});
  const a=store.getState().connect('s'),b=store.getState().connect('s');
  unsubscribe();assert.equal(reentered,a,'状态订阅重入时也必须共享请求');
  assert.equal(a,b);await Promise.resolve();assert.equal(connects,1);assert.equal(store.getState().phases.s.state,'connecting');
  connection.resolve({sessionId:'s',connected:true});await a;
  await store.getState().connect('s');assert.equal(connects,1,'已连接会话不能重复发起连接');
  const health=deferred();api.sessionHealth=()=>health.promise;
  const probe=store.getState().checkHealth('s');
  const beforeRefresh=store.getState().statuses.s;
  api.listSessions=async()=>[];api.sessionStatuses=async()=>[{sessionId:'s',connected:true}];
  await store.getState().load();assert.equal(store.getState().statuses.s,beforeRefresh,'普通刷新应保留健康探测所依据的连接身份');
  api.disconnectSession=async()=>{};await store.getState().disconnect('s');
  connection=deferred();const reconnect=store.getState().connect('s');connection.resolve({sessionId:'s',connected:true,serverVersion:'new'});await reconnect;
  health.reject(Error('旧连接超时'));await probe;
  assert.equal(store.getState().statuses.s.serverVersion,'new','过期探测不能覆盖重连结果');
  api.sessionHealth=async()=>{throw Error('网络断开');};await store.getState().checkHealth('s');
  assert.equal(store.getState().statuses.s,undefined);assert.equal(store.getState().phases.s.lost,true);
  connection=deferred();const retry=store.getState().connect('s');const retry2=store.getState().connect('s');assert.equal(retry,retry2);connection.reject(Error('认证失败'));await assert.rejects(retry);
  assert.equal(store.getState().phases.s.state,'disconnected');
  connection=deferred();const recovered=store.getState().connect('s');connection.resolve({sessionId:'s',connected:true});await recovered;
  const disconnectGate=deferred();api.disconnectSession=()=>disconnectGate.promise;
  const disconnecting=store.getState().disconnect('s');await assert.rejects(store.getState().connect('s'),/等待/);disconnectGate.resolve();await disconnecting;
  connection=deferred();const back=store.getState().connect('s');connection.resolve({sessionId:'s',connected:true});await back;
  console.log('通过：连接去重、连接中状态、失败重试、断线检测与过期探测隔离。');
  const {trackedInvoke}=load('src/ipc/taskInvoke.ts');
  let work=deferred();execute=()=>work.promise;
  let operation=trackedInvoke('import_csv',{request:{sessionId:'s',table:'items'}});
  await new Promise(setImmediate);
  let task=useTaskStore.getState().tasks[0];backend.get(task.id).processed=500;backend.get(task.id).message='已提交 500 行';
  await cancelTask(task.id);assert.equal(useTaskStore.getState().tasks[0].status,'cancelling');
  assert.equal(useTaskStore.getState().tasks[0].endedAt,undefined,'取消请求不能提前报告结束');
  work.reject({code:'E_CANCELLED',message:'已取消'});await assert.rejects(operation);
  task=useTaskStore.getState().tasks[0];assert.equal(task.status,'cancelled');assert.equal(task.progress.processed,500);assert.equal(backend.size,0);
  execute=async()=>({inserted:500,skipped:2,error:'第二批失败'});await trackedInvoke('import_csv',{request:{sessionId:'s'}});
  assert.equal(useTaskStore.getState().tasks[0].status,'error');assert.match(useTaskStore.getState().tasks[0].result,/500/);
  work=deferred();execute=()=>work.promise;operation=trackedInvoke('export_data',{request:{sessionId:'s'}});await new Promise(setImmediate);
  task=useTaskStore.getState().tasks[0];await cancelTask(task.id);work.resolve({rows:42,path:'result.csv'});await operation;
  assert.equal(useTaskStore.getState().tasks[0].status,'success','取消太晚时按真实结果报告成功');
  assert.equal(backend.size,0);
  console.log('通过：取消等待真实结果、已提交数量保留、部分失败、完成与取消竞争、任务释放。');
})().catch(error=>{console.error(error);process.exitCode=1;});
