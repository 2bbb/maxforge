// Core types for maxpat JSON structure

export interface PatcherJSON {
  patcher: {
    fileversion: number;
    appversion: AppVersion;
    classnamespace: string;
    rect: [number, number, number, number];
    bglocked: number;
    openrect: [number, number, number, number];
    openinpresentation: number;
    default_fontsize: number;
    default_fontface: number;
    default_fontname: string;
    gridonopen: number;
    gridsize: [number, number];
    gridsnaponopen: number;
    objectsnaponopen: number;
    statusbarvisible: number;
    toolbarvisible: number;
    lefttoolbarpinned: number;
    toptoolbarpinned: number;
    righttoolbarpinned: number;
    bottomtoolbarpinned: number;
    toolbars_unpinned_last_save: number;
    tallnewobj: number;
    boxanimatetime: number;
    enablehscroll: number;
    enablevscroll: number;
    devicewidth: number;
    description: string;
    digest: string;
    tags: string;
    style: string;
    subpatcher_template: string;
    assistshowspatchername: number;
    boxes: BoxWrapper[];
    lines: LineWrapper[];
  };
}

export interface AppVersion {
  major: number;
  minor: number;
  revision: number;
  architecture?: string;
  modernui?: number;
  /** Legacy fields accepted when decompiling older patches. */
  processor?: string;
  platform?: string;
}

export interface BoxWrapper {
  box: BoxJSON;
}

export interface BoxJSON {
  id: string;
  maxclass: string;
  numinlets: number;
  numoutlets: number;
  outlettype?: string[];
  patching_rect: [number, number, number, number];
  text?: string;
  patcher?: PatcherJSON["patcher"];
  comment?: string;
  parameter_enable?: number;
  presentation?: number;
  presentation_rect?: [number, number, number, number];
  hidden?: number;
  varname?: string;
  fontsize?: number;
  fontname?: string;
  fontface?: number;
  color?: [number, number, number, number];
  bgcolor?: [number, number, number, number];
  textcolor?: [number, number, number, number];
  [key: string]: unknown;
}

export interface LineWrapper {
  patchline: LineJSON;
}

export interface LineJSON {
  source: [string, number];
  destination: [string, number];
  midpoints?: number[];
  color?: [number, number, number, number];
  hidden?: number;
  disabled?: number;
}

// Object database entry
export interface ObjectDef {
  maxclass: string;
  numinlets: number;
  numoutlets: number;
  outlettype: string[];
  defaultSize: [number, number];
  category: string;
  argDependent?: boolean;
  argRule?: string;
  /** Port shape depends on attributes, an embedded patcher, or runtime state. */
  dynamicPorts?: boolean;
}

export type ObjectDatabase = Record<string, ObjectDef>;

// DSL AST types
export interface ASTNode {
  type: "program";
  patchDecl?: PatchDecl;
  statements: Statement[];
}

export interface PatchDecl {
  name: string;
  description?: string;
  size?: [number, number];
}

export type Statement =
  | ObjectDefStmt
  | ConnectionStmt
  | SubpatcherDefStmt;

export interface ObjectDefStmt {
  type: "object_def";
  name: string;
  objectText: string;
  line: number;
  pos?: [number, number];
  attrs?: Record<string, AttrValue[]>;
}

export type AttrValue = string | number;

export interface ConnectionStmt {
  type: "connection";
  refs: PortRef[];
  line: number;
}

export interface SubpatcherDefStmt {
  type: "subpatcher_def";
  name: string;
  subpatcherName: string;
  body: Statement[];
  line: number;
  pos?: [number, number];
  attrs?: Record<string, AttrValue[]>;
}

export interface PortRef {
  name: string;
  outlet?: number;  // undefined = 0
  inlet?: number;   // undefined = 0
}

// Compile error types
export enum ErrorCode {
  DUPLICATE_NAME = "E001",
  UNDEFINED_REF = "E002",
  UNKNOWN_OBJECT = "E003",
  OUTLET_OUT_OF_RANGE = "E004",
  INLET_OUT_OF_RANGE = "E005",
  INLET_OUTSIDE_SUBPATCHER = "E006",
  SYNTAX_ERROR = "E007",
  EMPTY_SUBPATCHER = "E008",
  RESERVED_ATTRIBUTE = "E009",
}

export enum WarningCode {
  DUPLICATE_CONNECTION = "W001",
  UNCONNECTED_OBJECT = "W002",
}

export interface CompileError {
  code: ErrorCode;
  message: string;
  line?: number;
}

export interface CompileWarning {
  code: WarningCode;
  message: string;
  line?: number;
}

export interface CompileResult {
  success: boolean;
  errors: CompileError[];
  warnings: CompileWarning[];
  output?: PatcherJSON;
}
