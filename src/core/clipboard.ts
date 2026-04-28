import zlib from "zlib";

const BEGIN_MARKER = "----------begin_max5_patcher-----------";
const END_MARKER = "-----------end_max5_patcher-----------";

export function toClipboardText(json: string): string {
  const originalLength = json.length;
  const compressed = zlib.gzipSync(Buffer.from(json, "utf-8"));
  const b64 = compressed.toString("base64");
  return `${BEGIN_MARKER}\n${originalLength}.${b64}\n${END_MARKER}`;
}

export function fromClipboardText(text: string): string {
  const beginIdx = text.indexOf(BEGIN_MARKER);
  const endIdx = text.indexOf(END_MARKER);
  if (beginIdx === -1 || endIdx === -1) {
    throw new Error("Not a valid Max compressed patcher (missing markers)");
  }

  const body = text.slice(beginIdx + BEGIN_MARKER.length, endIdx).trim();
  const dotIdx = body.indexOf(".");
  if (dotIdx === -1) {
    throw new Error("Invalid compressed patcher format (no prefix separator)");
  }

  const b64 = body.slice(dotIdx + 1);
  const compressed = Buffer.from(b64, "base64");
  return zlib.gunzipSync(compressed).toString("utf-8");
}
