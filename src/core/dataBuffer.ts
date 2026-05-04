import { randomUUID } from 'crypto';

const DEFAULT_COLORS = [
  '#4FC3F7',
  '#EF5350',
  '#66BB6A',
  '#FFA726',
  '#AB47BC',
  '#26C6DA',
  '#FFEE58',
  '#EC407A'
];

export class ChannelData {
  readonly id = randomUUID();
  readonly data: Float64Array;
  head = 0;
  size = 0;

  constructor(
    public readonly name: string,
    public readonly color: string,
    private readonly capacity: number
  ) {
    this.data = new Float64Array(capacity);
  }

  push(value: number): void {
    this.data[this.head] = value;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) {
      this.size += 1;
    }
  }

  get(index: number): number {
    if (index < 0 || index >= this.size) {
      return NaN;
    }
    const physical = this.size < this.capacity ? index : (this.head + index) % this.capacity;
    return this.data[physical] ?? NaN;
  }

  toArray(): number[] {
    const out = new Array<number>(this.size);
    for (let i = 0; i < this.size; i += 1) {
      out[i] = this.get(i);
    }
    return out;
  }

  clear(): void {
    this.head = 0;
    this.size = 0;
  }
}

export class DataBuffer {
  private channels: ChannelData[] = [];
  private timestamps: BigInt64Array;
  private tsHead = 0;
  private _tsSize = 0;
  private _baseTimestampNs = 0n;
  private _version = 0;

  constructor(public readonly maxChannels = 8, public readonly capacity = 10000) {
    this.timestamps = new BigInt64Array(capacity);
  }

  get tsSize(): number {
    return this._tsSize;
  }

  get version(): number {
    return this._version;
  }

  get baseTimestampNs(): bigint {
    return this._baseTimestampNs;
  }

  getChannels(): ChannelData[] {
    return [...this.channels];
  }

  addChannel(name: string): ChannelData | undefined {
    if (!name.trim()) {
      return undefined;
    }
    const exists = this.channels.find((c) => c.name === name);
    if (exists) {
      return exists;
    }
    if (this.channels.length >= this.maxChannels) {
      return undefined;
    }
    const ch = new ChannelData(name, DEFAULT_COLORS[this.channels.length % DEFAULT_COLORS.length], this.capacity);
    this.channels.push(ch);
    return ch;
  }

  removeChannel(name: string): void {
    this.channels = this.channels.filter((c) => c.name !== name);
  }

  pushAll(values: Map<string, number>, timestampNs = process.hrtime.bigint()): void {
    if (this._tsSize === 0) {
      this._baseTimestampNs = timestampNs;
    }
    this.timestamps[this.tsHead] = timestampNs;
    this.tsHead = (this.tsHead + 1) % this.capacity;
    if (this._tsSize < this.capacity) {
      this._tsSize += 1;
    }

    for (const ch of this.channels) {
      const value = values.get(ch.name);
      if (value !== undefined) {
        ch.push(value);
      }
    }
    this._version += 1;
  }

  getTimestamp(index: number): bigint {
    if (index < 0 || index >= this._tsSize) {
      return 0n;
    }
    const physical = this._tsSize < this.capacity ? index : (this.tsHead + index) % this.capacity;
    return this.timestamps[physical] ?? 0n;
  }

  getTimeSeconds(index: number): number {
    const ts = this.getTimestamp(index);
    return Number(ts - this._baseTimestampNs) / 1_000_000_000;
  }

  clearAll(): void {
    for (const ch of this.channels) {
      ch.clear();
    }
    this.tsHead = 0;
    this._tsSize = 0;
    this._baseTimestampNs = 0n;
    this._version += 1;
  }

  snapshot(): {
    channels: Array<{ name: string; color: string; data: number[] }>;
    timestampsSec: number[];
    version: number;
  } {
    const timestampsSec = new Array<number>(this._tsSize);
    for (let i = 0; i < this._tsSize; i += 1) {
      timestampsSec[i] = this.getTimeSeconds(i);
    }

    return {
      channels: this.channels.map((ch) => ({
        name: ch.name,
        color: ch.color,
        data: ch.toArray()
      })),
      timestampsSec,
      version: this._version
    };
  }
}
