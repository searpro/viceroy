import { NextResponse } from "next/server";
import { resolveConfig } from "@/lib/config";
import { createRunpodClient, httpPorts, podProxyUrl, uptimeMs } from "@/lib/runpod/client";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ podId: string }> };

/** Live status, rate, and what this pod has cost over the last 30 days. */
export async function GET(request: Request, { params }: Params) {
  const { podId } = await params;
  const { runpodApiKey } = resolveConfig();
  if (!runpodApiKey) {
    return NextResponse.json({ configured: false, error: "RUNPOD_API_KEY is not set" });
  }

  const port = Number(new URL(request.url).searchParams.get("port") ?? 8188);
  const client = createRunpodClient(runpodApiKey);

  try {
    const pod = await client.getPod(podId);
    const since = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    // Billing is a separate call and a separate failure: a pod whose status
    // loaded fine should still render when the billing window errors, rather
    // than the whole panel going red over a number that is nice to have.
    const spend = await client.spend(podId, since).catch(() => null);

    return NextResponse.json({
      configured: true,
      pod: {
        id: pod.id,
        name: pod.name ?? pod.id,
        status: pod.desiredStatus ?? "UNKNOWN",
        costPerHr: pod.adjustedCostPerHr ?? pod.costPerHr ?? null,
        uptimeMs: uptimeMs(pod),
        httpPorts: httpPorts(pod),
        proxyUrl: podProxyUrl(pod.id, port),
        gpu: pod.gpu?.id ?? null,
        gpuCount: pod.gpu?.count ?? null,
      },
      spend,
    });
  } catch (error) {
    return NextResponse.json({ configured: true, error: messageOf(error) }, { status: 502 });
  }
}

/** Start or stop, via `{"action":"start"}` / `{"action":"stop"}`. */
export async function POST(request: Request, { params }: Params) {
  const { podId } = await params;
  const { runpodApiKey } = resolveConfig();
  if (!runpodApiKey) {
    return NextResponse.json({ error: "RUNPOD_API_KEY is not set" }, { status: 400 });
  }

  const body = (await request.json().catch(() => null)) as { action?: string } | null;
  if (body?.action !== "start" && body?.action !== "stop") {
    return NextResponse.json({ error: 'action must be "start" or "stop"' }, { status: 400 });
  }

  const client = createRunpodClient(runpodApiKey);
  try {
    if (body.action === "start") await client.startPod(podId);
    else await client.stopPod(podId);

    // RunPod returns an empty body for both, so the useful answer is the pod's
    // state immediately afterwards — still not "ready", but at least real.
    const pod = await client.getPod(podId).catch(() => null);
    return NextResponse.json({
      ok: true,
      action: body.action,
      status: pod?.desiredStatus ?? "UNKNOWN",
    });
  } catch (error) {
    return NextResponse.json({ error: messageOf(error) }, { status: 502 });
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
