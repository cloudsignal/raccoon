// Type declaration for raccoon.bundle.mjs (self-contained; ships beside it).
// These shapes transcribe the vendored NanoClaw contract the bundle was built
// against. The wrapper (raccoon.ts) assigns them to the fork's own
// ChannelRegistration — if the fork's adapter interface has drifted, that
// assignment fails to compile, which is the drift signal.
export interface RaccoonBundleAdapter {
  name: string;
  channelType: string;
  instance?: string;
  supportsThreads: boolean;
  setup(config: {
    onInbound(platformId: string, threadId: string | null, message: unknown): void | Promise<void>;
    onInboundEvent(event: unknown): void | Promise<void>;
    onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
    onAction(questionId: string, selectedOption: string, userId: string): void;
  }): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;
  deliver(
    platformId: string,
    threadId: string | null,
    message: { kind: string; content: unknown; files?: Array<{ filename: string; data: Buffer }> },
  ): Promise<string | undefined>;
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
}

export interface RaccoonBundleDefaults {
  dm: { engageMode: 'pattern'; engagePattern: string; threads: false; unknownSenderPolicy: 'request_approval' };
  group: { engageMode: 'mention'; threads: false; unknownSenderPolicy: 'request_approval' };
  mentions: 'dm-only';
}

export declare function createRaccoonChannelAdapter(deps?: {
  env?: Record<string, string | undefined>;
  staticDir?: string;
}): RaccoonBundleAdapter | null;

export declare const RACCOON_CHANNEL_DEFAULTS: RaccoonBundleDefaults;
