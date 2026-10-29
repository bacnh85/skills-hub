// Lazy single clear error for missing optional deps (extract-zip for gitless GitLab/zip ingest)
export async function extract(_buf: Buffer, _dir: string): Promise<void> {
  throw new Error("zip ingest is not enabled: use a .tgz URL, a git URL, or install extract-zip and wire it in src/ingest/zipstub.ts");
}
