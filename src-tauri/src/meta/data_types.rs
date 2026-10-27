use super::Engine;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct DataTypeOption {
    pub name: String,
    pub label: String,
    pub description: String,
    pub category: String,
    /// none / length / precision / temporal / values / dimensions
    pub arguments: String,
    pub default_arguments: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all="camelCase")]
pub struct DataTypeCatalog {pub server_version:String,pub types:Vec<DataTypeOption>}
pub fn option(name:&str,description:&str,category:&str,args:&str,default:&str)->DataTypeOption {
    DataTypeOption{name:name.into(),label:name.into(),description:description.into(),category:category.into(),arguments:args.into(),default_arguments:default.into()}
}
pub fn version(value:&str)->Option<(u32,u32,u32)>{
    let value=if value.to_ascii_lowercase().contains("mariadb"){value.strip_prefix("5.5.5-").unwrap_or(value)}else{value};
    let mut parts=value.split(|c:char|!c.is_ascii_digit()).filter(|v|!v.is_empty());
    Some((parts.next()?.parse().ok()?,parts.next()?.parse().ok()?,parts.next().and_then(|s|s.parse().ok()).unwrap_or(0)))
}
pub fn builtin(engine:Engine,server_version:&str)->DataTypeCatalog{
    let mut types=Vec::new();
    let mut add=|n,d,c,a,v|types.push(option(n,d,c,a,v));
    if engine==Engine::Mysql {
        for (n,d) in [("tinyint","1 字节整数"),("smallint","2 字节整数"),("mediumint","3 字节整数"),("int","4 字节整数"),("bigint","8 字节整数")] {add(n,d,"数值","none","");}
        add("boolean","布尔值；TINYINT(1) 别名","布尔","none","");
        add("decimal","精确定点数：精度,小数位","数值","precision","10,0");add("float","单精度浮点数","数值","none","");add("double","双精度浮点数","数值","none","");
        for (n,d,args,default) in [("varchar","可变长度字符串","length","255"),("char","固定长度字符串","length","1"),("tinytext","短文本","none",""),("text","文本","none",""),("mediumtext","中等长度文本","none",""),("longtext","长文本","none",""),("enum","枚举值列表","values","'值1'"),("set","集合值列表","values","'值1'")] {add(n,d,"文本",args,default);}
        add("date","日期","日期与时间","none","");add("year","年份","日期与时间","none","");
        let temporal=version(server_version).is_some_and(|v|v>=(5,6,4));
        for n in ["time","datetime","timestamp"]{add(n,if temporal{"时间；可填 0～6 位小数秒"}else{"时间；仅秒精度"},"日期与时间",if temporal{"temporal"}else{"none"},"");}
        let maria=server_version.to_ascii_lowercase().contains("mariadb");
        if version(server_version).is_some_and(|v|v>=if maria{(10,2,7)}else{(5,7,8)}){add("json",if maria{"JSON 文档；MariaDB 文本别名"}else{"原生 JSON 文档；MySQL 5.7.8+"},"文档","none","");}
        if version(server_version).is_some_and(|v|v>=if maria{(11,7,1)}else{(9,0,0)}){add("vector",if maria{"向量；MariaDB 11.7.1+"}else{"向量；MySQL 9.0+"},"向量","dimensions","3");}
        for (n,d,args,default) in [("binary","固定长度二进制","length","1"),("varbinary","可变长度二进制","length","255"),("bit","位串","length","1"),("tinyblob","短二进制数据","none",""),("blob","二进制数据","none",""),("mediumblob","中等长度二进制数据","none",""),("longblob","长二进制数据","none","")] {add(n,d,"二进制",args,default);}
        for n in ["geometry","point","linestring","polygon","multipoint","multilinestring","multipolygon","geometrycollection"]{add(n,"空间几何类型","空间","none","");}
    } else if engine==Engine::Sqlite {
        for (n,d) in [("integer","整数亲和性"),("int","整数亲和性"),("bigint","整数亲和性"),("real","浮点亲和性"),("numeric","数值亲和性"),("decimal","数值亲和性，非定点约束"),("text","文本亲和性"),("varchar","文本亲和性，长度非强制约束"),("char","文本亲和性，长度非强制约束"),("blob","二进制/无类型亲和性"),("boolean","通常存为整数 0/1"),("date","日期声明，通常存为文本"),("datetime","日期时间声明，通常存为文本"),("timestamp","时间戳声明，通常存为文本"),("any","任意值；STRICT 需 SQLite 3.37+")] {add(n,d,"SQLite 声明","none","");}
    }
    DataTypeCatalog{server_version:server_version.into(),types}
}
pub fn validate_mysql_type(server_version:&str,raw:&str)->crate::error::AppResult<()>{
    let name=raw.trim().split(|c:char|!c.is_ascii_alphanumeric()).next().unwrap_or("").to_ascii_lowercase();
    if name=="json"||name=="vector" {
        if !builtin(Engine::Mysql,server_version).types.iter().any(|t|t.name==name){return Err(crate::error::AppError::InvalidInput(format!("当前服务器版本 {server_version} 不支持可视化选择的 {name} 类型，请刷新类型或通过 SQL 核对服务器能力")));}
    }
    if ["time","datetime","timestamp"].contains(&name.as_str())&&raw.contains('(')&&!version(server_version).is_some_and(|v|v>=(5,6,4)){
        return Err(crate::error::AppError::InvalidInput("此服务器版本不支持时间字段的小数秒精度".into()));
    }
    Ok(())
}
pub fn pg_builtin(name:&str)->Option<DataTypeOption>{
    let (alias,description,category,args,default)=match name {
        "int2"=>("smallint","2 字节整数","数值","none",""),"int4"=>("integer","4 字节整数","数值","none",""),"int8"=>("bigint","8 字节整数","数值","none",""),
        "bool"=>("boolean","布尔值","布尔","none",""),"numeric"=>("numeric","精确数值：精度,小数位","数值","precision","10,0"),"float4"=>("real","单精度浮点数","数值","none",""),"float8"=>("double precision","双精度浮点数","数值","none",""),"money"=>("money","货币值，格式受区域设置影响","数值","none",""),
        "varchar"=>("varchar","可变长度字符串","文本","length","255"),"bpchar"=>("char","固定长度字符串","文本","length","1"),"text"=>("text","不限长度文本","文本","none",""),
        "date"=>("date","日期","日期与时间","none",""),"time"=>("time","不带时区的时间","日期与时间","temporal",""),"timetz"=>("timetz","带时区的时间","日期与时间","temporal",""),"timestamp"=>("timestamp","不带时区的日期时间","日期与时间","temporal",""),"timestamptz"=>("timestamptz","带时区的日期时间","日期与时间","temporal",""),"interval"=>("interval","时间间隔","日期与时间","temporal",""),
        "json"=>("json","保留原文的 JSON 文档","文档","none",""),"jsonb"=>("jsonb","二进制 JSON 文档","文档","none",""),"xml"=>("xml","XML 文档","文档","none",""),"bytea"=>("bytea","二进制数据","二进制","none",""),"bit"=>("bit","固定长度位串","二进制","length","1"),"varbit"=>("bit varying","可变长度位串","二进制","length",""),
        "uuid"=>("uuid","通用唯一标识符","标识与网络","none",""),"inet"=>("inet","IP 地址","标识与网络","none",""),"cidr"=>("cidr","IP 网络地址","标识与网络","none",""),"macaddr"=>("macaddr","6 字节 MAC 地址","标识与网络","none",""),"macaddr8"=>("macaddr8","8 字节 MAC 地址","标识与网络","none",""),
        "tsvector"=>("tsvector","全文检索文档","全文检索","none",""),"tsquery"=>("tsquery","全文检索条件","全文检索","none",""),
        "point"|"line"|"lseg"|"box"|"path"|"polygon"|"circle"=>(name,"几何对象","空间","none",""),
        "int4range"|"int8range"|"numrange"|"tsrange"|"tstzrange"|"daterange"=>(name,"原生范围类型","范围","none",""),
        "int4multirange"|"int8multirange"|"nummultirange"|"tsmultirange"|"tstzmultirange"|"datemultirange"=>(name,"原生多范围类型","范围","none",""),
        _=>return None,
    };Some(option(alias,description,category,args,default))
}
#[cfg(test)]mod tests{
    use super::*;
    #[test]fn mysql_versions_do_not_offer_future_types(){
        for (v,json,vector) in [("5.6.51",false,false),("5.7.7",false,false),("5.7.8",true,false),("8.4.6",true,false),("9.0.0",true,true),("5.5.5-10.11.9-MariaDB",true,false),("11.7.1-MariaDB",true,true),("unknown",false,false)] {
            let types=builtin(Engine::Mysql,v).types;assert_eq!(types.iter().any(|t|t.name=="json"),json,"{v}");assert_eq!(types.iter().any(|t|t.name=="vector"),vector,"{v}");assert!(types.iter().all(|t|!t.description.is_empty()));
        }
        assert_eq!(builtin(Engine::Mysql,"5.6.3").types.iter().find(|t|t.name=="timestamp").unwrap().arguments,"none");
        assert_eq!(builtin(Engine::Mysql,"5.6.4").types.iter().find(|t|t.name=="timestamp").unwrap().arguments,"temporal");
        assert!(validate_mysql_type("5.7.7","JSON").is_err());assert!(validate_mysql_type("5.7.8","JSON").is_ok());
        assert!(validate_mysql_type("8.4.6","VECTOR(3)").is_err());assert!(validate_mysql_type("9.0.0","VECTOR(3)").is_ok());
        assert!(validate_mysql_type("5.6.3","TIMESTAMP(6)").is_err());
    }
}
