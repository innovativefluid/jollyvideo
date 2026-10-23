/** The button beside the camera and screen share buttons, and the panel it opens. */
import { Popcorn } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cls } from "./classes";
import { Panel } from "./panel";
import { start } from "./store";

export const VoiceButton = () => {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useEffect(start, []);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={cls.trigger}
        title="Watch together"
        aria-label="Watch together"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Popcorn className={cls.icon} />
      </button>
      {open && <Panel anchor={button} onClose={close} />}
    </>
  );
};
