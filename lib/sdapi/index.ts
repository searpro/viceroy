import { SdApiHttp, type SdApiOptions } from "./client";
import { LlmClient } from "./llm";
import { ImageClient } from "./image";
import { AudioClient } from "./audio";

export * from "./client";
export * from "./llm";
export * from "./image";
export * from "./audio";

export type SdApi = {
  http: SdApiHttp;
  llm: LlmClient;
  image: ImageClient;
  audio: AudioClient;
  health(): Promise<boolean>;
};

export function createSdApi(options: SdApiOptions): SdApi {
  const http = new SdApiHttp(options);
  return {
    http,
    llm: new LlmClient(http),
    image: new ImageClient(http),
    audio: new AudioClient(http),
    async health() {
      try {
        await http.request("/health");
        return true;
      } catch {
        return false;
      }
    },
  };
}
