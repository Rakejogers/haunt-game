import {
	completeObjectiveGrant,
	getResponseCookieHeader,
	getSessionContext,
} from "../../../lib/server-game-state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

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
	try {
		const sessionContext = await getSessionContext(request);
		const body = await request.json();
		const result = await completeObjectiveGrant({
			sessionId: sessionContext.sessionId,
			request,
			attemptId: body?.attemptId,
			objectiveGrantId: body?.objectiveGrantId,
			npcId: body?.npcId,
			secretId: body?.secretId,
			summary: body?.summary,
			confidence: body?.confidence,
		});

		return json(result, 200, getResponseCookieHeader(sessionContext));
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error
						? error.message
						: "Unable to complete that objective right now.",
			},
			error?.status ?? 500,
		);
	}
}
