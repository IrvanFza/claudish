import { type ProbeLinkInput, type ProbeResult, probeLink } from "./probe-live.js";

export function pinProbeModelSpec(link: Pick<ProbeLinkInput, "provider" | "modelSpec">): string {
  // native-anthropic is the ONE provider the proxy resolves by the ABSENCE of a
  // provider@ prefix (isNative = no "/" and no "@" → nativeHandler). Prefixing
  // it would set hasExplicitProvider=true and route it AWAY from the passthrough
  // (→ "not a valid model ID"). So keep its model spec BARE.
  if (link.provider === "native-anthropic") return link.modelSpec;
  return link.modelSpec.includes("@") ? link.modelSpec : `${link.provider}@${link.modelSpec}`;
}

export function probeProviderRoute(
  proxyUrl: string,
  link: ProbeLinkInput,
  timeoutMs: number
): Promise<ProbeResult> {
  return probeLink(
    proxyUrl,
    {
      ...link,
      modelSpec: pinProbeModelSpec(link),
    },
    timeoutMs
  );
}
