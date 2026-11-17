use crate::error::{AppError, AppResult};
use crate::meta::{mysql_bit_width, value::DbValue};

/// 旧版本将 BIT 解码为字节。字节表示位串的大端数值，不能按 ASCII 文本转换。
pub(super) fn bit_bytes_to_uint(bytes: &[u8]) -> Option<u64> {
    if bytes.is_empty() || bytes.len() > 8 {
        return None;
    }
    Some(bytes.iter().fold(0u64, |value, byte| (value << 8) | u64::from(*byte)))
}

fn unsigned_integer(value: &DbValue, allow_bytes: bool) -> Option<u64> {
    match value {
        DbValue::UInt(value) => Some(*value),
        DbValue::Int(value) => u64::try_from(*value).ok(),
        DbValue::Bool(value) => Some(u64::from(*value)),
        DbValue::Text(value) | DbValue::Decimal(value) => {
            let value = value.trim();
            (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
                .then(|| value.parse().ok()).flatten()
        }
        DbValue::Bytes(bytes) if allow_bytes => bit_bytes_to_uint(bytes),
        _ => None,
    }
}

/// 以服务器实际列类型修正 IPC 值；SET、旧值比较及主键条件必须使用同一种参数类型。
pub(super) fn normalize_column_value(column: &str, raw_type: &str, value: &DbValue) -> AppResult<DbValue> {
    if matches!(value, DbValue::Null) {
        return Ok(DbValue::Null);
    }
    if let Some(bits) = mysql_bit_width(raw_type) {
        let maximum = if bits == 64 { u64::MAX } else { (1u64 << bits) - 1 };
        return unsigned_integer(value, true)
            .filter(|value| *value <= maximum)
            .map(DbValue::UInt)
            .ok_or_else(|| AppError::InvalidInput(format!("列 {column} 的 BIT({bits}) 值必须为 0～{maximum} 的无符号整数")));
    }
    let base = raw_type.trim().split('(').next().unwrap_or("").trim();
    if base.eq_ignore_ascii_case("year") {
        return unsigned_integer(value, false)
            .filter(|value| *value == 0 || (1901..=2155).contains(value))
            .map(DbValue::UInt)
            .ok_or_else(|| AppError::InvalidInput(format!("列 {column} 的 YEAR 值必须为 0 或 1901～2155，不能使用两位年份")));
    }
    Ok(value.clone())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bit_accepts_exact_unsigned_values_and_legacy_binary() {
        for (raw, value, expected) in [
            ("bit", DbValue::Text("1".into()), 1),
            ("bit(1)", DbValue::Int(0), 0),
            ("bit(1)", DbValue::Bool(true), 1),
            ("bit(1)", DbValue::Bytes(vec![1]), 1),
            ("bit(9)", DbValue::Bytes(vec![1, 255]), 511),
            ("bit(8)", DbValue::Bytes(vec![b'1']), 49),
            ("bit(64)", DbValue::Text(u64::MAX.to_string()), u64::MAX),
            ("bit(64)", DbValue::Bytes(vec![255; 8]), u64::MAX),
        ] {
            assert_eq!(normalize_column_value("flag", raw, &value).unwrap(), DbValue::UInt(expected));
        }
        assert_eq!(normalize_column_value("flag", "bit(1)", &DbValue::Null).unwrap(), DbValue::Null);
    }

    #[test]
    fn bit_rejects_out_of_range_and_ambiguous_values() {
        for value in [DbValue::Int(-1), DbValue::UInt(2), DbValue::Text("1.0".into()), DbValue::Text("0b1".into()),
            DbValue::Text("18446744073709551616".into()), DbValue::Text("".into()), DbValue::Bytes(vec![b'1']),
            DbValue::Bytes(vec![]), DbValue::Bytes(vec![0; 9]), DbValue::Float(1.0)] {
            assert!(normalize_column_value("flag", "bit(1)", &value).is_err(), "{value:?}");
        }
        assert!(normalize_column_value("flag", "bit(63)", &DbValue::UInt(1u64 << 63)).is_err());
    }

    #[test]
    fn year_uses_full_years_without_server_coercion() {
        for value in [0, 1901, 2026, 2155] {
            assert_eq!(normalize_column_value("y", "year(4)", &DbValue::Text(value.to_string())).unwrap(), DbValue::UInt(value));
        }
        for value in [1, 26, 1900, 2156] {
            assert!(normalize_column_value("y", "YEAR", &DbValue::UInt(value)).is_err());
        }
        let bytes = DbValue::Bytes(vec![0, 49]);
        assert_eq!(normalize_column_value("payload", "varbinary(2)", &bytes).unwrap(), bytes);
        let text = DbValue::Text("UPPER".into());
        assert_eq!(normalize_column_value("state", "enum('UPPER','lower')", &text).unwrap(), text);
    }
}
