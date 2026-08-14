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
  collectCatalogDependencies,
  searchObjectCatalog,
} from "../index.js";
import { toClipboardText, fromClipboardText } from "../core/clipboard.js";
import { cpSync, existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "fs";
import { basename, dirname, extname, join, resolve } from "path";
import { brokerDescriptorFromEnvironment } from "../mcp/broker-protocol.js";
import { requestBroker, spawnBroker } from "../mcp/broker-client.js";

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

  if (command === "bundle") {
    await bundleCommand(args.slice(1));
    return;
  }

  if (command === "catalog") {
    await catalogCommand(args.slice(1));
    return;
  }

  if (command === "broker") {
    await brokerCommand(args.slice(1));
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

  if (clipboard && outputFile) {
    throw new Error("compile accepts either -o or --clipboard, not both");
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

async function bundleCommand(cmdArgs: string[]) {
  let inputFile = "";
  let outputDirectory = "";
  let configFile = "";
  let packageName = "";

  for (let i = 0; i < cmdArgs.length; i++) {
    const argument = cmdArgs[i];
    if (argument === "-o") {
      outputDirectory = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--config") {
      configFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--name") {
      packageName = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (!inputFile && !argument.startsWith("-")) {
      inputFile = argument;
    } else {
      throw new Error(`Unknown bundle argument: ${argument}`);
    }
  }
  if (!inputFile || !outputDirectory) {
    throw new Error("bundle requires <input.maxdsl> and -o <package-directory>");
  }

  const inputPath = resolve(inputFile);
  const outputPath = resolve(outputDirectory);
  if (existsSync(outputPath) && readdirSync(outputPath).length > 0) {
    throw new Error(`Bundle output directory is not empty: ${outputPath}`);
  }
  const source = readFileSync(inputPath, "utf8");
  const { ast, errors } = parse(source);
  if (errors.length > 0) {
    reportDiagnostics(errors, []);
    process.exit(1);
  }
  const catalog = await loadObjectCatalog({
    configPath: configFile || undefined,
    inputPath,
  });
  const result = compile(ast, catalog.database);
  reportDiagnostics(result.errors, result.warnings);
  if (!result.success || !result.output) process.exit(1);

  const dependencies = await collectCatalogDependencies(result.output, catalog);
  const title = packageName || basename(inputPath, extname(inputPath));
  if (!/^[A-Za-z0-9._-]+$/.test(title)) {
    throw new Error("Bundle name may contain only letters, digits, dot, underscore, and hyphen");
  }
  const mainRelative = `patchers/${title}.maxpat`;
  const copies = new Map<string, string>();
  copies.set(mainRelative, inputPath);
  for (const dependency of dependencies) {
    for (const sourcePath of dependency.paths) {
      const relative = `${dependency.destination}/${basename(sourcePath)}`;
      const previous = copies.get(relative);
      if (previous && previous !== sourcePath) {
        throw new Error(
          `Bundle path collision for ${relative}: ${previous} and ${sourcePath}`
        );
      }
      copies.set(relative, sourcePath);
    }
  }

  const patchersDirectory = join(outputPath, "patchers");
  mkdirSync(patchersDirectory, { recursive: true });
  writeFileSync(join(outputPath, mainRelative), serialize(result.output), "utf8");

  const filelist: Record<string, Record<string, never>> = { [mainRelative]: {} };
  for (const [relative, sourcePath] of copies) {
    if (relative === mainRelative) continue;
    const destination = join(outputPath, relative);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(sourcePath, destination, {
      recursive: true,
      errorOnExist: true,
      force: false,
    });
    filelist[relative] = {};
  }

  const packageJson = JSON.parse(readFileSync(
    new URL("../../package.json", import.meta.url),
    "utf8"
  )) as { version?: string; author?: string };
  writeFileSync(join(outputPath, "package-info.json"), `${JSON.stringify({
    title,
    description: `Portable maxforge bundle for ${title}`,
    version: packageJson.version ?? "0.0.0",
    author: packageJson.author ?? "",
    website: "https://github.com/2bbb/maxforge",
    extends: "",
    extensible: 0,
    homepatcher: mainRelative,
    max_version_min: "8.0",
    os: {
      macintosh: { externals: ["externals/"] },
      windows: { externals: ["externals/"] },
    },
    filelist,
  }, null, 2)}\n`, "utf8");
  console.log(`Written bundle: ${outputPath}`);
  console.log(`Dependencies: ${dependencies.length}`);
}

async function catalogCommand(cmdArgs: string[]) {
  let query = "";
  let configFile = "";
  let inputFile = "";
  let includeAll = false;
  let json = false;
  let limit = 50;

  for (let i = 0; i < cmdArgs.length; i++) {
    const argument = cmdArgs[i];
    if (argument === "--config") {
      configFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--input") {
      inputFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (argument === "--all") {
      includeAll = true;
    } else if (argument === "--json") {
      json = true;
    } else if (argument === "--limit") {
      const rawLimit = requiredOptionValue(cmdArgs, i);
      i++;
      if (!/^\d+$/.test(rawLimit) || Number(rawLimit) < 1 || Number(rawLimit) > 1000) {
        throw new Error("--limit must be an integer from 1 to 1000");
      }
      limit = Number(rawLimit);
    } else if (!query && !argument.startsWith("-")) {
      query = argument;
    } else {
      throw new Error(`Unknown catalog argument: ${argument}`);
    }
  }

  const catalog = await loadObjectCatalog({
    configPath: configFile || undefined,
    inputPath: inputFile || undefined,
  });
  const includeBuiltins = includeAll || query.length > 0;
  const matches = searchObjectCatalog(catalog, query, includeBuiltins);
  const objects = matches.slice(0, limit);
  if (json) {
    console.log(JSON.stringify({
      digest: catalog.digest,
      configPath: catalog.configPath ?? null,
      totalMatches: matches.length,
      truncated: objects.length < matches.length,
      objects,
    }, null, 2));
    return;
  }

  if (objects.length === 0) {
    console.log("No matching objects.");
    return;
  }
  for (const object of objects) {
    const portMode = object.dynamicPorts
      ? "dynamic"
      : object.argumentPorts ? "arguments" : "fixed";
    console.log(
      `${object.name}\t${object.kind}\t${object.numinlets}->${object.numoutlets}` +
      `\t${portMode}\t${object.maxclass}`
    );
  }
  if (objects.length < matches.length) {
    console.log(`... ${matches.length - objects.length} more; increase --limit`);
  }
}

async function brokerCommand(cmdArgs: string[]) {
  const action = cmdArgs[0] ?? "status";
  if (!["status", "start", "stop", "restart"].includes(action)) {
    throw new Error(`Unknown broker action: ${action}`);
  }
  let force = false;
  const environment = { ...process.env };
  for (let i = 1; i < cmdArgs.length; i++) {
    const argument = cmdArgs[i];
    if (argument === "--config") {
      environment.MAXFORGE_CONFIG = resolve(requiredOptionValue(cmdArgs, i));
      i++;
    } else if (argument === "--force") {
      force = true;
    } else {
      throw new Error(`Unknown broker argument: ${argument}`);
    }
  }
  if (force && action !== "stop" && action !== "restart") {
    throw new Error("--force is only valid with broker stop or broker restart");
  }

  const descriptor = await brokerDescriptorFromEnvironment(environment);
  if (action === "status") {
    const response = await requestBroker(descriptor, "status");
    console.log(JSON.stringify({
      key: descriptor.key,
      endpoint: `${descriptor.host}:${descriptor.port}`,
      clientVersion: descriptor.clientVersion,
      ...response.status,
    }, null, 2));
    return;
  }
  if (action === "start") {
    try {
      const response = await requestBroker(descriptor, "status");
      if (response.status.state === "ready") {
        console.log(JSON.stringify(response.status, null, 2));
        return;
      }
      throw new Error(
        `Broker already exists in ${response.status.state} state; use broker restart`
      );
    } catch (error) {
      if (!isConnectionRefused(error)) throw error;
    }
    spawnBroker(environment);
    console.log(JSON.stringify(await waitForBrokerReady(descriptor), null, 2));
    return;
  }

  if (action === "restart") {
    let wasRunning = true;
    try {
      await requestBroker(descriptor, "stop", force);
    } catch (error) {
      if (isConnectionRefused(error)) wasRunning = false;
      else if (!isConnectionReset(error)) throw error;
    }
    if (wasRunning) await waitForBrokerStopped(descriptor);
    spawnBroker(environment);
    console.log(JSON.stringify(await waitForBrokerReady(descriptor), null, 2));
    return;
  }

  const response = await requestBroker(descriptor, "stop", force);
  console.log(JSON.stringify(response.status, null, 2));
}

async function waitForBrokerReady(
  descriptor: Awaited<ReturnType<typeof brokerDescriptorFromEnvironment>>
) {
  const deadline = Date.now() + 5000;
  let lastError: unknown;
  while (Date.now() < deadline) {
    try {
      const response = await requestBroker(descriptor, "status");
      if (response.status.state === "ready") return response.status;
      if (response.status.state === "failed") {
        throw new Error(response.status.error ?? "Broker runtime failed to start");
      }
    } catch (error) {
      lastError = error;
      if (!isBrokerTransitionError(error)) throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("Timed out waiting for broker startup");
}

async function waitForBrokerStopped(
  descriptor: Awaited<ReturnType<typeof brokerDescriptorFromEnvironment>>
) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      await requestBroker(descriptor, "status");
    } catch (error) {
      if (isConnectionRefused(error)) return;
      if (isConnectionReset(error)) {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
        continue;
      }
      throw error;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
  }
  throw new Error("Timed out waiting for broker shutdown");
}

function isConnectionRefused(error: unknown): boolean {
  return error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ECONNREFUSED";
}

function isConnectionReset(error: unknown): boolean {
  return error instanceof Error &&
    (error as NodeJS.ErrnoException).code === "ECONNRESET";
}

function isBrokerTransitionError(error: unknown): boolean {
  return isConnectionRefused(error) || isConnectionReset(error);
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
    const argument = cmdArgs[i];
    if (argument === "-o") {
      outputFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else if (!inputFile && !argument.startsWith("-")) {
      inputFile = argument;
    } else {
      throw new Error(`Unknown decompile argument: ${argument}`);
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
    const argument = cmdArgs[i];
    if (argument === "-o") {
      outputFile = requiredOptionValue(cmdArgs, i);
      i++;
    } else {
      throw new Error(`Unknown from-clipboard argument: ${argument}`);
    }
  }

  const input = readFileSync(0, "utf-8");
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
  maxforge bundle <input.maxdsl> -o package-directory [--config path] [--name package-name]
  maxforge catalog [query] [--config path] [--input input.maxdsl] [--all] [--limit n] [--json]
  maxforge broker [status|start|stop|restart] [--config path] [--force]

Commands:
  compile         Compile .maxdsl to .maxpat JSON
  decompile       Convert .maxpat JSON to .maxdsl text
  from-clipboard  Read compressed patcher from stdin, output .maxdsl
  validate        Validate .maxdsl without writing output
  plan            Build a managed PatchPlan for maxforge.sync
  doctor          Validate project catalog files and abstraction metadata
  bundle          Build a portable Max package directory with declared dependencies
  catalog         List project objects or search the effective object catalog
  broker          Inspect, start, stop, or restart the project MCP broker

Options:
  -o <file>          Output file path
  --allow-unknown    Allow objects not in the database
  --config <file>    Project object catalog config (otherwise discovered upward from input)
  --clipboard        Output compressed text pasteable into Max
  --scope <name>     Managed scope for plan generation (default: default)
  --current <file>   Current managed .maxdsl or scoped .maxpat snapshot
  --compact          Emit a single-line JSON plan
  --input <file>     Input path used for doctor config discovery
  --name <name>      Package title and generated main patch name for bundle
  --all              Include all built-in objects in an unfiltered catalog listing
  --limit <n>        Maximum catalog records (default: 50, maximum: 1000)
  --json             Emit machine-readable catalog search results
  --force            Disconnect active clients during broker stop or restart
`);
}

main().catch((err) => {
  console.error(`Error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
