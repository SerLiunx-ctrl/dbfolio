import type { SqlToken } from "./sqlText";

export interface DamengStatementRange {
  start: number;
  end: number;
  text: string;
  kind: "sql" | "client" | "program";
}

const clientLine = /^(?:WHENEVER\b|PROMPT\b|SET\s+(?:DEFINE|ECHO|FEEDBACK|HEADING|PAGESIZE|LINESIZE|SERVEROUTPUT|TERMOUT|TIMING|VERIFY|COLSEP|SQLBLANKLINES|TRIMSPOOL|TRIMOUT|WRAP|LONG|LONGCHUNKSIZE|NUMWIDTH|NULL)\b|(?:SPOOL|EXIT|QUIT|CONNECT|CONN|DISCONNECT|COLUMN|COL|ACCEPT|UNDEFINE|DEFINE|PAUSE|PRINT|HOST|REM|REMARK)\b|START\b(?!\s+TRAN(?:SACTION)?\b)|@@?)/i;

function lineBounds(sql: string, at: number) {
  const start = sql.lastIndexOf("\n", at - 1) + 1;
  const newline = sql.indexOf("\n", at);
  return { start, end: newline < 0 ? sql.length : newline, after: newline < 0 ? sql.length : newline + 1 };
}

function isSlashLine(sql: string, token: SqlToken) {
  if (token.kind !== "symbol" || token.text !== "/") return false;
  const line = lineBounds(sql, token.start);
  return /^\s*\/\s*(?:--[^\r\n]*)?\r?$/.test(sql.slice(line.start, line.end));
}

function programHead(tokens: SqlToken[]): "block" | "slash" | null {
  const word = (at: number) => tokens[at]?.kind === "word" ? tokens[at].text.toUpperCase() : "";
  if (word(0) === "DECLARE") return "slash";
  if (word(0) === "BEGIN") return ["TRAN", "TRANSACTION"].includes(word(1)) ? null : "block";
  if (word(0) !== "CREATE") return null;
  let at = 1;
  if (word(at) === "OR" && word(at + 1) === "REPLACE") at += 2;
  while (["FORCE", "EDITIONABLE", "NONEDITIONABLE"].includes(word(at))) at++;
  return ["PROCEDURE", "FUNCTION", "TRIGGER", "PACKAGE"].includes(word(at))
    || (word(at) === "TYPE" && word(at + 1) === "BODY") ? "slash" : null;
}

/** disql 控制行独立选取；存储程序/匿名块内部的分号保留在同一语句中。 */
export function damengStatementRanges(sql: string, allTokens: SqlToken[]): DamengStatementRange[] {
  const tokens = allTokens.filter(t => t.kind !== "space" && t.kind !== "comment");
  const ranges: DamengStatementRange[] = [];
  let start = 0;
  let current: SqlToken[] = [];
  let program: "block" | "slash" | null = null;
  let began = false;
  let ended = false;
  const blocks: ("BEGIN" | "CASE")[] = [];
  const emit = (textEnd: number, end: number, kind: DamengStatementRange["kind"]) => {
    const text = sql.slice(start, textEnd).trim();
    if (text && current.length) ranges.push({ start, end, text, kind });
    start = end;
    current = [];
    program = null;
    began = false;
    ended = false;
    blocks.length = 0;
  };
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (isSlashLine(sql, token)) {
      const line = lineBounds(sql, token.start);
      if (current.length) emit(line.start, line.after, program ? "program" : "sql");
      else if (ranges.length) ranges[ranges.length - 1].end = line.after;
      start = line.after;
      continue;
    }
    if (!current.length) {
      const line = lineBounds(sql, token.start);
      if (!sql.slice(line.start, token.start).trim() && clientLine.test(sql.slice(token.start, line.end))) {
        current.push(token);
        emit(line.end, line.after, "client");
        while (tokens[i + 1]?.start < line.after) i++;
        continue;
      }
    }
    current.push(token);
    program = programHead(current);
    if (program && token.kind === "word") {
      const word = token.text.toUpperCase();
      const previous = tokens[i - 1]?.kind === "word" ? tokens[i - 1].text.toUpperCase() : "";
      const next = tokens[i + 1]?.kind === "word" ? tokens[i + 1].text.toUpperCase() : "";
      if (word === "BEGIN") {
        began = true;
        ended = false;
        blocks.push("BEGIN");
      } else if (word === "CASE" && previous !== "END") blocks.push("CASE");
      else if (word === "END" && !["IF", "LOOP"].includes(next)) {
        if (blocks.length) blocks.pop();
        ended = !blocks.length && (began || current.some(t => t.kind === "word" && /^(PACKAGE|TYPE)$/i.test(t.text)));
      }
    }
    // DECLARE/CREATE may contain local routines whose END is followed by the
    // main body. Only a standalone slash (or EOF) ends those compilation units.
    if (token.kind === "symbol" && token.text === ";" && (!program || (program === "block" && ended))) {
      emit(program ? token.end : token.start, token.end, program ? "program" : "sql");
    }
  }
  if (current.length) emit(sql.length, sql.length, program ? "program" : "sql");
  return ranges;
}

export function currentDamengStatement(sql: string, offset: number, tokens: SqlToken[]) {
  const ranges = damengStatementRanges(sql, tokens);
  return ranges.find(range => offset < range.end)?.text ?? ranges[ranges.length - 1]?.text ?? "";
}
