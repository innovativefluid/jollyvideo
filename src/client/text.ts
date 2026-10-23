/** The panel's words, in the browser's language when it is English, German or Polish. */
import { isMessageKey, pickLanguage, translate, type TMessage, type TMessageKey } from "../i18n";

const language = () => pickLanguage(typeof navigator === "undefined" ? [] : (navigator.languages ?? [navigator.language]));

export const t = (key: TMessageKey, params?: TMessage["params"]): string => translate(language(), key, params);

export const say = (message: TMessage): string => t(message.key, message.params);

/** an action's error, which carries a message key from the server: `jv:{"key":…}` */
export const errorMessage = (error: unknown): TMessage => {
  const text = error instanceof Error ? error.message : String(error);
  const encoded = /jv:(\{.*\})/.exec(text)?.[1];
  if (encoded) {
    try {
      const message = JSON.parse(encoded) as TMessage;
      if (isMessageKey(message.key)) return message;
    } catch {
      // not ours
    }
  }
  return { key: "error.generic" };
};
