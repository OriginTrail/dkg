export interface ProtobufLong {
  low: number;
  high: number;
  unsigned: boolean;
}

export function protobufScalarToNumber(value: number | bigint | ProtobufLong): number {
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'number') return value;
  return ((value.high >>> 0) * 0x100000000) + (value.low >>> 0);
}

export function protobufScalarToBigInt(
  value: string | number | bigint | ProtobufLong,
): bigint {
  if (typeof value === 'string') return BigInt(value);
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') return BigInt(value);
  return (BigInt(value.high >>> 0) << 32n) | BigInt(value.low >>> 0);
}
