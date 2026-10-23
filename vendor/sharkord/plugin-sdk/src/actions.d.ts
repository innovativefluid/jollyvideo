import type { TActionContract, TContractActions, TPluginActions, TPluginContract } from '@sharkord/shared';
type TypedCallAction<TActions extends TActionContract> = <K extends keyof TActions & string>(name: K, ...args: TActions[K]['payload'] extends void ? [] : [payload: TActions[K]['payload']]) => Promise<TActions[K]['response']>;
declare const createCallAction: <C extends TPluginContract>(actions: TPluginActions) => TypedCallAction<TContractActions<C>>;
export { createCallAction };
export type { TActionContract, TypedCallAction };
