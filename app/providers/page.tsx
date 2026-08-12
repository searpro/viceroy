import { getDb } from "@/lib/db/client";
import { listProviders } from "@/lib/providers";
import { ProvidersView } from "./providers-view";

export const dynamic = "force-dynamic";

export default async function ProvidersPage() {
  return <ProvidersView providers={listProviders(getDb())} />;
}
