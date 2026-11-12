import type * as Monaco from "monaco-editor";
import { conf, language } from "monaco-editor/languages/definitions/sql/sql";

export const DAMENG_SQL_LANGUAGE = "dameng-sql";
export const SQL_LANGUAGES = ["sql", DAMENG_SQL_LANGUAGE] as const;

export function sqlLanguage(engine?: string) {
  return engine === "dameng" ? DAMENG_SQL_LANGUAGE : "sql";
}

const damengKeywords = [
  "IDENTITY", "CLUSTER", "STORAGE", "CLUSTERBTR", "NOBRANCH", "BRANCH", "NOCOMPRESS", "COMPRESS",
  "TABLESPACE", "PCTFREE", "PCTUSED", "INITRANS", "MAXTRANS", "INITIAL", "NEXT", "MINEXTENTS", "MAXEXTENTS",
  "LOGGING", "NOLOGGING", "CACHE", "NOCACHE", "DISABLE", "ENABLE", "REUSE", "SEGMENT", "DEFERRED",
  "IDENTITY_INSERT", "AUTOCOMMIT", "SCHEMA", "REPLACE", "PACKAGE", "BODY", "EXCEPTION", "ELSIF", "LOOP",
];
const typeKeywords = [
  "BIT", "BOOLEAN", "BOOL", "TINYINT", "SMALLINT", "INTEGER", "INT", "BIGINT", "NUMBER", "NUMERIC", "DECIMAL", "DEC",
  "REAL", "DOUBLE", "PRECISION", "FLOAT", "CHAR", "CHARACTER", "VARCHAR", "VARCHAR2", "NCHAR", "NVARCHAR", "NVARCHAR2",
  "CLOB", "NCLOB", "TEXT", "LONGVARCHAR", "BLOB", "BINARY", "VARBINARY", "RAW", "LONGVARBINARY", "BYTE",
  "DATE", "TIME", "DATETIME", "TIMESTAMP", "INTERVAL", "ROWID", "BFILE",
];

/** 保留当前 Monaco SQL 语法的字符串/注释/标识符规则，仅扩展达梦词表。 */
export function damengSqlLanguage(base = language): Monaco.languages.IMonarchLanguage {
  const root = base.tokenizer.root.map(rule => {
    if (!Array.isArray(rule)) return rule;
    const action = rule[1];
    if (typeof action !== "object" || Array.isArray(action) || !action.cases || !("@keywords" in action.cases)) return rule;
    return [rule[0], { ...action, cases: { "@typeKeywords": "type", "@damengKeywords": "keyword", ...action.cases } }] as Monaco.languages.IMonarchLanguageRule;
  });
  return { ...base, keywords: [...base.keywords, ...damengKeywords], damengKeywords, typeKeywords, tokenizer: { ...base.tokenizer, root } };
}

const registered = new WeakSet<typeof Monaco>();
export function ensureSqlLanguage(monaco: typeof Monaco, engine?: string) {
  if (engine !== undefined && engine !== "dameng" || registered.has(monaco)) return;
  monaco.languages.register({ id: DAMENG_SQL_LANGUAGE, aliases: ["达梦 SQL", "Dameng SQL"] });
  monaco.languages.setLanguageConfiguration(DAMENG_SQL_LANGUAGE, conf);
  monaco.languages.setMonarchTokensProvider(DAMENG_SQL_LANGUAGE, damengSqlLanguage());
  registered.add(monaco);
}
