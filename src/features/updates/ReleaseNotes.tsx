import Markdown from 'react-markdown';
import { openUrl } from '@tauri-apps/plugin-opener';
import { useNotify } from '../../app/toast';

function externalUrl(value:string|undefined) {
  if(!value)return null;
  try { const url=new URL(value);return (url.protocol==='https:'||url.protocol==='http:')&&!url.username&&!url.password?url.href:null; }
  catch { return null; }
}

export function ReleaseNotes({text}:{text:string}) {
  const notify=useNotify();
  return <div className="dw-release-notes"><Markdown skipHtml urlTransform={url=>externalUrl(url)??''} components={{
    a:({href,children})=>{
      const url=externalUrl(href);
      return url?<a href={url} onClick={event=>{event.preventDefault();void openUrl(url).catch(e=>notify.error(e,'打开链接失败'));}}>{children}</a>:<span>{children}</span>;
    },
    // 发布说明只呈现文字；不执行 HTML，也不自动请求外部图片。
    img:({alt})=><span>{alt??'图片'}</span>,
  }}>{text||'此版本未提供更新说明。'}</Markdown></div>;
}
