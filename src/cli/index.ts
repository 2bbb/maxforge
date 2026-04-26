#!/usr/bin/env node

import { parse, compile, serialize, decompile, loadDatabase } from "../index.js";
import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";

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

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

async function compileCommand(cmdArgs: string[]) {
  let inputFile = "";
  let outputFile = "";
  let allowUnknown = false;

  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === "-o" && cmdArgs[i + 1]) {
      outputFile = cmdArgs[i + 1];
      i++;
    } else if (cmdArgs[i] === "--allow-unknown") {
      allowUnknown = true;
    } else if (!inputFile) {
      inputFile = cmdArgs[i];
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

  const db = await loadDatabase();
  const result = compile(ast, db, allowUnknown);

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

  if (outputFile) {
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

  for (let i = 0; i < cmdArgs.length; i++) {
    if (cmdArgs[i] === "--allow-unknown") {
      allowUnknown = true;
    } else if (!inputFile) {
      inputFile = cmdArgs[i];
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

  const db = await loadDatabase();
  const result = compile(ast, db, allowUnknown);

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

function printHelp() {
  console.log(`maxpat-dsl - Max/MSP patch DSL compiler

Usage:
  maxpat-dsl compile <input.maxdsl> [-o output.maxpat] [--allow-unknown]
  maxpat-dsl decompile <input.maxpat> [-o output.maxdsl]
  maxpat-dsl validate <input.maxdsl> [--allow-unknown]

Commands:
  compile      Compile .maxdsl to .maxpat JSON
  decompile    Convert .maxpat JSON to .maxdsl text
  validate     Validate .maxdsl without writing output

Options:
  -o <file>          Output file path
  --allow-unknown    Allow objects not in the database
`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
