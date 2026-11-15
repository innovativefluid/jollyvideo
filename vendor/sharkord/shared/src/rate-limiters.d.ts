import z from 'zod';
export declare enum RateLimiter {
    LOGIN = "login",
    JOIN_SERVER = "joinServer",
    USE_SECRET_TOKEN = "useSecretToken",
    PASSWORD = "password",
    SEND_MESSAGE = "sendMessage",
    SEARCH = "search",
    SIGNAL_TYPING = "signalTyping",
    JOIN_VOICE_CHANNEL = "joinVoiceChannel",
    VOICE_REACTION = "voiceReaction",
    VOICE_STATE = "voiceState",
    VOICE_STREAM = "voiceStream"
}
export declare const RATE_LIMIT_MIN_GLOBAL_REQUESTS = 20;
export declare const RATE_LIMIT_MAX_REQUESTS = 100000;
export declare const RATE_LIMIT_MIN_WINDOW_MS = 1000;
export declare const RATE_LIMIT_MAX_WINDOW_MS: number;
declare const zRateLimit: z.ZodObject<{
    maxRequests: z.ZodNumber;
    windowMs: z.ZodNumber;
}, z.core.$strip>;
export declare const zRateLimiters: z.ZodObject<{
    enabled: z.ZodBoolean;
    global: z.ZodObject<{
        windowMs: z.ZodNumber;
        maxRequests: z.ZodNumber;
    }, z.core.$strip>;
    overrides: z.ZodObject<{
        login: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        joinServer: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        useSecretToken: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        password: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        sendMessage: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        search: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        signalTyping: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        joinVoiceChannel: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        voiceReaction: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        voiceState: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
        voiceStream: z.ZodObject<{
            maxRequests: z.ZodNumber;
            windowMs: z.ZodNumber;
        }, z.core.$strip>;
    }, z.core.$strip>;
    loginLockout: z.ZodObject<{
        maxFailures: z.ZodNumber;
        windowMs: z.ZodNumber;
        blockMs: z.ZodNumber;
        maxBlockMs: z.ZodNumber;
    }, z.core.$strip>;
}, z.core.$strip>;
export type TRateLimit = z.infer<typeof zRateLimit>;
export type TRateLimiters = z.infer<typeof zRateLimiters>;
export declare const DEFAULT_RATE_LIMITERS: TRateLimiters;
export {};
