import { type RegisteredCommand, type TCommandElement, type TParsedDomCommand } from '../plugins';
declare const stringifyCommandResponse: (response: unknown) => string;
declare const toDomCommand: (command: RegisteredCommand & {
    imageUrl?: string;
    status: "pending" | "completed" | "failed";
    response?: unknown;
}, args: unknown[]) => string;
declare const parseDomCommand: (domElement: TCommandElement) => TParsedDomCommand;
export { parseDomCommand, stringifyCommandResponse, toDomCommand };
