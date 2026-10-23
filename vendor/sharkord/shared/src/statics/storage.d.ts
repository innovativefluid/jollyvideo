export declare enum StorageOverflowAction {
    DELETE_OLD_FILES = "delete",// when new uploads exceed the quota, delete the oldest files
    PREVENT_UPLOADS = "prevent"
}
export declare const STORAGE_OVERFLOW_ACTIONS_DICT: {
    delete: string;
    prevent: string;
};
export declare const STORAGE_OVERFLOW_ACTIONS_DESCRIPTION: {
    [key: string]: string;
};
export type TStorageData = {
    userId: number;
    fileCount: number;
    usedStorage: number;
};
export declare const STORAGE_QUOTA: number;
export declare const STORAGE_MIN_QUOTA: number;
export declare const STORAGE_MAX_QUOTA: number;
export declare const STORAGE_MAX_FILE_SIZE: number;
export declare const STORAGE_MIN_FILE_SIZE: number;
export declare const STORAGE_MAX_QUOTA_PER_USER: number;
export declare const STORAGE_MIN_QUOTA_PER_USER = 0;
export declare const STORAGE_DEFAULT_MAX_AVATAR_SIZE: number;
export declare const STORAGE_DEFAULT_MAX_BANNER_SIZE: number;
export declare const STORAGE_MAX_AVATAR_SIZE: number;
export declare const STORAGE_MAX_BANNER_SIZE: number;
export declare const STORAGE_DEFAULT_MAX_FILES_PER_MESSAGE = 10;
export declare const STORAGE_MIN_FILES_PER_MESSAGE = 0;
export declare const STORAGE_MAX_FILES_PER_MESSAGE = 20;
export declare const STORAGE_OVERFLOW_ACTION = StorageOverflowAction.PREVENT_UPLOADS;
export declare const STORAGE_DEFAULT_SIGNED_URLS_TTL_SECONDS = 3600;
export declare const STORAGE_MIN_SIGNED_URLS_TTL_SECONDS = 1800;
export declare const STORAGE_MAX_SIGNED_URLS_TTL_SECONDS: number;
export declare const STORAGE_DEFAULT_IMAGE_OPTIMIZATION_QUALITY = 80;
export declare const STORAGE_MIN_IMAGE_OPTIMIZATION_QUALITY = 1;
export declare const STORAGE_MAX_IMAGE_OPTIMIZATION_QUALITY = 100;
