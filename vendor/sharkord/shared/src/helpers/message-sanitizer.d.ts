declare const removeCommandElements: (html: string) => string;
declare const removeEmojiElements: (html: string) => string;
declare const removeChannelReferenceElements: (html: string) => string;
declare const isEmptyMessage: (content: string | undefined | null) => boolean;
declare const isEmojiOnlyMessage: (content: string | undefined | null) => boolean;
declare const getPlainTextFromHtml: (html: string) => string;
export { getPlainTextFromHtml, isEmojiOnlyMessage, isEmptyMessage, removeChannelReferenceElements, removeCommandElements, removeEmojiElements };
