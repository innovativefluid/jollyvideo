import { translate, type TMessage, type TMessageKey } from "../i18n";

/** An error meant for the person who caused it; the panel shows it in their language. */
export class UserError extends Error {
  override name = "UserError";
  readonly text: TMessage;

  constructor(key: TMessageKey, params?: TMessage["params"]) {
    super(translate("en", key, params));
    this.text = params ? { key, params } : { key };
  }
}

export const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

/** what a user gets to read about an error; anything unexpected stays in the log */
export const userMessage = (error: unknown): TMessage => (error instanceof UserError ? error.text : { key: "error.generic" });

/**
 * Action errors reach the panel as a message string, so they carry the key
 * for it to translate: `jv:{"key":…}`. Chat commands get English.
 */
export const ACTION_ERROR_PREFIX = "jv:";
export const encodeForPanel = (message: TMessage): string => `${ACTION_ERROR_PREFIX}${JSON.stringify(message)}`;
