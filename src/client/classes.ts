/**
 * Every class name the client uses, and only Sharkord's own: its stylesheet is
 * the only one on the page, and it holds just the classes its source uses.
 * Most strings here are what Sharkord's components render (`@sharkord/ui`,
 * MIT), merged the way they merge them. `bun run check` verifies each class
 * against Sharkord's source.
 */

const BUTTON =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap text-sm font-medium disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg:not([class*='size-'])]:size-4 shrink-0 [&_svg]:shrink-0 outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px] aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive";

export const cls = {
  /** the camera and screen share buttons beside it, switched off */
  trigger: `${BUTTON} dark:hover:bg-accent/50 size-9 h-8 w-8 rounded-md transition-all duration-200 bg-secondary hover:bg-secondary/80 text-muted-foreground hover:text-foreground`,
  /** Button variant="ghost" size="icon" */
  iconButton: `${BUTTON} rounded-md transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 size-9`,
  /** Button variant="ghost" size="icon-sm" */
  smallIconButton: `${BUTTON} rounded-md transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 size-6`,
  /** Button variant="secondary" size="icon", for a switch that is on */
  iconButtonOn: `${BUTTON} rounded-md transition-all bg-secondary text-secondary-foreground hover:bg-secondary/80 size-9`,
  /** PopoverContent, opening upwards */
  panel:
    "bg-popover text-popover-foreground data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2 z-50 w-80 rounded-md border p-4 shadow-md outline-hidden fixed flex flex-col gap-3 overflow-y-auto",
  /** Input */
  input:
    "file:text-foreground placeholder:text-muted-foreground selection:bg-primary selection:text-primary-foreground dark:bg-input/30 border-input h-9 w-full min-w-0 rounded-md border bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50 md:text-sm focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]",
  /** Badge variant="destructive" */
  liveBadge:
    "inline-flex items-center justify-center rounded-full border px-2 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 border-transparent bg-destructive text-white dark:bg-destructive/60",
  /** Slider */
  slider: "relative flex w-full touch-none items-center select-none data-[disabled]:opacity-50 py-2",
  /** taller than the track, so it is easy to hit */
  sliderEnabled: "relative flex w-full touch-none items-center select-none py-2 cursor-pointer",
  /** where a chapter ends: a gap in the track */
  chapterGap: "bg-popover absolute h-full",
  /** TooltipContent, over the point of the bar the mouse is at */
  seekPreview: "bg-foreground text-background animate-in fade-in-0 zoom-in-95 z-50 w-fit rounded-md px-3 py-1.5 text-xs absolute pointer-events-none whitespace-nowrap",
  /** the window a storyboard frame shows through */
  seekPreviewFrame: "relative overflow-hidden rounded-sm bg-muted mb-1",
  seekPreviewTime: "block text-center font-medium",
  seekPreviewChapter: "block max-w-40 truncate text-center",
  chapter: "text-xs text-muted-foreground truncate",
  sliderTrack: "bg-muted relative grow overflow-hidden rounded-full data-[orientation=horizontal]:h-1.5 data-[orientation=horizontal]:w-full",
  sliderRange: "bg-primary absolute data-[orientation=horizontal]:h-full",
  /** how much is downloaded, under the range */
  sliderBuffered: "bg-primary/20 absolute h-full",
  sliderThumb:
    "border-primary ring-ring/50 block size-4 shrink-0 rounded-full border bg-white shadow-sm transition-[color,box-shadow] hover:ring-4 focus-visible:ring-4 focus-visible:outline-hidden absolute",

  row: "flex items-center gap-2",
  controls: "flex items-center gap-1",
  grow: "flex-1",
  icon: "h-4 w-4",
  spinner: "h-4 w-4 animate-spin",
  nowPlaying: "flex gap-3",
  thumbnail: "aspect-video w-24 shrink-0 rounded-md object-cover bg-muted",
  nowText: "flex min-w-0 flex-1 flex-col gap-1",
  title: "text-sm font-medium leading-tight line-clamp-2 break-words",
  meta: "text-xs text-muted-foreground",
  queue: "flex flex-col gap-1 border-t pt-3",
  queueRow: "flex items-center gap-2 min-w-0 rounded-sm",
  queueRowDragging: "flex items-center gap-2 min-w-0 rounded-sm bg-accent shadow-sm",
  /** the handle a queued video is dragged by */
  grip: `${BUTTON} rounded-md transition-all hover:bg-accent hover:text-accent-foreground dark:hover:bg-accent/50 size-6 cursor-grab touch-none text-muted-foreground`,
  queueFooter: "flex justify-end",
  queueTitle: "flex-1 truncate text-sm",
  queueMeta: "w-10 shrink-0 text-xs text-muted-foreground",
  /** where a non-moderator sees that the player is locked */
  lockedMark: "inline-flex size-9 shrink-0 items-center justify-center text-muted-foreground",
  error: "text-sm text-destructive",
  /** the caption language picker */
  select: "border-input dark:bg-input/30 h-8 max-w-40 rounded-md border bg-transparent px-2 text-xs outline-none",
  captions: "rounded-md bg-muted/50 px-2 py-1.5 text-sm text-center break-words",
  captionsFailed: "rounded-md bg-muted/50 px-2 py-1.5 text-xs text-center text-muted-foreground",
  captionLine: "block",
} as const;
