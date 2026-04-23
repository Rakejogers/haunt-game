import {
	getCurrentAttemptSummary,
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

export async function GET(request) {
	try {
		const sessionContext = await getSessionContext(request);
		const attempt = await getCurrentAttemptSummary(sessionContext.sessionId);
		return json({ attempt }, 200, getResponseCookieHeader(sessionContext));
	} catch (error) {
		return json(
			{
				error:
					error instanceof Error
						? error.message
						: "Unable to load the current run state.",
			},
			error?.status ?? 500,
		);
	}
}
