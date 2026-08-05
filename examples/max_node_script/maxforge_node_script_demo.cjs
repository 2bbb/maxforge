const fs = require("node:fs/promises");
const path = require("node:path");
const maxApi = require("max-api");

const rootDir = path.resolve(__dirname, "../..");
const dslPath = path.join(__dirname, "generated_patch.maxdsl");
const maxforgeEntry = path.join(rootDir, "dist/index.js");

let lastCommands = [];

async function loadMaxforge() {
  try {
    return await import(maxforgeEntry);
  } catch (error) {
    maxApi.error(`[maxforge] Failed to import ${maxforgeEntry}`);
    maxApi.error("[maxforge] Run `npm install && npm run build` at the repository root, then reload this patch.");
    throw error;
  }
}

async function generate() {
  const { compileDslToThispatcherCommands, loadDatabase } = await loadMaxforge();
  const source = await fs.readFile(dslPath, "utf8");
  const db = await loadDatabase();
  const result = compileDslToThispatcherCommands(source, db, true);

  if (!result.success) {
    maxApi.error(`[maxforge] compile failed: ${JSON.stringify(result.errors)}`);
    return;
  }

  lastCommands = result.commands || [];

  for (const command of lastCommands) {
    if (command.targetPath.length > 0) {
      maxApi.post(`[maxforge] skipped nested command: ${JSON.stringify(command)}`);
      continue;
    }
    maxApi.outlet(...command.message);
  }

  maxApi.post(`[maxforge] emitted ${lastCommands.length} thispatcher commands from ${path.basename(dslPath)}`);
}

function clear() {
  const names = [];
  for (const command of lastCommands) {
    const idx = command.message.indexOf("@varname");
    if (command.targetPath.length === 0 && idx >= 0 && typeof command.message[idx + 1] === "string") {
      names.push(command.message[idx + 1]);
    }
  }

  for (const name of names.reverse()) {
    maxApi.outlet("script", "delete", name);
  }

  maxApi.post(`[maxforge] requested deletion of ${names.length} generated boxes`);
  lastCommands = [];
}

maxApi.addHandler("generate", generate);
maxApi.addHandler("clear", clear);
maxApi.post("[maxforge] node.script demo loaded. Send 'generate' to create DSL objects.");
