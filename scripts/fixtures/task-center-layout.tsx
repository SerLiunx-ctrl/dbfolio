import {createRoot} from 'react-dom/client';
import {FluentProvider} from '@fluentui/react-components';
import {TaskCenter} from '../../src/app/TaskCenter';
import {AppToaster} from '../../src/app/toast';
import {buildTheme} from '../../src/theme';
import {useTaskStore,updateTask,type WorkTask} from '../../src/stores/useTaskStore';
import {useTabStore} from '../../src/stores/useTabStore';
import {useSessionStore} from '../../src/stores/useSessionStore';
import '../../src/styles.css';import '../../src/compact.css';
const w=window as any,p=new URLSearchParams(location.search),mode=p.get('theme')??'light',zoom=Number(p.get('zoom')??1);
document.documentElement.dataset.density='compact';document.documentElement.dataset.oled=String(mode==='oled');
w.calls=[];w.store=useTaskStore;w.tabs=useTabStore;w.update=updateTask;
w.__TAURI_INTERNALS__={invoke:async(command:string,args:any)=>{w.calls.push({command,args});if(command==='task_cancel'){if(w.failCancel)throw {message:'取消通道不可用'};return;}if(command==='clipboard_write_text')return;throw Error(command);}};
useSessionStore.setState({sessions:[{id:'s',name:'本机',engine:'mysql'} as any],statuses:{}});
useTabStore.setState({tabs:[{id:'source',kind:'query',sessionId:'s',database:'test',title:'来源查询'} as any],activeId:null});
const now=Date.now();const base={sessionIds:['s'],startedAt:now-91300,tabId:'source'};
const tasks:WorkTask[]=[{...base,id:'done',kind:'导出',label:'已结束的导出',status:'success',endedAt:now,result:'导出完成'},
{...base,id:'run',kind:'生成',label:'生成测试数据',status:'running',progress:{processed:80,total:100,message:'正在请求 AI 生成第 81–90 条 / 共 100 条（2 个 AI 字段）',cancelRequested:false}},
{...base,id:'unknown',kind:'AI',label:'AI 生成任务 · '+ '超长中文任务名称'.repeat(10),status:'running',progress:{processed:3,total:null,message:'正在等待服务返回\n'+'长阶段说明'.repeat(100),cancelRequested:false}},
{...base,id:'stopping',kind:'同步',label:'同步任务',status:'cancelling'},
{...base,id:'failed',tabId:'closed',kind:'导入',label:'导入任务',status:'error',endedAt:now,error:'数据库错误：'+ '错误详情与文件位置\n'.repeat(70)},
{...base,id:'cancelled',kind:'生成',label:'已取消的任务',status:'cancelled',endedAt:now,error:'用户已取消'},
{...base,id:'front',kind:'查询',label:'普通前台查询',status:'running'}];
w.reset=()=>useTaskStore.setState({tasks:structuredClone(tasks)});w.reset();
createRoot(document.getElementById('root')!).render(<FluentProvider theme={buildTheme(mode!=='light','#d65b16',mode==='oled'?'oled':'classic')} style={{minHeight:'100vh'}}><AppToaster/><TaskCenter/></FluentProvider>);
