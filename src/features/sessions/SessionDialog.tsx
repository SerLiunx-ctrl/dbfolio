import {ConnectionSecurity} from './ConnectionSecurity';
import {InfoHint} from '../../common/InfoHint';
import {
  Button,
  Checkbox,
  Combobox,
  Dialog,
  DialogActions,
  DialogBody,
  DialogContent,
  DialogSurface,
  DialogTitle,
  Dropdown,
  Field,
  Input,
  Option,
  Spinner,
  Switch,
  Textarea,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { FolderOpenRegular } from "@fluentui/react-icons";
import { open } from "@tauri-apps/plugin-dialog";
import { useEffect, useRef, useState } from "react";
import type {SqliteFileDraft} from './SqliteFileDrop';
import { useNotify } from "../../app/toast";
import { api } from "../../ipc";
import type { Engine, SessionInput, SessionRecord, NetworkConfig, DiagnosticStep } from "../../ipc/types";
import { useSessionStore } from "../../stores/useSessionStore";
import { DEFAULT_PORTS, DEFAULT_USERNAMES, ENGINE_LABELS, ENGINE_OPTIONS } from "./engine";

const useStyles = makeStyles({
  form: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
    paddingTop: "4px",
  },
  row: {
    display: "grid",
    gridColumn: "1 / -1",
    gridTemplateColumns: "2fr 1fr",
    gap: "10px",
  },
  fileRow: {
    display: "grid",
    gridTemplateColumns: "1fr auto",
    gap: "8px",
    alignItems: "end",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
    width: "100%",
    minWidth: 0,
  },
  footerColumn: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    width: "100%",
    minWidth: 0,
  },
  testResult: {
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
    width: "100%",
    minWidth: 0,
    maxHeight: "54px",
    overflowY: "auto",
    wordBreak: "break-word",
    lineHeight: "18px",
    userSelect: "text",
  },
  testOk: {
    color: "#0e700e",
  },
  testFail: {
    color: tokens.colorPaletteRedForeground1,
  },
  gap: { flex: 1 },
});

const SSL_OPTIONS = [
  { value: "prefer", label: "prefer（默认，允许明文回退）" },
  { value: "disable", label: "disable（关闭 TLS）" },
  { value: "require", label: "require（强制加密）" },
  { value: "verify-ca", label: "verify-ca（验证证书链）" },
  { value: "verify-full", label: "verify-full（验证证书与主机名）" },
];

import { environmentLabels, setSessionEnvironment, useObjectPreferences, type Environment } from "../../stores/useObjectPreferences";

interface Props {
  sqliteFile?: SqliteFileDraft | null;
  open: boolean;
  session: SessionRecord | null;
  folders: string[];
  defaultGroup?: string | null;
  copy?: boolean;
  onClose: () => void;
  onSaved: (session: SessionRecord) => void;
}

export function SessionDialog({
  sqliteFile,
  open: isOpen,
  session,
  folders,
  defaultGroup,
  copy = false,
  onClose,
  onSaved,
}: Props) {
  const styles = useStyles();
  const notify = useNotify();
  const duplicateSession=useSessionStore(s=>s.duplicateSession);
  const createSession = useSessionStore((s) => s.createSession);
  const updateSession = useSessionStore((s) => s.updateSession);

  const [network,setNetwork]=useState<NetworkConfig>({});
  const [sshPassword,setSshPassword]=useState<string|null>(null),[sshPassphrase,setSshPassphrase]=useState<string|null>(null);
  const [steps,setSteps]=useState<DiagnosticStep[]>([]);
  const [name, setName] = useState("");
  const [environment, setEnvironment] = useState<Environment>("none");
  const [engine, setEngine] = useState<Engine>("mysql");
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("3306");
  const [username, setUsername] = useState("root");
  const [password, setPassword] = useState("");
  const [database, setDatabase] = useState("");
  const [filePath, setFilePath] = useState("");
  const [sslMode, setSslMode] = useState("prefer");
  const [redisDb, setRedisDb] = useState("0");
  const [authSource,setAuthSource]=useState("admin");
  const [tls, setTls] = useState(false);
  const [restrictDatabases,setRestrictDatabases]=useState(false);
  const [allowedDatabases,setAllowedDatabases]=useState("");
  const [databaseChoices,setDatabaseChoices]=useState<string[]>([]);
  const [loadingChoices,setLoadingChoices]=useState(false);
  const [readOnly, setReadOnly] = useState(false);
  const [confirmWritable,setConfirmWritable]=useState(false);
  const [group, setGroup] = useState("");
  const [clearPassword, setClearPassword] = useState(false);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testMessage, setTestMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const generatedName=useRef('');

  useEffect(() => {
    if (!isOpen) return;
    generatedName.current='';
    setNetwork(session?.network??{});setSshPassword(null);setSshPassphrase(null);setSteps([]);
    setConfirmWritable(false);
    setRestrictDatabases(session?.allowedDatabases != null);
    setAllowedDatabases((session?.allowedDatabases ?? []).join("\n"));
    setDatabaseChoices([]);
    setTestMessage(null);
    setClearPassword(false);
    setEnvironment(session ? useObjectPreferences.getState().environments[session.id] ?? "none" : "none");
    if (session) {
      setName(session.name + (copy ? "-副本" : ""));
      setEngine(session.engine);
      setHost(session.host ?? "127.0.0.1");
      setPort(session.port ? String(session.port) : "");
      setUsername(session.username ?? "");
      setDatabase(session.database ?? "");
      setFilePath(session.filePath ?? "");
      setSslMode(session.sslMode ?? "prefer");
      setRedisDb(session.redisDb !== null && session.redisDb !== undefined ? String(session.redisDb) : "0");
      setTls(Boolean(session.tls));
      setReadOnly(session.readOnly);
      setGroup(session.groupName ?? "");
    } else {
      setName("");
      setEngine("mysql");
      setHost("127.0.0.1");
      setPort("3306");
      setUsername("root");
      setDatabase("");
      setFilePath("");
      setSslMode("prefer");
      setRedisDb("0");
      setTls(false);
      setReadOnly(false);
      setGroup(defaultGroup ?? "");
    }
    setAuthSource(session?.authSource ?? "admin");
    setPassword("");
  }, [isOpen, session, defaultGroup, copy]);

  useEffect(()=>{
    if(!isOpen||!sqliteFile||session||copy)return;
    setEngine('sqlite');setPort('');setFilePath(sqliteFile.path);
    setPassword('');setSshPassword(null);setSshPassphrase(null);
    setNetwork(previous=>({queryTimeoutSecs:previous.queryTimeoutSecs}));
    const previousGenerated=generatedName.current;
    setName(previous=>!previous.trim()||previous===previousGenerated?sqliteFile.name:previous);
    generatedName.current=sqliteFile.name;
    setTestMessage(null);setSteps([]);
  },[isOpen,sqliteFile,session,copy]);

  const handleEngineChange = (next: Engine) => {
    const previousDefault = DEFAULT_USERNAMES[engine];
    setEngine(next);
    if (!username.trim() || username === previousDefault) {
      setUsername(DEFAULT_USERNAMES[next] ?? "");
    }
    if (next === "sqlite") {
      setPort("");
    } else if (!port) {
      setPort(String(DEFAULT_PORTS[next] ?? ""));
    }
  };

  const buildInput = (): SessionInput => {
    const isSqlite = engine === "sqlite";
    const isRedis = engine === "redis";
    let passwordValue: string | null = null;
    if (password.length > 0) {
      passwordValue = password;
    } else if (session && clearPassword) {
      passwordValue = "";
    }
    return {
      network:isSqlite?{queryTimeoutSecs:network.queryTimeoutSecs}:network,sshPassword,sshKeyPassphrase:sshPassphrase,
      name: name.trim(),
      engine,
      host: isSqlite ? null : host.trim(),
      port: isSqlite || !port.trim() ? null : Number(port.trim()),
      username: isSqlite ? null : username.trim(),
      password: passwordValue,
      database: isSqlite || isRedis ? null : database.trim() || null,
      filePath: isSqlite ? filePath.trim() : null,
      sslMode: isSqlite || isRedis ? null : sslMode,
      redisDb: isRedis ? Number(redisDb || "0") : null,
      tls: isRedis || engine === "mongodb" ? tls : null,
      authSource: engine === "mongodb" ? authSource.trim() || null : null,
      readOnly,
      allowedDatabases: engine === "mysql" && restrictDatabases ? [...new Set(allowedDatabases.split(/\r?\n/).map(s=>s.trim()).filter(Boolean))] : null,
      groupName: group.trim() || null,
      color: session?.color ?? null,
    };
  };

  const handleTest = async () => {
    setTesting(true);setSteps([]);
    setTestMessage(null);
    try {
      const result = await api.testSession(buildInput(), session?.id ?? null);
      setSteps(result.steps??[]);setTestMessage({ok:result.ok,text:result.ok?`连接成功 · 服务器版本 ${result.serverVersion}`:"连接未通过，请查看分步诊断"});
    } catch (error) {
      const message =
        typeof error === "object" && error !== null && "message" in error
          ? String((error as { message: unknown }).message)
          : String(error);
      setTestMessage({ ok: false, text: message });
    } finally {
      setTesting(false);
    }
  };

  const handleSave = async () => {
    setSaving(true);
    try {
      const input = buildInput();
      const saved = copy && session ? await duplicateSession(session.id,input) : session
        ? await updateSession(session.id, input)
        : await createSession(input);
      await setSessionEnvironment(saved.id, environment).catch(error => notify.error(error, "会话已保存，但环境标记保存失败"));
      notify.success(session && !copy ? "会话已更新" : "会话已创建", saved.name);
      onSaved(saved);
      onClose();
    } catch (error) {
      notify.error(error, "保存失败");
    } finally {
      setSaving(false);
    }
  };

  const pickFile = async () => {
    const selected = await open({
      multiple: false,
      directory: false,
      filters: [
        { name: "SQLite 数据库", extensions: ["db", "sqlite", "sqlite3", "db3"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    });
    if (typeof selected === "string") {
      setFilePath(selected);
    }
  };

  const isSqlite = engine === "sqlite";
  const isRedis = engine === "redis";
  const allowedNames=allowedDatabases.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
  const scopeError=engine === "mysql" && restrictDatabases ? (!allowedNames.length ? "请至少填写一个允许的数据库" : database.trim() && !allowedNames.includes(database.trim()) ? "默认数据库必须在允许列表中，或清空默认数据库" : "") : "";
  const canSave = !scopeError &&
    name.trim().length > 0 && (isSqlite ? filePath.trim().length > 0 : host.trim().length > 0);

  return (
    <>
    <Dialog
      open={isOpen}
      onOpenChange={(_, data) => {
        if (!data.open && !testing && !saving) onClose();
      }}
    >
      <DialogSurface data-sqlite-drop-allowed={!session&&!copy&&!saving&&!testing&&!confirmWritable?'true':'false'} style={{ maxWidth: "560px" }}>
        {confirmWritable?<DialogBody><DialogTitle>{environment==="production"?"关闭生产会话的只读保护？":"关闭只读保护？"}</DialogTitle><DialogContent>非只读情况下存在危险操作：可以修改或删除数据、表结构，也可以通过导入和同步写入。{environment==="production"?"当前为生产环境，请确认已核对操作范围并具备恢复措施。":"请确认你确实需要写入。"} 保存后生效，当前连接将断开。</DialogContent><DialogActions><Button appearance="primary" onClick={()=>setConfirmWritable(false)}>保持只读</Button><Button onClick={()=>{setReadOnly(false);setConfirmWritable(false);}}>我已了解风险，允许写入</Button></DialogActions></DialogBody>:<DialogBody>
          <DialogTitle>{copy ? "复制会话" : session ? "编辑会话" : "新建会话"}</DialogTitle>
          <DialogContent>
            <div className={styles.form + " dw-session-form"}>
              <Field label="名称" required>
                <Input
                  value={name}
                  placeholder="例如：本地 MySQL"
                  onChange={(_, data) => setName(data.value)}
                />
              </Field>

              <Field label="环境标记">
                <Dropdown selectedOptions={[environment]} value={environmentLabels[environment]} aria-label="环境标记" onOptionSelect={(_, data) => {const next=data.optionValue as Environment;setEnvironment(next);if(next==="production")setReadOnly(true);}}>
                  {Object.entries(environmentLabels).map(([value, label]) => <Option key={value} value={value}>{label}</Option>)}
                </Dropdown>
              </Field>
              <Field label="数据库类型" className="dw-span-full">
                <Dropdown
                  selectedOptions={[engine]}
                  value={ENGINE_LABELS[engine]}
                  onOptionSelect={(_, data) => {
                    if (data.optionValue) handleEngineChange(data.optionValue as Engine);
                  }}
                >
                  {ENGINE_OPTIONS.map((option) => (
                    <Option key={option} value={option}>
                      {ENGINE_LABELS[option]}
                    </Option>
                  ))}
                </Dropdown>
              </Field>

              {isSqlite ? (
                <Field label="数据库文件" required className="dw-span-full">
                  <div className={styles.fileRow}>
                    <Input
                      value={filePath}
                      placeholder="C:\\path\\to\\database.db"
                      onChange={(_, data) => setFilePath(data.value)}
                    />
                    <Button icon={<FolderOpenRegular />} onClick={() => void pickFile()}>
                      浏览
                    </Button>
                  </div>
                  {!session&&!copy&&<span style={{fontSize:12,color:tokens.colorNeutralForeground3}}>可拖入 SQLite 文件，自动填写名称和路径</span>}
                </Field>
              ) : (
                <>
                  <div className={styles.row}>
                    <Field label={engine === "mongodb" ? "主机或连接 URI" : "主机"} required>
                      <Input value={host} onChange={(_, data) => setHost(data.value)} />
                    </Field>
                    <Field label="端口">
                      <Input
                        value={port}
                        placeholder={String(DEFAULT_PORTS[engine] ?? "")}
                        onChange={(_, data) => setPort(data.value)}
                      />
                    </Field>
                  </div>
                  <div className={styles.row}>
                    <Field label="用户名">
                      <Input
                        value={username}
                        placeholder={isRedis ? "default（可留空）" : ""}
                        onChange={(_, data) => setUsername(data.value)}
                      />
                    </Field>
                    {isRedis ? (
                      <Field label="逻辑库（0-15）">
                        <Input
                          value={redisDb}
                          placeholder="0"
                          onChange={(_, data) => setRedisDb(data.value)}
                        />
                      </Field>
                    ) : (
                      <Field label="默认数据库">
                        <Input
                          value={database}
                          placeholder="可留空"
                          onChange={(_, data) => setDatabase(data.value)}
                        />
                      </Field>
                    )}
                  </div>
                  <Field label="密码">
                    <Input
                      type="password"
                      value={password}
                      placeholder={
                        session?.hasPassword ? (copy ? "留空沿用原会话密码" : "已保存，留空保持不变") : "可留空"
                      }
                      onChange={(_, data) => setPassword(data.value)}
                    />
                  </Field>
                  {session?.hasPassword && password.length === 0 && (
                    <Checkbox
                      label={copy ? "不复制密码" : "清除已保存的密码"}
                      checked={clearPassword}
                      onChange={(_, data) => setClearPassword(Boolean(data.checked))}
                    />
                  )}
                  {isRedis && (
                    <Switch
                      label="使用 TLS（rediss://）"
                      checked={tls}
                      onChange={(_, data) => setTls(data.checked)}
                    />
                  )}
                  {engine === "mongodb" && <><Field label="认证库（authSource）"><Input value={authSource} onChange={(_,d)=>setAuthSource(d.value)} /></Field><Switch label="启用 TLS（SRV 默认启用）" checked={tls} onChange={(_,d)=>setTls(d.checked)} /><InfoHint label="MongoDB 地址说明">地址支持 mongodb:// 和 mongodb+srv://；账号密码请分别填写，不要放在 URI 中。URI 模式忽略端口字段。</InfoHint></>}
                  {!isRedis && engine !== "mongodb" && (
                    <Field label="SSL 模式">
                      <Dropdown
                        selectedOptions={[sslMode]}
                        value={SSL_OPTIONS.find((o) => o.value === sslMode)?.label ?? sslMode}
                        onOptionSelect={(_, data) => {
                          if (data.optionValue) setSslMode(data.optionValue);
                        }}
                      >
                        {SSL_OPTIONS.map((option) => (
                          <Option key={option.value} value={option.value}>
                            {option.label}
                          </Option>
                        ))}
                      </Dropdown>
                    </Field>
                  )}
                </>
              )}

              <ConnectionSecurity engine={engine} value={network} onChange={setNetwork} sshPassword={sshPassword} onPassword={setSshPassword} sshPassphrase={sshPassphrase} onPassphrase={setSshPassphrase} disabled={testing||saving}/>
              <Field label="分组">
                <Combobox
                  freeform
                  value={group}
                  selectedOptions={group ? [group] : []}
                  placeholder="选择或输入文件夹名称"
                  onOptionSelect={(_, data) => setGroup(data.optionValue ?? "")}
                  onInput={(event) =>
                    setGroup((event.target as HTMLInputElement).value)
                  }
                >
                  {folders.map((folder) => (
                    <Option key={folder} value={folder}>
                      {folder}
                    </Option>
                  ))}
                </Combobox>
              </Field>

              {engine === "mysql" && <section>
                <div style={{display:'flex',alignItems:'center',gap:6}}><Switch label="仅允许指定数据库" checked={restrictDatabases} onChange={(_,d)=>setRestrictDatabases(d.checked)}/><InfoHint label="数据库访问范围">仅作用于本会话。未列入的数据库不显示，并阻止直接跨库 SQL、同步和导出访问。数据库名精确匹配，不支持通配符。视图、触发器及服务器内部依赖仍由服务器权限决定。</InfoHint></div>
                {restrictDatabases && <div style={{display:'flex',flexDirection:'column',gap:8}}>
                  <Field label="允许的数据库（每行一个）" validationState={scopeError ? "error" : "none"} validationMessage={scopeError || undefined}><Textarea resize="vertical" rows={3} value={allowedDatabases} onChange={(_,d)=>setAllowedDatabases(d.value)} placeholder={'test_db\ndev_db'}/></Field>
                  {session && <Button size="small" disabled={loadingChoices || !useSessionStore.getState().statuses[session.id]?.connected} onClick={async()=>{setLoadingChoices(true);try{setDatabaseChoices((await api.listDatabases(session.id)).map(d=>d.name));}catch(e){notify.error(e,'读取数据库失败');}finally{setLoadingChoices(false);}}}>从当前连接选择</Button>}
                  {databaseChoices.length>0 && <div style={{maxHeight:130,overflow:'auto'}}>{databaseChoices.map(db=><Checkbox key={db} label={db} checked={allowedDatabases.split(/\r?\n/).map(s=>s.trim()).includes(db)} onChange={(_,d)=>setAllowedDatabases([...new Set([...allowedDatabases.split(/\r?\n/).map(s=>s.trim()).filter(s=>s && s!==db),...(d.checked?[db]:[])])].join('\n'))}/>)}</div>}
                </div>}
              </section>}

              {environment==="production"&&!readOnly&&<div role="alert" style={{color:tokens.colorPaletteRedForeground1}}>生产会话已允许写入，请谨慎执行修改、删除和同步操作。</div>}
              <Switch
                label="只读模式（阻止数据库写入）"
                checked={readOnly}
                onChange={(_, data) => {if(data.checked)setReadOnly(true);else setConfirmWritable(true);}}
              />
            </div>
          </DialogContent>
          <DialogActions>
            <div className={styles.footerColumn}>
              {steps.length>0&&<div aria-label="连接诊断" style={{maxHeight:160,overflow:"auto",width:"100%",fontSize:12}}>{steps.map(s=><div key={s.key} style={{display:"grid",gridTemplateColumns:"100px 1fr 54px",gap:6,padding:"3px 0",color:s.status==="failed"?tokens.colorPaletteRedForeground1:undefined}}><span>{s.status==="ok"?"✓":s.status==="failed"?"✕":"—"} {s.label}</span><span style={{overflowWrap:"anywhere"}}>{s.message}</span><span>{s.durationMs} ms</span></div>)}</div>}
              {testMessage && (
                <div
                  className={`${styles.testResult} ${
                    testMessage.ok ? styles.testOk : styles.testFail
                  }`}
                >
                  {testMessage.text}
                </div>
              )}
              <div className={styles.footer}>
                <Button
                  appearance="secondary"
                  icon={testing ? <Spinner size="tiny" /> : undefined}
                  disabled={testing || saving || !canSave}
                  onClick={() => void handleTest()}
                >
                  测试连接
                </Button>
                <div className={styles.gap} />
                <Button appearance="secondary" onClick={onClose} disabled={saving||testing}>
                  取消
                </Button>
                <Button
                  appearance="primary"
                  onClick={() => void handleSave()}
                  disabled={saving || testing || !canSave}
                >
                  保存
                </Button>
              </div>
            </div>
          </DialogActions>
        </DialogBody>}
      </DialogSurface>
    </Dialog>

    </>
  );
}
