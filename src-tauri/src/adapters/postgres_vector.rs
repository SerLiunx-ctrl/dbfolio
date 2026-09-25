// pgvector vector_send/recv: 网络字节序 int16 维数、int16 保留位、逐项 float32。
// https://github.com/pgvector/pgvector/blob/v0.8.0/src/vector.c
pub fn decode_vector(bytes: &[u8], binary: bool) -> Result<String, &'static str> {
    if !binary {
        let text = std::str::from_utf8(bytes)
            .map_err(|_| "向量文本编码无效")?
            .trim();
        let body = text
            .strip_prefix('[')
            .and_then(|s| s.strip_suffix(']'))
            .ok_or("向量文本格式无效")?;
        let mut count = 0;
        for part in body.split(',') {
            let value = part.trim().parse::<f32>().map_err(|_| "向量元素无效")?;
            if !value.is_finite() {
                return Err("向量元素非有限数值");
            }
            count += 1;
        }
        if count == 0 || count > 16000 {
            return Err("向量维数无效");
        }
        return Ok(text.to_owned());
    }
    if bytes.len() < 4 {
        return Err("向量数据头不完整");
    }
    let dimensions = i16::from_be_bytes([bytes[0], bytes[1]]);
    if dimensions <= 0 || dimensions > 16000 {
        return Err("向量维数无效");
    }
    if bytes[2..4] != [0, 0] {
        return Err("向量保留位无效");
    }
    if bytes.len() != 4 + dimensions as usize * 4 {
        return Err("向量数据长度与维数不符");
    }
    let mut values = Vec::with_capacity(dimensions as usize);
    for chunk in bytes[4..].chunks_exact(4) {
        let value = f32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]);
        if !value.is_finite() {
            return Err("向量元素非有限数值");
        }
        values.push(value.to_string());
    }
    Ok(format!("[{}]", values.join(",")))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn binary_vectors_and_768_dimensions() {
        let values = [-0.25_f32, 0.0, 1.5];
        let mut bytes = vec![0, 3, 0, 0];
        for value in values {
            bytes.extend(value.to_be_bytes());
        }
        assert_eq!(decode_vector(&bytes, true).unwrap(), "[-0.25,0,1.5]");
        let mut full = vec![3, 0, 0, 0];
        for _ in 0..768 {
            full.extend(0.125_f32.to_be_bytes());
        }
        let output = decode_vector(&full, true).unwrap();
        assert_eq!(output.trim_matches(['[', ']']).split(',').count(), 768);
        assert!(decode_vector(&full[..full.len() - 1], true).is_err());
        assert!(decode_vector(&[0, 1, 0, 1, 0, 0, 0, 0], true).is_err());
        assert!(decode_vector(&[0, 0, 0, 0], true).is_err());
        let mut invalid = vec![0, 1, 0, 0];
        invalid.extend(f32::NAN.to_be_bytes());
        assert!(decode_vector(&invalid, true).is_err());
    }
    #[test]
    fn text_format_and_invalid_values() {
        assert_eq!(
            decode_vector(b"[-0.1, 2e-3,0]", false).unwrap(),
            "[-0.1, 2e-3,0]"
        );
        for text in ["[]", "[NaN]", "[1,]", "[1]junk"] {
            assert!(decode_vector(text.as_bytes(), false).is_err());
        }
    }
}
