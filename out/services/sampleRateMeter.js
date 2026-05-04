"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SampleRateMeter = void 0;
class SampleRateMeter {
    constructor() {
        this.recentNs = [];
    }
    reset() {
        this.recentNs.length = 0;
    }
    mark(nowNs) {
        this.recentNs.push(nowNs);
        if (this.recentNs.length > 32) {
            this.recentNs.shift();
        }
    }
    getHz() {
        if (this.recentNs.length < 2) {
            return 0;
        }
        const first = this.recentNs[0];
        const last = this.recentNs[this.recentNs.length - 1];
        if (last <= first) {
            return 0;
        }
        const seconds = Number(last - first) / 1_000_000_000;
        if (seconds <= 0) {
            return 0;
        }
        return (this.recentNs.length - 1) / seconds;
    }
}
exports.SampleRateMeter = SampleRateMeter;
//# sourceMappingURL=sampleRateMeter.js.map