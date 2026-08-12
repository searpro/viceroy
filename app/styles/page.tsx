import { getDb } from "@/lib/db/client";
import { listImageStyles, listNarrativeStyles, listVoiceStyles } from "@/lib/styles";
import { StylesView } from "./styles-view";

export const dynamic = "force-dynamic";

export default async function StylesPage() {
  const db = getDb();

  return (
    <StylesView
      narrativeStyles={listNarrativeStyles(db)}
      voiceStyles={listVoiceStyles(db)}
      imageStyles={listImageStyles(db)}
    />
  );
}
