type TMentions = {
    userIds: number[];
    roleIds: number[];
};
declare const getMentions: (content: string | null | undefined) => TMentions;
declare const hasMention: (content: string | null | undefined, userId: number | undefined, roleIds?: number[]) => boolean;
export { getMentions, hasMention };
