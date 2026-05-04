import net from 'net';
import { DataBuffer } from '../core/dataBuffer';
import { TelnetClient } from './telnetClient';
import { SampleRateMeter } from './sampleRateMeter';

export class RttService {
  readonly isRunning = { value: false };
  sampleCount = 0;
  lastError: string | undefined;
  lastFoundRegion: [string, string] | undefined;
  private readonly sampleRateMeter = new SampleRateMeter();

  private socket: net.Socket | undefined;
  private readerBuffer = '';
  private channelNames: string[] = [];
  private lastCallbackNs = 0n;

  constructor(private readonly dataBuffer: DataBuffer, private readonly onData: () => void) {}

  private readonly defaultRamRegions: Array<[string, string]> = [
    ['0x20000000', '0x10000'],
    ['0x24000000', '0x18000'],
    ['0x20010000', '0x10000'],
    ['0x30000000', '0x10000']
  ];

  async initOpenOcdRtt(
    telnetPort: number,
    rttPort: number,
    ramStart: string,
    ramSize: string
  ): Promise<boolean> {
    const client = new TelnetClient();
    try {
      await client.connect('127.0.0.1', telnetPort);
      await client.sendBatch(['rtt stop'], 500);

      const regions = this.buildRegionCandidates(ramStart, ramSize);
      let found = false;
      for (const [start, size] of regions) {
        await client.sendBatch([`rtt setup ${start} ${size} "SEGGER RTT"`], 500);
        const [startResp] = await client.sendBatch(['rtt start'], 900);
        if (/not found|error/i.test(startResp)) {
          await client.sendBatch(['rtt stop'], 300);
          continue;
        }

        const [channelsResp] = await client.sendBatch(['rtt channels'], 700);
        if (/up=0/i.test(channelsResp)) {
          await client.sendBatch(['rtt stop'], 300);
          await sleep(250);
          await client.sendBatch(['rtt start'], 900);
          const [retryResp] = await client.sendBatch(['rtt channels'], 700);
          if (/up=0/i.test(retryResp)) {
            await client.sendBatch(['rtt stop'], 300);
            continue;
          }
        }

        found = true;
        this.lastFoundRegion = [start, size];
        break;
      }

      if (!found) {
        this.lastError = 'RTT control block not found in candidate RAM regions';
        return false;
      }

      await client.sendBatch([`rtt server start ${rttPort} 0`], 600);
      await client.sendBatch(['rtt polling_interval 1'], 300);
      this.lastError = undefined;
      return true;
    } catch (err) {
      this.lastError = `RTT init failed: ${toErrMsg(err)}`;
      return false;
    } finally {
      await client.close();
    }
  }

  async stopOpenOcdRtt(telnetPort: number): Promise<void> {
    const client = new TelnetClient();
    try {
      await client.connect('127.0.0.1', telnetPort);
      await client.sendBatch(['rtt stop'], 300);
    } catch {
      // ignore
    } finally {
      await client.close();
    }
  }

  async startRtt(host: string, port: number, channelNames: string[]): Promise<void> {
    if (this.isRunning.value) {
      return;
    }

    this.channelNames = [...channelNames];
    this.sampleCount = 0;
    this.lastError = undefined;
    this.readerBuffer = '';
    this.lastCallbackNs = 0n;
    this.sampleRateMeter.reset();

    try {
      const socket = net.createConnection({ host, port });
      this.socket = socket;
      socket.setEncoding('utf8');
      socket.setNoDelay(true);
      socket.setTimeout(2000);
      socket.on('timeout', () => {
        // expected for low traffic
      });

      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('error', (err) => reject(err));
      });

      this.isRunning.value = true;

      socket.on('data', (chunk) => {
        this.readerBuffer += chunk.toString();
        this.consumeLines();
      });
      socket.on('error', (err) => {
        if (this.isRunning.value) {
          this.lastError = `RTT read error: ${err.message}`;
        }
      });
      socket.on('close', () => {
        this.isRunning.value = false;
      });
    } catch (err) {
      this.lastError = `RTT connect failed: ${toErrMsg(err)}`;
      this.isRunning.value = false;
      this.socket?.destroy();
      this.socket = undefined;
    }
  }

  async stopRtt(): Promise<void> {
    this.isRunning.value = false;
    this.sampleRateMeter.reset();
    const s = this.socket;
    this.socket = undefined;
    this.readerBuffer = '';
    if (!s) {
      return;
    }
    await new Promise<void>((resolve) => {
      s.once('close', () => resolve());
      s.end();
      setTimeout(() => {
        s.destroy();
        resolve();
      }, 250);
    });
  }

  private buildRegionCandidates(ramStart: string, ramSize: string): Array<[string, string]> {
    if (ramStart.trim() && ramSize.trim()) {
      return [[ramStart.trim(), ramSize.trim()]];
    }
    const out: Array<[string, string]> = [];
    if (this.lastFoundRegion) {
      out.push(this.lastFoundRegion);
    }
    for (const r of this.defaultRamRegions) {
      if (!this.lastFoundRegion || r[0] !== this.lastFoundRegion[0] || r[1] !== this.lastFoundRegion[1]) {
        out.push(r);
      }
    }
    return out;
  }

  private consumeLines(): void {
    while (true) {
      const idx = this.readerBuffer.indexOf('\n');
      if (idx < 0) {
        return;
      }
      const line = this.readerBuffer.slice(0, idx);
      this.readerBuffer = this.readerBuffer.slice(idx + 1);
      this.parseLine(line.trim());
    }
  }

  private parseLine(line: string): void {
    if (!line) {
      return;
    }

    const parts = line.split(',');
    const values = new Map<string, number>();
    for (let i = 0; i < parts.length && i < this.channelNames.length; i += 1) {
      const n = Number(parts[i].trim());
      if (Number.isFinite(n)) {
        values.set(this.channelNames[i], n);
      }
    }

    if (values.size === 0) {
      return;
    }

    for (const name of values.keys()) {
      if (!this.dataBuffer.getChannels().some((c) => c.name === name)) {
        this.dataBuffer.addChannel(name);
      }
    }

    const now = process.hrtime.bigint();
    this.dataBuffer.pushAll(values, now);
    this.sampleCount += 1;
    this.sampleRateMeter.mark(now);

    if (now - this.lastCallbackNs >= 16_000_000n) {
      this.lastCallbackNs = now;
      this.onData();
    }
  }

  getActualFrequencyHz(): number {
    return this.sampleRateMeter.getHz();
  }
}

function toErrMsg(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  return String(err);
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
