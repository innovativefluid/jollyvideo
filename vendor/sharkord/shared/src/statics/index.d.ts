export * from './locales';
export * from './metrics';
export * from './permissions';
export * from './storage';
export * from './upload';
export declare const DEFAULT_MESSAGES_LIMIT = 100;
export declare const MESSAGE_MAX_LENGTH = 10000;
export declare const REACTION_EMOJI_MAX_LENGTH = 32;
export declare const OWNER_ROLE_ID = 1;
export declare const TYPING_MS = 300;
export declare enum MessageNodeType {
    MENTION = "mention",
    ROLE_MENTION = "role-mention",
    CHANNEL_REFERENCE = "channel-reference",
    PLUGIN_COMMAND = "plugin-command",
    EMOJI = "emoji"
}
export declare enum DisconnectCode {
    UNEXPECTED = 1006,
    KICKED = 40000,
    BANNED = 40001,
    SERVER_SHUTDOWN = 40002
}
export declare const MAX_USER_NAME_LENGTH = 24;
export declare const DELETED_USER_IDENTITY_AND_NAME = "__deleted_user__";
export declare const DEFAULT_BITRATE = 6000;
