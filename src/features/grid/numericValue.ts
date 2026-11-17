import type { CanonicalType, ColumnMeta, DbValue } from "../../ipc/types";

// 编辑器返回文本；数值列必须保留数据库类型，不能在解析失败后退回 text。
export function numericValue(type: CanonicalType, text: string, column?: Pick<ColumnMeta, "rawType" | "unsigned">): DbValue | undefined {
  const value = text.trim();
  switch (type.kind) {
    case "int": {
      if (!/^[+-]?\d+$/.test(value)) throw Error("请输入有效整数");
      const integer = BigInt(value);
      const bits = BigInt(type.bits);
      const min = type.unsigned ? 0n : -(1n << (bits - 1n));
      const max = type.unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
      if (integer < min || integer > max) throw Error(`整数超出范围（${min}～${max}）`);
      if (type.bits === 16 && type.unsigned && /^year(?:\(\d+\))?$/i.test(column?.rawType.trim() ?? "") && integer !== 0n && (integer < 1901n || integer > 2155n)) {
        throw Error("YEAR 请输入 0 或 1901～2155，避免服务器自动转换年份");
      }
      const number = Number(integer);
      return [type.unsigned ? "uint" : "int", Number.isSafeInteger(number) ? number : integer.toString()];
    }
    case "float": {
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw Error("请输入有效数值");
      const number = Number(value);
      if (!Number.isFinite(number) || (type.bits === 32 && !Number.isFinite(Math.fround(number)))) {
        throw Error("数值超出浮点数范围");
      }
      return ["float", number];
    }
    case "decimal": {
      const parts = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:e([+-]?\d+))?$/i.exec(value);
      if (!parts) throw Error("请输入有效十进制数值");
      const fraction = parts[3] ?? parts[4] ?? "";
      const digits = ((parts[2] ?? "") + fraction).replace(/^0+/, "");
      if (digits) {
        if (column?.unsigned && parts[1] === "-") throw Error("无符号十进制数不能为负数");
        // 系数与十进制指数分开计算，不展开 e 指数、不经过 Number，也不舍入有效数字。
        const coefficient = digits.replace(/0+$/, "");
        const exponent = BigInt(parts[5] ?? "0") - BigInt(fraction.length) + BigInt(digits.length - coefficient.length);
        const precision = type.precision;
        if (precision != null && Number.isSafeInteger(precision) && precision > 0) {
          let scale = type.scale ?? 0;
          if (type.scale == null) {
            // PG 负 scale 无法由旧 unsigned canonical 字段承载；仅在精度已由服务器确认时恢复。
            // SQLite 的 NUMERIC 亲和性不提供 canonical 精度，不能仅凭声明的 (p,s) 加约束。
            const raw = /^(?:decimal|numeric|number)\s*\(\s*(\d+)\s*,\s*([+-]?\d+)\s*\)(?:\s+unsigned)?$/i.exec(column?.rawType.trim() ?? "");
            if (raw && Number(raw[1]) === precision && Number.isSafeInteger(Number(raw[2]))) scale = Number(raw[2]);
          }
          if (Number.isSafeInteger(scale)) {
            const quantum = BigInt(scale);
            if (exponent < -quantum) throw Error(`十进制数超出小数位限制（scale ${scale}），不会自动舍入`);
            if (BigInt(coefficient.length) + exponent + quantum > BigInt(precision)) throw Error(`十进制数超出精度限制（precision ${precision}，scale ${scale}）`);
          }
        }
      }
      // 保留输入的全部精确数字及数学等值的尾零、科学计数法形式。
      return ["decimal", value];
    }
    case "bool":
      if (/^(1|true|yes)$/i.test(value)) return ["bool", true];
      if (/^(0|false|no)$/i.test(value)) return ["bool", false];
      throw Error("布尔值请输入 true、false、0 或 1");
    default:
      return undefined;
  }
}
