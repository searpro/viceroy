import { getDb } from "@/lib/db/client";
import { listPreferences } from "@/lib/preferences";
import { listCaptionStyles, listImageStyles, listNarrativeStyles, listVoiceStyles } from "@/lib/styles";
import { PreferencesView } from "./preferences-view";

export const dynamic = "force-dynamic";

export default async function PreferencesPage() {
  const db = getDb();

  return (
    <PreferencesView
      preferences={listPreferences(db)}
      narrativeStyles={listNarrativeStyles(db)}
      voiceStyles={listVoiceStyles(db)}
      imageStyles={listImageStyles(db)}
      captionStyles={listCaptionStyles(db)}
    />
  );
}
