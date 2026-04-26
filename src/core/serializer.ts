import { PatcherJSON } from "./types.js";

export function serialize(patch: PatcherJSON): string {
  return JSON.stringify(patch, null, 2);
}
