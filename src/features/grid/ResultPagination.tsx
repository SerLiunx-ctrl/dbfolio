import {useEffect, useRef, useState} from "react";
import {Button, Input, Select} from "@fluentui/react-components";
import {ArrowLeftRegular, ArrowRightRegular, PreviousRegular} from "@fluentui/react-icons";
import "./pagination.css";

interface Props {
  offset: number;
  pageSize: number;
  rowCount: number;
  disabled?: boolean;
  onPage: (offset: number) => void | Promise<void>;
  onPageSize: (size: number) => void;
}

// 不通过 COUNT 或估算行数伪造总页数；满页只表示可能还有下一页。
export function ResultPagination({offset, pageSize, rowCount, disabled, onPage, onPageSize}: Props) {
  const page = Math.floor(offset / pageSize) + 1;
  const currentPage = useRef(page);
  currentPage.current = page;
  const [target, setTarget] = useState(String(page));
  useEffect(() => setTarget(String(page)), [page, pageSize]);
  const sizeOptions = [...new Set([50, 100, 200, 500, 1000, 5000, pageSize])].sort((a, b) => a - b);
  const targetPage = /^\d+$/.test(target) ? Number(target) : NaN;
  const targetOffset = (targetPage - 1) * pageSize;
  const valid = Number.isSafeInteger(targetPage) && targetPage >= 1 && Number.isSafeInteger(targetOffset);
  const jump = async () => {
    if (disabled || !valid || targetPage === page) return;
    try { await onPage(targetOffset); } finally { setTarget(String(currentPage.current)); }
  };
  return <div className="dw-result-pagination" role="group" aria-label="结果分页">
    <Select size="small" aria-label="每页条数" value={String(pageSize)} disabled={disabled}
      onChange={(_, data) => onPageSize(Number(data.value))}>
      {sizeOptions.map(size => <option key={size} value={size}>{size} 条/页</option>)}
    </Select>
    <Button size="small" appearance="subtle" icon={<PreviousRegular/>} title="回到第一页" aria-label="首页"
      disabled={disabled || offset === 0} onClick={() => onPage(0)}/>
    <Button size="small" appearance="subtle" icon={<ArrowLeftRegular/>} aria-label="上一页" title="上一页"
      disabled={disabled || offset === 0} onClick={() => onPage(Math.max(0, offset - pageSize))}/>
    <span>第</span>
    <Input size="small" className="dw-page-number" aria-label="页码" inputMode="numeric" value={target}
      disabled={disabled} aria-invalid={!valid} title="输入页码后按 Enter；未统计总页数，深页跳转可能较慢"
      onChange={(_, data) => setTarget(data.value)}
      onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void jump(); } else if (event.key === "Escape") setTarget(String(page)); }}/>
    <span>页</span>
    <Button size="small" appearance="subtle" disabled={disabled || !valid || targetPage === page} onClick={() => void jump()}>跳转</Button>
    <Button size="small" appearance="subtle" icon={<ArrowRightRegular/>} aria-label="下一页"
      title={rowCount < pageSize ? "本页不足一页，暂无后续数据" : "下一页（未统计总页数）"}
      disabled={disabled || rowCount < pageSize || !Number.isSafeInteger(offset + pageSize)} onClick={() => onPage(offset + pageSize)}/>
  </div>;
}

export function resultRowRange(offset: number, rowCount: number) {
  return rowCount > 0 ? `第 ${offset + 1}–${offset + rowCount} 行` : offset === 0 ? "暂无数据" : "本页无数据";
}
