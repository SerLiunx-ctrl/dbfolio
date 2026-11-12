import { useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { FluentProvider, webLightTheme, webDarkTheme } from '@fluentui/react-components';
import { AppToaster, useNotify } from '../../src/app/toast';
import '../../src/styles.css';
import '../../src/compact.css';
import '../../src/motion.css';

const params = new URLSearchParams(location.search);
const motion = params.get('motion');
if (motion) document.documentElement.dataset.motion = motion;
function Fixture() {
  const notify = useNotify();
  useEffect(() => { Object.assign(window, { notify }); }, [notify]);
  return <><button id="outside">工作区</button><AppToaster /></>;
}
const dark = params.get('theme') === 'dark';
createRoot(document.getElementById('root')!).render(<FluentProvider theme={dark ? webDarkTheme : webLightTheme}><Fixture /></FluentProvider>);
