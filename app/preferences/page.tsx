import { getDb } from "@/lib/db/client";
import { listPreferences } from "@/lib/preferences";
import { listProviders } from "@/lib/providers";
import { resolveConfig } from "@/lib/config";
import {
  listCaptionStyles,
  listDirectionStyles,
  listImageStyles,
  listNarrativeStyles,
  listProductionDesignStyles,
  listVoiceStyles,
} from "@/lib/styles";
import { PreferencesView } from "./preferences-view";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
  const db = getDb();
  const config = resolveConfig();

  return (
    <PreferencesView
      preferences={listPreferences(db)}
      narrativeStyles={listNarrativeStyles(db)}
      voiceStyles={listVoiceStyles(db)}
      imageStyles={listImageStyles(db)}
      captionStyles={listCaptionStyles(db)}
      // The Development chain's own two style kinds. Their absence here was
      // the whole reason a movie project's defaults could not be set: the
      // new-project form already read `defaultDirectionStyle` and
      // `defaultProductionDesignStyle`, and no screen could write them.
      directionStyles={listDirectionStyles(db)}
      productionDesignStyles={listProductionDesignStyles(db)}
      llmProviders={listProviders(db)
        .filter((provider) => provider.kind === "llm")
        .map((provider) => ({ id: provider.id, name: provider.name, model: provider.model }))}
      basePixels={config.video.width * config.video.height}
    />
  );
}
