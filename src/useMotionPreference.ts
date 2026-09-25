import {useEffect,useLayoutEffect,useState} from 'react';
import {useSettingsStore} from './stores/useSettingsStore';

export function useMotionPreference() {
 const mode=useSettingsStore(s=>s.motionMode);
 const [reduced,setReduced]=useState(()=>window.matchMedia('(prefers-reduced-motion: reduce)').matches);
 useEffect(()=>{const media=window.matchMedia('(prefers-reduced-motion: reduce)');const change=()=>setReduced(media.matches);change();media.addEventListener('change',change);return()=>media.removeEventListener('change',change);},[]);
 const effective=mode==='system'?(reduced?'reduced':'full'):mode;
 useLayoutEffect(()=>{document.documentElement.dataset.motion=effective;},[effective]);
 return effective;
}
