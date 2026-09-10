/**
 * useDelayedVisible — an affordance that is honest when the await is FAST.
 *
 * The catalog fetches are mem- and disk-cached and the credential fan-out can finish
 * before the first paint, so a naive loading bar flashes for one or two 100 ms ticks
 * on every warm start. That reads as a glitch, not as progress, and it is the same
 * class of dishonesty as a bar with an invented denominator: it tells the user
 * something happened that they cannot perceive.
 *
 * So: show nothing for the first `showAfterMs`, and once shown keep it for at least
 * `keepForMs`. A task that settles inside the first window is never announced; a task
 * that is announced does not vanish mid-blink.
 *
 * THE CONSEQUENCE IS STATED RATHER THAN DISCOVERED LATER: the loading states (V2, V3)
 * are photographed against the FIXTURE data source by design, because the real warm
 * path is too fast to capture. That is not a weaker test than a live capture — it is
 * the only reproducible one.
 */

import { useEffect, useRef, useState } from "react";

export function useDelayedVisible(active: boolean, showAfterMs = 120, keepForMs = 300): boolean {
  const [visible, setVisible] = useState(false);
  const shownAt = useRef<number | null>(null);

  useEffect(() => {
    if (active) {
      if (visible) return;
      const t = setTimeout(() => {
        shownAt.current = Date.now();
        setVisible(true);
      }, showAfterMs);
      return () => clearTimeout(t);
    }
    if (!visible) return;
    // Hold for the REMAINDER of the minimum, not the whole of it: a task that ran
    // for 2 s has already been seen, and re-holding the bar for another 300 ms after
    // it finished would make the screen feel slower than it is.
    const elapsed = shownAt.current === null ? keepForMs : Date.now() - shownAt.current;
    const hold = Math.max(0, keepForMs - elapsed);
    const t = setTimeout(() => {
      shownAt.current = null;
      setVisible(false);
    }, hold);
    return () => clearTimeout(t);
  }, [active, visible, showAfterMs, keepForMs]);

  return visible;
}
