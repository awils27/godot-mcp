import net, { type AddressInfo, type Socket } from 'net';
import { randomUUID } from 'crypto';

interface PendingRequest {
  reject: (error: Error) => void;
  resolve: (value: any) => void;
  timeout: NodeJS.Timeout;
}

interface LiveBridgeMessage {
  command?: string;
  error?: string;
  payload?: unknown;
  request_id?: string;
  success?: boolean;
  token?: string;
  type?: string;
}

export interface LiveBridgeRuntimeInfo {
  currentScenePath?: string | null;
  currentSceneName?: string | null;
}

export class LiveBridgeHost {
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly server = net.createServer((socket) => this.handleConnection(socket));
  private connectedSocket: Socket | null = null;
  private readBuffer = '';
  private runtimeInfo: LiveBridgeRuntimeInfo | null = null;
  readonly host = '127.0.0.1';
  readonly token = randomUUID();
  private listeningPort: number | null = null;

  async start(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        this.server.off('listening', onListening);
        reject(error);
      };
      const onListening = () => {
        this.server.off('error', onError);
        const address = this.server.address() as AddressInfo | null;
        this.listeningPort = address?.port ?? null;
        resolve();
      };

      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(0, this.host);
    });
  }

  get connected(): boolean {
    return this.connectedSocket !== null && !this.connectedSocket.destroyed;
  }

  get port(): number {
    if (this.listeningPort === null) {
      throw new Error('Live bridge host is not listening.');
    }
    return this.listeningPort;
  }

  get status(): { connected: boolean; listening: boolean; runtimeInfo: LiveBridgeRuntimeInfo | null } {
    return {
      connected: this.connected,
      listening: this.listeningPort !== null,
      runtimeInfo: this.runtimeInfo,
    };
  }

  async request<T>(command: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<T> {
    if (!this.connectedSocket || this.connectedSocket.destroyed) {
      throw new Error('Live bridge runtime is not connected.');
    }

    const requestId = randomUUID();
    const message = JSON.stringify({
      request_id: requestId,
      command,
      token: this.token,
      params,
    }) + '\n';

    return await new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Live bridge request timed out for command "${command}".`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timeout });
      this.connectedSocket!.write(message, (error) => {
        if (!error) {
          return;
        }

        const pending = this.pendingRequests.get(requestId);
        if (!pending) {
          return;
        }
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(requestId);
        reject(error);
      });
    });
  }

  async close(): Promise<void> {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error('Live bridge host closed before the request completed.'));
      this.pendingRequests.delete(requestId);
    }

    if (this.connectedSocket && !this.connectedSocket.destroyed) {
      this.connectedSocket.destroy();
    }

    await new Promise<void>((resolve) => {
      if (!this.server.listening) {
        resolve();
        return;
      }
      this.server.close(() => resolve());
    });
  }

  private handleConnection(socket: Socket): void {
    if (this.connectedSocket && !this.connectedSocket.destroyed) {
      this.connectedSocket.destroy();
    }

    this.connectedSocket = socket;
    this.readBuffer = '';

    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => this.processChunk(chunk));
    socket.on('close', () => {
      if (this.connectedSocket === socket) {
        this.connectedSocket = null;
        this.runtimeInfo = null;
      }
      this.rejectAllPending(new Error('Live bridge runtime disconnected.'));
    });
    socket.on('error', (error) => {
      this.rejectAllPending(error);
    });
  }

  private processChunk(chunk: string): void {
    this.readBuffer += chunk;
    while (true) {
      const newlineIndex = this.readBuffer.indexOf('\n');
      if (newlineIndex === -1) {
        break;
      }

      const line = this.readBuffer.slice(0, newlineIndex).trim();
      this.readBuffer = this.readBuffer.slice(newlineIndex + 1);
      if (!line) {
        continue;
      }

      let message: LiveBridgeMessage;
      try {
        message = JSON.parse(line) as LiveBridgeMessage;
      } catch {
        continue;
      }

      this.handleMessage(message);
    }
  }

  private handleMessage(message: LiveBridgeMessage): void {
    if (message.token && message.token !== this.token) {
      return;
    }

    if (message.type === 'hello') {
      this.runtimeInfo = (message.payload as LiveBridgeRuntimeInfo | undefined) ?? null;
      return;
    }

    if (!message.request_id) {
      return;
    }

    const pending = this.pendingRequests.get(message.request_id);
    if (!pending) {
      return;
    }

    clearTimeout(pending.timeout);
    this.pendingRequests.delete(message.request_id);

    if (message.success === false) {
      pending.reject(new Error(message.error ?? 'Unknown live bridge error.'));
      return;
    }

    pending.resolve(message.payload);
  }

  private rejectAllPending(error: Error): void {
    for (const [requestId, pending] of this.pendingRequests.entries()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
      this.pendingRequests.delete(requestId);
    }
  }
}
