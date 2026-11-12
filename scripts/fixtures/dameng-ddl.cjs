const ident = value => '"' + value.replace(/"/g, '""') + '"';
const literal = value => "'" + value.replace(/'/g, "''") + "'";
function ddlFixture(a, b) {
  const at = name => `${ident(a)}.${ident(name)}`, bt = name => `${ident(b)}.${ident(name)}`;
  const comment = `中文 '引号'\n第二行；仅作为文字保留源模式 "${a}".QA_PARENT`;
  return {
    comment,
    objects: [{ schema: a, table: 'QA_PARENT' }, { schema: b, table: 'QA_CHILD' }, { schema: a, table: 'QA_SIDE' }, { schema: a, table: 'QA_NO_INDEX' }, { schema: a, table: 'QA_VIEW' }],
    statements: [
      `CREATE TABLE ${at('QA_PARENT')}("ID" BIGINT IDENTITY(7,2) NOT NULL,"CODE" VARCHAR(40),"ALT" VARCHAR(40) UNIQUE,"TITLE" VARCHAR(80),"AMOUNT" DECIMAL(12,2) CHECK("AMOUNT">=0),"STATE" INT,"BIN" BLOB,"BODY" CLOB,CONSTRAINT "QA_PK" PRIMARY KEY("ID"),CONSTRAINT "QA_UQ" UNIQUE("CODE"),CONSTRAINT "QA_CK" CHECK("STATE">=0))`,
      `CREATE INDEX ${at('QA_IX')} ON ${at('QA_PARENT')}("AMOUNT" DESC)`,
      `CREATE UNIQUE INDEX ${at('QA_UIX')} ON ${at('QA_PARENT')}("TITLE")`,
      `CREATE INDEX ${at('QA_EXPR')} ON ${at('QA_PARENT')}(LOWER("TITLE"))`,
      `COMMENT ON TABLE ${at('QA_PARENT')} IS ${literal(comment)}`,
      `COMMENT ON COLUMN ${at('QA_PARENT')}."TITLE" IS ${literal("标题 '引号'\n换行")}`,
      `CREATE TABLE ${bt('QA_CHILD')}("ID" BIGINT PRIMARY KEY,"PARENT_ID" BIGINT,CONSTRAINT "QA_FK" FOREIGN KEY("PARENT_ID") REFERENCES ${at('QA_PARENT')}("ID") ON DELETE CASCADE)`,
      `CREATE TABLE ${at('QA_SIDE')}("ID" INT PRIMARY KEY,"CHILD_ID" BIGINT,CONSTRAINT "QA_REVERSE_FK" FOREIGN KEY("CHILD_ID") REFERENCES ${bt('QA_CHILD')}("ID"))`,
      `CREATE TABLE ${at('QA_NO_INDEX')}("ID" INT,"TEXT_VALUE" VARCHAR(50))`,
      `CREATE VIEW ${at('QA_VIEW')} AS SELECT "ID","TITLE" FROM ${at('QA_PARENT')}`,
      `COMMENT ON VIEW ${at('QA_VIEW')} IS '视图中文注释'`,
      `COMMENT ON COLUMN ${at('QA_VIEW')}."TITLE" IS '视图列注释'`,
    ],
  };
}

// Replace identifier tokens followed by '.', preserving string literals and comments byte-for-byte.
function remapQualifiedOwners(sql, owners) {
  let output = '';
  for (let at = 0; at < sql.length;) {
    const start = at;
    if (sql.startsWith('--', at)) { while (at < sql.length && sql[at] !== '\n') at++; }
    else if (sql.startsWith('/*', at)) { const end = sql.indexOf('*/', at + 2); if (end < 0) throw Error('注释未闭合'); at = end + 2; }
    else if (sql[at] === "'") { at++; let closed = false; while (at < sql.length) { if (sql[at++] === "'") { if (sql[at] === "'") at++; else { closed = true; break; } } } if (!closed) throw Error('字符串未闭合'); }
    else if (sql[at] === '"') {
      at++; let name = '', closed = false;
      while (at < sql.length) { const c = sql[at++]; if (c === '"') { if (sql[at] === '"') { name += '"'; at++; } else { closed = true; break; } } else name += c; }
      if (!closed) throw Error('标识符未闭合');
      if (owners[name] && /^\s*\./.test(sql.slice(at))) { output += ident(owners[name]); continue; }
    } else if (/[A-Za-z_]/.test(sql[at])) {
      while (at < sql.length && /[A-Za-z_\d$]/.test(sql[at])) at++;
      const name = sql.slice(start, at);
      if (owners[name] && /^\s*\./.test(sql.slice(at))) { output += ident(owners[name]); continue; }
    } else at++;
    output += sql.slice(start, at);
  }
  return output;
}
module.exports = { ddlFixture, remapQualifiedOwners };
