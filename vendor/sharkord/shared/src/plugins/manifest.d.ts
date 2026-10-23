import z from 'zod';
/**
 * The SDK contract this server speaks. A plugin declares the same number as
 * `sdkVersion` in its manifest, and one that does not match is refused at load
 * rather than failing later against an API that moved.
 */
export declare const PLUGIN_SDK_VERSION = 2;
/** where the host looks for a plugin's `onLoad` */
export declare const SERVER_ENTRY_FILE = "server/index.js";
/** the only file of a plugin the browser can fetch, so bundle the UI into it */
export declare const CLIENT_ENTRY_FILE = "client/index.js";
export declare const zPluginManifest: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    author: z.ZodString;
    description: z.ZodString;
    homepage: z.ZodOptional<z.ZodURL>;
    logo: z.ZodOptional<z.ZodURL>;
    sdkVersion: z.ZodNumber;
    version: z.ZodString;
}, z.core.$strip>;
export type TPluginManifest = z.infer<typeof zPluginManifest>;
export type TPluginInfo = {
    id: string;
    enabled: boolean;
    loadError?: string;
    sdkVersion: TPluginManifest['sdkVersion'];
    author: TPluginManifest['author'];
    description: TPluginManifest['description'];
    version: TPluginManifest['version'];
    logo: TPluginManifest['logo'];
    name: TPluginManifest['name'];
    homepage: TPluginManifest['homepage'];
    path: string;
};
export type TPluginMetadata = {
    pluginId: string;
    name: string;
    description: string;
    version: string;
    avatarUrl?: string;
};
export declare const assertSdkVersionCompatibility: (sdkVersion: number) => void;
export type TLogEntry = {
    type: 'info' | 'error' | 'debug';
    timestamp: number;
    message: string;
    pluginId: string;
};
