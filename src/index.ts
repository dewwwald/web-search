import { PluginContext } from "@lmstudio/sdk";
import { toolsProvider } from "./toolsProvider";
import { configSchematics } from "./config";

export async function main(context:PluginContext) {
	context.withConfigSchematics(configSchematics);
	context.withToolsProvider(toolsProvider);
}
