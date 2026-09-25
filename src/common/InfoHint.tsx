import type {ReactNode} from 'react';
import {Button, Tooltip} from '@fluentui/react-components';
import {InfoRegular} from '@fluentui/react-icons';

/** 静态操作帮助；错误、执行状态和确认风险应直接显示。 */
export function InfoHint({label, children}: {label: string; children: ReactNode}) {
  return <Tooltip content={<span style={{whiteSpace:'pre-wrap', overflowWrap:'anywhere'}}>{children}</span>} relationship="description" positioning="above" withArrow>
    <Button appearance="transparent" size="small" icon={<InfoRegular/>} aria-label={label}
      style={{minWidth:24,width:24,height:24,padding:2,flexShrink:0,verticalAlign:'middle'}}/>
  </Tooltip>;
}
