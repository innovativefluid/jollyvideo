import z from 'zod';
export declare const zPluginId: z.ZodString;
export declare const zHttpUrl: z.ZodURL;
export declare const PLUGIN_USER_DATA_MAX_BYTES: number;
export type TPluginPushEvent = {
    pluginId: string;
    data: unknown;
};
export declare const PLUGIN_PUSH_MAX_BYTES: number;
export declare const PLUGIN_MESSAGE_COMPONENTS_MAX_BYTES: number;
export declare const PLUGIN_MESSAGE_COMPONENTS_MAX = 5;
export declare const PLUGIN_MESSAGE_COMPONENT_NAME_MAX_LENGTH = 64;
export declare const PLUGIN_STORAGE_KEY_MAX_LENGTH = 256;
export declare const PLUGIN_STORAGE_VALUE_MAX_BYTES: number;
export declare const PLUGIN_STORAGE_LIST_MAX_LIMIT = 1000;
