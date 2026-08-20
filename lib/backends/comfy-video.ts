import type { ComfyClient } from "../comfy/client";
import { selectOutput } from "../comfy/client";
import { applyTemplate } from "../comfy/template";
import type { workflows } from "../db/schema";
import { bindVariables } from "./comfy-bind";
import type { GenerateOptions, VideoBackend, VideoRequest } from "./types";

type Workflow = typeof workflows.$inferSelect;

export type ComfyVideoOptions = {
  client: ComfyClient;
  provider: { name: string; defaultParams: Record<string, unknown> };
  workflowFor: (role: "image_to_video" | "speech_to_video") => Workflow;
};

/**
 * The ComfyUI video backend.
 *
 * Which workflow runs is decided by whether narration was supplied: driving
 * audio means speech-to-video, and a still frame alone means image-to-video.
 * The pod carries a Wan model for each.
 */
export function comfyVideoBackend(options: ComfyVideoOptions): VideoBackend {
  const { client, provider, workflowFor } = options;

  return {
    label: provider.name,

    async generate(request: VideoRequest, options: GenerateOptions = {}): Promise<Buffer> {
      const workflow = workflowFor(request.audio ? "speech_to_video" : "image_to_video");

      // Both the driving frame and the narration are local bytes, and ComfyUI
      // reads them through LoadImage/LoadAudio nodes by name — so they have to
      // exist on the host before the graph that references them is submitted.
      const [image, audio] = await Promise.all([
        request.image
          ? client.uploadImage(request.image.bytes, request.image.filename)
          : Promise.resolve(undefined),
        request.audio
          ? client.uploadFile(request.audio.bytes, request.audio.filename, "audio/wav")
          : Promise.resolve(undefined),
      ]);

      const values = bindVariables(
        workflow.variables,
        {
          prompt: request.prompt,
          negativePrompt: request.negativePrompt,
          seed: Math.floor(Math.random() * 2 ** 31),
          // The still frame occupies the same slot a character portrait would
          // in an image workflow: a LoadImage hole fed by an uploaded file.
          ...(image ? { references: [image] } : {}),
          ...(audio ? { audio } : {}),
        },
        { ...provider.defaultParams, ...request.params },
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
          if (!announcedLoading) {
            announcedLoading = true;
            // The Wan video models are 14 B against the image model's 4 B, so
            // the cold load measured at ~33 s in F26 is the floor here, not
            // the expectation.
            options.log?.("ComfyUI is loading video models", "debug");
          }
          options.onProgress?.(0);
        },
      });

      return client.fetchOutput(selectOutput(outputs, workflow.outputNodeId));
    },
  };
}
