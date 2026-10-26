import { useEffect, useState } from 'react';
import { Button, Checkbox, Dropdown, Field, Input, Option, tokens } from '@fluentui/react-components';
import { revealItemInDir } from '@tauri-apps/plugin-opener';
import { TaskActivity } from '../../app/TaskActivity';
import { errorText } from '../../stores/useTaskStore';
import { checkUpdate, downloadUpdate, installUpdate, loadUpdateStatus, saveUpdatePreferences, useUpdateStore } from './updateStore';
import '../settings/settings.css';

export function UpdatePanel() {
  const { status, available, busy, error, message } = useUpdateStore();
  const [proxy, setProxy] = useState('');
  const [settingsError, setSettingsError] = useState('');
  const [saving, setSaving] = useState(false);
  useEffect(() => { void loadUpdateStatus().catch(error => setSettingsError(errorText(error))); }, []);
  useEffect(() => { if (status) setProxy(status.preferences.proxy); }, [status?.preferences.proxy]);
  const save = async (patch: Partial<NonNullable<typeof status>['preferences']>) => {
    if (!status) return;
    setSaving(true); setSettingsError('');
    try { await saveUpdatePreferences({ ...status.preferences, ...patch }); }
    catch (error) { setSettingsError(errorText(error)); }
    finally { setSaving(false); }
  };
  const disabled = !!busy || saving;
  return <section className="dw-update-panel" aria-label="软件更新">
    <div className="dw-update-current">当前版本：{status?.version ?? '读取中'}</div>
    <div className="dw-update-actions">
      <Button size="small" appearance={!available && !status?.readyVersion ? 'primary' : 'secondary'} disabled={disabled} onClick={() => void checkUpdate()}>{busy === 'check' ? '正在检查…' : '检查更新'}</Button>
      {available && status?.readyVersion !== available.version && <Button size="small" appearance="primary" disabled={disabled} onClick={() => void downloadUpdate()}>下载 {available.version}</Button>}
      {status?.readyVersion && <Button size="small" appearance="primary" disabled={disabled} onClick={() => void installUpdate()}>重启并更新至 {status.readyVersion}</Button>}
    </div>
    {(message || error || settingsError) && <div role={error || settingsError ? 'alert' : 'status'} style={{ color: error || settingsError ? tokens.colorPaletteRedForeground1 : undefined, overflowWrap: 'anywhere' }}>{settingsError || error || message}</div>}
    {busy === 'download' && <TaskActivity kind="更新" />}
    {available && <div>
      <strong>新版本 {available.version}</strong>
      <details className="dw-update-notes"><summary>新版更新说明</summary><div>{available.notes || '此版本未提供更新说明。'}</div></details>
    </div>}
    <Checkbox size="medium" checked={status?.preferences.automatic ?? false} disabled={!status || disabled} label="自动检查更新" onChange={(_, data) => void save({ automatic: !!data.checked })} />
    <details className="dw-update-settings">
      <summary>更新设置</summary>
      <div className="dw-update-settings-body">
        <div className="dw-update-setting-row"><span>更新通道</span>
          <Dropdown size="small" aria-label="更新通道" value={status?.preferences.channel === 'stable' ? '稳定版' : '预览版'} selectedOptions={[status?.preferences.channel ?? 'preview']} disabled={!status || disabled} onOptionSelect={(_, data) => void save({ channel: data.optionValue as 'stable' | 'preview', skipped: '' })}>
            <Option value="stable">稳定版</Option><Option value="preview">预览版（alpha / beta）</Option>
          </Dropdown>
        </div>
        <Field size="small" label="代理地址"><div className="dw-update-proxy">
          <Input size="small" aria-label="更新代理" value={proxy} placeholder="留空使用默认网络" disabled={disabled} onChange={(_, data) => setProxy(data.value)} />
          <Button size="small" disabled={!status || disabled || proxy === status.preferences.proxy} onClick={() => void save({ proxy })}>保存</Button>
        </div></Field>
        <div className="dw-update-actions">
          {available && <Button size="small" disabled={disabled} onClick={() => void save({ skipped: available.skipped ? '' : available.version })}>{available.skipped ? '恢复此版本提醒' : '跳过此版本提醒'}</Button>}
          {status && <Button size="small" disabled={!!busy} onClick={() => void revealItemInDir(status.logPath).catch(error => setSettingsError(errorText(error)))}>打开更新文件夹</Button>}
        </div>
        {!!status?.preferences.lastCheck && <span className="dw-update-meta">上次检查：{new Date(status.preferences.lastCheck * 1000).toLocaleString('zh-CN')}</span>}
      </div>
    </details>
  </section>;
}
