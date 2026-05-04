export class SampleRateMeter {
  private readonly recentNs: bigint[] = [];

  reset(): void {
    this.recentNs.length = 0;
  }

  mark(nowNs: bigint): void {
    this.recentNs.push(nowNs);
    if (this.recentNs.length > 32) {
      this.recentNs.shift();
    }
  }

  getHz(): number {
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
