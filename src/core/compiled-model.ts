import { PatcherJSON } from "./types.js";

export interface CompiledBox {
  id: string;
  name: string;
  maxclass: string;
  numinlets: number;
  numoutlets: number;
  outlettype: string[];
  text?: string;
  comment?: string;
  defaultSize: [number, number];
  patcher?: PatcherJSON["patcher"];
  line: number;
  x: number;
  y: number;
  pinnedPos: boolean;
  attrs?: Record<string, (string | number)[]>;
}

export interface CompiledLine {
  sourceId: string;
  sourceOutlet: number;
  destId: string;
  destInlet: number;
}
