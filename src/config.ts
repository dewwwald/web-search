import { createConfigSchematics } from "@lmstudio/sdk";

export const configSchematics = createConfigSchematics()
	.field(
		"pageSize",
		"numeric",
		{
			displayName: "Search Results Per Page",
			subtitle: "Between 1 and 10, 0 = auto",
			min: 0,
			max: 10,
			int: true,
			slider: {
				step: 1,
				min: 0,
				max: 10,
			},
		},
		5
	)
	.field(
		"contentLimit",
		"numeric",
		{
			displayName: "Max Content",
			min: -1,
			max: 50_000,
			int: true,
			subtitle: "Maximum text content size in chars returned by the Visit Website tool ",
		},
		8000
	)
	.field(
		"promptGuidance",
		"boolean",
		{
			displayName: "Prompt Guidance",
			subtitle: "Adds reminders to tool output to guide the model toward more thorough search. Recommended for small models, large models may work better without it.",
		},
		true
	)
	.field(
		"jinaApiKey",
		"string",
		{
			displayName: "Jina API Key",
			subtitle: "Optional. Jina Reader (r.jina.ai) is used as a fallback for content extraction and rate-limits/blocks anonymous requests. Get a free key at jina.ai to authenticate those requests.",
			isProtected: true,
			placeholder: "jina_...",
		},
		""
	)
	.build();
