import type { TAppNotification, TNotificationTarget } from './notifications';
export type TDesktopUnreadState = {
    count: number;
    mentioned: boolean;
};
export declare const DESKTOP_CONNECTION_STATES: readonly ["connecting", "connected", "signed-out", "disconnected"];
export type TDesktopConnectionState = (typeof DESKTOP_CONNECTION_STATES)[number];
export type TDesktopHotkeyBinding = {
    actionId: string;
    combo: string;
};
export type TDesktopHotkeyPhase = 'down' | 'up';
export type TDesktopHotkeyCapabilities = {
    keyUp: boolean;
    systemManaged: boolean;
};
export declare const DESKTOP_HOTKEY_ERROR_REASONS: readonly ["unsupported", "needs-modifier", "taken", "declined"];
export type TDesktopHotkeyErrorReason = (typeof DESKTOP_HOTKEY_ERROR_REASONS)[number];
export type TDesktopHotkeyError = {
    actionId: string;
    reason: TDesktopHotkeyErrorReason;
};
export type TDesktopBridge = {
    getServerListVisible: () => Promise<boolean>;
    onServerListVisibleChange: (listener: (visible: boolean) => void) => () => void;
    toggleServerList: () => Promise<void>;
    openSettings: () => Promise<void>;
    setUnreadState: (state: TDesktopUnreadState) => void;
    setConnectionState: (state: TDesktopConnectionState) => void;
    setVoiceActive: (active: boolean) => void;
    startSystemAudio: () => Promise<boolean>;
    stopSystemAudio: () => Promise<void>;
    showNotification: (notification: TAppNotification) => void;
    setHotkeys: (bindings: TDesktopHotkeyBinding[]) => Promise<TDesktopHotkeyError[]>;
    getHotkeyCapabilities: () => Promise<TDesktopHotkeyCapabilities>;
    onHotkey: (listener: (actionId: string, phase: TDesktopHotkeyPhase) => void) => () => void;
    onHotkeyErrors: (listener: (errors: TDesktopHotkeyError[]) => void) => () => void;
    onNotificationClick: (listener: (target: TNotificationTarget) => void) => () => void;
};
export declare const DESKTOP_BRIDGE_VERSION = 1;
export type TDesktopEntry = {
    version: number;
    connect: (clientVersion: number) => TDesktopBridge | undefined;
};
export declare const DESKTOP_MISMATCHES: readonly ["server-outdated", "app-outdated"];
export type TDesktopMismatch = (typeof DESKTOP_MISMATCHES)[number];
export declare const getDesktopMismatch: (desktopVersion: number, clientVersion: number) => TDesktopMismatch | undefined;
export declare const DESKTOP_PROTOCOL = "sharkord";
export declare const DESKTOP_ADD_SERVER_ACTION = "add-server";
export declare const getDesktopAddServerLink: (serverUrl: string) => string;
