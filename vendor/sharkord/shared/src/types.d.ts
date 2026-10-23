import { z } from 'zod';
import { ChannelPermission, type TFile, type TSettings, type TUser } from '.';
import type { WithOptional } from './type-utils';
export declare enum ChannelType {
    TEXT = "TEXT",
    VOICE = "VOICE"
}
export declare enum StreamKind {
    AUDIO = "audio",
    VIDEO = "video",
    SCREEN = "screen",
    SCREEN_AUDIO = "screen_audio",
    EXTERNAL_VIDEO = "external_video",
    EXTERNAL_AUDIO = "external_audio"
}
export declare const PRODUCIBLE_STREAM_KINDS: readonly [StreamKind.AUDIO, StreamKind.VIDEO, StreamKind.SCREEN, StreamKind.SCREEN_AUDIO];
export type TProducibleStreamKind = (typeof PRODUCIBLE_STREAM_KINDS)[number];
export type TExternalStreamTrackKind = 'audio' | 'video';
export type TExternalStreamTracks = {
    audio?: boolean;
    video?: boolean;
};
export type TStreamQualityLayer = {
    spatialLayer: number;
    label: string;
};
export type TStreamQuality = {
    mode: 'auto';
} | {
    mode: 'layer';
    spatialLayer: number;
};
export type TRemoteProducerIds = {
    remoteVideoIds: number[];
    remoteAudioIds: number[];
    remoteScreenIds: number[];
    remoteScreenAudioIds: number[];
    remoteExternalStreamIds: number[];
};
export type TPublicServerSettings = Pick<TSettings, 'name' | 'description' | 'serverId' | 'storageUploadEnabled' | 'directMessagesEnabled' | 'storageQuota' | 'storageUploadMaxFileSize' | 'storageFileSharingInDirectMessages' | 'storageMaxAvatarSize' | 'storageMaxBannerSize' | 'storageMaxFilesPerMessage' | 'storageSpaceQuotaByUser' | 'storageOverflowAction' | 'enablePlugins' | 'webRtcSimulcastEnabled' | 'enableSearch' | 'showWelcomeDialog' | 'storageSignedUrlsEnabled'> & {
    webRtcMaxBitrate: number;
};
export type TMessageMediaMetadata = {
    kind: 'media';
    url: string;
    title?: string;
    description?: string;
    mediaType: 'image' | 'video' | 'audio';
};
export type TMessageOpenGraphMetadata = {
    kind: 'open_graph';
    url: string;
    title?: string;
    siteName?: string;
    description?: string;
    mediaType: string;
    images?: string[];
    videos?: string[];
    favicons?: string[];
};
export type TMessageMetadata = TMessageMediaMetadata | TMessageOpenGraphMetadata;
export declare enum UserStatus {
    ONLINE = "online",
    IDLE = "idle",
    OFFLINE = "offline"
}
export type TOwnUser = WithOptional<TUser, 'identity'>;
export type TConnectionParams = {
    token: string;
};
export type TTempFile = {
    id: string;
    originalName: string;
    size: number;
    md5: string;
    path: string;
    extension: string;
    userId: number | null;
};
export type TServerInfo = Pick<TSettings, 'serverId' | 'name' | 'description' | 'allowNewUsers'> & {
    logo: TFile | null;
    version?: string;
    oidcEnabled: boolean;
    oidcDisableLocalLogin: boolean;
};
export declare enum OidcError {
    ACCESS_DENIED = "access_denied",
    INVALID_STATE = "invalid_state",
    EXPIRED = "expired",
    RATE_LIMITED = "rate_limited",
    REGISTRATION_CLOSED = "registration_closed",
    SERVER_ERROR = "server_error"
}
export type TWebAppManifest = {
    name: string;
    short_name: string;
    description: string;
    start_url: string;
    display: string;
    background_color: string;
    theme_color: string;
    icons: Array<{
        src: string;
        sizes: string;
        type: string;
        purpose?: string;
    }>;
};
export type TArtifact = {
    name: string;
    target: string;
    size: number;
    checksum: string;
};
export type TVersionInfo = {
    version: string;
    releaseDate: string;
    artifacts: TArtifact[];
};
export type TIpInfo = {
    ip: string;
    hostname: string;
    city: string;
    region: string;
    country: string;
    loc: string;
    org: string;
    postal: string;
    timezone: string;
};
export type TChannelPermissionsMap = Record<ChannelPermission, boolean>;
export type TChannelUserPermissionsMap = Record<number, {
    channelId: number;
    permissions: TChannelPermissionsMap;
}>;
export type TReadStateMap = Record<number, number>;
export type TThreadReadState = {
    unreadCount: number;
    hasUnreadMention: boolean;
};
export type TFollowedThreadsMap = Record<number, TThreadReadState>;
export type TThreadSummary = {
    replyCount: number;
    replyUserIds: number[];
};
export type TFollowedThread = TThreadSummary & {
    parentMessageId: number;
    channelId: number;
    userId: number | null;
    pluginId: string | null;
    content: string | null;
    lastReplyAt: number;
};
export type TThreadFollowUpdate = TThreadReadState & {
    parentMessageId: number;
    channelId: number;
    thread: TFollowedThread | null;
};
export type TDirectMessageConversation = {
    channelId: number;
    userId: number;
    lastMessageAt: number;
    closedAt: number | null;
};
export type TMessagesCursor = {
    createdAt: number;
    id: number;
};
export declare const zMessagesCursor: z.ZodObject<{
    createdAt: z.ZodNumber;
    id: z.ZodNumber;
}, z.core.$strip>;
export declare const DEFAULT_PROFILE_COLOR = "#262626";
export declare const HEX_COLOR_REGEX: RegExp;
export declare const INVITE_CODE_REGEX: RegExp;
export declare const EMOJI_CHARACTER_REGEX: RegExp;
export declare const EMOJI_SHORTCODE_REGEX: RegExp;
