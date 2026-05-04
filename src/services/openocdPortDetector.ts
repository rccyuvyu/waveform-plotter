import net from 'net';

const MIN_PORT = 1;
const MAX_PORT = 65535;

export class OpenOcdPortDetector {
  constructor(private readonly host = '127.0.0.1') {}

  async findTelnetPort(
    preferredPort: number,
    hintPorts: number[] = [],
    maxRounds = 4
  ): Promise<number | undefined> {
    const candidates = this.buildCandidates(preferredPort, hintPorts);
    for (let round = 0; round < maxRounds; round += 1) {
      for (const port of candidates) {
        const ok = await this.isOpenOcdTelnetPort(port);
        if (ok) {
          return port;
        }
      }
      if (round < maxRounds - 1) {
        await this.sleep(250);
      }
    }
    return undefined;
  }

  private buildCandidates(preferredPort: number, hints: number[]): number[] {
    const unique = new Set<number>();
    const push = (p: number): void => {
      if (Number.isInteger(p) && p >= MIN_PORT && p <= MAX_PORT) {
        unique.add(p);
      }
    };

    const addAround = (center: number, delta: number): void => {
      for (let d = -delta; d <= delta; d += 1) {
        push(center + d);
      }
    };

    push(preferredPort);
    push(4444);

    for (const h of hints) {
      push(h);
    }

    addAround(preferredPort, 5);
    addAround(4444, 40);
    for (const h of hints) {
      addAround(h, 3);
    }

    return [...unique];
  }

  private async isOpenOcdTelnetPort(port: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const socket = net.createConnection({ host: this.host, port });
      let settled = false;
      let buffer = '';
      let connected = false;

      const done = (ok: boolean): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        try {
          socket.end();
          socket.destroy();
        } catch {
          // ignore
        }
        resolve(ok);
      };

      const timer = setTimeout(() => {
        done(this.looksLikeOpenOcd(buffer));
      }, 1200);

      socket.setEncoding('utf8');
      socket.setNoDelay(true);

      socket.on('connect', () => {
        connected = true;
      });

      socket.on('data', (chunk: string) => {
        buffer += chunk;
        if (this.looksLikeOpenOcd(buffer)) {
          done(true);
        }
      });

      socket.on('error', () => done(false));
      socket.on('close', () => done(connected && this.looksLikeOpenOcd(buffer)));
    });
  }

  private looksLikeOpenOcd(text: string): boolean {
    const lower = text.toLowerCase();
    const hasPrompt = /(^|\r|\n)>\s*$/.test(text);
    return (
      lower.includes('open on-chip debugger') ||
      lower.includes('openocd') ||
      lower.includes('telnet_port') ||
      lower.includes('telnet port') ||
      hasPrompt
    );
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }
}
