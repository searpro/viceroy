import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { SdApiHttp } from "../sdapi/client";
import {
  ComfyAbortedError,
  ComfyClient,
  ComfyExecutionError,
  ComfyValidationError,
  selectOutput,
  type ComfyProgress,
  type WebSocketFactory,
} from "./client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Recorded from the live pod: a completed Flux-2 Klein job. */
const HISTORY_SUCCESS = JSON.parse(
  readFileSync(new URL("./fixtures/history-success.json", import.meta.url), "utf8"),
) as Record<string, unknown>;
const SUCCESS_ID = Object.keys(HISTORY_SUCCESS)[0]!;

/** ComfyUI's real 400 body, recorded by submitting an unknown checkpoint. */
const VALIDATION_BODY = {
  error: { type: "prompt_outputs_failed_validation", message: "Prompt outputs failed validation" },
  node_errors: {
    "1": {
      class_type: "UNETLoader",
      errors: [
        {
          type: "value_not_in_list",
          details: "unet_name: 'no-such-model.safetensors' not in ['flux-2-klein-base-4b-fp8.safetensors']",
        },
      ],
    },
  },
};

type Handler = (url: string, init?: RequestInit) => Response;

function comfy(handler: Handler, webSocketFactory?: WebSocketFactory) {
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => handler(url, init));
  const client = new ComfyClient(
    new SdApiHttp({ baseUrl: "http://comfy", fetch: fetchImpl, service: "ComfyUI" }),
    "http://comfy",
    { webSocketFactory },
  );
  return { client, fetchImpl };
}

/** A socket that replays a scripted message list on the next tick. */
function scriptedSocket(messages: unknown[], onUrl?: (url: string) => void): WebSocketFactory {
  return (url: string) => {
    onUrl?.(url);
    const listeners: ((event: { data: string }) => void)[] = [];
    queueMicrotask(() => {
      for (const message of messages) {
        for (const listener of listeners) listener({ data: JSON.stringify(message) });
      }
    });
    return {
      addEventListener: (_type: string, listener: (event: never) => void) =>
        listeners.push(listener as (event: { data: string }) => void),
      close: () => undefined,
    };
  };
}

describe("submit", () => {
  it("posts the graph and returns the prompt id", async () => {
    const { client, fetchImpl } = comfy(() => json({ prompt_id: "p1", node_errors: {} }));
    expect(await client.submit({ "1": { class_type: "X" } }, "viceroy")).toBe("p1");

    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe("http://comfy/prompt");
    expect(JSON.parse(init!.body as string)).toEqual({
      prompt: { "1": { class_type: "X" } },
      client_id: "viceroy",
    });
  });

  // ComfyUI's 400 names the node, the input, the bad value and the legal
  // values. Flattening that into a generic error would throw away exactly what
  // the workflow editor needs to show.
  it("turns a validation 400 into a per-node error", async () => {
    const { client } = comfy(() => json(VALIDATION_BODY, 400));

    await expect(client.submit({}, "viceroy")).rejects.toThrow(ComfyValidationError);
    try {
      await client.submit({}, "viceroy");
    } catch (error) {
      const validation = error as ComfyValidationError;
      expect(validation.nodeErrors).toHaveLength(1);
      expect(validation.nodeErrors[0]).toMatchObject({ nodeId: "1", classType: "UNETLoader" });
      expect(validation.nodeErrors[0]!.details[0]).toMatch(/no-such-model/);
    }
  });
});

describe("awaitJob", () => {
  it("returns the outputs from a completed job", async () => {
    const { client } = comfy((url) =>
      url.includes("/history/") ? json(HISTORY_SUCCESS) : json({}),
    );

    const outputs = await client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1 });
    expect(outputs["9"]!.images![0]).toEqual({
      filename: "viceroy_probe_00001_.png",
      subfolder: "",
      type: "output",
    });
  });

  // The socket is the only progress source: /history is `{}` until the job is
  // over and /queue only says running-vs-pending (F23).
  it("reports sampling progress from the socket", async () => {
    let polls = 0;
    const { client } = comfy((url) => {
      if (url.includes("/history/")) {
        // Stay unfinished for the first poll so the socket has a turn.
        polls += 1;
        return json(polls > 1 ? HISTORY_SUCCESS : {});
      }
      return json({});
    }, scriptedSocket([
      { type: "execution_start", data: { prompt_id: SUCCESS_ID } },
      { type: "progress", data: { prompt_id: SUCCESS_ID, value: 3, max: 12, node: "7" } },
      { type: "progress", data: { prompt_id: SUCCESS_ID, value: 12, max: 12, node: "7" } },
    ]));

    const seen: ComfyProgress[] = [];
    await client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1, onProgress: (p) => seen.push(p) });

    expect(seen[0]).toEqual({ phase: "loading" });
    expect(seen).toContainEqual({ phase: "sampling", fraction: 0.25, node: "7" });
    expect(seen).toContainEqual({ phase: "sampling", fraction: 1, node: "7" });
  });

  it("ignores events belonging to another job on the same socket", async () => {
    let polls = 0;
    const { client } = comfy((url) => {
      if (url.includes("/history/")) {
        polls += 1;
        return json(polls > 1 ? HISTORY_SUCCESS : {});
      }
      return json({});
    }, scriptedSocket([
      { type: "progress", data: { prompt_id: "someone-else", value: 5, max: 10 } },
    ]));

    const seen: ComfyProgress[] = [];
    await client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1, onProgress: (p) => seen.push(p) });
    expect(seen).toEqual([]);
  });

  it("surfaces an execution error with the failing node", async () => {
    const { client } = comfy(
      (url) => (url.includes("/history/") ? json({}) : json({})),
      scriptedSocket([
        {
          type: "execution_error",
          data: {
            prompt_id: SUCCESS_ID,
            node_id: "8",
            node_type: "VAEDecode",
            exception_message: "tuple index out of range\n",
          },
        },
      ]),
    );

    try {
      await client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1 });
      expect.unreachable("should have thrown");
    } catch (error) {
      const failure = error as ComfyExecutionError;
      expect(failure).toBeInstanceOf(ComfyExecutionError);
      expect(failure.nodeId).toBe("8");
      expect(failure.nodeType).toBe("VAEDecode");
      expect(failure.message).toBe("tuple index out of range");
    }
  });

  // Both an interrupt and a real failure land in history as status_str
  // "error" (F24), so only the socket can tell an operator's abort apart from
  // a broken workflow.
  it("distinguishes an interrupt from a failure", async () => {
    const { client } = comfy(
      () => json({ [SUCCESS_ID]: { status: { status_str: "error", completed: false } } }),
      scriptedSocket([{ type: "execution_interrupted", data: { prompt_id: SUCCESS_ID } }]),
    );

    await expect(client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1 })).rejects.toThrow(
      ComfyAbortedError,
    );
  });

  it("still fails when history says error and no socket saw why", async () => {
    const { client } = comfy(() =>
      json({ [SUCCESS_ID]: { status: { status_str: "error", completed: false } } }),
    );
    await expect(client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1 })).rejects.toThrow(
      ComfyExecutionError,
    );
  });

  // No socket is the worker-restart case: the job is already running and there
  // was never a socket for it. Correctness must not depend on one.
  it("completes without a socket at all", async () => {
    const { client } = comfy((url) => (url.includes("/history/") ? json(HISTORY_SUCCESS) : json({})));
    const outputs = await client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1 });
    expect(Object.keys(outputs)).toEqual(["9"]);
  });

  it("cancels and throws when the caller aborts", async () => {
    const calls: string[] = [];
    const { client } = comfy((url) => {
      calls.push(url);
      if (url.includes("/queue")) return json({ queue_running: [[0, SUCCESS_ID]], queue_pending: [] });
      return json({});
    });

    await expect(
      client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1, shouldAbort: () => true }),
    ).rejects.toThrow(ComfyAbortedError);
    // Running job: queue-delete alone is not enough, /interrupt is required.
    expect(calls.some((url) => url.endsWith("/interrupt"))).toBe(true);
  });

  it("times out and cancels", async () => {
    const { client } = comfy((url) =>
      url.includes("/queue") ? json({ queue_running: [], queue_pending: [] }) : json({}),
    );
    await expect(client.awaitJob(SUCCESS_ID, { pollIntervalMs: 1, timeoutMs: 5 })).rejects.toThrow(
      /timed out/,
    );
  });
});

describe("generate", () => {
  // ComfyUI routes a job's events to the socket whose clientId matches the
  // client_id that submitted it. When these disagree the socket connects,
  // stays silent, and the job still succeeds — so the only symptom is missing
  // progress, which reads as "this server has none". Measured against the live
  // pod: mismatched ids produced zero progress events across a whole run.
  it("opens the socket under the same client id it submits with", async () => {
    let socketUrl = "";
    let submittedClientId = "";

    const { client } = comfy(
      (url, init) => {
        if (url.endsWith("/prompt")) {
          submittedClientId = JSON.parse(init!.body as string).client_id;
          return json({ prompt_id: SUCCESS_ID });
        }
        return url.includes("/history/") ? json(HISTORY_SUCCESS) : json({});
      },
      scriptedSocket([], (url) => {
        socketUrl = url;
      }),
    );

    await client.generate({ "1": { class_type: "X" } }, { pollIntervalMs: 1 });

    expect(submittedClientId).toBeTruthy();
    expect(socketUrl).toContain(`clientId=${encodeURIComponent(submittedClientId)}`);
  });

  // The socket has to be listening before the prompt is submitted: on a warm
  // pod the entire generation can finish in under two seconds (F26), and
  // events emitted before the socket connects are simply gone.
  it("subscribes before submitting", async () => {
    const order: string[] = [];
    const { client } = comfy(
      (url) => {
        if (url.endsWith("/prompt")) {
          order.push("submit");
          return json({ prompt_id: SUCCESS_ID });
        }
        return url.includes("/history/") ? json(HISTORY_SUCCESS) : json({});
      },
      scriptedSocket([], () => order.push("subscribe")),
    );

    await client.generate({ "1": { class_type: "X" } }, { pollIntervalMs: 1 });
    expect(order.slice(0, 2)).toEqual(["subscribe", "submit"]);
  });

  it("reports progress for the job it just submitted", async () => {
    let polls = 0;
    const { client } = comfy(
      (url) => {
        if (url.endsWith("/prompt")) return json({ prompt_id: SUCCESS_ID });
        if (url.includes("/history/")) {
          polls += 1;
          return json(polls > 1 ? HISTORY_SUCCESS : {});
        }
        return json({});
      },
      scriptedSocket([
        { type: "progress", data: { prompt_id: SUCCESS_ID, value: 6, max: 12, node: "7" } },
      ]),
    );

    const seen: ComfyProgress[] = [];
    await client.generate({}, { pollIntervalMs: 1, onProgress: (p) => seen.push(p) });
    expect(seen).toContainEqual({ phase: "sampling", fraction: 0.5, node: "7" });
  });
});

describe("cancel", () => {
  // /interrupt is global — it kills whatever is executing (F24). Using it on a
  // job that is merely queued would cancel an unrelated running generation.
  it("deletes a pending job without interrupting the running one", async () => {
    const calls: string[] = [];
    const { client } = comfy((url) => {
      calls.push(url);
      return json({ queue_running: [[0, "someone-else"]], queue_pending: [[1, "mine"]] });
    });

    await client.cancel("mine");
    expect(calls.some((url) => url.endsWith("/queue"))).toBe(true);
    expect(calls.some((url) => url.endsWith("/interrupt"))).toBe(false);
  });
});

describe("uploadImage", () => {
  it("rejoins subfolder and name the way LoadImage needs them", async () => {
    const { client } = comfy(() => json({ name: "portrait.png", subfolder: "viceroy", type: "input" }));
    expect(await client.uploadImage(Buffer.from("png"), "portrait.png")).toBe("viceroy/portrait.png");
  });

  it("returns a bare name when the upload landed in the input root", async () => {
    const { client } = comfy(() => json({ name: "portrait.png", subfolder: "", type: "input" }));
    expect(await client.uploadImage(Buffer.from("png"), "portrait.png", "")).toBe("portrait.png");
  });
});

describe("hasInput", () => {
  it("splits a subfolder-qualified name back into query parameters", async () => {
    let seen = "";
    const { client } = comfy((url) => {
      seen = url;
      return new Response("bytes");
    });

    expect(await client.hasInput("viceroy/portrait.png")).toBe(true);
    expect(seen).toContain("filename=portrait.png");
    expect(seen).toContain("subfolder=viceroy");
    expect(seen).toContain("type=input");
  });

  it("reports a missing input as absent rather than throwing", async () => {
    const { client } = comfy(() => new Response("not found", { status: 404 }));
    expect(await client.hasInput("viceroy/gone.png")).toBe(false);
  });
});

describe("selectOutput", () => {
  const outputs = {
    "9": { images: [{ filename: "a.png", subfolder: "", type: "output" }] },
    "12": { gifs: [{ filename: "b.mp4", subfolder: "vid", type: "output" }] },
  };

  it("finds the file from the named node", () => {
    expect(selectOutput(outputs, "12").filename).toBe("b.mp4");
  });

  it("finds any output when no node is named", () => {
    expect(selectOutput({ "9": outputs["9"] }).filename).toBe("a.png");
  });

  it("explains an empty result rather than returning undefined", () => {
    expect(() => selectOutput({})).toThrow(/Save node/);
    expect(() => selectOutput(outputs, "99")).toThrow(/node 99/);
  });
});
