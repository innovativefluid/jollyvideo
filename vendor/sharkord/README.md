# Sharkord SDK types

Type declarations generated with `tsc --emitDeclarationOnly` from
`packages/shared` and `packages/plugin-sdk` of
[Sharkord v0.0.28](https://github.com/Sharkord/sharkord/tree/v0.0.28)
(commit 07ab40f7). Sharkord is MIT licensed, see `LICENSE`.

Types only: nothing here ends up in the plugin bundles, so code imports from
these packages with `import type`. Two declarations point at Sharkord's server
(database rows and the tRPC router) and resolve to `any`; the plugin uses
neither.
