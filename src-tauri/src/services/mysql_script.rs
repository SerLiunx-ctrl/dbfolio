//! Streaming mysql-client script reader. Client directives are never sent to the server.
use crate::error::{AppError, AppResult};
use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read, Write};
pub const MAX_STATEMENT: usize = 64 * 1024 * 1024;
pub fn nonstandard_quotes(mode: &str) -> bool {
    mode.split(',')
        .any(|s| matches!(s.trim(), "NO_BACKSLASH_ESCAPES" | "ANSI_QUOTES"))
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Statement {
    pub line: u64,
    pub sql: String,
}
pub struct Script<R: BufRead> {
    reader: R,
    input: Vec<u8>,
    at: usize,
    line: u64,
    start: u64,
    sql: Vec<u8>,
    delimiter: Vec<u8>,
    quote: u8,
    block: bool,
    keep_block: bool,
    escaped: bool,
    eof: bool,
}
fn invalid(message: impl Into<String>) -> AppError {
    AppError::InvalidInput(message.into())
}
impl<R: BufRead> Script<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            input: vec![],
            at: 0,
            line: 0,
            start: 1,
            sql: vec![],
            delimiter: vec![b';'],
            quote: 0,
            block: false,
            keep_block: false,
            escaped: false,
            eof: false,
        }
    }
    pub fn next(&mut self) -> AppResult<Option<Statement>> {
        loop {
            if self.at == self.input.len() {
                if self.eof {
                    return Ok(None);
                }
                self.input.clear();
                self.at = 0;
                let n = (&mut self.reader)
                    .take((MAX_STATEMENT + 1) as u64)
                    .read_until(b'\n', &mut self.input)?;
                if n > MAX_STATEMENT {
                    return Err(invalid("SQL 单行超过 64 MiB，请减小 INSERT 批次"));
                }
                if n == 0 {
                    self.eof = true;
                    if self.quote != 0 || self.block {
                        return Err(invalid(format!(
                            "第 {} 行开始的字符串或注释未闭合",
                            self.start
                        )));
                    }
                    return self.finish();
                }
                self.line += 1;
                if self.quote == 0 && !self.block && self.sql.is_empty() {
                    let text = std::str::from_utf8(&self.input)
                        .map_err(|_| invalid("文件不是有效的所选编码"))?
                        .trim();
                    let mut words = text.split_whitespace();
                    if words
                        .next()
                        .is_some_and(|s| s.eq_ignore_ascii_case("delimiter"))
                    {
                        let value = words
                            .next()
                            .ok_or_else(|| invalid("DELIMITER 缺少分隔符"))?;
                        if words.next().is_some()
                            || value.len() > 64
                            || value.is_empty()
                            || value.bytes().any(|c| b"'\"`\\#".contains(&c))
                            || value.starts_with("/*")
                            || value.starts_with("--")
                        {
                            return Err(invalid(format!("第 {} 行 DELIMITER 无效", self.line)));
                        }
                        self.delimiter = value.as_bytes().to_vec();
                        self.at = self.input.len();
                        continue;
                    }
                }
            }
            let rest = &self.input[self.at..];
            let b = rest[0];
            if self.quote != 0 {
                self.sql.push(b);
                self.at += 1;
                if self.escaped {
                    self.escaped = false;
                } else if b == b'\\' && self.quote != b'`' {
                    self.escaped = true;
                } else if b == self.quote {
                    if self.input.get(self.at) == Some(&self.quote) {
                        self.sql.push(b);
                        self.at += 1;
                    } else {
                        self.quote = 0;
                    }
                }
            } else if self.block {
                if rest.starts_with(b"*/") {
                    if self.keep_block {
                        self.sql.extend_from_slice(b"*/");
                    }
                    self.at += 2;
                    self.block = false;
                } else {
                    if self.keep_block {
                        self.sql.push(b);
                    }
                    self.at += 1;
                }
            } else if rest.starts_with(&self.delimiter) {
                self.at += self.delimiter.len();
                if let Some(s) = self.finish()? {
                    return Ok(Some(s));
                }
            } else if b == b'#'
                || (rest.starts_with(b"--") && rest.get(2).is_none_or(|c| c.is_ascii_whitespace()))
            {
                if !self.sql.is_empty() {
                    self.sql.push(b' ');
                }
                self.at = self.input.len();
            } else if rest.starts_with(b"/*") {
                if self.sql.is_empty() {
                    self.start = self.line;
                }
                self.block = true;
                self.keep_block = rest.get(2).is_some_and(|c| *c == b'!' || *c == b'+');
                if self.keep_block {
                    self.sql.extend_from_slice(b"/*");
                } else if !self.sql.is_empty() {
                    self.sql.push(b' ');
                }
                self.at += 2;
            } else {
                if self.sql.is_empty() && b.is_ascii_whitespace() {
                    self.at += 1;
                    continue;
                }
                if self.sql.is_empty() {
                    self.start = self.line;
                }
                if b"'\"`".contains(&b) {
                    self.quote = b;
                }
                self.sql.push(b);
                self.at += 1;
            }
            if self.sql.len() > MAX_STATEMENT {
                return Err(invalid(format!("第 {} 行语句超过 64 MiB", self.start)));
            }
        }
    }
    fn finish(&mut self) -> AppResult<Option<Statement>> {
        let sql =
            String::from_utf8(std::mem::take(&mut self.sql)).map_err(|_| invalid("无效 UTF-8"))?;
        if words(&sql).is_empty() {
            return Ok(None);
        }
        Ok(Some(Statement {
            line: self.start,
            sql: sql.trim().to_owned(),
        }))
    }
}
/// SQL tokens outside literals; executable comments are expanded for scope/risk inspection.
pub fn words(sql: &str) -> Vec<String> {
    let b = sql.as_bytes();
    let mut i = 0;
    let mut out = vec![];
    while i < b.len() {
        if b[i..].starts_with(b"/*") {
            if let Some(end) = sql[i + 2..].find("*/") {
                let mut inner = &sql[i + 2..i + 2 + end];
                if inner.starts_with('!') {
                    inner = inner[1..].trim_start_matches(|c: char| c.is_ascii_digit());
                    out.extend(words(inner));
                }
                i += end + 4;
                continue;
            }
        }
        if b[i..].starts_with(b"--") && b.get(i + 2).is_none_or(u8::is_ascii_whitespace)
            || b[i] == b'#'
        {
            while i < b.len() && b[i] != b'\n' {
                i += 1;
            }
            continue;
        }
        if b"'\"`".contains(&b[i]) {
            let quote = b[i];
            i += 1;
            let mut token = vec![];
            while i < b.len() {
                if b[i] == b'\\' && quote != b'`' {
                    i += 2;
                    continue;
                }
                if b[i] == quote {
                    if b.get(i + 1) == Some(&quote) {
                        token.push(quote);
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                token.push(b[i]);
                i += 1;
            }
            out.push(if quote == b'`' {
                String::from_utf8_lossy(&token).into_owned()
            } else {
                "<literal>".into()
            });
            continue;
        }
        if b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] >= 128 {
            let start = i;
            while i < b.len()
                && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] == b'$' || b[i] >= 128)
            {
                i += 1;
            }
            out.push(sql[start..i].to_owned());
        } else {
            if !b[i].is_ascii_whitespace() {
                out.push((b[i] as char).to_string());
            }
            i += 1;
        }
    }
    out
}
/// Transcode incrementally into a temporary UTF-8 snapshot. Reject lossy conversions.
pub fn decode(path: &std::path::Path, encoding: &str) -> AppResult<tempfile::NamedTempFile> {
    let enc = encoding_rs::Encoding::for_label(encoding.as_bytes())
        .ok_or_else(|| invalid("不支持的文件编码"))?;
    let mut decoder = enc.new_decoder();
    let mut reader = BufReader::new(std::fs::File::open(path)?);
    let mut output = tempfile::NamedTempFile::new()?;
    let mut buffer = [0u8; 32768];
    loop {
        crate::tasks::checkpoint()?;
        let n = reader.read(&mut buffer)?;
        let mut offset = 0;
        loop {
            let mut text = String::with_capacity(131072);
            let (result, used, errors) =
                decoder.decode_to_string(&buffer[offset..n], &mut text, n == 0);
            if errors {
                return Err(invalid("文件含有无法按所选编码解码的字节，请更换编码"));
            }
            output.write_all(text.as_bytes())?;
            offset += used;
            if result == encoding_rs::CoderResult::InputEmpty {
                break;
            }
        }
        if n == 0 {
            break;
        }
    }
    output.flush()?;
    Ok(output)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn quote_modes() {
        assert!(nonstandard_quotes("STRICT_TRANS_TABLES,ANSI_QUOTES"));
        assert!(nonstandard_quotes("NO_BACKSLASH_ESCAPES"));
        assert!(!nonstandard_quotes(
            "NO_AUTO_VALUE_ON_ZERO,STRICT_TRANS_TABLES"
        ));
    }
    #[test]
    fn delimiter_and_routines() {
        let s="-- header\nDELIMITER $$\nCREATE PROCEDURE p() BEGIN SELECT ';', 'a\\\'b'; /* ; */ SELECT 2; END$$\nDELIMITER ;\nINSERT INTO t VALUES('$$', '中文');\n/*!40101 SET @a=1 */;";
        let mut p = Script::new(s.as_bytes());
        let a = p.next().unwrap().unwrap();
        assert_eq!(a.line, 3);
        assert!(a.sql.ends_with("END"));
        assert!(p.next().unwrap().unwrap().sql.starts_with("INSERT"));
        assert!(p.next().unwrap().unwrap().sql.starts_with("/*!"));
        assert!(p.next().unwrap().is_none());
    }
    #[test]
    fn incomplete_and_comments() {
        assert!(Script::new("select 'a".as_bytes()).next().is_err());
        assert!(Script::new("/*x*/; -- a\n".as_bytes())
            .next()
            .unwrap()
            .is_none());
        assert_eq!(words("/*!50000 USE `a``b` */"), vec!["USE", "a`b"]);
    }
    #[test]
    fn encoding_roundtrip() {
        let mut f = tempfile::NamedTempFile::new().unwrap();
        let (v, _, _) = encoding_rs::GBK.encode("SELECT '中文';");
        f.write_all(&v).unwrap();
        let d = decode(f.path(), "gbk").unwrap();
        assert_eq!(std::fs::read_to_string(d.path()).unwrap(), "SELECT '中文';");
        assert!(decode(f.path(), "utf-8").is_err());
    }
}
