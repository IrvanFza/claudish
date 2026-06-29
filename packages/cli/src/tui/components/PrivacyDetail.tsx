import { DETAIL_H } from "../constants.js";
/** @jsxImportSource @opentui/react */
import { C } from "../theme.js";

export function PrivacyDetail() {
  return (
    <box
      height={DETAIL_H}
      border
      borderStyle="single"
      borderColor={C.dim}
      title=" Your Privacy "
      backgroundColor={C.bgAlt}
      flexDirection="column"
      paddingX={1}
    >
      <text>
        <span fg={C.fgMuted}>
          Telemetry and usage stats are always opt-in and never send personally identifiable data.
        </span>
      </text>
      <text>
        <span fg={C.fgMuted}>
          All data is anonymized before transmission. You can disable either independently.
        </span>
      </text>
    </box>
  );
}
