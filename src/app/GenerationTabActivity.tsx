import { Spinner } from '@fluentui/react-components';
import { DatabaseRegular } from '@fluentui/react-icons';
import { isTaskActive, useTaskStore } from '../stores/useTaskStore';
import './task-center.css';

/** Subscribe to the label only: progress ticks must not rerender the whole tab strip. */
export function GenerationTabActivity({tabId}:{tabId:string}) {
  const label = useTaskStore(state => {
    const task = state.tasks.find(task => task.tabId === tabId && isTaskActive(task));
    return task ? (task.status === 'cancelling' ? '正在停止 · ' : '进行中 · ') + task.label : '';
  });
  return <span className="dw-tab-activity" title={label || undefined} aria-busy={!!label}>
    {label ? <Spinner size="extra-tiny" aria-label={label}/> : <DatabaseRegular fontSize={14}/>}
  </span>;
}
