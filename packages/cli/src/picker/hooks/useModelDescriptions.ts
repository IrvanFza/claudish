/**
 * useModelDescriptions — the catalog's prose sentence per model, on its own clock.
 *
 * IT IS DELIBERATELY THE LAST THING TO ARRIVE. The list is built from the slim
 * catalog, which carries no `description` at all (0 of 704 entries on disk), so
 * the sentence comes from a bulk fetch of the rich catalog — MEASURED at 2.8 s for
 * all 1 016 active models, cached on disk for a day. Nothing waits for it: the
 * rows are already usable, and a description is worth having on the row the cursor
 * is on and worth nothing on a row nobody has looked at.
 *
 * `DescriptionIndex.size === 0` therefore means "not loaded yet", never "no model
 * has one" — which is why the detail block renders blank rows rather than
 * collapsing. A block that grew by two rows when this landed would shove the
 * footer down under the reader's cursor, seconds after they started reading.
 */

import { useEffect, useState } from "react";
import {
  type DescriptionIndex,
  emptyDescriptionIndex,
} from "../../providers/model-descriptions.js";
import type { PickerDataSource } from "../PickerDataSource.js";

export function useModelDescriptions(source: PickerDataSource): DescriptionIndex {
  const [index, setIndex] = useState<DescriptionIndex>(emptyDescriptionIndex);

  useEffect(() => {
    let live = true;
    void source.descriptions().then(
      (loaded) => {
        if (live) setIndex(loaded);
      },
      () => {
        // Documented never to reject; guarded anyway. A missing sentence must
        // never be able to take the picker down.
      }
    );
    return () => {
      live = false;
    };
  }, [source]);

  return index;
}
