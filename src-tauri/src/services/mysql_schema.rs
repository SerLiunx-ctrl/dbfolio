//! 从服务器原始 DDL 中隔离目标列；不重写其他列、表选项或厂商扩展。
use crate::error::{AppError, AppResult};
use sqlparser::{dialect::MySqlDialect, tokenizer::{Token, Tokenizer}};

pub fn column_definition(raw: &str, name: &str) -> AppResult<String> {
    let fail = |e: String| AppError::InvalidInput(format!("无法安全定位列定义：{e}"));
    let tokens = Tokenizer::new(&MySqlDialect {}, raw).tokenize_with_location().map_err(|e| fail(e.to_string()))?;
    let offset = |line: u64, column: u64| -> usize {
        let start = raw.split_inclusive('\n').take(line.saturating_sub(1) as usize).map(str::len).sum::<usize>();
        start + raw[start..].char_indices().nth(column.saturating_sub(1) as usize).map(|(i,_)|i).unwrap_or(raw.len()-start)
    };
    let mut depth = 0;
    let mut start = None;
    let mut matches_name = false;
    for t in tokens {
        let at = offset(t.span.start.line, t.span.start.column);
        match t.token {
            Token::LParen => { depth += 1; }
            Token::RParen if depth == 1 => {
                if matches_name { return Ok(raw[start.unwrap_or(at)..at].trim().to_owned()); }
                break;
            }
            Token::RParen => { depth -= 1; }
            Token::Comma if depth == 1 => {
                if matches_name { return Ok(raw[start.unwrap_or(at)..at].trim().to_owned()); }
                start = None;
            }
            Token::Whitespace(_) => {}
            token if depth == 1 && start.is_none() => {
                start = Some(at);
                matches_name = matches!(token, Token::Word(w) if w.value == name);
            }
            _ => {}
        }
    }
    Err(fail(format!("未找到字段 {name}")))
}

/// CHECK 引用随字段改名更新，字符串、函数名和其他限定名保持不变。
pub fn rename_check(expr:&sqlparser::ast::Expr, old:&str, new:&str)->AppResult<sqlparser::ast::Expr> {
    use sqlparser::parser::Parser;
    let fail=|e:String|AppError::InvalidInput(format!("无法安全更新字段 CHECK 引用：{e}"));
    let mut text=expr.to_string();
    let tokens=Tokenizer::new(&MySqlDialect{},&text).tokenize_with_location().map_err(|e|fail(e.to_string()))?;
    let tokens=tokens.into_iter().filter(|t|!matches!(t.token,Token::Whitespace(_))).collect::<Vec<_>>();
    let position=|line:u64,column:u64|{
        let start=text.split_inclusive('\n').take(line.saturating_sub(1) as usize).map(str::len).sum::<usize>();
        start+text[start..].char_indices().nth(column.saturating_sub(1) as usize).map(|(i,_)|i).unwrap_or(text.len()-start)
    };
    let ranges=tokens.iter().enumerate().filter_map(|(i,t)|{
        if matches!(&t.token,Token::Word(w) if w.value==old) && !tokens.get(i+1).is_some_and(|next|matches!(next.token,Token::LParen|Token::Period)) {
            Some(position(t.span.start.line,t.span.start.column)..position(t.span.end.line,t.span.end.column))
        }else{None}
    }).collect::<Vec<_>>();
    let ident=format!("`{}`",new.replace('`',"``"));
    for range in ranges.into_iter().rev(){text.replace_range(range,&ident);}
    Parser::new(&MySqlDialect{}).try_with_sql(&text).map_err(|e|fail(e.to_string()))?.parse_expr().map_err(|e|fail(e.to_string()))
}

#[cfg(test)] mod tests {
    use super::*;
    #[test] fn isolates_without_rewriting_vendor_options_or_quoted_commas() {
        let raw = "CREATE TABLE `x` (\n `中文` varchar(80) DEFAULT 'a,b)''c' COMMENT '说明',\n `g` int AS (`id`*2) STORED, `h` int INVISIBLE, KEY `i` (`中文`(5)) IGNORED) ENGINE=InnoDB";
        assert_eq!(column_definition(raw,"中文").unwrap(), "`中文` varchar(80) DEFAULT 'a,b)''c' COMMENT '说明'");
        assert_eq!(column_definition(raw,"h").unwrap(), "`h` int INVISIBLE");
        assert!(column_definition(raw,"missing").is_err());
    }
    #[test] fn check_rename_preserves_literals_functions_and_qualifiers() {
        use sqlparser::parser::Parser;
        let expr=Parser::new(&MySqlDialect{}).try_with_sql("json_valid(`中文`) AND `中文` <> '中文' AND 中文(1)>0 AND 中文.other>0").unwrap().parse_expr().unwrap();
        let next=rename_check(&expr,"中文","新`列").unwrap().to_string();
        assert!(next.contains("json_valid(`新``列`)"));
        assert!(next.contains("'中文'"));assert!(next.contains("中文(1)"));assert!(next.contains("中文.other"));
    }
    #[test] fn ignores_comments_and_multibyte_locations() {
        let raw = "CREATE TABLE x (/* ( , */ `表` int, -- ) ,\n `b``c` varchar(9) DEFAULT 'x\\\'y,z', CONSTRAINT c CHECK (`表`>0))";
        assert_eq!(column_definition(raw,"表").unwrap(),"`表` int");
        assert_eq!(column_definition(raw,"b`c").unwrap(),"`b``c` varchar(9) DEFAULT 'x\\\'y,z'");
    }
}
