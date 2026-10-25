import type { CanonicalType, DbValue } from "../../ipc/types";

// 编辑器返回文本；数值列必须保留数据库类型，不能在解析失败后退回 text。
export function numericValue(type: CanonicalType, text: string): DbValue | undefined {
  const value = text.trim();
  switch (type.kind) {
    case "int": {
      if (!/^[+-]?\d+$/.test(value)) throw Error("请输入有效整数");
      const integer = BigInt(value);
      const bits = BigInt(type.bits);
      const min = type.unsigned ? 0n : -(1n << (bits - 1n));
      const max = type.unsigned ? (1n << bits) - 1n : (1n << (bits - 1n)) - 1n;
      if (integer < min || integer > max) throw Error(`整数超出范围（${min}～${max}）`);
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
    case "decimal":
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) throw Error("请输入有效十进制数值");
      // 不经 Number 转换，保留 Decimal 的全部有效位。
      return ["decimal", value];
    case "bool":
      if (/^(1|true|yes)$/i.test(value)) return ["bool", true];
      if (/^(0|false|no)$/i.test(value)) return ["bool", false];
      throw Error("布尔值请输入 true、false、0 或 1");
    default:
      return undefined;
  }
}
