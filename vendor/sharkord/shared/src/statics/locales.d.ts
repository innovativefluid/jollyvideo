import z from 'zod';
export declare const SUPPORTED_LOCALES: string[];
export type TLocale = (typeof SUPPORTED_LOCALES)[number];
export declare const DEFAULT_LOCALE: TLocale;
export declare const zLocale: z.ZodEnum<{
    [x: string]: string;
}>;
