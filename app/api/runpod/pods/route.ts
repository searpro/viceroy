import { NextResponse } from "next/server";
import { resolveConfig } from "@/lib/config";
import { createRunpodClient, httpPorts, uptimeMs } from "@/lib/runpod/client";

export const dynamic = "force-dynamic";

/** Every pod on the account, for the picker on the Providers screen. */
export async function GET() {
  const { runpodApiKey } = resolveConfig();
  if (!runpodApiKey) {
    return NextResponse.json(
      { configured: false, error: "RUNPOD_API_KEY is not set", pods: [] },
      { status: 200 },
    );
  }

  try {
    const pods = await createRunpodClient(runpodApiKey).listPods();
    return NextResponse.json({
      configured: true,
      pods: pods.map((pod) => ({
        id: pod.id,
        name: pod.name ?? pod.id,
        status: pod.desiredStatus ?? "UNKNOWN",
        costPerHr: pod.adjustedCostPerHr ?? pod.costPerHr ?? null,
        httpPorts: httpPorts(pod),
        uptimeMs: uptimeMs(pod),
      })),
    });
  } catch (error) {
    return NextResponse.json(
      { configured: true, error: messageOf(error), pods: [] },
      { status: 502 },
    );
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
