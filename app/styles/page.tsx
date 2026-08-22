import { getDb } from "@/lib/db/client";
import {
  listCaptionStyles,
  listDirectionStyles,
  listImageStyles,
  listNarrativeStyles,
  listProductionDesignStyles,
  listVoiceStyles,
} from "@/lib/styles";
import { StylesView } from "./styles-view";

export const dynamic = "force-dynamic";

export default async function StylesPage() {
  const db = getDb();

  return (
    <StylesView
      narrativeStyles={listNarrativeStyles(db)}
      voiceStyles={listVoiceStyles(db)}
      imageStyles={listImageStyles(db)}
      captionStyles={listCaptionStyles(db)}
      directionStyles={listDirectionStyles(db)}
      productionDesignStyles={listProductionDesignStyles(db)}
    />
  );
}
