import { useEffect, useRef, useState, type FocusEvent } from 'react';
import { Button, Checkbox, Dialog, DialogActions, DialogBody, DialogContent, DialogSurface, DialogTitle, Field, Input, Spinner } from '@fluentui/react-components';
import { AddRegular, ArrowSyncRegular, CheckmarkRegular, DeleteRegular, EditRegular, PlugConnectedRegular, SaveRegular } from '@fluentui/react-icons';
import { InfoHint } from '../../common/InfoHint';
import { generationApi, type Provider } from '../generation/model';
import { errorText } from '../../stores/useTaskStore';
import '../generation/generation.css';
import './ai-settings.css';

const efforts = [['none', '关闭'], ['minimal', '最低'], ['low', '低'], ['medium', '中'], ['high', '高'], ['xhigh', '极高'], ['max', '最高']] as const;
const fresh = (): Provider => ({ id: crypto.randomUUID(), name: '', baseUrl: 'https://api.openai.com/v1', model: '', outputFormat: 'json', tokenParameter: 'max_tokens', timeoutSeconds: 60, maxTokens: 4096, reasoningEffort: null, temperature: null, topP: null, isDefault: false, hasKey: false });
const effortLabel = (p: Provider) => efforts.find(([value]) => value === p.reasoningEffort)?.[1] ?? '服务默认';

export function AiSettings() {
  const [providers, setProviders] = useState<Provider[]>([]);
  const [draft, setDraft] = useState<Provider | null>(null);
  const [editorOpen, setEditorOpen] = useState(false);
  const [key, setKey] = useState<string | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [modelState, setModelState] = useState<'idle' | 'ready' | 'fallback'>('idle');
  const [modelError, setModelError] = useState('');
  const [modelLoading, setModelLoading] = useState(false);
  const [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [error, setError] = useState('');
  const [dirty, setDirty] = useState(false), [discarding, setDiscarding] = useState(false);
  const [removing, setRemoving] = useState<Provider | null>(null);
  const [search, setSearch] = useState('');
  const lock = useRef(false), mounted = useRef(true);
  const modelRevision = useRef(0);
  const run = async (work: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(true); setError(''); setMessage('');
    try { await work(); } catch (e) { if (mounted.current) setError(errorText(e)); }
    finally { lock.current = false; if (mounted.current) setBusy(false); }
  };
  useEffect(() => { mounted.current = true; void run(async () => { const list = await generationApi.providers(); if (mounted.current) setProviders(list); }); return () => { mounted.current = false; }; }, []);
  const patch = (value: Partial<Provider>) => { setDraft(current => current ? { ...current, ...value } : current); setDirty(true); };
  const resetModels = () => { modelRevision.current++; setModelLoading(false); setModels([]); setModelState('idle'); setModelError(''); };
  const loadModels = async (provider: Provider, apiKey: string | null) => {
    const revision = ++modelRevision.current;
    setModelError(''); setModelLoading(true);
    try {
      // Listing only needs connection details, not a model or edited generation parameters.
      const list = await generationApi.models({ ...fresh(), id: provider.id, name: provider.name.trim() || '新模型配置', baseUrl: provider.baseUrl.trim() }, apiKey);
      if (!mounted.current || revision !== modelRevision.current) return;
      setModels(list); setModelState(list.length ? 'ready' : 'fallback');
      if (!list.length) setModelError('服务返回空模型列表，请手动填写模型 ID。');
      else if (!provider.model && list.length === 1) patch({ model: list[0] });
    } catch (e) { if (mounted.current && revision === modelRevision.current) { setModels([]); setModelState('fallback'); setModelError(`获取模型列表失败，可手动填写模型 ID。${errorText(e)}`); } }
    finally { if (mounted.current && revision === modelRevision.current) setModelLoading(false); }
  };
  const openEditor = (provider: Provider) => {
    setDraft({ ...provider }); setEditorOpen(true); setKey(null); setDirty(false); resetModels(); setError(''); setMessage('');
    if (providers.some(p => p.id === provider.id)) void loadModels(provider, null);
  };
  // Keep the last form during the close animation so its size and title stay stable.
  const closeEditor = () => { modelRevision.current++; setModelLoading(false); setEditorOpen(false); setKey(null); setDirty(false); setDiscarding(false); setError(''); };
  const requestClose = () => { if (!busy) { if (dirty) setDiscarding(true); else closeEditor(); } };
  const connectionBlur = (event: FocusEvent<HTMLInputElement>) => {
    // Let a key edit or an explicit action finish before starting discovery.
    if ((event.relatedTarget as HTMLElement | null)?.closest('button,.dw-ai-key')) return;
    if (draft && modelState === 'idle' && /^https?:\/\//i.test(draft.baseUrl.trim())) void loadModels(draft, key);
  };
  const valid = !!draft && !!draft.name.trim() && !!draft.baseUrl.trim() && !!draft.model.trim()
    && Number.isInteger(draft.maxTokens) && draft.maxTokens >= 128 && draft.maxTokens <= 128000
    && Number.isInteger(draft.timeoutSeconds) && draft.timeoutSeconds >= 5 && draft.timeoutSeconds <= 300
    && (draft.temperature == null || Number.isFinite(draft.temperature) && draft.temperature >= 0 && draft.temperature <= 2)
    && (draft.topP == null || Number.isFinite(draft.topP) && draft.topP >= 0 && draft.topP <= 1);
  const rows = providers.filter(p => `${p.name} ${p.model} ${p.baseUrl}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase()));
  const status = <>{busy && <Spinner size="tiny" label="处理中，可在任务中心取消网络请求" />}{message && <p role="status">{message}</p>}{error && <p role="alert" className="gen-error">{error}</p>}</>;

  return <div className="dw-generation dw-ai-settings dw-ai-manager">
    <div className="dw-ai-list-heading"><h2>AI 服务</h2><InfoHint label="AI 模型配置说明">每条配置对应一个模型；同一服务可配置多个模型及参数。兼容 OpenAI Chat Completions 接口，密钥仅保存在 Windows 凭据管理器。</InfoHint><span className="gen-note">{providers.length} / 20 个配置</span></div>
    <div className="gen-toolbar"><Button size="small" appearance="primary" icon={<AddRegular />} disabled={busy || providers.length >= 20} onClick={() => openEditor(fresh())}>新增模型</Button><Input size="small" aria-label="搜索模型配置" placeholder="搜索名称、模型或地址" value={search} onChange={(_, data) => setSearch(data.value)} /><Button size="small" icon={<ArrowSyncRegular />} disabled={busy} onClick={() => void run(async () => setProviders(await generationApi.providers()))}>刷新</Button></div>
    <div className="dw-ai-table-scroll"><table className="dw-ai-table" aria-label="AI 模型配置"><thead><tr><th>名称</th><th>模型 / 服务地址</th><th>参数</th><th>密钥</th><th>操作</th></tr></thead><tbody>
      {rows.map(p => <tr key={p.id}><td><strong>{p.name}</strong>{p.isDefault && <span className="dw-ai-default">默认</span>}</td><td><span className="dw-ai-model">{p.model}</span><small title={p.baseUrl}>{p.baseUrl}</small></td><td><span>{p.maxTokens.toLocaleString()} tokens · {p.timeoutSeconds} 秒</span><small>思考：{effortLabel(p)} · {p.outputFormat === 'schema' ? 'JSON Schema' : p.outputFormat === 'json' ? 'JSON' : '文本'}</small></td><td>{p.hasKey ? '已保存' : '未设置'}</td><td><div className="dw-ai-row-actions"><Button size="small" icon={<EditRegular />} disabled={busy} onClick={() => openEditor(p)}>编辑</Button><Button size="small" icon={<PlugConnectedRegular />} disabled={busy} onClick={() => void run(async () => { await generationApi.test(p, null); setMessage(`「${p.name}」测试通过`); })}>测试</Button><Button size="small" icon={<CheckmarkRegular />} disabled={busy || p.isDefault} onClick={() => void run(async () => { setProviders(await generationApi.saveProvider({ ...p, isDefault: true }, null)); setMessage(`已将「${p.name}」设为默认`); })}>设为默认</Button><Button size="small" icon={<DeleteRegular />} disabled={busy} onClick={() => setRemoving(p)}>删除</Button></div></td></tr>)}
      {!rows.length && <tr><td colSpan={5} className="dw-ai-empty">{providers.length ? '没有匹配的模型配置' : '尚未配置模型，点击“新增模型”开始。'}</td></tr>}
    </tbody></table></div>
    {!editorOpen && status}
    <Dialog open={editorOpen} onOpenChange={(_, data) => { if (!data.open) requestClose(); }}><DialogSurface className="dw-ai-editor"><DialogBody><DialogTitle>{providers.some(p => p.id === draft?.id) ? '编辑模型配置' : '新增模型配置'}</DialogTitle><DialogContent className="dw-ai-editor-content">
      {draft && <fieldset disabled={busy} className="gen-form"><div className="dw-ai-fields">
        <Field label="配置名称" required><Input size="small" value={draft.name} placeholder="例如：日常查询助手" maxLength={120} onChange={(_, data) => patch({ name: data.value })} /></Field>
        <Field label="服务地址" required><Input size="small" value={draft.baseUrl} placeholder="https://example.com/v1" onBlur={connectionBlur} onChange={(_, data) => { patch({ baseUrl: data.value }); resetModels(); }} /></Field>
        <Field label="API 密钥" className="dw-ai-wide"><div className="dw-ai-key"><Input size="small" aria-label="API 密钥" type="password" autoComplete="new-password" value={key ?? ''} placeholder={draft.hasKey ? '已保存，留空保持原密钥' : '本地无密钥服务可留空'} onBlur={connectionBlur} onChange={(_, data) => { setKey(data.value || null); setDirty(true); resetModels(); }} />{draft.hasKey && <Button size="small" onClick={() => { setKey(''); setDirty(true); resetModels(); }}>移除密钥</Button>}</div>{key === '' && <span className="gen-note">保存后移除已保存的密钥</span>}</Field>
        <Field label="模型 ID" required className="dw-ai-wide"><div className="dw-ai-model-picker">{modelState === 'fallback'
          ? <Input size="small" aria-label="手动填写模型 ID" value={draft.model} maxLength={200} placeholder="服务未提供模型列表，请填写模型 ID" onChange={(_, data) => patch({ model: data.value })} />
          : <select aria-label="模型 ID" className="dw-native-select" disabled={modelState !== 'ready'} value={draft.model} onChange={e => patch({ model: e.target.value })}><option value="" disabled>{modelState === 'ready' ? '请选择模型' : '先获取模型列表'}</option>{draft.model && !models.includes(draft.model) && <option value={draft.model}>{draft.model}（当前配置）</option>}{models.map(model => <option key={model} value={model}>{model}</option>)}</select>}
          <Button size="small" icon={<ArrowSyncRegular />} disabled={modelLoading || !draft.baseUrl.trim()} onClick={() => void loadModels(draft, key)}>{modelState === 'idle' ? '获取模型' : '重新获取'}</Button></div>{modelLoading && <Spinner size="tiny" label="正在获取模型列表" />}{modelError && <span role="status" className="gen-note">{modelError}</span>}</Field>
      </div>
      <h3>生成参数</h3><div className="dw-ai-fields">
        <Field label="思考等级"><select aria-label="思考等级" className="dw-native-select" value={draft.reasoningEffort ?? ''} onChange={e => patch({ reasoningEffort: (e.target.value || null) as Provider['reasoningEffort'] })}><option value="">服务默认</option>{efforts.map(([value, label]) => <option key={value} value={value}>{label}（{value}）</option>)}</select></Field>
        <Field label="输出 token 上限（128–128000）"><Input size="small" type="number" min={128} max={128000} step={1} value={String(draft.maxTokens)} onChange={(_, data) => patch({ maxTokens: Number(data.value) })} /></Field>
        <Field label="输出格式"><select aria-label="输出格式" className="dw-native-select" value={draft.outputFormat} onChange={e => patch({ outputFormat: e.target.value as Provider['outputFormat'] })}><option value="json">JSON 模式</option><option value="schema">JSON Schema</option><option value="text">普通文本</option></select></Field>
        <Field label="输出上限参数"><select aria-label="输出上限参数" className="dw-native-select" value={draft.tokenParameter} onChange={e => patch({ tokenParameter: e.target.value as Provider['tokenParameter'] })}><option value="max_tokens">max_tokens</option><option value="max_completion_tokens">max_completion_tokens</option></select></Field>
        <Field label="温度（0–2）"><Input size="small" type="number" min={0} max={2} step={0.1} placeholder="服务默认" value={draft.temperature == null ? '' : String(draft.temperature)} onChange={(_, data) => patch({ temperature: data.value === '' ? null : Number(data.value) })} /></Field>
        <Field label="Top P（0–1）"><Input size="small" type="number" min={0} max={1} step={0.1} placeholder="服务默认" value={draft.topP == null ? '' : String(draft.topP)} onChange={(_, data) => patch({ topP: data.value === '' ? null : Number(data.value) })} /></Field>
        <Field label="超时（5–300 秒）"><Input size="small" type="number" min={5} max={300} step={1} value={String(draft.timeoutSeconds)} onChange={(_, data) => patch({ timeoutSeconds: Number(data.value) })} /></Field>
        <Checkbox checked={draft.isDefault} label="设为默认模型配置" onChange={(_, data) => patch({ isDefault: !!data.checked })} />
      </div><p className="gen-note">参数支持范围和实际输出上限由模型决定。留空使用服务默认；温度和 Top P 建议只调整一项。测试可能计费。</p></fieldset>}
      {status}
    </DialogContent><DialogActions>{discarding ? <><span className="gen-note" role="alert">废弃未保存的配置？</span><Button size="small" onClick={() => setDiscarding(false)}>继续编辑</Button><Button size="small" appearance="primary" onClick={closeEditor}>废弃修改</Button></> : <><Button size="small" icon={<PlugConnectedRegular />} disabled={busy || !valid} onClick={() => draft && void run(async () => { const result = await generationApi.test(draft, key); setMessage(`测试通过 · 输入 ${result.usage.inputTokens ?? '未报告'} / 输出 ${result.usage.outputTokens ?? '未报告'} tokens`); })}>测试</Button><Button size="small" disabled={busy} onClick={requestClose}>{dirty ? '废弃' : '取消'}</Button><Button size="small" appearance="primary" icon={<SaveRegular />} disabled={busy || !valid} onClick={() => draft && void run(async () => { const list = await generationApi.saveProvider(draft, key); if (!mounted.current) return; setProviders(list); closeEditor(); setMessage('模型配置已保存'); })}>保存</Button></>}</DialogActions></DialogBody></DialogSurface></Dialog>
    <Dialog open={!!removing} onOpenChange={(_, data) => { if (!busy && !data.open) setRemoving(null); }}><DialogSurface><DialogBody><DialogTitle>删除模型配置？</DialogTitle><DialogContent>删除「{removing?.name}」及其保存的密钥。已有模板保留。</DialogContent><DialogActions><Button size="small" disabled={busy} onClick={() => setRemoving(null)}>取消</Button><Button size="small" appearance="primary" disabled={busy} onClick={() => removing && void run(async () => { setProviders(await generationApi.removeProvider(removing.id)); setRemoving(null); setMessage('模型配置已删除'); })}>删除</Button></DialogActions>{error && <p role="alert" className="gen-error">{error}</p>}</DialogBody></DialogSurface></Dialog>
  </div>;
}
