import { buildNpcSessionInstructions } from "../../../lib/npc-secrets";

export const runtime = "nodejs";

export async function POST(request) {
	try {
		const body = await request.json();
		const npcId = body?.npcId;

		if (!npcId) {
			return Response.json(
				{
					error: "npcId is required to build a Grok session briefing.",
				},
				{ status: 400 },
			);
		}

		const instructions = buildNpcSessionInstructions(npcId);

		return Response.json(
			{ instructions },
			{
				status: 200,
				headers: {
					"Cache-Control": "no-store",
				},
			},
		);
	} catch (error) {
		return Response.json(
			{
				error: error instanceof Error ? error.message : "Unable to build the NPC briefing.",
			},
			{ status: 500 },
		);
	}
}
