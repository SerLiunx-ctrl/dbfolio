const fs=require('node:fs'),path=require('node:path'),ts=require('typescript'),assert=require('node:assert/strict');
global.crypto=require('node:crypto').webcrypto;
const cache=new Map(),settings=new Map();let fail=false;let generationInvoke;
const api={settingsGet:async k=>settings.get(k)??null,settingsSet:async(k,v)=>{if(fail)throw Error('disk failed');settings.set(k,v);}};
function load(file){file=path.resolve(file);if(file.endsWith(path.join('src','ipc.ts')))return{api};if(file.endsWith(path.join('src','ipc','taskInvoke.ts')))return{trackedInvoke:async(command,args)=>{if(generationInvoke)return generationInvoke(command,args);throw Error('unexpected IPC');}};if(cache.has(file))return cache.get(file).exports;const mod={exports:{}};cache.set(file,mod);const code=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText;new Function('require','module','exports',code)(name=>name.startsWith('.')?load(path.resolve(path.dirname(file),name)+'.ts'):require(name),mod,mod.exports);return mod.exports;}
(async()=>{
 const model=load('src/features/generation/model.ts');
 assert.equal(model.defaultRules({engine:'redis',fields:[]},null)[0].args.pattern,'test:${prefix}:{uuid}');
 const randomId=model.newRule('id','random_uuid');assert.deepEqual(model.directAiFields([randomId],{engine:'mysql',fields:[]}),[randomId]);
 assert.equal(model.defaultRules({engine:'postgres',fields:[{name:'id',kind:'uuid',generated:false,defaultValue:null}]},null)[0].kind,'random_uuid');
 const catalog=load('src/features/generation/templateCatalog.ts');assert(catalog.TEMPLATE_VARIABLES.some(v=>v.token==='{uuid}'));assert(catalog.TEMPLATE_PRESETS.some(p=>p.pattern==='system:user:{uuid}'));
const field={name:'id',rawType:'bigint',kind:'int',nullable:false,generated:false,unique:true,defaultValue:null,comment:null};
 assert.equal(model.defaultRules({engine:'mysql',fields:[field]},null)[0].kind,'sequence');assert.equal(model.defaultRules({engine:'mysql',fields:[{...field,generated:true}]},null)[0].kind,'omit');
 const a=model.newRule('a','choice'),b=model.newRule('b','choice');a.args.values.push('other');assert.equal(b.args.values.length,3,'新建规则不能共享可变候选值');
 const template={version:1,id:'old',name:'测试',engine:'mysql',fields:[model.newRule('id','sequence')],count:100,seed:'seed',parameters:{prefix:'sample'},redisKind:null,ttlSeconds:null,apiKey:'not-exportable',target:{host:'not-exportable'}};
 const clean=model.validateTemplate(template);assert.equal(clean.apiKey,undefined);assert.equal(clean.target,undefined);assert.notEqual(clean.id,'old');assert.throws(()=>model.validateTemplate({...template,count:100001}));assert.throws(()=>model.validateTemplate({...template,fields:[{...a,kind:'javascript'}]}));assert.throws(()=>model.validateTemplate({...template,parameters:{prefix:123}}));

 const description={engine:'mysql',fields:[field,{...field,name:'generated',generated:true},{...field,name:'blob',kind:'binary'}]};
 const localFields=[model.newRule('id','sequence'),model.newRule('generated','text'),model.newRule('blob','null'),model.newRule('title','text'),model.newRule('price','decimal'),model.newRule('default','omit'),model.newRule('uuid','uuid'),model.newRule('objectId','objectId'),model.newRule('slug','compute',{op:'concat',fields:['title']})];
 const original={version:1,count:12,seed:'1',fields:localFields,parameters:{},target:{},ai:{providerId:'p',model:'m',prompt:'生成自然的商品描述'}};
 const direct=model.prepareDirectAiPlan(original,description);
 assert.deepEqual(direct.fields.filter(f=>f.kind==='ai').map(f=>f.name),['title','price'],'直接生成自动选择业务字段');
 assert.equal(original.fields[3].kind,'text','构建 AI 方案不修改原方案');
 assert.equal(direct.ai.prompt,original.ai.prompt);assert.equal(direct.count,12);
 assert.deepEqual(direct.fields.filter(f=>f.kind!=='ai'),localFields.filter(f=>!['title','price'].includes(f.name)),'数据库生成、默认值和标识符保留');
 assert.throws(()=>model.prepareDirectAiPlan({...original,ai:null},description),/AI 服务/);
 assert.throws(()=>model.prepareDirectAiPlan({...original,ai:{...original.ai,prompt:'  '}},description),/生成要求/);
 assert.throws(()=>model.prepareDirectAiPlan({...original,count:2001},description),/2000/);
 assert.throws(()=>model.prepareDirectAiPlan({...original,fields:[localFields[0]]},description),/没有可由 AI/);
 const redisFields=model.directAiFields(model.defaultRules({engine:'redis',fields:[]},'hash'),{engine:'redis',fields:[]});
 assert.equal(redisFields[0].kind,'text');assert.equal(redisFields[1].kind,'ai');
 const custom=model.newRule('profile.name','ai',{prompt:'保留字段要求'});custom.unique=true;
 assert.deepEqual(model.directAiFields([custom],{engine:'mongodb',fields:[]}),[custom]);
 const nullable=model.newRule('title','text');nullable.nullPercent=20;nullable.unique=true;
 const converted=model.directAiFields([nullable],description)[0];assert.equal(converted.nullPercent,0);assert.equal(converted.unique,true);
 console.log('通过：AI 直接生成字段选择、原方案隔离、参数验证、Redis 键保护和 MongoDB 自定义字段。');

 const progress=load('src/features/generation/progress.ts');let live=progress.newTrace(120);
 live=progress.reduceGenerationEvent(live,{kind:'batch',start:1,end:10,total:120});
 live=progress.reduceGenerationEvent(live,{kind:'delta',text:'x'.repeat(70000)});assert.equal(live.raw.length,65536);assert.equal(live.characters,70000);
 for(let n=1;n<=100;n++)live=progress.reduceGenerationEvent(live,{kind:'validated',number:n,row:{title:'text'.repeat(200)}});
 assert.equal(live.rows.length,100);assert.equal(live.rows[0].cells.title.length,500);
 live=progress.reduceGenerationEvent(live,{kind:'rejected',number:104,row:{title:'duplicate'},message:'唯一约束失败'});assert.equal(live.count,103);assert.equal(live.rejected.number,104);
 const failed={...live,status:'error'};assert.equal(progress.reduceGenerationEvent(failed,{kind:'delta',text:'late'}),failed,'结束后的迟到事件不能修改现场');
 live=progress.reduceGenerationEvent(live,{kind:'batch',start:111,end:120,total:120});assert.equal(live.raw,'');assert.equal(live.rows.length,100);
 console.log('通过：流式现场缓冲上限、已校验预览、失败行和迟到事件隔离。');
 const response={text:'response',diagnostic:'',format:'AI 正文',status:200,receivedBytes:100,contentBytes:8,truncated:false};
 let archives=progress.newTrace(300);
 for(let n=1;n<=25;n++){archives=progress.reduceGenerationEvent(archives,{kind:'batch',start:n,end:n,total:300});archives=progress.reduceGenerationEvent(archives,{kind:'response',snapshot:response});}
 assert.equal(archives.responses.length,20);assert.equal(archives.evictedResponses,5);assert.equal(archives.responses.at(-1).start,25);
 archives=progress.reduceGenerationEvent(archives,{kind:'response',snapshot:{...response,text:'x'.repeat(3*1024*1024)}});
 assert.equal(archives.responses.at(-1).truncated,true);assert.equal(archives.responses.at(-1).text.length,2*1024*1024);
 archives=progress.reduceGenerationEvent(archives,{kind:'response',snapshot:{...response,text:'y'.repeat(2*1024*1024)}});
 assert(archives.responses.reduce((n,r)=>n+r.text.length+r.diagnostic.length,0)<=4*1024*1024);
 console.log('通过：AI 响应按批次保留、数量/内存上限与截断标识。');


 const oldWindow=global.window;global.window={__TAURI_INTERNALS__:{transformCallback:()=>1}};
 const delivered=[];generationInvoke=async(command,args)=>{assert.equal(command,'generation_generate');setTimeout(()=>{args.onEvent.onmessage({kind:'delta',text:'最后片段'});args.onEvent.onmessage({kind:'finished'});},20);throw Error('流末尾失败');};
 await assert.rejects(model.generationApi.generate(original,e=>delivered.push(e)),/流末尾失败/);assert.equal(delivered[0].text,'最后片段','命令失败后应等待有序通道交付现场再展示终态');
 generationInvoke=undefined;global.window=oldWindow;
 console.log('通过：生成失败响应先于最后流事件时，依然保留完整现场。');
 const library=load('src/features/generation/templates.ts');await Promise.all([library.storeTemplate({...clean,id:'a'}),library.storeTemplate({...clean,id:'b'})]);assert.equal(library.useGenerationTemplates.getState().items.length,2);fail=true;await assert.rejects(library.deleteTemplate('a'));assert.equal(library.useGenerationTemplates.getState().items.length,2);fail=false;await library.deleteTemplate('a');assert.deepEqual(library.useGenerationTemplates.getState().items.map(t=>t.id),['b']);
 const tabs=load('src/stores/useTabStore.ts').useTabStore,sessions=load('src/stores/useSessionStore.ts').useSessionStore,workspace=load('src/stores/useWorkspace.ts');sessions.setState({sessions:[{id:'s',engine:'mysql'}],activeSessionId:'s'});const stop=await workspace.initializeWorkspace(e=>{throw e;});const target={sessionId:'s',database:'db',schema:null,object:'items',redisKind:null,ttlSeconds:null};tabs.getState().openGeneration(target);const id=tabs.getState().activeId;const plan={version:1,target,count:100,seed:'seed',fields:clean.fields,parameters:{prefix:'p'},ai:{providerId:'id',model:'model',prompt:'规则要求'}};workspace.useWorkspace.setState({generationPlans:{[id]:plan}});await workspace.flushWorkspace();const snapshot=JSON.parse(settings.get('workspace_v1'));assert.equal(snapshot.tabs[0].kind,'generation');assert.deepEqual(snapshot.generationPlans[id],plan);stop();tabs.setState({tabs:[],activeId:null});workspace.useWorkspace.setState({generationPlans:{}});const stop2=await workspace.initializeWorkspace(e=>{throw e;});assert.equal(tabs.getState().activeId,id);assert.deepEqual(workspace.useWorkspace.getState().generationPlans[id],plan);stop2();
 console.log('通过：规则独立性、主键/自动生成列默认规则、模板格式与凭据隔离、并发保存/失败回滚、生成页签和方案重启恢复。');
})().catch(e=>{console.error(e);process.exitCode=1;});
