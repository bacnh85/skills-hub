// minimal ustar tar writer (deterministic, no deps) — enough for SKILL.md bundles
function header(path: string, size: number): Buffer {
  const h = Buffer.alloc(512, 0);
  if (path.length > 100) {
    // split into prefix/name per ustar
    const idx = path.lastIndexOf("/", path.length - 100 > 0 ? path.length - 100 : 0);
    h.write(path.slice(0, idx), 345); // prefix
    h.write(path.slice(idx + 1), 0); // name
  } else {
    h.write(path, 0);
  }
  h.write("0000644\0", 100); // mode
  h.write("0000000\0", 108); // uid
  h.write("0000000\0", 116); // gid
  h.write(size.toString(8).padStart(11, "0") + "\0", 124); // size
  const mtime = Math.floor(Date.now() / 1000).toString(8).padStart(11, "0") + "\0";
  h.write(mtime, 136);
  h.write("        ", 148); // chksum placeholder (spaces)
  h.write("0", 156); // typeflag: regular file
  h.write("ustar\0", 257);
  h.write("00", 263);
  let sum = 0;
  for (const b of h) sum += b;
  h.write(sum.toString(8).padStart(6, "0") + "\0 ", 148);
  return h;
}

export function tarBuffer(files: { path: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  for (const f of files) {
    parts.push(header(f.path, f.data.length));
    parts.push(f.data);
    const pad = (512 - (f.data.length % 512)) % 512;
    if (pad) parts.push(Buffer.alloc(pad, 0));
  }
  parts.push(Buffer.alloc(1024, 0)); // end-of-archive: two zero blocks
  return Buffer.concat(parts);
}
