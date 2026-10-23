import {create} from 'zustand';
import {invoke} from '@tauri-apps/api/core';
import {trackedInvoke} from '../../ipc/taskInvoke';
import {errorText,isTaskActive,useTaskStore} from '../../stores/useTaskStore';
import {confirmEdits} from '../../stores/useEditGuard';
import {flushWorkspace} from '../../stores/useWorkspace';
import {flushWindowState} from '../../app/windowState';
import {flushLayoutPresets} from '../../stores/useLayoutPresets';
import {flushDockLayout} from '../../stores/useDockStore';

export interface UpdatePreferences {automatic:boolean;channel:'stable'|'preview';skipped:string;lastCheck:number;proxy:string}
export interface UpdateStatus {version:string;distribution:'development'|'installed'|'portable';preferences:UpdatePreferences;logPath:string;readyVersion:string|null}
export interface AvailableUpdate {version:string;notes:string;date:string|null;skipped:boolean;size:number|null}
interface UpdateStore {status:UpdateStatus|null;available:AvailableUpdate|null;busy:'check'|'download'|'prepare'|'install'|null;error:string;message:string;open:boolean;notice:boolean}
export const useUpdateStore=create<UpdateStore>(()=>({status:null,available:null,busy:null,error:'',message:'',open:false,notice:false}));
let loading:Promise<void>|undefined;
export function loadUpdateStatus(){
  if(loading)return loading;
  loading=invoke<UpdateStatus>('updater_status').then(status=>{useUpdateStore.setState({status});}).finally(()=>{loading=undefined;});
  return loading;
}
export async function saveUpdatePreferences(value:UpdatePreferences){
  if(useUpdateStore.getState().busy)throw Error('更新操作正在进行');
  await invoke('updater_preferences',{value});await loadUpdateStatus();
  useUpdateStore.setState({available:null,error:'',message:''});
}
export async function checkUpdate(automatic=false){
  if(useUpdateStore.getState().busy)return;
  useUpdateStore.setState({busy:'check',error:'',message:''});
  try{
    const available=await invoke<AvailableUpdate|null>('updater_check');await loadUpdateStatus();
    useUpdateStore.setState({available,message:available?'':'当前没有可用的新版本',notice:automatic?!!available&&!available.skipped:false});
  }catch(error){useUpdateStore.setState({error:errorText(error)});}
  finally{useUpdateStore.setState({busy:null});}
}
export async function downloadUpdate(){
  if(useUpdateStore.getState().busy)return;
  useUpdateStore.setState({busy:'download',error:'',message:''});
  try{await trackedInvoke('updater_download');await loadUpdateStatus();useUpdateStore.setState({message:'下载完成，签名验证通过。可在方便时重启更新。'});}
  catch(error){useUpdateStore.setState({error:errorText(error)});}
  finally{useUpdateStore.setState({busy:null});}
}
export async function installUpdate(){
  if(useUpdateStore.getState().busy)return;
  useUpdateStore.setState({busy:'prepare',error:''});
  try{
    const idle=()=>{if(useTaskStore.getState().tasks.some(isTaskActive))throw Error('请先等待运行中的查询和后台任务结束，再安装更新。');};
    idle();if(!await confirmEdits())return;
    useUpdateStore.setState({busy:'install'});
    await flushWorkspace();await flushWindowState();await flushLayoutPresets();await flushDockLayout();idle();
    await invoke('updater_install');
  }catch(error){useUpdateStore.setState({error:errorText(error)});}
  finally{useUpdateStore.setState({busy:null});}
}
