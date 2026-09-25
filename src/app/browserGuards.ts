export function installBrowserGuards(target: Window = window) {
  const context = (e: Event) => e.preventDefault();
  const key = (e: KeyboardEvent) => {
    const k = e.key.toLowerCase();
    const ctrl = e.ctrlKey || e.metaKey;
    const browser = ['f5', 'f11', 'f12'].includes(k)
      || (ctrl && ['r','p','s','o','l','n','t','w','u','+','-','=','0'].includes(k))
      || (ctrl && e.shiftKey && ['i','j','c','delete'].includes(k))
      || (e.altKey && ['arrowleft','arrowright','home'].includes(k));
    const element = e.target instanceof Element ? e.target : null;
    if (browser || (k === 'backspace' && !element?.closest('input,textarea,[contenteditable="true"],.monaco-editor'))) e.preventDefault();
    // Keep propagation: application save, quick-open and zoom handlers still run.
  };
  const mouse = (e: MouseEvent) => { if (e.button === 3 || e.button === 4) e.preventDefault(); };
  const files = (e: DragEvent) => { if (e.dataTransfer?.types.includes('Files')) e.preventDefault(); };
  const wheel = (e: WheelEvent) => { if (e.ctrlKey || e.metaKey) e.preventDefault(); };
  const link = (e: MouseEvent) => { if ((e.target as Element)?.closest?.('a[href]')) e.preventDefault(); };
  target.addEventListener('contextmenu', context, true);
  target.addEventListener('keydown', key, true);
  target.addEventListener('mouseup', mouse, true);
  target.addEventListener('auxclick', mouse, true);
  target.addEventListener('dragover', files, true);
  target.addEventListener('drop', files, true);
  target.addEventListener('wheel', wheel, {capture:true, passive:false});
  target.addEventListener('click', link, true);
  return () => {
    target.removeEventListener('contextmenu', context, true); target.removeEventListener('keydown', key, true);
    target.removeEventListener('mouseup', mouse, true); target.removeEventListener('auxclick', mouse, true);
    target.removeEventListener('dragover', files, true); target.removeEventListener('drop', files, true);
    target.removeEventListener('wheel', wheel, true); target.removeEventListener('click', link, true);
  };
}
