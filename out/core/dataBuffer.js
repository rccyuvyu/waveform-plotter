"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.DataBuffer = exports.ChannelData = void 0;
const crypto_1 = require("crypto");
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
class ChannelData {
    constructor(name, color, capacity) {
        this.name = name;
        this.color = color;
        this.capacity = capacity;
        this.id = (0, crypto_1.randomUUID)();
        this.head = 0;
        this.size = 0;
        this.data = new Float64Array(capacity);
    }
    push(value) {
        this.data[this.head] = value;
        this.head = (this.head + 1) % this.capacity;
        if (this.size < this.capacity) {
            this.size += 1;
        }
    }
    get(index) {
        if (index < 0 || index >= this.size) {
            return NaN;
        }
        const physical = this.size < this.capacity ? index : (this.head + index) % this.capacity;
        return this.data[physical] ?? NaN;
    }
    toArray() {
        const out = new Array(this.size);
        for (let i = 0; i < this.size; i += 1) {
            out[i] = this.get(i);
        }
        return out;
    }
    clear() {
        this.head = 0;
        this.size = 0;
    }
}
exports.ChannelData = ChannelData;
class DataBuffer {
    constructor(maxChannels = 8, capacity = 10000) {
        this.maxChannels = maxChannels;
        this.capacity = capacity;
        this.channels = [];
        this.tsHead = 0;
        this._tsSize = 0;
        this._baseTimestampNs = 0n;
        this._version = 0;
        this._totalSamples = 0;
        this.timestamps = new BigInt64Array(capacity);
    }
    get tsSize() {
        return this._tsSize;
    }
    get version() {
        return this._version;
    }
    get totalSamples() {
        return this._totalSamples;
    }
    get baseTimestampNs() {
        return this._baseTimestampNs;
    }
    getChannels() {
        return [...this.channels];
    }
    addChannel(name) {
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
    removeChannel(name) {
        this.channels = this.channels.filter((c) => c.name !== name);
    }
    pushAll(values, timestampNs = process.hrtime.bigint()) {
        if (this._tsSize === 0) {
            this._baseTimestampNs = timestampNs;
        }
        this.timestamps[this.tsHead] = timestampNs;
        this.tsHead = (this.tsHead + 1) % this.capacity;
        if (this._tsSize < this.capacity) {
            this._tsSize += 1;
        }
        for (const ch of this.channels) {
            ch.push(values.get(ch.name) ?? Number.NaN);
        }
        this._totalSamples += 1;
        this._version += 1;
    }
    getTimestamp(index) {
        if (index < 0 || index >= this._tsSize) {
            return 0n;
        }
        const physical = this._tsSize < this.capacity ? index : (this.tsHead + index) % this.capacity;
        return this.timestamps[physical] ?? 0n;
    }
    getTimeSeconds(index) {
        const ts = this.getTimestamp(index);
        return Number(ts - this._baseTimestampNs) / 1_000_000_000;
    }
    clearAll() {
        for (const ch of this.channels) {
            ch.clear();
        }
        this.tsHead = 0;
        this._tsSize = 0;
        this._baseTimestampNs = 0n;
        this._version += 1;
    }
    appendSnapshotSince(lastTotalSamples) {
        if (lastTotalSamples < 0 || lastTotalSamples > this._totalSamples) {
            return undefined;
        }
        const appended = this._totalSamples - lastTotalSamples;
        if (appended <= 0) {
            return {
                totalSamples: this._totalSamples,
                timestampsSec: [],
                channels: this.channels.map((ch) => ({ name: ch.name, data: [] }))
            };
        }
        if (appended > this._tsSize) {
            return undefined;
        }
        const startIndex = this._tsSize - appended;
        const timestampsSec = new Array(appended);
        for (let i = 0; i < appended; i += 1) {
            timestampsSec[i] = this.getTimeSeconds(startIndex + i);
        }
        return {
            totalSamples: this._totalSamples,
            timestampsSec,
            channels: this.channels.map((ch) => {
                const data = new Array(Math.min(appended, ch.size));
                const channelStart = Math.max(0, ch.size - appended);
                for (let i = 0; i < data.length; i += 1) {
                    data[i] = ch.get(channelStart + i);
                }
                return { name: ch.name, data };
            })
        };
    }
    snapshot() {
        const timestampsSec = new Array(this._tsSize);
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
exports.DataBuffer = DataBuffer;
//# sourceMappingURL=dataBuffer.js.map