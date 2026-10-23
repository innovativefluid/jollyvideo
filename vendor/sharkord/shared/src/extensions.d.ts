export declare const imageExtensions: string[];
export declare const videoExtensions: string[];
export declare const audioExtensions: string[];
export declare const documentExtensions: string[];
export declare enum FileCategory {
    IMAGE = "image",
    VIDEO = "video",
    AUDIO = "audio",
    DOCUMENT = "document",
    OTHER = "other"
}
export declare const getFileCategory: (extension: string) => FileCategory;
export declare const isPreviewable: (file: File) => boolean;
