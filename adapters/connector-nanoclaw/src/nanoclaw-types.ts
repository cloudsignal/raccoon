// Vendored STRUCTURAL types for NanoClaw's channel-adapter surface,
// transcribed 2026-08-02 from github.com/nanocoai/nanoclaw main:
//   src/channels/adapter.ts        (ChannelAdapter, ChannelSetup, messages, defaults)
//   src/channels/ask-question.ts   (AskQuestionContent, NormalizedOption)
//   src/channels/channel-registry.ts (ChannelRegistration)
// NanoClaw is not on npm; the real interface binds structurally when the
// wrapper file compiles inside the user's NanoClaw checkout. Their trunk
// moves fast — on install, the add-raccoon skill re-verifies the wrapper
// against the current source.

/** One attachment as NanoClaw's chat content carries it. */
export interface NanoClawAttachment {
  type: string; // 'image' | 'video' | 'audio' | 'file' — free-form on their side
  url: string;
}

/** The `content` object for kind 'chat' inbound messages. The HOST
 *  JSON.stringifys this before writing to the session DB — the adapter
 *  passes a plain object. */
export interface InboundChatContent {
  sender: string;
  senderId: string;
  text: string;
  attachments?: NanoClawAttachment[];
  isFromMe?: boolean;
}

/** Inbound message from adapter to host (their InboundMessage, verbatim
 *  shape). id and timestamp are REQUIRED. isMention === true is what makes
 *  the router run its auto-create/registration flow for a conversation with
 *  no wired agent — undefined means "not a mention" and the message is
 *  dropped for unwired conversations. Raccoon chats are DMs: always set
 *  isMention: true, isGroup: false (mirrors their 'dm-only' mention mode). */
export interface InboundMessage {
  id: string;
  kind: 'chat' | 'chat-sdk';
  content: unknown;
  timestamp: string;
  isMention?: boolean;
  isGroup?: boolean;
}

/** A file attachment the host hands the adapter (read from the session outbox). */
export interface OutboundFile {
  filename: string;
  data: Buffer;
}

/** What deliver() receives: content is ALREADY-PARSED JSON (the delivery
 *  bridge does JSON.parse before dispatch). For agent chat replies content
 *  is { text: string, ... }; for cards content is AskQuestionContent. */
export interface OutboundMessage {
  kind: string;
  content: unknown;
  files?: OutboundFile[];
}

/** Normalized card option (their ask-question.ts). onAction must be called
 *  with the option's VALUE (the host forwards selectedOption verbatim as the
 *  response value), while raccoon approval.request shows the LABEL. */
export interface NormalizedOption {
  label: string;
  selectedLabel: string;
  value: string;
  style?: 'primary' | 'danger' | 'default';
}

/** deliver() content for ask_user_question cards. */
export interface AskQuestionContent {
  type: 'ask_question';
  questionId: string;
  title: string;
  question: string;
  options: NormalizedOption[];
}

/** Callbacks the NanoClaw host hands the adapter in setup(). The host
 *  provides all four; this connector consumes onInbound and onAction. */
export interface ChannelSetup {
  onInbound(platformId: string, threadId: string | null, message: InboundMessage): void | Promise<void>;
  onInboundEvent(event: unknown): void | Promise<void>;
  onMetadata(platformId: string, name?: string, isGroup?: boolean): void;
  onAction(questionId: string, selectedOption: string, userId: string): void;
}

export interface ConversationInfo {
  platformId: string;
  name: string;
  isGroup: boolean;
}

/** Wiring-time defaults for one conversation context (their shape, verbatim). */
export interface ChannelContextDefaults {
  engageMode: 'pattern' | 'mention' | 'mention-sticky';
  engagePattern?: string; // required iff engageMode === 'pattern'
  threads: boolean;       // MUST be false when supportsThreads is false
  unknownSenderPolicy: 'strict' | 'request_approval' | 'public';
}

export interface ChannelDefaults {
  dm: ChannelContextDefaults;
  group: ChannelContextDefaults;
  mentions: 'platform' | 'dm-only' | 'never';
}

/** The v2 channel adapter contract (their src/channels/adapter.ts). */
export interface ChannelAdapter {
  name: string;
  channelType: string;
  instance?: string;
  supportsThreads: boolean;
  setup(config: ChannelSetup): Promise<void>;
  teardown(): Promise<void>;
  isConnected(): boolean;
  deliver(platformId: string, threadId: string | null, message: OutboundMessage): Promise<string | undefined>;
  setTyping?(platformId: string, threadId: string | null): Promise<void>;
  syncConversations?(): Promise<ConversationInfo[]>;
  resolveChannelName?(platformId: string): Promise<string | null>;
  subscribe?(platformId: string, threadId: string): Promise<void>;
  openDM?(userHandle: string): Promise<string>;
  /** Declared wiring-time defaults for this channel (their adapter.ts).
   *  Optional for backward compatibility with stale adapter copies; absent
   *  means the core falls back to fallbackChannelDefaults(supportsThreads). */
  defaults?: ChannelDefaults;
}

/** Factory function that creates a channel adapter (returns null if
 *  credentials missing). Their trunk allows async factories; this
 *  connector's factory stays sync, which remains assignable. */
export type ChannelAdapterFactory = () => ChannelAdapter | Promise<ChannelAdapter> | null;

/** registerChannelAdapter's second argument (their channel-registry.ts).
 *  Note: defaults are ALSO declared on the registration — resolvable without
 *  instantiating the adapter (offline creation paths read them from the
 *  registry); channel modules pass the same const in both places. */
export interface ChannelRegistration {
  factory: ChannelAdapterFactory;
  defaults?: ChannelDefaults;
  containerConfig?: {
    mounts?: Array<{ hostPath: string; containerPath: string; readonly: boolean }>;
    env?: Record<string, string>;
  };
}
