import React, {useState} from 'react';
import {createRoot} from 'react-dom/client';
import {FluentProvider,webLightTheme,webDarkTheme,Button} from '@fluentui/react-components';
import {TemplateEditor} from '../../src/features/generation/TemplateEditor';
import {AccentPicker} from '../../src/features/settings/AccentPicker';
import '../../src/features/generation/generation.css';
function Fixture(){
 const [dark,setDark]=useState(false),[value,setValue]=useState('system:user:{uuid}');
 return <FluentProvider theme={dark?webDarkTheme:webLightTheme}><main style={{padding:16,maxWidth:600}}>
  <Button onClick={()=>setDark(!dark)}>切换主题</Button>
  <AccentPicker value="#336699" onApply={async()=>{}}/>
  <h3>文本模板</h3><TemplateEditor value={value} onChange={setValue}/>
 </main></FluentProvider>;
}
createRoot(document.getElementById('root')!).render(<Fixture/>);
