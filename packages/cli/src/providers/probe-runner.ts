import { probeLink, type ProbeLinkInput, type ProbeResult } from "./probe-live.js";

export function pinProbeModelSpec(link: Pick<ProbeLinkInput, "provider" | "modelSpec">): string {
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
