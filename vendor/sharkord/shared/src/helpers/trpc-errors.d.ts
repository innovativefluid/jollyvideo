export type TTrpcErrors = Record<string, string | undefined>;
declare const parseTrpcErrors: (err: unknown) => TTrpcErrors;
declare const getTrpcError: (err: unknown, fallback: string) => string;
export { getTrpcError, parseTrpcErrors };
