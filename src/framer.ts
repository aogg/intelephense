/**
 * stdio Framer：Content-Length 帧解析/序列化。
 * - 字节级缓冲按 Content-Length 严格切帧（分包/粘包安全）；
 * - 头部容忍大小写与多余字段；无 Content-Length 的坏帧丢弃头部继续；
 * - JSON 解析失败的帧静默跳过（不中断管道）。
 */

export type JsonRpcMessage = Record<string, unknown>;

export class Framer {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly onMessage: (msg: JsonRpcMessage) => void) {}

  push(chunk: Buffer): void {
    if (this.buffer.length === 0) this.buffer = chunk;
    else this.buffer = Buffer.concat([this.buffer, chunk]);

    for (;;) {
      const sep = this.buffer.indexOf('\r\n\r\n');
      if (sep < 0) break;
      const header = this.buffer.slice(0, sep).toString('ascii');
      const m = /Content-Length:\s*(\d+)/i.exec(header);
      if (!m) {
        // 坏头：丢掉这段头部，避免死循环
        this.buffer = this.buffer.slice(sep + 4);
        continue;
      }
      const bodyLength = parseInt(m[1], 10);
      const total = sep + 4 + bodyLength;
      if (this.buffer.length < total) break; // 半包，等下一个 chunk
      const body = this.buffer.slice(sep + 4, total).toString('utf8');
      this.buffer = this.buffer.slice(total);
      try {
        this.onMessage(JSON.parse(body) as JsonRpcMessage);
      } catch {
        // 非法 JSON：跳过该帧
      }
    }
  }

  static encode(msg: JsonRpcMessage): Buffer {
    const body = Buffer.from(JSON.stringify(msg), 'utf8');
    return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body]);
  }
}
