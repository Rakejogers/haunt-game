import { buildNpcSessionInstructions } from "../../../lib/npc-secrets";
import {
	createGrokSessionMaterial,
	getResponseCookieHeader,
	getSessionContext,
} from "../../../lib/server-game-state";

export const runtime = "nodejs";

const SESSION_REQUEST_URL = "https://api.x.ai/v1/realtime/client_secrets";

function json(payload, status = 200, sessionCookie = null) {
	const headers = {
		"Cache-Control": "no-store",
	};

	if (sessionCookie) {
		headers["Set-Cookie"] = sessionCookie;
	}

	return Response.json(payload, { status, headers });
}

export async function POST(request) {
	const apiKey = process.env.XAI_API_KEY;

	if (!apiKey) {
		return json(
			{
				error:
					"Missing XAI_API_KEY. Add it to your environment before starting a Grok session.",
			},
			500,
		);
	}

	try {
		const sessionContext = await getSessionContext(request);
		const body = await request.json();
		const material = await createGrokSessionMaterial({
			sessionId: sessionContext.sessionId,
			request,
			attemptId: body?.attemptId,
			worldId: body?.worldId,
			npcId: body?.npcId,
		});
		const upstreamResponse = await fetch(SESSION_REQUEST_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				expires_after: {
					seconds: 300,
				},
			}),
			cache: "no-store",
		});

		const payload = await upstreamResponse.json();

		if (!upstreamResponse.ok) {
			return json(
				{
					error: "xAI rejected the ephemeral token request.",
					details: payload,
				},
				upstreamResponse.status,
			);
		}

		return json(
			{
				token:
					payload?.value ??
					payload?.token ??
					payload?.client_secret?.value ??
					payload?.client_secret ??
					null,
				objectiveGrantId: material.objectiveGrantId,
				sanitizedInstructions: buildNpcSessionInstructions(material.instructions.npcId),
				expiresAt: material.expiresAt,
			},
			200,
			getResponseCookieHeader(sessionContext),
		);
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error
						? error.message
						: "Failed to contact xAI while creating an ephemeral token.",
			},
			error?.status ?? 500,
		);
	}
}
