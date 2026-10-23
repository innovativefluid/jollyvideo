import z from 'zod';
declare const MARKETPLACE_REGISTRY_URL = "https://raw.githubusercontent.com/Sharkord/plugins/refs/heads/main/plugins.json?raw=true";
declare const zMarketplacePlugin: z.ZodObject<{
    id: z.ZodString;
    name: z.ZodString;
    description: z.ZodString;
    author: z.ZodString;
    logo: z.ZodURL;
    homepage: z.ZodOptional<z.ZodURL>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
    categories: z.ZodOptional<z.ZodArray<z.ZodString>>;
    verified: z.ZodBoolean;
    screenshots: z.ZodOptional<z.ZodArray<z.ZodURL>>;
}, z.core.$strip>;
declare const zMarketplacePluginVersion: z.ZodObject<{
    version: z.ZodString;
    downloadUrl: z.ZodURL;
    checksum: z.ZodString;
    sdkVersion: z.ZodNumber;
    size: z.ZodNumber;
    timestamp: z.ZodNumber;
}, z.core.$strip>;
declare const zMarketplaceEntry: z.ZodObject<{
    plugin: z.ZodObject<{
        id: z.ZodString;
        name: z.ZodString;
        description: z.ZodString;
        author: z.ZodString;
        logo: z.ZodURL;
        homepage: z.ZodOptional<z.ZodURL>;
        tags: z.ZodOptional<z.ZodArray<z.ZodString>>;
        categories: z.ZodOptional<z.ZodArray<z.ZodString>>;
        verified: z.ZodBoolean;
        screenshots: z.ZodOptional<z.ZodArray<z.ZodURL>>;
    }, z.core.$strip>;
    versions: z.ZodArray<z.ZodObject<{
        version: z.ZodString;
        downloadUrl: z.ZodURL;
        checksum: z.ZodString;
        sdkVersion: z.ZodNumber;
        size: z.ZodNumber;
        timestamp: z.ZodNumber;
    }, z.core.$strip>>;
}, z.core.$strip>;
declare const parseMarketplaceRegistry: (input: unknown) => TMarketplaceEntry[];
type TMarketplacePlugin = z.infer<typeof zMarketplacePlugin>;
type TMarketplacePluginVersion = z.infer<typeof zMarketplacePluginVersion>;
type TMarketplaceEntry = z.infer<typeof zMarketplaceEntry>;
export { MARKETPLACE_REGISTRY_URL, parseMarketplaceRegistry, zMarketplaceEntry, zMarketplacePlugin, zMarketplacePluginVersion, type TMarketplaceEntry, type TMarketplacePlugin, type TMarketplacePluginVersion };
