import type { ComfyClient } from "../comfy/client";
import { selectOutput } from "../comfy/client";
import { applyTemplate } from "../comfy/template";
import type { workflows } from "../db/schema";
import { bindVariables, fillReferenceSlots, referenceSlots } from "./comfy-bind";
import type { GenerateOptions, ImageBackend, ImageRequest } from "./types";

type Workflow = typeof workflows.$inferSelect;

export type ComfyImageOptions = {
  client: ComfyClient;
  provider: { name: string; defaultParams: Record<string, unknown> };
  /** Resolved on demand so a text-only stage never needs a ref workflow. */
  workflowFor: (role: "text_to_image" | "text_to_image_ref") => Workflow;
};

/**
 * The ComfyUI image backend.
 *
 * Two workflows rather than one: a scene with characters in it has to be
 * generated against their reference portraits and a scene with nobody in it
 * must not be, and those are different graphs. Which one runs is decided by
 * whether the stage supplied references.
 */
export function comfyImageBackend(options: ComfyImageOptions): ImageBackend {
  const { client, provider, workflowFor } = options;

  return {
    label: provider.name,

    referenceCapacity() {
      // A missing ref workflow is a configuration gap, not a capability
      // ceiling — report 0 and let `generate` produce the actionable error.
      try {
        return referenceSlots(workflowFor("text_to_image_ref").variables);
      } catch {
        return 0;
      }
    },

    async generate(request: ImageRequest, options: GenerateOptions = {}): Promise<Buffer> {
      const usingRefs = request.references.length > 0;
      // Throws naming the provider and the missing role when a scene has
      // characters but the provider has no reference workflow. Degrading to a
      // text-only generation instead would quietly give every scene a
      // different face — the thing ADR 0001 exists to prevent — and it would
      // look finished.
      const workflow = workflowFor(usingRefs ? "text_to_image_ref" : "text_to_image");

      // A graph's reference slots are fixed by its wiring; a scene's cast is
      // not. Reconcile the two before binding, and say so in the job log when
      // they disagree — both directions lose something, and neither should be
      // discovered by squinting at the finished frame.
      const { filled, notes } = fillReferenceSlots(
        referenceSlots(workflow.variables),
        request.references,
      );
      for (const note of notes) options.log?.(note, "warn");

      const values = bindVariables(
        workflow.variables,
        {
          prompt: request.prompt,
          negativePrompt: request.negativePrompt,
          width: request.width,
          height: request.height,
          // ComfyUI caches node outputs, so resubmitting an identical graph
          // returns the previous file without sampling again. A redo with no
          // seed would then hand back the byte-identical image it was asked to
          // replace, which reads as a broken button rather than a cache hit.
          seed: request.seed ?? Math.floor(Math.random() * 2 ** 31),
          references: filled,
        },
        provider.defaultParams,
      );

      const graph = applyTemplate(workflow.graph, values);

      let announcedLoading = false;
      const outputs = await client.generate(graph, {
        ...(options.shouldAbort ? { shouldAbort: options.shouldAbort } : {}),
        onProgress: (progress) => {
          if (progress.phase === "sampling") {
            options.onProgress?.(progress.fraction);
            return;
          }
          // A cold pod spends ~33 s loading weights before the first sampling
          // step (F26), with no progress events at all in that window. Saying
          // so beats a bar sitting at zero, which reads as a hung job.
          if (!announcedLoading) {
            announcedLoading = true;
            options.log?.("ComfyUI is loading models", "debug");
          }
          options.onProgress?.(0);
        },
      });

      return client.fetchOutput(selectOutput(outputs, workflow.outputNodeId));
    },

    async uploadReference(bytes: Buffer, filename: string): Promise<string> {
      return client.uploadImage(bytes, filename);
    },

    async hasReference(name: string): Promise<boolean> {
      return client.hasInput(name);
    },
  };
}
