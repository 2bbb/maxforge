#!/usr/bin/env node

import {
  parse,
  compile,
  serialize,
  decompile,
  loadObjectCatalog,
  compileDslToPatchGraph,
  createEmptyPatchGraph,
  diffPatchGraphs,
  patcherToPatchGraph,
  PatchGraph,
} from "../index.js";
import { toClipboardText, fromClipboardText } from "../core/clipboard.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, extname, resolve } from "path";

const args = process.argv.slice(2);
const command = args[0];

async function main() {
  if (!command || command === "help" || command === "--help") {
    printHelp();
    return;
  }

  if (command === "compile") {
    await compileCommand(args.slice(1));
    return;
  }

  if (command === "decompile") {
    decompileCommand(args.slice(1));
    return;
  }

  if (command === "validate") {
    await validateCommand(args.slice(1));
    return;
  }

  if (command === "plan") {
    await planCommand(args.slice(1));
    return;
  }

  if (command === "doctor") {
    await doctorCommand(args.slice(1));
    return;
  }

  if (command === "from-clipboard") {
    fromClipboardCommand(args.slice(1));
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

async function compileCommand(cmdArgs: string[]) {
  let inputFile = "";
  let outputFile = "";
  let allowUnknown = false;
  let clipboard = false;
  let configFile = "";

  for (let i = 0; i < cmdArgs.length; i++) {
    const argument = cmdArgs[i];
    if (argument === "-o") {
      outputFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--allow-unknown") {
      allowUnknown = true;
    } else if (argument === "--config") {
      configFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--clipboard") {
      clipboard = true;
    } else if (!inputFile && !argument.startsWith("-")) {
      inputFile = argument;
    } else {
      throw new Error(`Unknown compile argument: ${argument}`);
    }
  }

  if (!inputFile) {
    console.error("Error: input file required");
    process.exit(1);
  }

  const source = readFileSync(resolve(inputFile), "utf-8");
  const { ast, errors: parseErrors } = parse(source);

  if (parseErrors.length > 0) {
    for (const e of parseErrors) {
      console.error(`Line ${e.line}: [${e.code}] ${e.message}`);
    }
    process.exit(1);
  }

  const catalog = await loadObjectCatalog({
    configPath: configFile || undefined,
    inputPath: inputFile,
  });
  const result = compile(ast, catalog.database, allowUnknown);

  for (const w of result.warnings) {
    console.warn(`Warning [${w.code}]: ${w.message}`);
  }

  if (!result.success) {
    for (const e of result.errors) {
      console.error(`Line ${e.line}: [${e.code}] ${e.message}`);
    }
    process.exit(1);
  }

  const json = serialize(result.output!);

  if (clipboard) {
    console.log(toClipboardText(json));
  } else if (outputFile) {
    const outPath = resolve(outputFile);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, json, "utf-8");
    console.log(`Written: ${outPath}`);
  } else {
    console.log(json);
  }
}

async function validateCommand(cmdArgs: string[]) {
  let inputFile = "";
  let allowUnknown = false;
  let configFile = "";

  for (let i = 0; i < cmdArgs.length; i++) {
    const argument = cmdArgs[i];
    if (argument === "--allow-unknown") {
      allowUnknown = true;
    } else if (argument === "--config") {
      configFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (!inputFile && !argument.startsWith("-")) {
      inputFile = argument;
    } else {
      throw new Error(`Unknown validate argument: ${argument}`);
    }
  }

  if (!inputFile) {
    console.error("Error: input file required");
    process.exit(1);
  }

  const source = readFileSync(resolve(inputFile), "utf-8");
  const { ast, errors: parseErrors } = parse(source);

  if (parseErrors.length > 0) {
    for (const e of parseErrors) {
      console.error(`Line ${e.line}: [${e.code}] ${e.message}`);
    }
    process.exit(1);
  }

  const catalog = await loadObjectCatalog({
    configPath: configFile || undefined,
    inputPath: inputFile,
  });
  const result = compile(ast, catalog.database, allowUnknown);

  for (const w of result.warnings) {
    console.warn(`Warning [${w.code}]: ${w.message}`);
  }

  if (!result.success) {
    for (const e of result.errors) {
      console.error(`Line ${e.line}: [${e.code}] ${e.message}`);
    }
    process.exit(1);
  }

  console.log("Validation passed.");
}

async function planCommand(cmdArgs: string[]) {
  let inputFile = "";
  let currentFile = "";
  let outputFile = "";
  let scope = "default";
  let allowUnknown = false;
  let compact = false;
  let configFile = "";

  for (let i = 0; i < cmdArgs.length; i++) {
    const argument = cmdArgs[i];
    if (argument === "-o") {
      outputFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--scope") {
      scope = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--current") {
      currentFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--allow-unknown") {
      allowUnknown = true;
    } else if (argument === "--config") {
      configFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--compact") {
      compact = true;
    } else if (!inputFile && !argument.startsWith("-")) {
      inputFile = argument;
    } else {
      throw new Error(`Unknown plan argument: ${argument}`);
    }
  }

  if (!inputFile) {
    console.error("Error: desired .maxdsl input file required");
    process.exit(1);
  }

  const catalog = await loadObjectCatalog({
    configPath: configFile || undefined,
    inputPath: inputFile,
  });
  const db = catalog.database;
  const source = readFileSync(resolve(inputFile), "utf-8");
  const desiredResult = compileDslToPatchGraph(source, db, scope, allowUnknown);
  reportDiagnostics(desiredResult.errors, desiredResult.warnings);
  if (!desiredResult.success || !desiredResult.graph) process.exit(1);

  let current: PatchGraph;
  if (!currentFile) {
    current = createEmptyPatchGraph(scope);
  } else if (extname(currentFile).toLowerCase() === ".maxdsl") {
    const currentSource = readFileSync(resolve(currentFile), "utf-8");
    const currentResult = compileDslToPatchGraph(
      currentSource,
      db,
      scope,
      allowUnknown
    );
    reportDiagnostics(currentResult.errors, currentResult.warnings);
    if (!currentResult.success || !currentResult.graph) process.exit(1);
    current = currentResult.graph;
  } else {
    const snapshot = JSON.parse(readFileSync(resolve(currentFile), "utf-8"));
    current = patcherToPatchGraph(snapshot, scope);
  }

  const plan = diffPatchGraphs(current, desiredResult.graph);
  const json = compact ? JSON.stringify(plan) : JSON.stringify(plan, null, 2);

  if (outputFile) {
    const outputPath = resolve(outputFile);
    mkdirSync(dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, `${json}\n`, "utf-8");
    console.log(`Written: ${outputPath}`);
  } else {
    console.log(json);
  }
}

async function doctorCommand(cmdArgs: string[]) {
  let configFile = "";
  let inputFile = "";

  for (let i = 0; i < cmdArgs.length; i++) {
    const argument = cmdArgs[i];
    if (argument === "--config") {
      configFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--input") {
      inputFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else {
      throw new Error(`Unknown doctor option: ${argument}`);
    }
  }

  const catalog = await loadObjectCatalog({
    configPath: configFile || undefined,
    inputPath: inputFile || undefined,
  });
  const abstractionCount = catalog.customObjects.filter(
    ({ kind }) => kind === "abstraction"
  ).length;
  const externalCount = catalog.customObjects.length - abstractionCount;

  console.log("Object catalog validation passed.");
  console.log(`Config: ${catalog.configPath ?? "built-in only"}`);
  console.log(`Digest: ${catalog.digest}`);
  console.log(`Effective objects: ${Object.keys(catalog.database).length}`);
  console.log(`Custom externals: ${externalCount}`);
  console.log(`Abstractions: ${abstractionCount}`);
  for (const source of catalog.sources) console.log(`Source: ${source}`);
}

function requiredOptionValue(cmdArgs: string[], index: number): string {
  const option = cmdArgs[index];
  const value = cmdArgs[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function reportDiagnostics(
  errors: Array<{ line?: number; code: string; message: string }>,
  warnings: Array<{ line?: number; code: string; message: string }>
) {
  for (const warning of warnings) {
    const location = warning.line ? `Line ${warning.line}: ` : "";
    console.warn(`${location}Warning [${warning.code}]: ${warning.message}`);
  }
  for (const error of errors) {
    const location = error.line ? `Line ${error.line}: ` : "";
    console.error(`${location}[${error.code}] ${error.message}`);
  }
}

function decompileCommand(cmdArgs: string[]) {
  let inputFile = "";
  let outputFile = "";

  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === "-o" && cmdArgs[i + 1]) {
      outputFile = cmdArgs[i + 1];
      i++;
    } else if (!inputFile) {
      inputFile = cmdArgs[i];
    }
  }

  if (!inputFile) {
    console.error("Error: input file required");
    process.exit(1);
  }

  const raw = readFileSync(resolve(inputFile), "utf-8");
  const patch = JSON.parse(raw);
  const dsl = decompile(patch);

  if (outputFile) {
    const outPath = resolve(outputFile);
    mkdirSync(dirname(outPath), { recursive: true });
    writeFileSync(outPath, dsl, "utf-8");
    console.log(`Written: ${outPath}`);
  } else {
    console.log(dsl);
  }
}

function fromClipboardCommand(cmdArgs: string[]) {
  let outputFile = "";

  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === "-o" && cmdArgs[i + 1]) {
      outputFile = cmdArgs[i + 1];
      i++;
    }
  }

  let input = "";
  process.stdin.setEncoding("utf-8");
  process.stdin.on("data", (chunk: string) => {
    input += chunk;
  });
  process.stdin.on("end", () => {
    const json = fromClipboardText(input);
    const patch = JSON.parse(json);
    const dsl = decompile(patch);

    if (outputFile) {
      const outPath = resolve(outputFile);
      mkdirSync(dirname(outPath), { recursive: true });
      writeFileSync(outPath, dsl, "utf-8");
      console.log(`Written: ${outPath}`);
    } else {
      console.log(dsl);
    }
  });
}

function printHelp() {
  console.log(`maxforge - unofficial Max/MSP patch DSL compiler

Usage:
  maxforge compile <input.maxdsl> [-o output.maxpat] [--config path] [--allow-unknown] [--clipboard]
  maxforge decompile <input.maxpat> [-o output.maxdsl]
  maxforge from-clipboard [-o output.maxdsl]
  maxforge validate <input.maxdsl> [--config path] [--allow-unknown]
  maxforge plan <desired.maxdsl> [--config path] [--scope name] [--current current.maxdsl|maxpat] [-o plan.json] [--compact]
  maxforge doctor [--config path] [--input input.maxdsl]

Commands:
  compile         Compile .maxdsl to .maxpat JSON
  decompile       Convert .maxpat JSON to .maxdsl text
  from-clipboard  Read compressed patcher from stdin, output .maxdsl
  validate        Validate .maxdsl without writing output
  plan            Build a managed PatchPlan for maxforge.sync
  doctor          Validate project catalog files and abstraction metadata

Options:
  -o <file>          Output file path
  --allow-unknown    Allow objects not in the database
  --config <file>    Project object catalog config (otherwise discovered upward from input)
  --clipboard        Output compressed text pasteable into Max
  --scope <name>     Managed scope for plan generation (default: default)
  --current <file>   Current managed .maxdsl or scoped .maxpat snapshot
  --compact          Emit a single-line JSON plan
  --input <file>     Input path used for doctor config discovery
`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
