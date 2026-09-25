export const TEMPLATE_VARIABLES = [
  {group:'标识', token:'{uuid}', label:'随机 UUID', help:'每条记录生成新 UUID，不受种子影响；同一行各文本字段共享。'},
  {group:'标识', token:'{uuid32}', label:'紧凑 UUID', help:'同一行 UUID 去除连字符后的 32 位形式。'},
  {group:'标识', token:'{run_id}', label:'任务批次号', help:'一次生成任务共享一个随机标识；重新生成时改变。'},
  {group:'标识', token:'{seeded_uuid}', label:'可复现 UUID', help:'受种子影响，相同方案再次运行可能与已有数据重复。'},
  {group:'序号与参数', token:'{n}', label:'行号', help:'从 1 开始，跨 AI 请求批次连续编号。'},
  {group:'序号与参数', token:'{n:6}', label:'补零行号', help:'例如 000001；宽度支持 1–20，超出宽度不截断。'},
  {group:'序号与参数', token:'${prefix}', label:'方案参数', help:'引用“方案参数”中的 prefix；参数值不会再次展开。'},
  {group:'时间', token:'{date:yyyyMMdd}', label:'日期', help:'任务开始时的 UTC 日期；还支持 yyyy-MM-dd、HHmmss、yyyyMMddHHmmss。'},
  {group:'时间', token:'{timestamp}', label:'秒时间戳', help:'任务开始时间，整个任务固定。'},
  {group:'时间', token:'{timestamp_ms}', label:'毫秒时间戳', help:'任务开始时间，整个任务固定；单独使用不能保证唯一。'},
  {group:'随机值', token:'{int:1:100}', label:'随机整数', help:'闭区间，支持 64 位整数；受种子影响，可能重复。'},
  {group:'随机值', token:'{hex:8}', label:'十六进制串', help:'长度 1–128，受种子影响，可能重复。'},
  {group:'随机值', token:'{alnum:12}', label:'字母数字串', help:'长度 1–128，受种子影响，可能重复。'},
];
export const TEMPLATE_PRESETS = [
  {label:'用户缓存键', pattern:'system:user:{uuid}'},
  {label:'批次与序号', pattern:'test:{run_id}:{n:6}'},
  {label:'订单编号', pattern:'ORD-{date:yyyyMMdd}-{uuid32}'},
  {label:'带参数前缀', pattern:'${prefix}:{uuid}'},
  {label:'文件名', pattern:'sample-{date:yyyyMMddHHmmss}-{n:6}.json'},
];
