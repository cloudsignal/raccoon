// Minimal local types for @cloudsignal/mqtt-client. The published package
// declares `"types": "dist/index.d.ts"` in its exports map, but the file
// isn't shipped — so TypeScript resolution fails without this shim.
// Drop this file once upstream ships its .d.ts (tracked separately).
declare module '@cloudsignal/mqtt-client' {
  export interface CloudSignalClientInstance {
    connectWithToken(opts: {
      host: string;
      organizationId: string;
      externalToken: string;
      willTopic?: string;
      willMessage?: string;
      willQos?: 0 | 1 | 2;
      willRetain?: boolean;
    }): Promise<void>;
    subscribe(topic: string, qos?: 0 | 1 | 2): Promise<unknown>;
    unsubscribe(topic: string): Promise<unknown>;
    transmit(topic: string, message: string, options?: { qos?: 0 | 1 | 2; retain?: boolean }): void;
    destroy(): void;
    onMessage(handler: (topic: string, message: string) => void): void;
    onConnectionStatusChange: ((connected: boolean) => void) | null;
    onAuthError: ((err: Error) => void) | null;
  }

  export const CloudSignalClient: new (opts: Record<string, unknown>) => CloudSignalClientInstance;
  const _default: typeof CloudSignalClient;
  export default _default;
}
