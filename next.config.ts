import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // better-sqlite3 is a native module; bundling it breaks the .node binding
  // resolution in the server runtime. pdfkit (M7 PR4) has the same problem
  // for a different reason: it loads its standard-14 fonts' .afm metric
  // files off disk at runtime via a path relative to its own package
  // directory, and bundling rewrites that path out from under it — verified
  // directly against the dev server, which 500'd with an ENOENT for
  // Helvetica.afm until this was added.
  serverExternalPackages: ["better-sqlite3", "pdfkit"],
};

export default nextConfig;
