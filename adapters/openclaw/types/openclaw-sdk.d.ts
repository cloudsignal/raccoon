// Local shim of the OpenClaw plugin SDK surface this adapter uses.
// RECONCILED 2026-07-05 against the real openclaw@2026.6.11 type
// declarations (dist/plugin-sdk/plugin-entry.d.ts + types chunk) extracted
// from the npm tarball. Kept as an ambient shim so the workspace typechecks
// without installing the 86 MB package; the shapes below mirror the real
// ones 1:1 for the subset we call. Verified additionally by a scratch
// typecheck against the real .d.ts files (see docs/ smoke-test notes).
//
// channel-inbound shim: RECONCILED 2026-07-07 against the real
// openclaw@2026.6.11 type declarations. Sources verified:
//   - hook-types-YIiTro9N.d.ts — ReplyDispatchKind, ReplyDispatchRuntimeInfo,
//     ReplyDispatchBeforeDeliver, ReplyDispatcher, ReplyFollowupAdmissionBarrierTimeoutPolicy
//   - types-CR1WAXpo.d.ts — DispatchFromConfigResult
//   - templating-BLMMEF1D.d.ts — FinalizedMsgContext (Omit<MsgContext,"CommandAuthorized"> + CommandAuthorized: boolean)
//   - inbound-reply-dispatch-B7tGveLY.d.ts — dispatchReplyFromConfigWithSettledDispatcher signature
//   - channel-inbound.d.ts — confirmed export list includes all names below

declare module 'openclaw/plugin-sdk/channel-inbound' {
  // --- ReplyDispatchKind (from hook-types-YIiTro9N.d.ts, line 11) ---
  export type ReplyDispatchKind = 'tool' | 'block' | 'final';

  // --- ReplyFollowupAdmissionBarrierTimeoutPolicy (from hook-types-YIiTro9N.d.ts, lines 12-15) ---
  export interface ReplyFollowupAdmissionBarrierTimeoutPolicy {
    maxTimeoutMs: number;
    shouldExtend: () => boolean;
  }

  // --- ReplyDispatchRuntimeInfo (from hook-types-YIiTro9N.d.ts, lines 16-19) ---
  export interface ReplyDispatchRuntimeInfo {
    kind: ReplyDispatchKind;
    assistantMessageIndex?: number;
  }

  // --- ReplyDispatchBeforeDeliver (from hook-types-YIiTro9N.d.ts, line 20) ---
  export type ReplyDispatchBeforeDeliver = (
    payload: ReplyPayload,
    info: ReplyDispatchRuntimeInfo,
  ) => Promise<ReplyPayload | null> | ReplyPayload | null;

  // --- ReplyPayload (from types-DNy-f8Hr.d.ts, minimal subset used by Raccoon) ---
  // Full shape has presentation, interactive, isReasoning, etc.; we only
  // need the fields we actually read or pass through.
  export interface ReplyPayload {
    text?: string;
    mediaUrl?: string;
    mediaUrls?: string[];
    channelData?: Record<string, unknown>;
    isError?: boolean;
    isReasoning?: boolean;
  }

  // --- ReplyDispatcher (from hook-types-YIiTro9N.d.ts, lines 21-32) ---
  export interface ReplyDispatcher {
    sendToolResult(payload: ReplyPayload): boolean;
    sendBlockReply(payload: ReplyPayload): boolean;
    sendFinalReply(payload: ReplyPayload): boolean;
    appendBeforeDeliver?: (hook: ReplyDispatchBeforeDeliver) => void;
    waitForIdle(): Promise<void>;
    getQueuedCounts(): Record<ReplyDispatchKind, number>;
    getCancelledCounts?: () => Record<ReplyDispatchKind, number>;
    getFailedCounts(): Record<ReplyDispatchKind, number>;
    markComplete(): void;
    resolveFollowupAdmissionBarrierTimeoutPolicy?: () => ReplyFollowupAdmissionBarrierTimeoutPolicy | undefined;
  }

  // --- DispatchFromConfigResult (from types-CR1WAXpo.d.ts, lines 6309-6319) ---
  // Subset — only the fields Raccoon reads.
  export interface DispatchFromConfigResult {
    queuedFinal: boolean;
    counts: Record<ReplyDispatchKind, number>;
    failedCounts?: Partial<Record<ReplyDispatchKind, number>>;
  }

  // --- FinalizedMsgContext (from templating-BLMMEF1D.d.ts, lines 354-365) ---
  // Full MsgContext has 100+ optional string fields. We declare only the subset
  // we populate; the index signature covers any additional pass-through fields.
  export interface FinalizedMsgContext {
    /** Always set; default-deny: missing/undefined becomes false. */
    CommandAuthorized: boolean;
    /** Populated by finalizeInboundContext(); optional for SDK compat. */
    CommandTurn?: unknown;
    Body?: string;
    BodyForAgent?: string;
    CommandBody?: string;
    BodyForCommands?: string;
    From?: string;
    SessionKey?: string;
    AgentId?: string;
    MessageSid?: string;
    /** The provider/channel id (e.g. 'raccoon'). Used to resolve
     *  commands.allowFrom.<provider> — without it OpenClaw cannot correctly
     *  scope per-provider command authorization to this channel. */
    Provider?: string;
    /** Channel-native sender identity (the Raccoon userId). Paired with
     *  Provider to resolve commands.allowFrom.<provider> membership. */
    SenderId?: string;
    /** 'direct' | 'group' — Raccoon is DM-only (capabilities.chatTypes). */
    ChatType?: string;
    /** The resolved account id (gateway accountId; 'default' for the single
     *  Raccoon account model). */
    AccountId?: string;
    [key: string]: unknown;
  }

  // --- OpenClawConfig (from types.openclaw-DEkRlTdX.d.ts) ---
  // Opaque; Raccoon only passes it through, never constructs it.
  export interface OpenClawConfig {
    readonly __brand: 'OpenClawConfig';
  }

  // --- dispatchReplyFromConfigWithSettledDispatcher ---
  // (from inbound-reply-dispatch-B7tGveLY.d.ts, lines 53-60)
  // Confirmed in channel-inbound.d.ts export list as `dispatchReplyFromConfigWithSettledDispatcher`.
  export function dispatchReplyFromConfigWithSettledDispatcher(params: {
    cfg: OpenClawConfig;
    ctxPayload: FinalizedMsgContext;
    dispatcher: ReplyDispatcher;
    onSettled: () => void | Promise<void>;
    // Deliberate widening: the real type is ReplyDispatchFromConfigOptions
    // (Omit<GetReplyOptions,"onBlockReply">), but Raccoon never passes
    // replyOptions so the widened shape is safe here and avoids pulling in
    // GetReplyOptions and its large transitive dependency tree.
    replyOptions?: Record<string, unknown>;
    configOverride?: OpenClawConfig;
  }): Promise<DispatchFromConfigResult>;
}

// reply-chunking shim: RECONCILED 2026-07-07 against the real
// openclaw@2026.6.11 type declarations. Sources verified:
//   - outbound.types-CHpw9VBQ.d.ts — ChunkMode ("length" | "newline"),
//     chunkMarkdownTextWithMode(text, limit, mode) signature.
//   - reply-chunking.d.ts — confirmed export list includes ChunkMode and
//     chunkMarkdownTextWithMode (re-exported from outbound.types-CHpw9VBQ.js).
//
// IMPORTANT: the real ChunkMode is "length" | "newline". The brief referenced
// 'paragraph' as a conceptual description of behaviour; the valid SDK string
// that produces paragraph-boundary splitting is 'newline' (its JSDoc says
// "now it only breaks on paragraph boundaries (blank lines) unless the text
// exceeds the length limit"). There is no 'paragraph' literal in the SDK type.
declare module 'openclaw/plugin-sdk/reply-chunking' {
  /**
   * Chunking mode for outbound messages:
   * - "length": Split only when exceeding textChunkLimit (default).
   * - "newline": Prefer breaking on paragraph boundaries (blank lines) unless
   *   the text exceeds the length limit.
   *
   * Real SDK definition (outbound.types-CHpw9VBQ.d.ts):
   *   type ChunkMode = "length" | "newline";
   */
  export type ChunkMode = 'length' | 'newline';

  /**
   * Split markdown text into chunks using the given mode and byte limit.
   * Returns an ordered string[] — each element becomes one OAM msg envelope.
   *
   * Real SDK signature (outbound.types-CHpw9VBQ.d.ts line 79):
   *   declare function chunkMarkdownTextWithMode(
   *     text: string, limit: number, mode: ChunkMode
   *   ): string[];
   */
  export function chunkMarkdownTextWithMode(
    text: string,
    limit: number,
    mode: ChunkMode,
  ): string[];
}

// channel-core shim: RECONCILED 2026-07-07 against the real
// openclaw@2026.6.11 type declarations. Sources verified:
//   - types.plugin-ByOu7kLN.d.ts     — ChannelPlugin (required members only)
//   - types.core-BnNQH4rw.d.ts       — ChannelMeta, ChannelCapabilities, ChatType
//   - types.adapters-DUxexnLv.d.ts   — ChannelConfigAdapter (listAccountIds + resolveAccount)
//   - types.config-D1pSqbn8.d.ts     — ChannelConfigSchema, ChannelConfigUiHint,
//                                       ChannelConfigRuntimeSchema, ChannelConfigRuntimeParseResult
//   - channel-core.d.ts              — exports ChannelPlugin, OpenClawConfig (re-export)
// ChannelPlugin.id is typed as ChannelId = ChatChannelId | (string & {});
// for external plugins string & {} is the correct widened form.
// The real JsonSchemaObject = TSchema & Record<string,unknown>; we widen to
// Record<string,unknown> since the typecheck excludes typebox TSchema pull-in.
declare module 'openclaw/plugin-sdk/channel-core' {
  // OpenClawConfig: opaque pass-through (same brand as in channel-inbound shim).
  export interface OpenClawConfig {
    readonly __brand: 'OpenClawConfig';
    // channels is open-world; raccoon section is Record<string,unknown>.
    channels?: Record<string, unknown>;
  }

  // ---------------------------------------------------------------------------
  // Interactive payload types (from payload-BHJeg3MX.d.ts)
  // Mirrored 1:1 for the subset Raccoon needs to read in the outbound adapter.
  // ---------------------------------------------------------------------------

  // MessagePresentationAction (message-presentation docs, confirmed 2026-07-10
  // via docs.openclaw.ai/plugins/message-presentation). 'command' executes a
  // native slash command; 'callback' carries opaque plugin data. Per the spec:
  // "Channel plugins must not reinterpret callback data as slash commands."
  export type MessagePresentationAction =
    | { type: 'command'; command: string }
    | { type: 'callback'; value: string };

  // InteractiveReplyButton (payload-BHJeg3MX.d.ts, line 53 — alias for MessagePresentationButton)
  // We declare the minimal subset we read: label (required), value (optional).
  export interface InteractiveReplyButton {
    label: string;
    action?: MessagePresentationAction;
    /** Legacy callback value. Prefer action for new controls. */
    value?: string;
    style?: string;
    disabled?: boolean;
    priority?: number;
    reusable?: boolean;
    url?: string;
    webApp?: { url: string };
  }
  // The real SDK aliases these 1:1 (see comment above each) — reuse the same
  // declarations under their modern names for the renderPresentation surface.
  export type MessagePresentationButton = InteractiveReplyButton;

  // InteractiveReplyOption (payload-BHJeg3MX.d.ts, line 57 — alias for MessagePresentationOption)
  export interface InteractiveReplyOption {
    label: string;
    value?: string;
  }
  export type MessagePresentationOption = InteractiveReplyOption;

  // MessagePresentationBlock / MessagePresentation (confirmed 2026-07-10 via
  // docs.openclaw.ai/plugins/message-presentation). Chart variants are
  // declared for completeness but Raccoon's presentationCapabilities.charts
  // is false — renderPresentation never needs to render them richly.
  export type MessagePresentationBlock =
    | { type: 'text'; text: string }
    | { type: 'context'; text: string }
    | { type: 'divider' }
    | { type: 'buttons'; buttons: MessagePresentationButton[] }
    | { type: 'select'; placeholder?: string; options: MessagePresentationOption[] }
    | { type: 'chart'; chartType: 'pie'; title: string; segments: Array<{ label: string; value: number }> }
    | {
        type: 'chart'; chartType: 'bar' | 'area' | 'line'; title: string;
        categories: string[]; series: Array<{ name: string; values: number[] }>;
        xLabel?: string; yLabel?: string;
      };

  export interface MessagePresentation {
    title?: string;
    tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
    blocks: MessagePresentationBlock[];
  }

  // PresentationCapabilities (confirmed 2026-07-10 via
  // docs.openclaw.ai/plugins/message-presentation). `limits` is shown in the
  // SDK's own example but not confirmed required, and we have no real numeric
  // constraints to report for Raccoon (protocol.ts's approval.request payload
  // has no length/count caps beyond non-empty strings) — declared optional so
  // omitting it doesn't overclaim precision we can't verify.
  export interface PresentationCapabilities {
    supported: boolean;
    buttons?: boolean;
    selects?: boolean;
    context?: boolean;
    divider?: boolean;
    charts?: boolean;
    limits?: {
      actions?: {
        maxActions?: number;
        maxActionsPerRow?: number;
        maxRows?: number;
        maxLabelLength?: number;
        maxValueBytes?: number;
        supportsStyles?: boolean;
        supportsDisabled?: boolean;
      };
      selects?: { maxOptions?: number; maxLabelLength?: number; maxValueBytes?: number };
      text?: { maxLength?: number; encoding?: string; markdownDialect?: string };
    };
  }

  // InteractiveReplyTextBlock (payload-BHJeg3MX.d.ts, line 62)
  export interface InteractiveReplyTextBlock {
    type: 'text';
    text: string;
  }

  // InteractiveReplyButtonsBlock (payload-BHJeg3MX.d.ts, line 68)
  export interface InteractiveReplyButtonsBlock {
    type: 'buttons';
    buttons: InteractiveReplyButton[];
  }

  // InteractiveReplySelectBlock (payload-BHJeg3MX.d.ts, line 75)
  export interface InteractiveReplySelectBlock {
    type: 'select';
    placeholder?: string;
    options: InteractiveReplyOption[];
  }

  // InteractiveReplyBlock (payload-BHJeg3MX.d.ts, line 83)
  export type InteractiveReplyBlock =
    | InteractiveReplyTextBlock
    | InteractiveReplyButtonsBlock
    | InteractiveReplySelectBlock;

  // InteractiveReply (payload-BHJeg3MX.d.ts, line 87)
  // @deprecated — use MessagePresentation. Still in use by existing producers.
  export interface InteractiveReply {
    blocks: InteractiveReplyBlock[];
  }

  // ---------------------------------------------------------------------------
  // ReplyPayload — plugin-facing subset (reply-payload-CGSW3318.d.ts, lines 34-46)
  // Raccoon only reads the fields it acts on; the rest are open-world unknown.
  // ---------------------------------------------------------------------------
  export interface ReplyPayload {
    text?: string;
    mediaUrls?: string[];
    mediaUrl?: string;
    /** Portable structured presentation (new shape). */
    presentation?: unknown;
    /**
     * @deprecated Use presentation. Runtime support remains for legacy producers.
     * Real type: InteractiveReply. Typed as unknown here so callers must
     * normalise/cast — consistent with how the SDK treats it externally.
     */
    interactive?: unknown;
    channelData?: unknown;
    sensitiveMedia?: boolean;
    replyToId?: string;
  }

  // ---------------------------------------------------------------------------
  // Outbound types (from outbound.types-CHpw9VBQ.d.ts)
  // Mirrored 1:1 for the subset Raccoon's outbound adapter uses.
  // ---------------------------------------------------------------------------

  // OutboundDeliveryResult (outbound.types-CHpw9VBQ.d.ts, lines 13-25)
  // channel: Exclude<ChannelId, "none"> — ChannelId is a large union in the real SDK;
  // we widen to `string & {}` which is the external-plugin-safe form.
  export interface OutboundDeliveryResult {
    channel: string & {};
    messageId: string;
    chatId?: string;
    channelId?: string;
    roomId?: string;
    conversationId?: string;
    timestamp?: number;
    meta?: Record<string, unknown>;
  }

  // OutboundDeliveryFormattingOptions (outbound.types-CHpw9VBQ.d.ts, lines 87-94)
  export interface OutboundDeliveryFormattingOptions {
    textLimit?: number;
    maxLinesPerMessage?: number;
    tableMode?: string;
    chunkMode?: 'length' | 'newline';
    parseMode?: 'HTML';
  }

  // ChannelOutboundContext (outbound.types-CHpw9VBQ.d.ts, lines 105-126)
  // We declare only the subset Raccoon's sendText reads.
  export interface ChannelOutboundContext {
    cfg: OpenClawConfig;
    to: string;
    text: string;
    accountId?: string | null;
    threadId?: string | number | null;
    replyToId?: string | null;
    formatting?: OutboundDeliveryFormattingOptions;
    silent?: boolean;
    [key: string]: unknown;
  }

  // ChannelOutboundPayloadContext (outbound.types-CHpw9VBQ.d.ts, lines 127-129)
  // ChannelOutboundContext & { payload: ReplyPayload }
  export interface ChannelOutboundPayloadContext extends ChannelOutboundContext {
    payload: ReplyPayload;
  }

  // ChannelOutboundChunkContext (outbound.types-CHpw9VBQ.d.ts, lines 196-198)
  export interface ChannelOutboundChunkContext {
    formatting?: OutboundDeliveryFormattingOptions;
  }

  // ChannelOutboundAdapter (outbound.types-CHpw9VBQ.d.ts, lines 203-297)
  // Required: deliveryMode. All other members optional.
  // We declare only the subset Raccoon's outbound adapter exposes.
  export interface ChannelOutboundAdapter {
    /** Required by the real SDK. 'gateway' = OpenClaw routes via the channel gateway. */
    deliveryMode: 'direct' | 'gateway' | 'hybrid';
    sendText?: (ctx: ChannelOutboundContext) => Promise<OutboundDeliveryResult>;
    sendPayload?: (ctx: ChannelOutboundPayloadContext) => Promise<OutboundDeliveryResult>;
    /**
     * Optional chunker exposed by the adapter. Mirrors real SDK field 1:1
     * (outbound.types-CHpw9VBQ.d.ts line 205):
     *   chunker?: ((text: string, limit: number, ctx?: ChannelOutboundChunkContext) => string[]) | null
     */
    chunker?: ((text: string, limit: number, ctx?: ChannelOutboundChunkContext) => string[]) | null;
    /**
     * Declares which MessagePresentation block types this adapter can render
     * natively. Confirmed 2026-07-10 via docs.openclaw.ai/plugins/message-presentation:
     * "Core owns fallback behavior so producers can stay channel-agnostic" —
     * i.e. core falls back to conservative text itself when this is absent or
     * a block type isn't declared; adapters do not implement that fallback.
     */
    presentationCapabilities?: PresentationCapabilities;
    /**
     * Renders a structured MessagePresentation payload natively. Core calls
     * this "when the adapter can render the payload" (per presentationCapabilities)
     * and falls back to text itself otherwise — see presentationCapabilities above.
     * Return type mirrors sendPayload's: both are alternate outbound-delivery
     * paths reporting the same delivery result back to core.
     */
    renderPresentation?: (args: {
      payload: ReplyPayload;
      presentation: MessagePresentation;
      ctx: ChannelOutboundContext;
    }) => Promise<OutboundDeliveryResult>;
    [key: string]: unknown;
  }

  // ChannelMeta (types.core-BnNQH4rw.d.ts, lines 190-212)
  // Required members: id, label, selectionLabel, docsPath, blurb.
  // We only use id, label, selectionLabel, docsPath, blurb — all required.
  export interface ChannelMeta {
    id: string;
    label: string;
    selectionLabel: string;
    docsPath: string;
    blurb: string;
    order?: number;
    aliases?: readonly string[];
    markdownCapable?: boolean;
  }

  // ChatType (chat-type-B6XXSSnm.d.ts)
  export type ChatType = 'direct' | 'group' | 'channel';

  // ChannelCapabilities (types.core-BnNQH4rw.d.ts, lines 319-335)
  // Only chatTypes is required; rest optional.
  export interface ChannelCapabilities {
    chatTypes: Array<ChatType | 'thread'>;
    polls?: boolean;
    reactions?: boolean;
    edit?: boolean;
    unsend?: boolean;
    reply?: boolean;
    effects?: boolean;
    threads?: boolean;
    media?: boolean;
    nativeCommands?: boolean;
    blockStreaming?: boolean;
  }

  // ChannelConfigRuntimeParseResult (types.config-D1pSqbn8.d.ts)
  export type ChannelConfigRuntimeParseResult =
    | { success: true; data: unknown }
    | { success: false; issues: Array<{ path?: Array<string | number>; message?: string; code?: string } & Record<string, unknown>> };

  // ChannelConfigRuntimeSchema (types.config-D1pSqbn8.d.ts)
  export interface ChannelConfigRuntimeSchema {
    safeParse(value: unknown): ChannelConfigRuntimeParseResult;
  }

  // ChannelConfigUiHint (types.config-D1pSqbn8.d.ts)
  export interface ChannelConfigUiHint {
    label?: string;
    help?: string;
    tags?: string[];
    advanced?: boolean;
    sensitive?: boolean;
    placeholder?: string;
  }

  // ChannelConfigSchema (types.config-D1pSqbn8.d.ts)
  // schema: JsonSchemaObject = TSchema & Record<string,unknown>; widened to Record<string,unknown>.
  export interface ChannelConfigSchema {
    schema: Record<string, unknown>;
    uiHints?: Record<string, ChannelConfigUiHint>;
    runtime?: ChannelConfigRuntimeSchema;
  }

  // ChannelConfigAdapter (types.adapters-DUxexnLv.d.ts, lines 127-167)
  // Only the two REQUIRED members; optionals omitted.
  export interface ChannelConfigAdapter<ResolvedAccount> {
    listAccountIds(cfg: OpenClawConfig): string[];
    resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedAccount;
    defaultAccountId?: (cfg: OpenClawConfig) => string;
    isConfigured?: (account: ResolvedAccount, cfg: OpenClawConfig) => boolean | Promise<boolean>;
  }

  // ChannelPlugin (types.plugin-ByOu7kLN.d.ts, lines 19-65)
  // Required members: id, meta, capabilities, config.
  // configSchema optional (but we provide it); all other adapters deliberately absent (T4-T7).
  export interface ChannelPlugin<ResolvedAccount = unknown> {
    id: string;
    meta: ChannelMeta;
    capabilities: ChannelCapabilities;
    config: ChannelConfigAdapter<ResolvedAccount>;
    configSchema?: ChannelConfigSchema;
    // Optional adapter slots — presence advertises capability.
    // Mirrored from types.plugin-ByOu7kLN.d.ts (lines 32-44) for the ones
    // Raccoon supplies (T4-T7).
    outbound?: ChannelOutboundAdapter;
    pairing?: ChannelPairingAdapter;
    security?: ChannelSecurityAdapter<ResolvedAccount>;
    setupWizard?: ChannelPluginSetupWizard;
    gateway?: ChannelGatewayAdapter<ResolvedAccount>;
    // Any other optional adapter fields remain open-world.
    [key: string]: unknown;
  }

  // ---------------------------------------------------------------------------
  // ChannelSecurityContext (types.core-BnNQH4rw.d.ts, lines 344-349)
  // Subset: cfg, accountId, account — the fields ChannelSecurityAdapter uses.
  // ---------------------------------------------------------------------------
  export interface ChannelSecurityContext<ResolvedAccount = unknown> {
    cfg: OpenClawConfig;
    accountId?: string | null;
    account: ResolvedAccount;
  }

  // ChannelSecurityDmPolicy (types.core-BnNQH4rw.d.ts, lines 336-343)
  // Describes the DM policy OpenClaw should enforce on this channel account.
  export interface ChannelSecurityDmPolicy {
    policy: string;
    allowFrom?: Array<string | number> | null;
    policyPath?: string;
    allowFromPath: string;
    approveHint: string;
    normalizeEntry?: (raw: string) => string;
  }

  // ---------------------------------------------------------------------------
  // ChannelPairingAdapter (pairing.types-DOYSvai_.d.ts, lines 8-17)
  // Reconciled 2026-07-07 against openclaw@2026.6.11.
  // ---------------------------------------------------------------------------
  export interface ChannelPairingAdapter {
    idLabel: string;
    normalizeAllowEntry?: (entry: string) => string;
    notifyApproval?: (params: {
      cfg: OpenClawConfig;
      id: string;
      accountId?: string;
      runtime?: unknown;
    }) => Promise<void>;
  }

  // ---------------------------------------------------------------------------
  // ChannelSecurityAdapter (types.adapters-DUxexnLv.d.ts, lines 812-836)
  // Reconciled 2026-07-07 against openclaw@2026.6.11.
  // Subset: only the members Raccoon uses.
  // ---------------------------------------------------------------------------
  export interface ChannelSecurityAdapter<ResolvedAccount = unknown> {
    applyConfigFixes?: (params: {
      cfg: OpenClawConfig;
      env: NodeJS.ProcessEnv;
    }) => unknown | Promise<unknown>;
    resolveDmPolicy?: (ctx: ChannelSecurityContext<ResolvedAccount>) => ChannelSecurityDmPolicy | null;
    collectWarnings?: (ctx: ChannelSecurityContext<ResolvedAccount>) => Promise<string[]> | string[];
  }

  // ---------------------------------------------------------------------------
  // Gateway lifecycle — Task 7. Reconciled 2026-07-07 against openclaw@2026.6.11.
  // Sources verified (all in /tmp/openclaw-real/package/dist/plugin-sdk/):
  //   types.adapters-DUxexnLv.d.ts, lines 237-306  — ChannelGatewayContext
  //   types.adapters-DUxexnLv.d.ts, lines 330-332  — ChannelGatewayAdapter
  //     (startAccount/stopAccount only — Raccoon uses no login/probe members)
  //   runtime-Bxifh4bY.d.ts, lines 2-6             — RuntimeEnv (log/error/exit)
  //   types.core-BnNQH4rw.d.ts, line 277           — ChannelLogSink
  //   types.core-BnNQH4rw.d.ts                     — ChannelAccountSnapshot
  //     (large; Raccoon only needs accountId + open index signature)
  // ---------------------------------------------------------------------------

  // RuntimeEnv (runtime-Bxifh4bY.d.ts, lines 2-6) — mirrored 1:1.
  export interface RuntimeEnv {
    log: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    exit: (code: number) => void;
  }

  // ChannelLogSink (types.core-BnNQH4rw.d.ts, line 277) — mirrored 1:1.
  export interface ChannelLogSink {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug?: (msg: string) => void;
  }

  // ChannelAccountSnapshot (types.core-BnNQH4rw.d.ts) — subset. accountId is
  // the only required member; the rest are open-world status fields Raccoon
  // does not read. Index signature keeps get/setStatus assignment-safe.
  export interface ChannelAccountSnapshot {
    accountId: string;
    running?: boolean;
    connected?: boolean;
    [key: string]: unknown;
  }

  // ChannelRuntimeSurface (channel-runtime-surface.types-CouuvmKm.d.ts) —
  // opaque; Raccoon does not use ctx.channelRuntime, so an open type suffices.
  export type ChannelRuntimeSurface = Record<string, unknown>;

  // ChannelGatewayContext (types.adapters-DUxexnLv.d.ts, lines 237-306).
  // Subset: the members Raccoon's startAccount/stopAccount read (cfg,
  // accountId, account, log) plus the rest of the required surface so the
  // adapter is assignable to ChannelGatewayAdapter.
  export interface ChannelGatewayContext<ResolvedAccount = unknown> {
    cfg: OpenClawConfig;
    accountId: string;
    account: ResolvedAccount;
    runtime: RuntimeEnv;
    abortSignal: AbortSignal;
    log?: ChannelLogSink;
    getStatus: () => ChannelAccountSnapshot;
    setStatus: (next: ChannelAccountSnapshot) => void;
    channelRuntime?: ChannelRuntimeSurface;
  }

  // ChannelGatewayAdapter (types.adapters-DUxexnLv.d.ts, lines 330-332).
  // Subset: startAccount + stopAccount only (Raccoon exposes no QR-login /
  // probe / auth-bypass members). All members optional in the real type.
  export interface ChannelGatewayAdapter<ResolvedAccount = unknown> {
    startAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<unknown>;
    stopAccount?: (ctx: ChannelGatewayContext<ResolvedAccount>) => Promise<void>;
  }

  // ---------------------------------------------------------------------------
  // Setup wizard slot on ChannelPlugin (types.plugin-ByOu7kLN.d.ts, line 13):
  //   ChannelPluginSetupWizard = ChannelSetupWizard | ChannelSetupWizardAdapter
  // Raccoon supplies a ChannelSetupWizard (T6). We import that type from the
  // setup-runtime shim to keep one source of truth.
  // ---------------------------------------------------------------------------
  import type { ChannelSetupWizard } from 'openclaw/plugin-sdk/setup-runtime';
  export type ChannelPluginSetupWizard = ChannelSetupWizard;

  // ---------------------------------------------------------------------------
  // OpenClawPluginApi — Task 7 subset. Reconciled 2026-07-07 against
  // openclaw@2026.6.11 (types-CR1WAXpo.d.ts, lines 9360-9411). Only the members
  // the channel-native entry uses are mirrored; index signature widens to the
  // full real surface so the real api is assignable to this subset.
  // NOTE: this is a SEPARATE declaration from the plugin-entry module's
  // OpenClawPluginApi (used by definePluginEntry) — defineChannelPluginEntry
  // passes the api typed from types-CR1WAXpo.d.ts, which includes registerCli.
  // ---------------------------------------------------------------------------
  export interface OpenClawPluginHttpRouteParams {
    path: string;
    auth: 'gateway' | 'plugin';
    handler: (
      req: import('node:http').IncomingMessage,
      res: import('node:http').ServerResponse,
    ) => Promise<boolean | void> | boolean | void;
    replaceExisting?: boolean;
  }

  export interface OpenClawPluginApi {
    id: string;
    registrationMode: PluginRegistrationMode;
    config: OpenClawConfig;
    logger: PluginLogger;
    registerHttpRoute: (params: OpenClawPluginHttpRouteParams) => void;
    registerCli: (
      registrar: OpenClawPluginCliRegistrar,
      opts?: {
        parentPath?: string[];
        commands?: string[];
        descriptors?: OpenClawPluginCliCommandDescriptor[];
      },
    ) => void;
    [key: string]: unknown;
  }

  // PluginRegistrationMode (mirrors plugin-entry shim; real: types-CR1WAXpo.d.ts).
  export type PluginRegistrationMode =
    | 'full'
    | 'discovery'
    | 'tool-discovery'
    | 'setup-only'
    | 'setup-runtime'
    | 'cli-metadata';

  // ---------------------------------------------------------------------------
  // defineChannelPluginEntry — Task 7. Reconciled 2026-07-07 against
  // openclaw@2026.6.11 (core-Ch6CsyM-.d.ts, lines 118-160):
  //   DefineChannelPluginEntryOptions<TPlugin> = {
  //     id; name; description; plugin: TPlugin;
  //     configSchema?: ChannelEntryConfigSchema<TPlugin> | (() => ...);
  //     setRuntime?; registerCliMetadata?; registerFull?;
  //   }
  //   DefinedChannelPluginEntry<TPlugin> = {
  //     id; name; description; configSchema; register; channelPlugin;
  //     setChannelRuntime?;
  //   }
  // The real ChannelEntryConfigSchema resolves to the plugin's configSchema
  // type; we widen to ChannelConfigSchema for the external-plugin-safe form.
  // ---------------------------------------------------------------------------
  export interface DefineChannelPluginEntryOptions<TPlugin = ChannelPlugin> {
    id: string;
    name: string;
    description: string;
    plugin: TPlugin;
    configSchema?: ChannelConfigSchema | (() => ChannelConfigSchema);
    setRuntime?: (runtime: unknown) => void;
    registerCliMetadata?: (api: OpenClawPluginApi) => void;
    registerFull?: (api: OpenClawPluginApi) => void;
  }

  export interface DefinedChannelPluginEntry<TPlugin = ChannelPlugin> {
    id: string;
    name: string;
    description: string;
    configSchema: ChannelConfigSchema;
    register: (api: OpenClawPluginApi) => void;
    channelPlugin: TPlugin;
    setChannelRuntime?: (runtime: unknown) => void;
  }

  export function defineChannelPluginEntry<TPlugin = ChannelPlugin>(
    options: DefineChannelPluginEntryOptions<TPlugin>,
  ): DefinedChannelPluginEntry<TPlugin>;
}

// ---------------------------------------------------------------------------
// setup-runtime shim — RECONCILED 2026-07-07 against openclaw@2026.6.11.
//
// setup-runtime.d.ts re-exports from setup-wizard-binary-COmrO5xX.d.ts which
// imports from bundled chunks (*.js) that TypeScript cannot resolve at
// typecheck time without the full package installed. We therefore shim the
// subset of the module that setup-wizard.ts uses, 1:1 from the real d.ts.
//
// Sources verified (all in /tmp/openclaw-real/package/dist/plugin-sdk/):
//   setup-wizard-types-Dh8rs7xx.d.ts  — ChannelSetupWizard, ChannelSetupWizardStatus,
//     ChannelSetupWizardCredential, ChannelSetupWizardTextInput,
//     ChannelSetupWizardAllowFrom, ChannelSetupWizardNote,
//     ChannelSetupDmPolicy, ChannelSetupWizardCredentialValues (lines 33-417)
//   setup-wizard-binary-COmrO5xX.d.ts — createStandardChannelSetupStatus (line 44),
//     createAllowFromSection (line 388), createTopLevelChannelDmPolicy (line 118)
//   types.core-BnNQH4rw.d.ts          — ChannelSetupInput (lines 134-176)
//   types.base-DmKdGokm.d.ts          — DmPolicy ("pairing"|"allowlist"|"open"|"disabled")
//
// The shim module is 'openclaw/plugin-sdk/setup-runtime'; the real public
// specifier is confirmed by setup-runtime.d.ts being the barrel that the SDK
// surface exposes.
// ---------------------------------------------------------------------------
declare module 'openclaw/plugin-sdk/setup-runtime' {
  // Re-use OpenClawConfig from channel-core shim (same brand).
  import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';

  // --- DmPolicy (types.base-DmKdGokm.d.ts, line 17) ---
  export type DmPolicy = 'pairing' | 'allowlist' | 'open' | 'disabled';

  // --- ChannelSetupInput (types.core-BnNQH4rw.d.ts, lines 134-176) ---
  // Full union; subset listed here = the keys Raccoon's textInputs use.
  export type ChannelSetupInput = {
    name?: string;
    token?: string;
    httpPort?: string;
    url?: string;
    groupChannels?: string[];
    // remaining keys omitted; only those above are used as inputKey values
    [key: string]: unknown;
  };

  // --- ChannelSetupWizardCredentialValues ---
  export type ChannelSetupWizardCredentialValues = Partial<Record<string, string>>;

  // --- ChannelSetupWizardAllowFromEntry ---
  export type ChannelSetupWizardAllowFromEntry = {
    input: string;
    resolved: boolean;
    id: string | null;
  };

  // --- ChannelSetupWizardNote (setup-wizard-types-Dh8rs7xx.d.ts, lines 79-87) ---
  export type ChannelSetupWizardNote = {
    title: string;
    lines: string[];
    shouldShow?: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      credentialValues: ChannelSetupWizardCredentialValues;
    }) => boolean | Promise<boolean>;
  };

  // --- ChannelSetupWizardStatus (setup-wizard-types-Dh8rs7xx.d.ts, lines 43-69) ---
  export type ChannelSetupWizardStatus = {
    configuredLabel: string;
    unconfiguredLabel: string;
    configuredHint?: string;
    unconfiguredHint?: string;
    configuredScore?: number;
    unconfiguredScore?: number;
    resolveConfigured: (params: {
      cfg: OpenClawConfig;
      accountId?: string;
    }) => boolean | Promise<boolean>;
    resolveStatusLines?: (params: {
      cfg: OpenClawConfig;
      accountId?: string;
      configured: boolean;
    }) => string[] | Promise<string[]>;
    resolveSelectionHint?: (params: {
      cfg: OpenClawConfig;
      accountId?: string;
      configured: boolean;
    }) => string | undefined | Promise<string | undefined>;
  };

  // --- ChannelSetupWizardCredential (setup-wizard-types-Dh8rs7xx.d.ts, lines 102-138) ---
  export type ChannelSetupWizardCredential = {
    inputKey: keyof ChannelSetupInput;
    providerHint: string;
    credentialLabel: string;
    preferredEnvVar?: string;
    helpTitle?: string;
    helpLines?: string[];
    envPrompt: string;
    keepPrompt: string;
    inputPrompt: string;
    inspect: (params: {
      cfg: OpenClawConfig;
      accountId: string;
    }) => {
      accountConfigured: boolean;
      hasConfiguredValue: boolean;
      resolvedValue?: string;
      envValue?: string;
    };
    applySet?: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      credentialValues: ChannelSetupWizardCredentialValues;
      value: unknown;
      resolvedValue: string;
    }) => OpenClawConfig | Promise<OpenClawConfig>;
  };

  // --- ChannelSetupWizardTextInput (setup-wizard-types-Dh8rs7xx.d.ts, lines 140-183) ---
  export type ChannelSetupWizardTextInput = {
    inputKey: keyof ChannelSetupInput;
    message: string;
    placeholder?: string;
    required?: boolean;
    applyEmptyValue?: boolean;
    helpTitle?: string;
    helpLines?: string[];
    confirmCurrentValue?: boolean;
    keepPrompt?: string | ((value: string) => string);
    currentValue?: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      credentialValues: ChannelSetupWizardCredentialValues;
    }) => string | undefined | Promise<string | undefined>;
    initialValue?: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      credentialValues: ChannelSetupWizardCredentialValues;
    }) => string | undefined | Promise<string | undefined>;
    shouldPrompt?: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      credentialValues: ChannelSetupWizardCredentialValues;
      currentValue?: string;
    }) => boolean | Promise<boolean>;
    applyCurrentValue?: boolean;
    validate?: (params: {
      value: string;
      cfg: OpenClawConfig;
      accountId: string;
      credentialValues: ChannelSetupWizardCredentialValues;
    }) => string | undefined;
    normalizeValue?: (params: {
      value: string;
      cfg: OpenClawConfig;
      accountId: string;
      credentialValues: ChannelSetupWizardCredentialValues;
    }) => string;
    applySet?: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      value: string;
    }) => OpenClawConfig | Promise<OpenClawConfig>;
  };

  // --- ChannelSetupWizardAllowFrom (setup-wizard-types-Dh8rs7xx.d.ts, lines 191-211) ---
  export type ChannelSetupWizardAllowFrom = {
    helpTitle?: string;
    helpLines?: string[];
    credentialInputKey?: keyof ChannelSetupInput;
    message: string;
    placeholder: string;
    invalidWithoutCredentialNote: string;
    parseInputs?: (raw: string) => string[];
    parseId: (raw: string) => string | null;
    resolveEntries: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      credentialValues: ChannelSetupWizardCredentialValues;
      entries: string[];
    }) => Promise<ChannelSetupWizardAllowFromEntry[]>;
    apply: (params: {
      cfg: OpenClawConfig;
      accountId: string;
      allowFrom: string[];
    }) => OpenClawConfig | Promise<OpenClawConfig>;
  };

  // --- ChannelSetupDmPolicy (setup-wizard-types-Dh8rs7xx.d.ts, lines 389-405) ---
  export type ChannelSetupDmPolicy = {
    label: string;
    channel: string;
    policyKey: string;
    allowFromKey: string;
    resolveConfigKeys?: (cfg: OpenClawConfig, accountId?: string) => {
      policyKey: string;
      allowFromKey: string;
    };
    getCurrent: (cfg: OpenClawConfig, accountId?: string) => DmPolicy;
    setPolicy: (cfg: OpenClawConfig, policy: DmPolicy, accountId?: string) => OpenClawConfig;
    promptAllowFrom?: (params: {
      cfg: OpenClawConfig;
      prompter: unknown;
      accountId?: string;
    }) => Promise<OpenClawConfig>;
  };

  // --- ChannelSetupWizard (setup-wizard-types-Dh8rs7xx.d.ts, lines 281-311) ---
  export type ChannelSetupWizard = {
    channel: string;
    status: ChannelSetupWizardStatus;
    introNote?: ChannelSetupWizardNote;
    prepare?: unknown;
    stepOrder?: 'credentials-first' | 'text-first';
    credentials: ChannelSetupWizardCredential[];
    textInputs?: ChannelSetupWizardTextInput[];
    finalize?: unknown;
    completionNote?: ChannelSetupWizardNote;
    dmPolicy?: ChannelSetupDmPolicy;
    allowFrom?: ChannelSetupWizardAllowFrom;
    groupAccess?: unknown;
    disable?: (cfg: OpenClawConfig) => OpenClawConfig;
  };

  // --- createStandardChannelSetupStatus ---
  // (setup-wizard-binary-COmrO5xX.d.ts, lines 44-59)
  export function createStandardChannelSetupStatus(params: {
    channelLabel: string;
    configuredLabel: string;
    unconfiguredLabel: string;
    configuredHint?: string;
    unconfiguredHint?: string;
    configuredScore?: number;
    unconfiguredScore?: number;
    includeStatusLine?: boolean;
    resolveConfigured: ChannelSetupWizardStatus['resolveConfigured'];
    resolveExtraStatusLines?: (params: {
      cfg: OpenClawConfig;
      accountId?: string;
      configured: boolean;
    }) => string[] | Promise<string[]>;
  }): ChannelSetupWizardStatus;

  // --- createAllowFromSection ---
  // (setup-wizard-binary-COmrO5xX.d.ts, lines 388-399)
  export function createAllowFromSection(params: {
    helpTitle?: string;
    helpLines?: string[];
    credentialInputKey?: ChannelSetupWizardAllowFrom['credentialInputKey'];
    message: string;
    placeholder: string;
    invalidWithoutCredentialNote: string;
    parseInputs?: ChannelSetupWizardAllowFrom['parseInputs'];
    parseId: ChannelSetupWizardAllowFrom['parseId'];
    resolveEntries?: ChannelSetupWizardAllowFrom['resolveEntries'];
    apply: ChannelSetupWizardAllowFrom['apply'];
  }): ChannelSetupWizardAllowFrom;

  // --- createTopLevelChannelDmPolicy ---
  // (setup-wizard-binary-COmrO5xX.d.ts, lines 118-126)
  export function createTopLevelChannelDmPolicy(params: {
    label: string;
    channel: string;
    policyKey: string;
    allowFromKey: string;
    getCurrent: (cfg: OpenClawConfig) => DmPolicy;
    promptAllowFrom?: ChannelSetupDmPolicy['promptAllowFrom'];
    getAllowFrom?: (cfg: OpenClawConfig) => Array<string | number> | undefined;
  }): ChannelSetupDmPolicy;
}

declare module 'openclaw/plugin-sdk/plugin-entry' {
  import type { IncomingMessage, ServerResponse } from 'node:http';

  export type OpenClawPluginHttpRouteAuth = 'gateway' | 'plugin';
  export type OpenClawPluginHttpRouteHandler = (
    req: IncomingMessage,
    res: ServerResponse,
  ) => Promise<boolean | void> | boolean | void;

  export interface PluginLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }

  export type PluginRegistrationMode =
    | 'full'
    | 'discovery'
    | 'tool-discovery'
    | 'setup-only'
    | 'setup-runtime'
    | 'cli-metadata';

  /** Subset of the real OpenClawPluginApi this adapter touches. */
  export interface OpenClawPluginApi {
    id: string;
    registrationMode: PluginRegistrationMode;
    logger: PluginLogger;
    registerHttpRoute(params: {
      path: string;
      auth: OpenClawPluginHttpRouteAuth;
      handler: OpenClawPluginHttpRouteHandler;
      replaceExisting?: boolean;
    }): void;
  }

  export interface DefinePluginEntryOptions {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  }

  export interface DefinedPluginEntry {
    id: string;
    name: string;
    description: string;
    register: (api: OpenClawPluginApi) => void;
  }

  /** Canonical entry helper for non-channel plugins (real signature). */
  export function definePluginEntry(options: DefinePluginEntryOptions): DefinedPluginEntry;
}

// ---------------------------------------------------------------------------
// CLI registrar shim — RECONCILED 2026-07-07 against openclaw@2026.6.11.
// Sources verified:
//   types-CR1WAXpo.d.ts lines 9017-9030 — OpenClawPluginCliContext
//     (program: Command from 'commander', parentPath, config, workspaceDir, logger)
//   types-CR1WAXpo.d.ts line 9030 — OpenClawPluginCliRegistrar
//   types-CR1WAXpo.d.ts lines 9039-9052 — OpenClawPluginCliCommandDescriptor
//   types-CR1WAXpo.d.ts lines 9395-9411 — registerCli signature on the plugin API
//
// We use `import('openclaw/plugin-sdk/channel-core').OpenClawConfig` for cfg.
// `program` is typed as `unknown` (we cast in cli.ts) to avoid pulling in
// the full `commander` dependency into the shim.
// ---------------------------------------------------------------------------
declare module 'openclaw/plugin-sdk/channel-core' {
  // PluginLogger is re-declared here (matches plugin-entry shim shape).
  // Real source: types-CR1WAXpo.d.ts (PluginLogger interface).
  export interface PluginLogger {
    info(message: string): void;
    warn(message: string): void;
    error(message: string): void;
  }

  // OpenClawPluginCliCommandDescriptor (types-CR1WAXpo.d.ts, lines 9039-9052)
  export interface OpenClawPluginCliCommandDescriptor {
    name: string;
    description: string;
    hasSubcommands: boolean;
  }

  // OpenClawPluginCliContext (types-CR1WAXpo.d.ts, lines 9017-9029)
  // program: Command from 'commander'; typed as unknown here to avoid bundling
  // commander types — callers cast as needed.
  export interface OpenClawPluginCliContext {
    /** commander.Command at the registration root (root program or parent command). */
    program: unknown;
    parentPath: readonly string[];
    config: OpenClawConfig;
    workspaceDir?: string;
    logger: PluginLogger;
  }

  // OpenClawPluginCliRegistrar (types-CR1WAXpo.d.ts, line 9030)
  export type OpenClawPluginCliRegistrar = (ctx: OpenClawPluginCliContext) => void | Promise<void>;
}
