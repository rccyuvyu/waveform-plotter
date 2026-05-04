"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FFT = void 0;
class FFT {
    constructor() {
        this.cachedWindowSize = 0;
        this.cachedWindow = new Float64Array(0);
        this.workN = 0;
        this.workRe = new Float64Array(0);
        this.workIm = new Float64Array(0);
    }
    magnitudeSpectrum(input) {
        const n = this.nextPowerOf2(input.length);
        const half = Math.floor(n / 2);
        if (this.workN !== n) {
            this.workN = n;
            this.workRe = new Float64Array(n);
            this.workIm = new Float64Array(n);
        }
        const window = this.getWindow(input.length);
        for (let i = 0; i < input.length; i += 1) {
            this.workRe[i] = input[i] * window[i];
        }
        for (let i = input.length; i < n; i += 1) {
            this.workRe[i] = 0;
        }
        this.workIm.fill(0);
        this.fftInPlace(this.workRe, this.workIm);
        const invN = 2 / n;
        const mag = new Array(half);
        for (let i = 0; i < half; i += 1) {
            const amp = Math.sqrt(this.workRe[i] * this.workRe[i] + this.workIm[i] * this.workIm[i]) * invN;
            mag[i] = amp > 1e-12 ? 20 * Math.log10(amp) : -240;
        }
        return mag;
    }
    fftSize(inputSize) {
        return this.nextPowerOf2(inputSize);
    }
    getWindow(size) {
        if (this.cachedWindowSize === size) {
            return this.cachedWindow;
        }
        this.cachedWindowSize = size;
        this.cachedWindow = new Float64Array(size);
        if (size <= 1) {
            this.cachedWindow.fill(1);
            return this.cachedWindow;
        }
        for (let i = 0; i < size; i += 1) {
            this.cachedWindow[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (size - 1)));
        }
        return this.cachedWindow;
    }
    nextPowerOf2(n) {
        let v = 1;
        while (v < n) {
            v <<= 1;
        }
        return v;
    }
    fftInPlace(re, im) {
        const n = re.length;
        let j = 0;
        for (let i = 1; i < n; i += 1) {
            let bit = n >> 1;
            while ((j & bit) !== 0) {
                j ^= bit;
                bit >>= 1;
            }
            j ^= bit;
            if (i < j) {
                [re[i], re[j]] = [re[j], re[i]];
                [im[i], im[j]] = [im[j], im[i]];
            }
        }
        for (let len = 2; len <= n; len <<= 1) {
            const halfLen = len >> 1;
            const angle = (-2 * Math.PI) / len;
            const wRe = Math.cos(angle);
            const wIm = Math.sin(angle);
            for (let i = 0; i < n; i += len) {
                let curRe = 1;
                let curIm = 0;
                for (let k = 0; k < halfLen; k += 1) {
                    const idx = i + k + halfLen;
                    const tRe = curRe * re[idx] - curIm * im[idx];
                    const tIm = curRe * im[idx] + curIm * re[idx];
                    re[idx] = re[i + k] - tRe;
                    im[idx] = im[i + k] - tIm;
                    re[i + k] += tRe;
                    im[i + k] += tIm;
                    const newRe = curRe * wRe - curIm * wIm;
                    curIm = curRe * wIm + curIm * wRe;
                    curRe = newRe;
                }
            }
        }
    }
}
exports.FFT = FFT;
//# sourceMappingURL=fft.js.map