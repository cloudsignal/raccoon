// Minimal shim for @cloudsignal/pwa-sdk until the package ships types.
// Only the surface used by CloudSignalTransport.enablePush() is declared here.
declare module '@cloudsignal/pwa-sdk' {
  export interface PushRegistration {
    registrationId: string;
  }

  export interface CloudSignalPWAOptions {
    organizationId: string;
    organizationPublishableKey?: string;
    serviceId: string;
    serviceUrl: string;
    [key: string]: unknown;
  }

  export class CloudSignalPWA {
    constructor(opts: CloudSignalPWAOptions);
    initialize(): Promise<void>;
    registerForPush(): Promise<PushRegistration | null>;
    isRegistered(): boolean;
    canInstall(): boolean;
    clearBadge(): void;
    showInstallPrompt(): Promise<void>;
    on(event: string, handler: (payload?: unknown) => void): void;
  }
}
