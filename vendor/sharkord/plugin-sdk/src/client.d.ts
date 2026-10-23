import type { TContractActions, TContractCommands, TContractPush, TContractUserData, TPluginActions, TPluginComponentsMapBySlotId, TPluginContract, TPluginHotkeyAction, TPluginHotkeyBinding, TPluginHotkeyPhase, TPluginMessageComponentProps, TPluginMessageComponentsMap, TPluginStore, TPluginStoreState, TPluginTabs, TPluginUserData } from '@sharkord/shared';
declare global {
    interface Window {
        /** the host store, exposed before any plugin bundle is imported */
        __SHARKORD_STORE__: TPluginStore;
    }
}
/**
 * Sharkord's own actions: sending a message, selecting a channel, fetching one
 * of your HTTP routes. To call your own server actions use `createCallAction`.
 */
declare const actions: TPluginActions;
/**
 * Calls your own server actions, typed by the `TPluginContract` both halves of
 * the plugin share:
 *
 * ```ts
 * const callAction = createCallAction<TSharkord>();
 * ```
 *
 * Call it once at module scope, not inside a component.
 */
declare const createCallAction: <C extends TPluginContract>() => import("./actions").TypedCallAction<TContractActions<C>>;
/**
 * Receives whatever your server sent through `ctx.push`. Pass the contract to
 * type the payload, or nothing to receive it as `unknown`.
 */
declare const usePush: <C extends TPluginContract = TPluginContract>(handler: (data: TContractPush<C>) => void) => void;
/**
 * Per-user storage for this plugin, the client half of `ctx.userData`. Pass the
 * contract to type what `data` holds and what `save` accepts.
 */
declare const useUserData: <C extends TPluginContract = TPluginContract>() => TPluginUserData<TContractUserData<C>>;
/**
 * Whether the user may run one of this plugin's actions, so the UI can disable
 * a button rather than let the call fail. Pass the contract to autocomplete the
 * name.
 *
 * UX only: the server checks again on every call, and it is the answer that
 * counts.
 */
declare const useCanUseAction: <C extends TPluginContract = TPluginContract>(name: keyof TContractActions<C> & string) => boolean;
/**
 * The same for a slash command, for UI that lists or offers them. The command
 * is refused server side either way.
 */
declare const useCanUseCommand: <C extends TPluginContract = TPluginContract>(name: keyof TContractCommands<C> & string) => boolean;
/**
 * The audio output the user picked in their device settings, for
 * `audio.setSinkId()`, so what you play comes out where the call does.
 * `undefined` means the system default: leave the sink alone then. The device
 * can be unplugged since it was picked, so catch a failing `setSinkId`.
 */
declare const usePlaybackDeviceId: () => string | undefined;
/**
 * Registers an action the user can bind a key to, in Sharkord's Hotkeys
 * settings or with a `HotkeyInput` from `@sharkord/ui`. Keys work while the game or another app has
 * focus, when the user runs the Sharkord Bridge. The action exists while the
 * component using the hook is mounted, so a soundboard calls it once per sound.
 *
 * ```ts
 * useHotkey({ id: `play-${sound.id}`, label: sound.name }, () => play(sound));
 * ```
 *
 * `mode: 'hold'` also reports the release (`phase === 'up'`).
 */
declare const useHotkey: (action: TPluginHotkeyAction, handler: (phase: TPluginHotkeyPhase) => void) => void;
/**
 * Everything one of your actions needs to be bound: the key as the user should
 * read it (`display`, `undefined` while unbound) and the props of the
 * `HotkeyInput` from `@sharkord/ui`, so a control to record the key is one line.
 * It records, refuses keys the browser or OS keep and keys another action
 * already uses, and applies as soon as the user picks.
 *
 * ```tsx
 * const binding = useHotkeyBinding(id);
 *
 * return <HotkeyInput {...binding} />;
 * ```
 */
declare const useHotkeyBinding: (id: string) => TPluginHotkeyBinding;
/**
 * Reads a slice of Sharkord's state and re-renders when it changes.
 *
 * The selector must return a stable reference for unchanged state: reading a
 * field (`(state) => state.users`) is fine, building a new array or object on
 * every call is not. Memoize those with `createSelector` from reselect.
 */
declare const useStoreSelector: <T>(selector: (state: TPluginStoreState) => T) => T;
export { actions, createCallAction, useCanUseAction, useCanUseCommand, useHotkey, useHotkeyBinding, usePlaybackDeviceId, usePush, useStoreSelector, useUserData };
export type { TPluginComponentsMapBySlotId, TPluginHotkeyAction, TPluginHotkeyBinding, TPluginHotkeyPhase, TPluginMessageComponentProps, TPluginMessageComponentsMap, TPluginStoreState, TPluginTabs };
