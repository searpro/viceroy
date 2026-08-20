import { SdApiHttp, SdFormData, type SdApiOptions } from "../sdapi/client";

/**
 * Client for a ComfyUI server.
 *
 * Like `VideoClient`, this reuses `SdApiHttp` as the project's HTTP transport
 * rather than because ComfyUI resembles sd-api — it carries the long-timeout
 * Agent from finding F19, which matters here for a different reason than
 * usual: the first generation after a pod starts spends ~33 s loading weights
 * before a single sampling step runs (finding F26).
 *
 * The interesting constraint is that ComfyUI's REST surface has no progress at
 * all. `GET /history/{id}` returns `{}` for the entire run and `/queue` only
 * distinguishes running from pending, so a poll-only client shows nothing
 * until the job is over (finding F23). Progress lives exclusively on the
 * WebSocket, which is why `awaitJob` opens one and only falls back to polling
 * when it cannot.
 */

/** A file ComfyUI produced, as `/history` and the `executed` event name it. */
export type ComfyOutputRef = {
  filename: string;
  subfolder: string;
  type: string;
};

/** Outputs keyed by the node that produced them, e.g. `{ "9": { images: [...] } }`. */
export type ComfyOutputs = Record<string, Record<string, ComfyOutputRef[] | undefined>>;

export type ComfyHistoryRecord = {
  status?: { status_str?: string; completed?: boolean };
  outputs?: ComfyOutputs;
};

/**
 * Where a job is.
 *
 * `loading` is a real state rather than 0% sampling: between `execution_start`
 * and the first `progress` event the server is reading weights off disk, and
 * on a cold pod that is the majority of the wall time. Reporting it as 0%
 * makes a working job look wedged (F26).
 */
export type ComfyProgress =
  | { phase: "queued" }
  | { phase: "loading"; node?: string | undefined }
  | { phase: "sampling"; fraction: number; node?: string | undefined };

export type ComfyAwaitOptions = {
  onProgress?: ((progress: ComfyProgress) => void) | undefined;
  /** Called between polls and on every socket event; true abandons the job. */
  shouldAbort?: (() => boolean) | undefined;
  pollIntervalMs?: number | undefined;
  timeoutMs?: number | undefined;
};

export class ComfyAbortedError extends Error {
  constructor(message = "ComfyUI generation aborted") {
    super(message);
    this.name = "ComfyAbortedError";
  }
}

export class ComfyExecutionError extends Error {
  constructor(
    message: string,
    readonly nodeId?: string,
    readonly nodeType?: string,
  ) {
    super(message);
    this.name = "ComfyExecutionError";
  }
}

/**
 * A validation rejection from `POST /prompt`.
 *
 * ComfyUI's 400 is unusually good — it names the node, the input, the value it
 * got and the values it would have accepted — so it is worth parsing into
 * something the workflow editor can render per-node instead of showing the
 * user a wall of JSON.
 */
export class ComfyValidationError extends Error {
  constructor(
    message: string,
    readonly nodeErrors: {
      nodeId: string;
      classType: string;
      details: string[];
    }[],
  ) {
    super(message);
    this.name = "ComfyValidationError";
  }
}

type PromptResponse = { prompt_id?: string; node_errors?: Record<string, unknown> };

/** A live subscription to one job's events. */
type Subscription = {
  failure(): Error | undefined;
  bind(promptId: string): void;
  close(): void;
};

type WebSocketLike = {
  addEventListener(type: string, listener: (event: never) => void): void;
  close(): void;
};
export type WebSocketFactory = (url: string) => WebSocketLike;

export type ComfyClientOptions = SdApiOptions & {
  /** Injected so the socket path is testable without a server. */
  webSocketFactory?: WebSocketFactory | undefined;
  clientId?: string | undefined;
};

export class ComfyClient {
  private readonly webSocketFactory: WebSocketFactory | undefined;
  /**
   * The identity both halves of a generation must share.
   *
   * ComfyUI delivers a job's events to the socket whose `clientId` matches the
   * `client_id` that submitted it. Opening the socket under any other name
   * connects fine, receives the global `status` broadcasts, and silently never
   * sees a single `progress` event — a failure that looks exactly like a
   * server with no progress to report, which is why it survived a full live
   * generation before being noticed.
   */
  private readonly clientId: string;

  constructor(
    private readonly http: SdApiHttp,
    private readonly baseUrl: string,
    options: { webSocketFactory?: WebSocketFactory | undefined; clientId?: string | undefined } = {},
  ) {
    this.webSocketFactory = options.webSocketFactory;
    this.clientId = options.clientId ?? `viceroy-${crypto.randomUUID()}`;
  }

  /** Queue a graph, returning its prompt id. */
  async submit(graph: Record<string, unknown>, clientId: string = this.clientId): Promise<string> {
    let payload: PromptResponse;
    try {
      payload = await this.http.postJson<PromptResponse>("/prompt", {
        prompt: graph,
        client_id: clientId,
      });
    } catch (error) {
      throw toValidationError(error);
    }

    if (!payload.prompt_id) throw new Error("ComfyUI accepted the prompt but returned no prompt_id");
    return payload.prompt_id;
  }

  async history(promptId: string): Promise<ComfyHistoryRecord | undefined> {
    // An unknown id returns 200 with `{}` rather than a 404, so "still
    // running" and "never existed" are the same response here (F23). Callers
    // must not read absence as failure.
    const payload = await this.http.json<Record<string, ComfyHistoryRecord>>(
      `/history/${encodeURIComponent(promptId)}`,
    );
    return payload[promptId];
  }

  async queue(): Promise<{ running: string[]; pending: string[] }> {
    const payload = await this.http.json<{
      queue_running?: unknown[][];
      queue_pending?: unknown[][];
    }>("/queue");
    // Each entry is a positional tuple whose second element is the prompt id.
    const ids = (entries: unknown[][] | undefined) =>
      (entries ?? []).map((entry) => String(entry[1])).filter((id) => id !== "undefined");
    return { running: ids(payload.queue_running), pending: ids(payload.queue_pending) };
  }

  /** Download one output file. */
  async fetchOutput(ref: ComfyOutputRef): Promise<Buffer> {
    const query = new URLSearchParams({
      filename: ref.filename,
      subfolder: ref.subfolder ?? "",
      type: ref.type ?? "output",
    });
    const response = await this.http.request(`/view?${query.toString()}`);
    return Buffer.from(await response.arrayBuffer());
  }

  /**
   * Upload an image for a `LoadImage` node, returning the name that node needs.
   *
   * ComfyUI answers with `{name, subfolder, type}` and `LoadImage` wants them
   * rejoined as `subfolder/name` — a bare filename only works when the upload
   * went to the input root.
   */
  async uploadImage(bytes: Buffer, filename: string, subfolder = "viceroy"): Promise<string> {
    return this.uploadFile(bytes, filename, "image/png", subfolder);
  }

  /**
   * Put any file in ComfyUI's input directory.
   *
   * `/upload/image` is the only upload endpoint there is, and despite the name
   * it stores whatever it is given — measured: a WAV uploaded through it loads
   * fine in a `LoadAudio` node. That node's own dropdown lists only files at
   * the input root, which makes a subfolder look unusable, but the listing and
   * the validator disagree: `viceroy/probe.wav` validated and executed. So
   * everything Viceroy uploads can stay in one subfolder rather than being
   * scattered through the root alongside the user's own files.
   */
  async uploadFile(
    bytes: Buffer,
    filename: string,
    contentType = "application/octet-stream",
    subfolder = "viceroy",
  ): Promise<string> {
    const form = new SdFormData();
    form.append("image", new Blob([new Uint8Array(bytes)], { type: contentType }), filename);
    form.append("overwrite", "true");
    if (subfolder) form.append("subfolder", subfolder);

    const payload = await this.http.json<{ name?: string; subfolder?: string }>("/upload/image", {
      method: "POST",
      body: form as never,
    });
    if (!payload.name) throw new Error("ComfyUI upload response missing name");
    return payload.subfolder ? `${payload.subfolder}/${payload.name}` : payload.name;
  }

  /** Whether ComfyUI still holds an uploaded input under this name. */
  async hasInput(name: string): Promise<boolean> {
    const slash = name.lastIndexOf("/");
    const subfolder = slash === -1 ? "" : name.slice(0, slash);
    const filename = slash === -1 ? name : name.slice(slash + 1);
    const query = new URLSearchParams({ filename, subfolder, type: "input" });
    try {
      await this.http.request(`/view?${query.toString()}`);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Stop a job.
   *
   * Two different calls, because ComfyUI has no single per-job cancel. A
   * pending job is deletable by id. A *running* one is not targetable at all:
   * `POST /interrupt` takes no body and kills whatever is executing at that
   * instant (finding F24). So the queue is checked first, and `/interrupt` is
   * only used when this job is the one running — which still races anything
   * else pointed at the same pod.
   */
  async cancel(promptId: string): Promise<void> {
    try {
      const { running } = await this.queue();
      await this.http.request("/queue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ delete: [promptId] }),
      });
      if (running.includes(promptId)) {
        await this.http.request("/interrupt", { method: "POST" });
      }
    } catch {
      // Cancellation is best-effort: the caller is already unwinding, and a
      // failure to cancel must not replace the error that caused the unwind.
    }
  }

  /**
   * Wait for a job, reporting progress from the WebSocket.
   *
   * Falls back to polling `/history` if the socket cannot be opened or drops,
   * which costs progress reporting but still returns the right answer — and is
   * what happens after a worker restart, where the job is already in flight
   * and there was never a socket for it.
   */
  async awaitJob(
    promptId: string,
    options: ComfyAwaitOptions = {},
    subscription?: Subscription | undefined,
  ): Promise<ComfyOutputs> {
    const timeoutMs = options.timeoutMs ?? 30 * 60_000;
    const deadline = Date.now() + timeoutMs;

    // A subscription opened before submitting is preferred: events emitted
    // between `POST /prompt` returning and the socket connecting are gone, and
    // on a warm pod the whole generation can be under two seconds (F26).
    const socket = subscription ?? this.openSocket(promptId, options);
    try {
      while (true) {
        if (options.shouldAbort?.()) {
          await this.cancel(promptId);
          throw new ComfyAbortedError();
        }
        if (Date.now() > deadline) {
          await this.cancel(promptId);
          throw new Error(`ComfyUI generation timed out after ${timeoutMs}ms`);
        }

        // The socket is the progress source; history is the authority on the
        // terminal state. Checking both means a dropped socket degrades to
        // slow-but-correct rather than hanging until the deadline.
        const failure = socket?.failure();
        if (failure) throw failure;

        const record = await this.history(promptId);
        if (record?.status?.completed) return record.outputs ?? {};
        if (record?.status?.status_str === "error") {
          // An interrupt and a genuine failure are indistinguishable here —
          // both land as status_str "error" with no outputs. Only the socket
          // can tell them apart, so prefer whatever it saw.
          throw socket?.failure() ?? new ComfyExecutionError("ComfyUI reported the job as failed");
        }

        await sleep(options.pollIntervalMs ?? 1000);
      }
    } finally {
      // Only close what we opened; a caller-supplied subscription is theirs.
      if (!subscription) socket?.close();
    }
  }

  /**
   * Submit and wait, with the socket already listening.
   *
   * This is the ordering every caller wants: subscribe, then submit, then
   * await. Doing it the other way round loses the early events, and on a warm
   * pod that can be all of them.
   */
  async generate(
    graph: Record<string, unknown>,
    options: ComfyAwaitOptions = {},
  ): Promise<ComfyOutputs> {
    const subscription = this.openSocket(undefined, options);
    try {
      const promptId = await this.submit(graph);
      subscription?.bind(promptId);
      return await this.awaitJob(promptId, options, subscription);
    } finally {
      subscription?.close();
    }
  }

  /**
   * Subscribe to this job's events.
   *
   * Returns undefined when no WebSocket implementation is available, which is
   * what puts `awaitJob` on the polling-only path.
   */
  private openSocket(
    promptId: string | undefined,
    options: ComfyAwaitOptions,
  ): Subscription | undefined {
    const factory =
      this.webSocketFactory ??
      (typeof WebSocket !== "undefined"
        ? (url: string) => new WebSocket(url) as unknown as WebSocketLike
        : undefined);
    if (!factory) return undefined;

    const wsUrl =
      this.baseUrl.replace(/^http/, "ws").replace(/\/$/, "") +
      `/ws?clientId=${encodeURIComponent(this.clientId)}`;

    // Set once `POST /prompt` answers. Until then every event is ours by
    // construction, because this socket is only used for our own submissions.
    let boundPromptId = promptId;
    let failure: Error | undefined;
    let sawSampling = false;
    let socket: WebSocketLike;
    try {
      socket = factory(wsUrl);
    } catch {
      return undefined;
    }

    socket.addEventListener("message", ((event: { data: unknown }) => {
      if (typeof event.data !== "string") return;
      let message: { type?: string; data?: Record<string, unknown> };
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }

      const data = message.data ?? {};
      // Events for other clients' jobs share this socket only if the server
      // broadcasts them; filter by prompt id wherever one is present.
      if (
        boundPromptId !== undefined &&
        typeof data.prompt_id === "string" &&
        data.prompt_id !== boundPromptId
      ) {
        return;
      }

      switch (message.type) {
        case "execution_start":
          options.onProgress?.({ phase: "loading" });
          break;
        case "progress": {
          const value = Number(data.value ?? 0);
          const max = Number(data.max ?? 0);
          if (max > 0) {
            sawSampling = true;
            options.onProgress?.({
              phase: "sampling",
              fraction: Math.min(1, value / max),
              node: typeof data.node === "string" ? data.node : undefined,
            });
          }
          break;
        }
        case "executing":
          if (!sawSampling) {
            options.onProgress?.({
              phase: "loading",
              node: typeof data.node === "string" ? data.node : undefined,
            });
          }
          break;
        case "execution_interrupted":
          failure = new ComfyAbortedError();
          break;
        case "execution_error":
          failure = new ComfyExecutionError(
            String(data.exception_message ?? "ComfyUI execution failed").trim(),
            typeof data.node_id === "string" ? data.node_id : undefined,
            typeof data.node_type === "string" ? data.node_type : undefined,
          );
          break;
      }
    }) as (event: never) => void);

    return {
      failure: () => failure,
      bind: (id: string) => {
        boundPromptId = id;
      },
      close: () => {
        try {
          socket.close();
        } catch {
          // Already closed, or never opened.
        }
      },
    };
  }
}

/**
 * Pick the single output file out of a job's results.
 *
 * `outputNodeId` names which node to read when a graph saves more than one
 * thing; without it, any node that produced a file will do, which is
 * unambiguous for the single-SaveImage graphs that are the norm.
 */
export function selectOutput(
  outputs: ComfyOutputs,
  outputNodeId?: string | null,
): ComfyOutputRef {
  const nodes = outputNodeId
    ? ([[outputNodeId, outputs[outputNodeId]]] as const)
    : (Object.entries(outputs) as readonly (readonly [string, ComfyOutputs[string] | undefined])[]);

  const found: ComfyOutputRef[] = [];
  for (const [, byKey] of nodes) {
    for (const refs of Object.values(byKey ?? {})) {
      for (const ref of refs ?? []) {
        if (ref && typeof ref.filename === "string") found.push(ref);
      }
    }
  }

  if (found.length === 0) {
    throw new Error(
      outputNodeId
        ? `Workflow finished but node ${outputNodeId} produced no output file`
        : `Workflow finished but produced no output file — check it ends in a Save node`,
    );
  }
  return found[0]!;
}

function toValidationError(error: unknown): unknown {
  const body = (error as { body?: unknown }).body;
  if (typeof body !== "string") return error;

  let parsed: {
    error?: { message?: string };
    node_errors?: Record<string, { class_type?: string; errors?: { details?: string }[] }>;
  };
  try {
    parsed = JSON.parse(body);
  } catch {
    return error;
  }
  if (!parsed.node_errors) return error;

  const nodeErrors = Object.entries(parsed.node_errors).map(([nodeId, node]) => ({
    nodeId,
    classType: node.class_type ?? "unknown",
    details: (node.errors ?? []).map((e) => e.details ?? "").filter(Boolean),
  }));

  const summary = nodeErrors
    .map((n) => `node ${n.nodeId} (${n.classType}): ${n.details.join("; ")}`)
    .join(" — ");
  return new ComfyValidationError(
    `${parsed.error?.message ?? "ComfyUI rejected the workflow"}: ${summary}`,
    nodeErrors,
  );
}

export function createComfyClient(options: ComfyClientOptions): ComfyClient {
  const { webSocketFactory, ...httpOptions } = options;
  return new ComfyClient(
    new SdApiHttp({ ...httpOptions, service: httpOptions.service ?? "ComfyUI" }),
    options.baseUrl,
    { webSocketFactory, clientId: options.clientId },
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
