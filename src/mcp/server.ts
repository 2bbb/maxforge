import { runMcpFrontend } from "./broker-client.js";

export {
  bridgeOptionsFromEnvironment,
  catalogOptionsFromEnvironment,
  createMaxforgeMcpRuntime,
  packageVersion,
} from "./runtime.js";

export async function main(): Promise<void> {
  await runMcpFrontend(process.env);
}
