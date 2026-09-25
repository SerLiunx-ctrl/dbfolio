import {FilterValueInput} from "./FilterValueInput";
import {loadedFilterValues} from "./filterValues";
import type {DbValue} from "../../ipc/types";
import "./filter.css";
import {InfoHint} from '../../common/InfoHint';
import { loadLibrary, useLibrary, saveFilterPreset, deleteFilterPreset } from "../../stores/useLibrary";
import { useNotify } from "../../app/toast";
import {
  Button,
  Combobox,
  Dropdown,
  Input,
  Option,
  makeStyles,
  tokens,
} from "@fluentui/react-components";
import { AddRegular, DeleteRegular } from "@fluentui/react-icons";
import { useEffect, useMemo, useState } from "react";
import type {
  ColumnMeta,
  FilterCondition,
  FilterOperator,
} from "../../ipc/types";

const LISTBOX_PROPS = { className: "dw-listbox-compact" };

const POSITIONING = { position: "below" as const, align: "start" as const };

const useStyles = makeStyles({
  root: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    width: "640px",
    maxWidth: "86vw",
    fontSize: "12px",
  },
  header: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    fontSize: tokens.fontSizeBase200,
    color: tokens.colorNeutralForeground3,
  },
  rows: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    maxHeight: "320px",
    overflowY: "auto",
  },
  row: {
    display: "grid",
    gridTemplateColumns: "190px 150px minmax(0, 1fr) 28px",
    gap: "6px",
    alignItems: "center",
    overflow: "hidden",
  },
  valueCell: {
    display: "flex",
    gap: "4px",
    minWidth: 0,
    overflow: "hidden",
  },
  control: {
    minWidth: 0,
    width: "100%",
    overflow: "hidden",
  },
  optionLabel: {
    display: "inline-block",
    maxWidth: "280px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    verticalAlign: "bottom",
  },
  footer: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    borderTop: `1px solid ${tokens.colorNeutralStroke2}`,
    paddingTop: "10px",
  },
  spacer: { flex: 1 },
});

/** 列名（注释），注释用括号包裹；过长截断 */
function columnLabel(column: ColumnMeta): string {
  const comment = column.comment?.trim();
  return comment ? `${column.name}（${comment}）` : column.name;
}

const OPERATORS: Array<{ value: FilterOperator; label: string }> = [
  { value: "eq", label: "=（等于）" },
  { value: "ne", label: "!=（不等于）" },
  { value: "gt", label: ">（大于）" },
  { value: "ge", label: ">=（大于等于）" },
  { value: "lt", label: "<（小于）" },
  { value: "le", label: "<=（小于等于）" },
  { value: "contains", label: "LIKE（包含）" },
  { value: "startsWith", label: "LIKE x%（开头是）" },
  { value: "endsWith", label: "LIKE %x（结尾是）" },
  { value: "isNull", label: "IS NULL（为空）" },
  { value: "isNotNull", label: "IS NOT NULL（不为空）" },
  { value: "in", label: "IN（在列表中）" },
  { value: "between", label: "BETWEEN（区间）" },
];

function operatorLabel(value: string): string {
  return OPERATORS.find((item) => item.value === value)?.label ?? value;
}

function needsValue(operator: string): boolean {
  return operator !== "isNull" && operator !== "isNotNull";
}

interface ColumnComboboxProps {
  columns: ColumnMeta[];
  value: string;
  onChange: (column: string) => void;
  className?: string;
}

/** 列选择：支持输入模糊匹配（列名或注释），下拉最多约 10 项 */
function ColumnCombobox({ columns, value, onChange, className }: ColumnComboboxProps) {
  const [query, setQuery] = useState("");
  const selected = columns.find((item) => item.name === value);
  const display = selected ? columnLabel(selected) : value;

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return columns;
    return columns.filter(
      (column) =>
        column.name.toLowerCase().includes(keyword) ||
        (column.comment ?? "").toLowerCase().includes(keyword),
    );
  }, [columns, query]);

  return (
    <Combobox
      size="small"
      className={`${className ?? ""} dw-filter-column`}
      aria-label="筛选字段"
      title={display}
      listbox={{className:"dw-listbox-compact dw-filter-column-options"}}
      positioning={POSITIONING}
      selectedOptions={value ? [value] : []}
      value={query.length > 0 ? query : display}
      placeholder="搜索列名或注释…"
      onInput={(event) => setQuery((event.target as HTMLInputElement).value)}
      onBlur={() => setQuery("")}
      onOptionSelect={(_, data) => {
        if (data.optionValue) {
          onChange(data.optionValue);
        }
        setQuery("");
      }}
    >
      {filtered.length === 0 && (
        <Option key="__empty" value="" disabled text="无匹配列">
          无匹配列
        </Option>
      )}
      {filtered.map((column) => {
        const label = columnLabel(column);
        return (
          <Option key={column.name} value={column.name} text={label}>
            <span className="dw-filter-field-label" title={label}>
              <span>{column.name}</span>
              {column.comment?.trim()&&<small>（{column.comment.trim()}）</small>}
            </span>
          </Option>
        );
      })}
    </Combobox>
  );
}

interface Props {
  scope: string;
  loadedRows?: DbValue[][];
  columns: ColumnMeta[];
  initialFilters: FilterCondition[];
  initialConjunction: "and" | "or";
  onApply: (filters: FilterCondition[], conjunction: "and" | "or") => void;
  onClear: () => void;
}

export function FilterPanel({
  scope,
  loadedRows = [],
  columns,
  initialFilters,
  initialConjunction,
  onApply,
  onClear,
}: Props) {
  const styles = useStyles();
  const [filters, setFilters] = useState<FilterCondition[]>(
    initialFilters.length > 0
      ? initialFilters
      : [
          {
            column: columns[0]?.name ?? "",
            operator: "eq",
            value: "",
            value2: "",
          },
        ],
  );
  const valueChoices=useMemo(()=>new Map(columns.map((c,i)=>[c.name,loadedFilterValues(loadedRows,i)])),[columns,loadedRows]);
  const presets=useLibrary(s=>s.filters);
  const notify=useNotify();
  const [presetName,setPresetName]=useState("");
  const [saving,setSaving]=useState(false);
  useEffect(()=>{void loadLibrary().catch(e=>notify.error(e));},[notify]);
  const [conjunction, setConjunction] = useState<"and" | "or">(initialConjunction);

  const update = (index: number, patch: Partial<FilterCondition>) => {
    setFilters((current) =>
      current.map((item, i) => (i === index ? { ...item, ...patch } : item)),
    );
  };

  return (
    <div className={`${styles.root} dw-filter-panel`}>
      <details className="dw-filter-presets"><summary>筛选方案</summary>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <Input aria-label="筛选方案名称" placeholder="筛选方案名称" value={presetName} onChange={(_,d)=>setPresetName(d.value)} />
        <Button disabled={saving||!presetName.trim()||!filters.length} onClick={()=>{setSaving(true);void saveFilterPreset({id:crypto.randomUUID(),scope,name:presetName.trim(),filters,conjunction}).then(()=>notify.success("筛选方案已保存")).catch(e=>notify.error(e)).finally(()=>setSaving(false));}}>保存方案</Button>
      </div>
      {presets.filter(p=>p.scope===scope).map(p=><div key={p.id} style={{display:"flex",gap:8}}><Button size="small" onClick={()=>{if(p.filters.some(f=>!columns.some(c=>c.name===f.column))){notify.error(Error("方案中的字段已不存在，请重新设置"));return;}setFilters(p.filters);setConjunction(p.conjunction);setPresetName(p.name);}}>载入：{p.name}</Button><Button size="small" icon={<DeleteRegular/>} aria-label={"删除方案 "+p.name} onClick={()=>void deleteFilterPreset(p.id).catch(e=>notify.error(e))}/></div>)}
      <InfoHint label="筛选方案说明">方案按连接、库、schema 和表保存；载入后点击「应用筛选」。同名保存会覆盖原方案。</InfoHint>
      </details>
      <div className={styles.header}>
        <span>条件匹配</span>
        <Dropdown
          size="small"
          listbox={LISTBOX_PROPS}
              positioning={POSITIONING}
          selectedOptions={[conjunction]}
          style={{minWidth:0,width:150}}
          value={conjunction === "and" ? "AND（全部条件）" : "OR（任一条件）"}
          onOptionSelect={(_, data) => {
            if (data.optionValue) setConjunction(data.optionValue as "and" | "or");
          }}
        >
          <Option value="and">AND（全部条件）</Option>
          <Option value="or">OR（任一条件）</Option>
        </Dropdown>
      </div>

      <div className="dw-filter-labels"><span>字段</span><span>关系</span><span>值</span><span/></div>
      <div className={styles.rows}>
        {filters.map((filter, index) => (
          <div key={index} className={styles.row}>
            <ColumnCombobox
              columns={columns}
              value={filter.column}
              onChange={(column) => update(index, { column, value:"", value2:"", literal: undefined })}
              className={styles.control}
            />
            <Dropdown
              size="small"
              className={styles.control}
              listbox={LISTBOX_PROPS}
              positioning={POSITIONING}
              aria-label="筛选关系"
              selectedOptions={[filter.operator]}
              value={operatorLabel(filter.operator)}
              onOptionSelect={(_, data) => {
                if (data.optionValue) {
                  update(index, { operator: data.optionValue as FilterOperator, literal: undefined });
                }
              }}
            >
              {OPERATORS.map((operator) => (
                <Option key={operator.value} value={operator.value}>
                  {operator.label}
                </Option>
              ))}
            </Dropdown>
            <div className={styles.valueCell}>
              <FilterValueInput
                value={filter.value ?? ""}
                disabled={!needsValue(filter.operator)}
                choices={valueChoices.get(filter.column)??[]}
                listMode={filter.operator==='in'}
                placeholder={filter.operator==='in'?'值1, 值2, …':filter.operator==='between'?'起始值':'输入或选择值'}
                onChange={value=>update(index,{value,literal:undefined})}
                onSelect={(literal,value)=>update(index,literal[0]==='null'?{operator:'isNull',value:'',literal:undefined}:{value,literal:['eq','ne','gt','ge','lt','le'].includes(filter.operator)?literal:undefined})}
              />
              {filter.operator==='between'&&<FilterValueInput value={filter.value2??''} choices={(valueChoices.get(filter.column)??[]).filter(c=>c.value[0]!=='null')} placeholder="结束值" onChange={value2=>update(index,{value2})} onSelect={(_,value2)=>update(index,{value2})}/>}

            </div>
            <Button
              appearance="subtle"
              size="small"
              icon={<DeleteRegular />}
              aria-label="删除条件"
              onClick={() =>
                setFilters((current) => current.filter((_, i) => i !== index))
              }
            />
          </div>
        ))}
      </div>

      <Button
        appearance="subtle"
        size="small"
        style={{alignSelf:"flex-start"}}
        icon={<AddRegular />}
        onClick={() =>
          setFilters((current) => [
            ...current,
            {
              column: columns[0]?.name ?? "",
              operator: "eq",
              value: "",
              value2: "",
            },
          ])
        }
      >
        添加条件
      </Button>

      <div className={styles.footer}>
        <Button
          appearance="primary"
          size="small"
          disabled={filters.length === 0}
          onClick={() => onApply(filters, conjunction)}
        >
          应用筛选
        </Button>
        <Button
          appearance="secondary"
          size="small"
          onClick={() => {
            setFilters([
              {
                column: columns[0]?.name ?? "",
                operator: "eq",
                value: "",
                value2: "",
              },
            ]);
            onClear();
          }}
        >
          清空筛选
        </Button>
        <div className={styles.spacer} />
        <InfoHint label="筛选值说明">候选值仅来自当前已加载的 {loadedRows.length} 行，去重显示，不额外查询数据库。长值仅缩略显示，选择时保留完整内容；截断预览不可直接选择。IN 使用逗号分隔；LIKE 支持 % 和 _ 通配符。</InfoHint>
      </div>
    </div>
  );
}
